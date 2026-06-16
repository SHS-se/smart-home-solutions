import React, { useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ArrowLeft, Plus, Trash2, FileText, Package, Pencil, Check, X, Copy, Save, Lock, Info, Receipt } from 'lucide-react';
import { getQuoteStatusBadge } from '@/lib/quote-status-badge';
import { supersedeActiveQuotesInChain } from '@/lib/supersede-quotes';
import { getFulfillmentStatus, remainingToInvoice, type FulfillmentStatus } from '@/lib/bom-fulfillment';
import { getAuthenticatedFunctionHeaders } from '@/lib/supabase-function-auth';
import { getEdgeFunctionErrorMessage } from '@/lib/edge-function-error';
import { getDefaultInvoiceDueDate } from '@/lib/swedish-banking-days';
import { toast } from '@/hooks/use-toast';
import SKUSelector from '@/components/portal/boms/SKUSelector';
import TemplateSelector from '@/components/portal/boms/TemplateSelector';
import QuantityInput from '@/components/portal/boms/QuantityInput';
import BOMVersionSelector from '@/components/portal/boms/BOMVersionSelector';

interface BOMItem {
  id: string;
  sku_id: string;
  quantity: number;
  cost_ex_vat_at_time: number | null;
  sku: {
    sku: string;
    name: string;
    category_id: string | null;
    category_name?: string;
    cost_ex_vat_computed: number | null;
    vat_rate: number;
    sell_price_ex_vat: number | null;
    sell_price_inc_vat: number | null;
    effective_margin_percent: number | null;
  };
}

const REVISION_REASON_OPTIONS = [
  { value: 'customer_phone', label: { sv: 'Kundönskemål (telefon)', en: 'Customer request (phone)' } },
  { value: 'customer_email', label: { sv: 'Kundönskemål (e-post)', en: 'Customer request (email)' } },
  { value: 'customer_portal', label: { sv: 'Kundönskemål (portal)', en: 'Customer request (portal)' } },
  { value: 'internal_correction', label: { sv: 'Intern korrigering', en: 'Internal correction' } },
  { value: 'technical_change', label: { sv: 'Projektering / teknisk ändring', en: 'Design / technical change' } },
  { value: 'other', label: { sv: 'Annat', en: 'Other' } },
];

// Maps a fulfillment status into a localized label + badge styling for the BOM fulfillment column.
const FULFILLMENT_BADGE: Record<FulfillmentStatus, { label: { sv: string; en: string }; className: string }> = {
  not_invoiced: { label: { sv: 'Ej fakturerad', en: 'Not invoiced' }, className: 'bg-muted text-muted-foreground border-transparent' },
  partial: { label: { sv: 'Delvis fakturerad', en: 'Partially invoiced' }, className: 'bg-amber-100 text-amber-800 border-amber-200' },
  full: { label: { sv: 'Fullt fakturerad', en: 'Fully invoiced' }, className: 'bg-green-100 text-green-800 border-green-200' },
  over: { label: { sv: 'Överfakturerad', en: 'Over-invoiced' }, className: 'bg-destructive/10 text-destructive border-destructive/20' },
};

const BOMBuilder: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { isStaff, loading: authLoading, user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isSKUSelectorOpen, setIsSKUSelectorOpen] = useState(false);
  const [isTemplateSelectorOpen, setIsTemplateSelectorOpen] = useState(false);
  const [isRevisionDialogOpen, setIsRevisionDialogOpen] = useState(false);
  const [isEditingProject, setIsEditingProject] = useState(false);
  const [editedProjectName, setEditedProjectName] = useState('');

  // Revision reason form state
  const [revisionReasonType, setRevisionReasonType] = useState('');
  const [revisionReasonNote, setRevisionReasonNote] = useState('');

  // Local state for unsaved quantity changes
  const [localQuantities, setLocalQuantities] = useState<Record<string, number>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);

  // Fetch BOM
  const { data: bom } = useQuery({
    queryKey: ['bom', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boms')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: isStaff && !!id,
  });

  // Detect locked state: locked if any quote OR finalized invoice for this bom+version
  const { data: isLocked = false } = useQuery({
    queryKey: ['bom_locked', id, bom?.version],
    queryFn: async () => {
      // Check quotes
      const { count: quoteCount, error: quoteError } = await supabase
        .from('quotes')
        .select('id', { count: 'exact', head: true })
        .eq('bom_id', id!)
        .eq('bom_version', bom!.version)
        .in('status', ['sent', 'viewed', 'accepted', 'revision_requested']);
      if (quoteError) throw quoteError;
      if ((quoteCount ?? 0) > 0) return true;

      // Check finalized invoices
      const { count: invoiceCount, error: invoiceError } = await supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('bom_id', id!)
        .in('status', ['open', 'paid']);
      if (invoiceError) throw invoiceError;
      return (invoiceCount ?? 0) > 0;
    },
    enabled: isStaff && !!id && !!bom,
  });

  // Fetch BOM items with SKU data (scope only - no pricing)
  const { data: items = [] } = useQuery({
    queryKey: ['bom_items', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bom_items')
        .select('*, skus(sku, name, category_id, cost_ex_vat_computed, vat_rate, sell_price_ex_vat, sell_price_inc_vat, effective_margin_percent, sku_categories!skus_category_id_fkey(id, name))')
        .eq('bom_id', id);
      if (error) throw error;
      return data.map(item => {
        const skuData = (item as any).skus;
        return {
          ...item,
          sku: {
            ...skuData,
            category_name: skuData?.sku_categories?.name || 'Unknown',
          },
        };
      }) as BOMItem[];
    },
    enabled: isStaff && !!id,
  });

  // Fetch premises-level fulfillment (quoted/invoiced/remaining per sku) for this BOM's group
  const { data: fulfillment } = useQuery({
    queryKey: ['bom_fulfillment', bom?.bom_group_id],
    queryFn: async () => {
      const map = new Map<string, { bom_quantity: number; quoted_quantity: number; invoiced_quantity: number; remaining_quantity: number }>();
      const groupId = bom?.bom_group_id;
      if (!groupId) return map;
      const { data, error } = await supabase
        .from('bom_fulfillment')
        .select('sku_id, bom_quantity, quoted_quantity, invoiced_quantity, remaining_quantity')
        .eq('bom_group_id', groupId);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.sku_id) {
          map.set(row.sku_id, {
            bom_quantity: row.bom_quantity ?? 0,
            quoted_quantity: row.quoted_quantity ?? 0,
            invoiced_quantity: row.invoiced_quantity ?? 0,
            remaining_quantity: row.remaining_quantity ?? 0,
          });
        }
      }
      return map;
    },
    enabled: isStaff && !!bom?.bom_group_id,
  });

  // Fetch existing quote linked to this BOM
  const { data: existingQuote } = useQuery({
    queryKey: ['bom_quote', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('id, quote_number, status')
        .eq('bom_id', id!)
        .not('status', 'eq', 'cancelled')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: isStaff && !!id,
  });

  // Fetch customers for selector
  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customers_with_identity')
        .select('id, name, contact_name')
        .order('name');
      if (error) throw error;
      return data;
    },
    enabled: isStaff,
  });

  // Update BOM mutation with optimistic UI
  const updateBOMMutation = useMutation({
    mutationFn: async (updates: { project_name?: string; customer_id?: string | null }) => {
      const { error } = await supabase
        .from('boms')
        .update(updates)
        .eq('id', id);
      if (error) throw error;

      // Propagate customer change to linked draft quotes
      if ('customer_id' in updates) {
        const { error: quoteError } = await supabase
          .from('quotes')
          .update({ customer_id: updates.customer_id })
          .eq('bom_id', id!)
          .in('status', ['draft', 'revision_requested']);
        if (quoteError) console.error('Failed to update quote customers:', quoteError);
      }
    },
    onMutate: async (updates) => {
      await queryClient.cancelQueries({ queryKey: ['bom', id] });
      const previous = queryClient.getQueryData(['bom', id]);
      queryClient.setQueryData(['bom', id], (old: any) => old ? { ...old, ...updates } : old);
      return { previous };
    },
    onError: (error: any, _updates, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['bom', id], context.previous);
      }
      toast({ title: t('Kunde inte uppdatera BOM', 'Failed to update BOM'), description: error.message, variant: 'destructive' });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['bom', id] });
      setIsEditingProject(false);
    },
    onSuccess: () => {
      toast({ title: t('BOM uppdaterad', 'BOM updated') });
    },
  });

  // Create new BOM revision mutation (with reason)
  const createRevisionMutation = useMutation({
    mutationFn: async ({ reasonType, reasonNote }: { reasonType: string; reasonNote: string }) => {
      const newVersion = (bom?.version ?? 1) + 1;

      const { data: newBom, error: bomError } = await supabase
        .from('boms')
        .insert({
          project_name: bom?.project_name,
          customer_id: bom?.customer_id,
          version: newVersion,
          bom_group_id: (bom as any)?.bom_group_id || id,
          revision_reason_type: reasonType,
          revision_reason_note: reasonNote || null,
          revision_created_by: user?.id,
          revision_created_at: new Date().toISOString(),
        } as any)
        .select()
        .single();
      if (bomError) throw bomError;

      // Copy all items to new BOM (scope only)
      if (items.length > 0) {
        const newItems = items.map(item => ({
          bom_id: newBom.id,
          sku_id: item.sku_id,
          quantity: item.quantity,
          cost_ex_vat_at_time: item.cost_ex_vat_at_time,
        }));

        const { error: itemsError } = await supabase
          .from('bom_items')
          .insert(newItems);
        if (itemsError) throw itemsError;
      }

      // Log bom_event for audit
      await supabase.from('bom_events' as any).insert({
        bom_id: newBom.id,
        event_type: 'revision_created',
        actor_email: user?.email,
        actor_type: 'staff',
        metadata: {
          reason_type: reasonType,
          reason_note: reasonNote || null,
          from_version: bom?.version ?? 1,
          to_version: newVersion,
          source_bom_id: id,
        },
      });

      return newBom;
    },
    onSuccess: (newBom) => {
      setIsRevisionDialogOpen(false);
      setRevisionReasonType('');
      setRevisionReasonNote('');
      toast({ 
        title: t('Ny BOM-revision skapad', 'New BOM revision created'),
        description: `v${newBom.version}`
      });
      navigate(`/portal/boms/${newBom.id}`);
    },
    onError: (error: any) => {
      toast({ title: t('Kunde inte skapa ny revision', 'Failed to create new revision'), description: error.message, variant: 'destructive' });
    },
  });

  // Add item mutation (scope only - just sku_id, quantity, cost reference)
  const addItemMutation = useMutation({
    mutationFn: async (data: { sku_id: string; quantity: number }) => {
      const { data: sku, error: skuError } = await supabase
        .from('skus')
        .select('cost_ex_vat_computed')
        .eq('id', data.sku_id)
        .single();
      if (skuError) throw skuError;

      const { error } = await supabase.from('bom_items').upsert({
        bom_id: id,
        sku_id: data.sku_id,
        quantity: data.quantity,
        cost_ex_vat_at_time: sku.cost_ex_vat_computed,
      }, { onConflict: 'bom_id,sku_id' });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bom_items', id] });
    },
    onError: (error: Error) => {
      toast({ title: t('Kunde inte lägga till SKU', 'Failed to add SKU'), description: error.message, variant: 'destructive' });
    },
  });

  // Update item mutation
  const updateItemMutation = useMutation({
    mutationFn: async ({ itemId, updates }: { itemId: string; updates: Partial<BOMItem> }) => {
      const { error } = await supabase
        .from('bom_items')
        .update(updates)
        .eq('id', itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bom_items', id] });
    },
  });

  // Compute whether there are unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    return items.some(item => 
      localQuantities[item.id] !== undefined && 
      localQuantities[item.id] !== item.quantity
    );
  }, [items, localQuantities]);

  // Handle local quantity change (no DB mutation)
  const handleLocalQuantityChange = (itemId: string, quantity: number) => {
    setLocalQuantities(prev => ({
      ...prev,
      [itemId]: quantity,
    }));
  };

  // Save all changes to database
  const handleSaveChanges = async () => {
    const updates = Object.entries(localQuantities).filter(([itemId, qty]) => {
      const item = items.find(i => i.id === itemId);
      return item && item.quantity !== qty;
    });

    if (updates.length === 0) return;

    setIsSaving(true);
    try {
      await Promise.all(
        updates.map(([itemId, quantity]) =>
          supabase.from('bom_items').update({ quantity }).eq('id', itemId)
        )
      );
      await queryClient.invalidateQueries({ queryKey: ['bom_items', id] });
      setLocalQuantities({});
      toast({ title: t('Ändringar sparade', 'Changes saved') });
    } catch (error: any) {
      toast({ title: t('Kunde inte spara', 'Failed to save'), description: error.message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  // Delete item mutation
  const deleteItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase.from('bom_items').delete().eq('id', itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bom_items', id] });
    },
  });

  // Calculate scope-only totals
  const totals = items.reduce(
    (acc, item) => {
      const qty = localQuantities[item.id] ?? item.quantity;
      const unitCostEx = item.cost_ex_vat_at_time ?? 0;
      const costEx = unitCostEx * qty;
      
      return {
        costEx: acc.costEx + costEx,
        items: acc.items + qty,
      };
    },
    { costEx: 0, items: 0 }
  );

  // Premises-level fulfillment rollup across the BOM items
  const fulfillmentSummary = useMemo(() => {
    let fullyInvoiced = 0;
    let unitsRemaining = 0;
    for (const item of items) {
      const invoiced = fulfillment?.get(item.sku_id)?.invoiced_quantity ?? 0;
      if (invoiced >= item.quantity && item.quantity > 0) fullyInvoiced += 1;
      unitsRemaining += remainingToInvoice(item.quantity, invoiced);
    }
    return { fullyInvoiced, unitsRemaining };
  }, [items, fulfillment]);

  // Create a FRESH quote from BOM (no previous quote to clone)
  const createFreshQuote = async () => {
    const freshItems = items;
    const skuIds = freshItems.map(i => i.sku_id);
    const { data: skuPricing, error: skuError } = await supabase
      .from('skus')
      .select('id, sell_price_ex_vat, sell_price_inc_vat, vat_rate, cost_ex_vat_computed')
      .in('id', skuIds);
    if (skuError) throw skuError;

    const skuMap = new Map((skuPricing || []).map(s => [s.id, s]));

    const { data: quote, error } = await supabase
      .from('quotes')
      .insert({
        bom_id: id,
        bom_version: bom?.version ?? 1,
        customer_id: bom?.customer_id || null,
        created_by: user?.id,
      })
      .select()
      .single();
    if (error) throw error;

    const hardwareLines = freshItems.map(item => {
      const sku = skuMap.get(item.sku_id);
      const sellExVat = sku?.sell_price_ex_vat ?? 0;
      const vatRate = sku?.vat_rate ?? 0.25;
      const sellIncVat = sku?.sell_price_inc_vat ?? (sellExVat * (1 + vatRate));

      return {
        quote_id: quote.id,
        section: 'hardware',
        description: item.sku.name,
        quantity: item.quantity,
        unit_price: sellExVat,
        unit_price_ex_vat: sellExVat,
        vat_rate: vatRate,
        unit_price_inc_vat: sellIncVat,
        sku_id: item.sku_id,
        original_sku_name: item.sku.name,
        original_sku_code: item.sku.sku,
        cost_ex_vat_at_time: sku?.cost_ex_vat_computed ?? item.cost_ex_vat_at_time ?? 0,
        pricing_source: 'sku',
        source_bom_id: id,
        source_bom_item_id: item.id,
        source_bom_version: bom?.version ?? 1,
      };
    });

    if (hardwareLines.length > 0) {
      const { error: linesError } = await supabase.from('quote_lines').insert(hardwareLines);
      if (linesError) throw linesError;
    }

    return quote;
  };

  // Clone a previous quote and sync hardware lines with new BOM
  const createQuoteFromPreviousVersion = async (previousQuote: any) => {
    // Step 1: Create new quote record
    const { data: newQuote, error: createError } = await supabase
      .from('quotes')
      .insert({
        bom_id: id,
        bom_version: bom?.version ?? 1,
        customer_id: bom?.customer_id || previousQuote.customer_id,
        status: 'draft',
        is_latest: true,
        created_by: user?.id,
      })
      .select()
      .single();
    if (createError) throw createError;

    // Step 2: Fetch previous quote lines
    const { data: previousLines, error: linesError } = await supabase
      .from('quote_lines')
      .select('*')
      .eq('quote_id', previousQuote.id);
    if (linesError) throw linesError;

    // Step 3: Separate hardware vs non-hardware lines by section only
    const previousHardwareLines = (previousLines || []).filter(
      (l: any) => l.section === 'hardware'
    );
    const nonHardwareLines = (previousLines || []).filter(
      (l: any) => l.section !== 'hardware'
    );

    // Step 4: Map previous hardware lines by sku_id for lookup
    const previousHardwareBySkuId = new Map<string, any>();
    for (const line of previousHardwareLines) {
      if (line.sku_id) {
        previousHardwareBySkuId.set(line.sku_id, line);
      }
    }

    // Step 5: Get current BOM items
    const bomItems = items;

    // Step 6: Fetch current SKU pricing for any NEW SKUs not in previous quote
    const newSkuIds = bomItems
      .map(i => i.sku_id)
      .filter(skuId => !previousHardwareBySkuId.has(skuId));

    let newSkuPricing = new Map<string, any>();
    if (newSkuIds.length > 0) {
      const { data: skuData } = await supabase
        .from('skus')
        .select('id, sell_price_ex_vat, sell_price_inc_vat, vat_rate, cost_ex_vat_computed, name, sku')
        .in('id', newSkuIds);
      newSkuPricing = new Map((skuData || []).map(s => [s.id, s]));
    }

    // Step 7: Build hardware lines — existing SKUs keep previous pricing, new SKUs get current pricing
    const hardwareLines = bomItems.map(bomItem => {
      const previousLine = previousHardwareBySkuId.get(bomItem.sku_id);

      if (previousLine) {
        // SKU exists in previous quote → keep negotiated pricing, update quantity from BOM
        return {
          quote_id: newQuote.id,
          section: 'hardware',
          description: previousLine.description,
          quantity: bomItem.quantity,
          unit_price: previousLine.unit_price,
          unit_price_ex_vat: previousLine.unit_price_ex_vat,
          vat_rate: previousLine.vat_rate,
          unit_price_inc_vat: previousLine.unit_price_inc_vat,
          sku_id: bomItem.sku_id,
          original_sku_name: previousLine.original_sku_name,
          original_sku_code: previousLine.original_sku_code,
          cost_ex_vat_at_time: previousLine.cost_ex_vat_at_time,
          pricing_source: 'bom',
          source_bom_id: id,
          source_bom_item_id: bomItem.id,
          source_bom_version: bom?.version ?? 1,
        };
      } else {
        // New SKU not in previous quote → use current SKU pricing
        const sku = newSkuPricing.get(bomItem.sku_id);
        const sellExVat = sku?.sell_price_ex_vat ?? 0;
        const vatRate = sku?.vat_rate ?? 0.25;
        const sellIncVat = sku?.sell_price_inc_vat ?? (sellExVat * (1 + vatRate));

        return {
          quote_id: newQuote.id,
          section: 'hardware',
          description: sku?.name || bomItem.sku.name,
          quantity: bomItem.quantity,
          unit_price: sellExVat,
          unit_price_ex_vat: sellExVat,
          vat_rate: vatRate,
          unit_price_inc_vat: sellIncVat,
          sku_id: bomItem.sku_id,
          original_sku_name: sku?.name || bomItem.sku.name,
          original_sku_code: sku?.sku || bomItem.sku.sku,
          cost_ex_vat_at_time: sku?.cost_ex_vat_computed ?? bomItem.cost_ex_vat_at_time ?? 0,
          pricing_source: 'sku',
          source_bom_id: id,
          source_bom_item_id: bomItem.id,
          source_bom_version: bom?.version ?? 1,
        };
      }
    });

    // Step 8: Clone non-hardware lines (labor, travel, manual) — preserve all pricing
    const clonedNonHardwareLines = nonHardwareLines.map((line: any) => ({
      quote_id: newQuote.id,
      section: line.section,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unit_price,
      unit_price_ex_vat: line.unit_price_ex_vat,
      vat_rate: line.vat_rate,
      unit_price_inc_vat: line.unit_price_inc_vat,
      sku_id: line.sku_id,
      original_sku_name: line.original_sku_name,
      original_sku_code: line.original_sku_code,
      cost_ex_vat_at_time: line.cost_ex_vat_at_time,
      pricing_source: line.pricing_source,
      source_bom_id: line.source_bom_id,
      source_bom_item_id: line.source_bom_item_id,
      source_bom_version: line.source_bom_version,
    }));

    // Step 9: Insert all lines
    const allNewLines = [...hardwareLines, ...clonedNonHardwareLines];
    if (allNewLines.length > 0) {
      const { error: insertError } = await supabase.from('quote_lines').insert(allNewLines);
      if (insertError) throw insertError;
    }

    return newQuote;
  };

  // Main quote creation handler — decides between clone+sync or fresh creation
  const createQuote = async () => {
    try {
      const isRevision = !!(bom as any)?.revision_reason_type;

      if (isRevision) {
        // Look up source BOM from bom_events
        const { data: revisionEvent } = await supabase
          .from('bom_events')
          .select('metadata')
          .eq('bom_id', id!)
          .eq('event_type', 'revision_created')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const sourceBomId = (revisionEvent?.metadata as any)?.source_bom_id;

        if (sourceBomId) {
          // Find latest non-cancelled quote for the source BOM
          const { data: previousQuote } = await supabase
            .from('quotes')
            .select('*')
            .eq('bom_id', sourceBomId)
            .not('status', 'eq', 'cancelled')
            .not('status', 'eq', 'superseded')
            .order('version', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (previousQuote) {
            const newQuote = await createQuoteFromPreviousVersion(previousQuote);

            // Supersede all active quotes in the chain
            if (id) {
              await supersedeActiveQuotesInChain({ newQuoteId: newQuote.id, bomId: id });
            }

            toast({
              title: t('Offert skapad', 'Quote created'),
              description: t(
                'Ny offert skapad baserat på föregående version med uppdaterad omfattning.',
                'New quote created based on previous version with updated scope.'
              ),
            });
            navigate(`/portal/quotes/${newQuote.id}`);
            return;
          }
        }
      }

      // Fallback: fresh quote (no previous quote to clone)
      const quote = await createFreshQuote();

      // Supersede any active quotes in the same chain
      if (id) {
        await supersedeActiveQuotesInChain({ newQuoteId: quote.id, bomId: id });
      }

      navigate(`/portal/quotes/${quote.id}`);
    } catch (error: any) {
      toast({ title: t('Kunde inte skapa offert', 'Failed to create quote'), description: error.message, variant: 'destructive' });
    }
  };

  // Create a draft invoice directly from the current BOM revision, billing only the remaining
  // (un-invoiced) quantities so already-fulfilled items are never double billed. The invoice stores
  // the source BOM revision (bom_id + version) and has no quote (created directly from BOM).
  const createInvoiceFromBOM = async () => {
    if (!bom?.customer_id) {
      toast({ title: t('Välj en kund först', 'Select a customer first'), variant: 'destructive' });
      return;
    }

    const lineItems = items
      .map(item => {
        const invoiced = fulfillment?.get(item.sku_id)?.invoiced_quantity ?? 0;
        return { item, remaining: remainingToInvoice(item.quantity, invoiced) };
      })
      .filter(({ remaining }) => remaining > 0)
      .map(({ item, remaining }) => {
        const vatRateRaw = item.sku.vat_rate;
        const vatRatePct = vatRateRaw == null ? 25 : vatRateRaw <= 1 ? vatRateRaw * 100 : vatRateRaw;
        return {
          line_type: 'hardware',
          description: item.sku.name,
          sku: item.sku.sku,
          sku_id: item.sku_id,
          quantity: remaining,
          unit_price: item.sku.sell_price_ex_vat ?? 0,
          tax_rate: vatRatePct,
          category: item.sku.category_name,
          source_bom_id: id,
          source_bom_item_id: item.id,
          source_bom_version: bom?.version ?? 1,
        };
      });

    if (lineItems.length === 0) {
      toast({ title: t('Alla BOM-artiklar är redan fakturerade', 'All BOM items have already been invoiced.') });
      return;
    }

    setIsCreatingInvoice(true);
    try {
      const { data, error, response } = await supabase.functions.invoke('create-draft-invoice', {
        headers: await getAuthenticatedFunctionHeaders(),
        body: {
          customer_id: bom.customer_id,
          bom_id: id,
          due_date: getDefaultInvoiceDueDate(),
          line_items: lineItems,
        },
      });
      if (error) throw new Error(await getEdgeFunctionErrorMessage(error, response));
      if (data?.error) throw new Error(data.error);
      toast({ title: t('Fakturautkast skapat från BOM', 'Invoice draft created from BOM') });
      navigate(`/portal/invoices/new?id=${data.invoice_id}`);
    } catch (error: any) {
      toast({ title: t('Kunde inte skapa faktura', 'Failed to create invoice'), description: error.message, variant: 'destructive' });
    } finally {
      setIsCreatingInvoice(false);
    }
  };

  // Handle add from template
  const handleAddFromTemplate = async (templateId: string) => {
    try {
      const { data: templateItems, error } = await supabase
        .from('template_items')
        .select('*, skus(*)')
        .eq('template_id', templateId);
      if (error) throw error;

      for (const item of templateItems || []) {
        await addItemMutation.mutateAsync({
          sku_id: item.sku_id,
          quantity: item.quantity,
        });
      }

      toast({ title: t('Mall tillagd', 'Template added') });
    } catch (error: any) {
      toast({ title: t('Kunde inte lägga till mall', 'Failed to add template'), description: error.message, variant: 'destructive' });
    }
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  // Detect if this is a newly created revision (has revision_reason_type set)
  const isNewRevision = !!(bom as any)?.revision_reason_type;

  const formatPrice = (value: number) => value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <>
      <div className="space-y-6">
        {/* Locked BOM banner */}


        {/* Header */}
        <div className="flex items-center gap-4">
          <Link 
            to="/portal/boms" 
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold">BOM Builder</h1>
              <BOMVersionSelector
                bomGroupId={(bom as any)?.bom_group_id || id || ''}
                currentBomId={id || ''}
                currentVersion={bom?.version || 1}
              />
              {isLocked && (
                <Badge variant="secondary" className="gap-1">
                  <Lock className="h-3 w-3" />
                  {t('Låst', 'Locked')}
                </Badge>
              )}
              {existingQuote && getQuoteStatusBadge(existingQuote.status, t)}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-1">
              {/* Customer selector */}
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">{t('Kund', 'Customer')}:</span>
                <Select
                  value={bom?.customer_id || 'none'}
                  onValueChange={(value) => {
                    updateBOMMutation.mutate({ customer_id: value === 'none' ? null : value });
                  }}
                  disabled={isLocked}
                >
                  <SelectTrigger data-testid="bom-customer-trigger" className="w-[200px] h-8 text-sm">
                    <SelectValue placeholder={t('Välj kund', 'Select customer')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('Ingen kund', 'No customer')}</SelectItem>
                    {customers.map((customer) => (
                      <SelectItem key={customer.id} value={customer.id}>
                        {customer.name || t('Namnlös', 'Unnamed')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              {/* Project name - editable only when unlocked */}
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">{t('Projekt', 'Project')}:</span>
                {isEditingProject && !isLocked ? (
                  <div className="flex items-center gap-1">
                    <Input
                      value={editedProjectName}
                      onChange={(e) => setEditedProjectName(e.target.value)}
                      className="h-8 w-[200px] text-sm"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && editedProjectName.trim()) {
                          updateBOMMutation.mutate({ project_name: editedProjectName.trim() });
                        } else if (e.key === 'Escape') {
                          setIsEditingProject(false);
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        if (editedProjectName.trim()) {
                          updateBOMMutation.mutate({ project_name: editedProjectName.trim() });
                        }
                      }}
                      disabled={!editedProjectName.trim() || updateBOMMutation.isPending}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setIsEditingProject(false)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <button
                    className="flex items-center gap-1 text-sm hover:text-primary transition-colors group"
                    onClick={() => {
                      if (!isLocked) {
                        setEditedProjectName(bom?.project_name || '');
                        setIsEditingProject(true);
                      }
                    }}
                    disabled={isLocked}
                  >
                    <span>{bom?.project_name}</span>
                    {!isLocked && (
                      <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>


        {/* Actions */}
        <div className="flex flex-wrap gap-2 mb-4">
          <Button data-testid="bom-add-sku-button" onClick={() => setIsSKUSelectorOpen(true)} disabled={isLocked}>
            <Plus className="h-4 w-4 mr-2" />
            {t('Lägg till SKU', 'Add SKU')}
          </Button>
          <Button variant="outline" onClick={() => setIsTemplateSelectorOpen(true)} disabled={isLocked}>
            <Package className="h-4 w-4 mr-2" />
            {t('Lägg till från mall', 'Add from template')}
          </Button>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    data-testid="bom-create-revision-button"
                    variant="outline"
                    onClick={() => setIsRevisionDialogOpen(true)}
                    disabled={(!isLocked && existingQuote?.status !== 'revision_requested') || createRevisionMutation.isPending}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    {t('Skapa ny BOM-revision', 'Create new BOM revision')}
                  </Button>
                </span>
              </TooltipTrigger>
              {!isLocked && existingQuote?.status !== 'revision_requested' && (
                <TooltipContent>
                  <p>{t(
                    'Skapa BOM-revision först efter att en offert har skickats till kunden.',
                    'Create BOM revision only after a quote has been sent to the customer.'
                  )}</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          {/* Main Content - Items Table (scope only) */}
          <div className="lg:col-span-2">
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs uppercase">SKU</TableHead>
                    <TableHead className="text-xs uppercase">{t('Produktnamn', 'Product Name')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Antal', 'Qty')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Offererat', 'Quoted')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Fakturerat', 'Invoiced')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Återstår', 'Remaining')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Status', 'Status')}</TableHead>
                    <TableHead className="text-xs uppercase text-right">{t('Kostnad ex', 'Cost ex')}</TableHead>
                    {!isLocked && <TableHead></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={isLocked ? 8 : 9} className="text-center py-8 text-muted-foreground">
                        {t('Lägg till SKUs för att börja bygga din BOM', 'Add SKUs to start building your BOM')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map(item => {
                      const qty = localQuantities[item.id] ?? item.quantity;
                      const unitCostEx = item.cost_ex_vat_at_time ?? 0;
                      const costEx = unitCostEx * qty;
                      const f = fulfillment?.get(item.sku_id);
                      const invoiced = f?.invoiced_quantity ?? 0;
                      const quoted = f?.quoted_quantity ?? 0;
                      const remaining = remainingToInvoice(item.quantity, invoiced);
                      const status = FULFILLMENT_BADGE[getFulfillmentStatus(invoiced, item.quantity)];

                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-mono">{item.sku.sku}</TableCell>
                          <TableCell>{item.sku.name}</TableCell>
                          <TableCell className="text-center">
                            {isLocked ? (
                              <span className="text-sm">{item.quantity}</span>
                            ) : (
                              <QuantityInput
                                value={localQuantities[item.id] ?? item.quantity}
                                onCommit={(qty) => handleLocalQuantityChange(item.id, qty)}
                                className="w-16 text-center mx-auto"
                              />
                            )}
                          </TableCell>
                          <TableCell className="text-center text-muted-foreground">{quoted}</TableCell>
                          <TableCell className="text-center">{invoiced}</TableCell>
                          <TableCell className="text-center font-medium">{remaining}</TableCell>
                          <TableCell className="text-center">
                            <Badge variant="outline" className={status.className}>{t(status.label.sv, status.label.en)}</Badge>
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {costEx ? `${formatPrice(costEx)} kr` : '—'}
                          </TableCell>
                          {!isLocked && (
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => deleteItemMutation.mutate(item.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </Card>
          </div>

          {/* Summary Sidebar (scope only) */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>{t('Sammanfattning', 'Summary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Antal SKUs', 'SKU count')}:</span>
                    <span>{items.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Totalt antal enheter', 'Total units')}:</span>
                    <span>{totals.items}</span>
                  </div>
                </div>

                <div className="border-t border-border pt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Fullt fakturerade artiklar', 'Items fully invoiced')}:</span>
                    <span>{fulfillmentSummary.fullyInvoiced} / {items.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Enheter kvar att fakturera', 'Units left to invoice')}:</span>
                    <span className="font-medium">{fulfillmentSummary.unitsRemaining}</span>
                  </div>
                </div>

                <div className="border-t border-border pt-4 flex justify-between">
                  <span className="text-muted-foreground">{t('Total kostnad (ex moms)', 'Total cost (ex VAT)')}:</span>
                  <span className="font-medium">{formatPrice(totals.costEx)} kr</span>
                </div>
              </CardContent>
            </Card>

            {existingQuote ? (
              <Button 
                className="w-full" 
                size="lg" 
                onClick={() => navigate(`/portal/quotes/${existingQuote.id}`)}
              >
                <FileText className="h-4 w-4 mr-2" />
                {t('Gå till offert', 'Go to offer')}
              </Button>
            ) : (
              <Button
                data-testid="bom-create-quote-button"
                className="w-full"
                size="lg"
                onClick={createQuote}
                disabled={items.length === 0 || hasUnsavedChanges || isLocked}
              >
                <FileText className="h-4 w-4 mr-2" />
                {t('Skapa offert från BOM', 'Create quote from BOM')}
              </Button>
            )}

            <div className="space-y-1">
              <Button
                data-testid="bom-create-invoice-button"
                variant="outline"
                className="w-full"
                size="lg"
                onClick={createInvoiceFromBOM}
                disabled={items.length === 0 || hasUnsavedChanges || isCreatingInvoice || fulfillmentSummary.unitsRemaining === 0}
              >
                <Receipt className="h-4 w-4 mr-2" />
                {isCreatingInvoice
                  ? t('Skapar...', 'Creating...')
                  : t('Skapa faktura från BOM', 'Create invoice from BOM')}
              </Button>
              {items.length > 0 && fulfillmentSummary.unitsRemaining === 0 && (
                <p className="text-xs text-muted-foreground text-center">
                  {t('Alla BOM-artiklar har redan fakturerats.', 'All BOM items have already been invoiced.')}
                </p>
              )}
            </div>

            <Button
              data-testid="bom-save-button"
              className="w-full bg-[#F6C573] text-foreground hover:bg-[#E5B463] disabled:bg-[#E8DCC4] disabled:text-muted-foreground"
              size="lg"
              onClick={handleSaveChanges}
              disabled={!hasUnsavedChanges || isSaving || isLocked}
            >
              <Save className="h-4 w-4 mr-2" />
              {isSaving ? t('Sparar...', 'Saving...') : t('Spara ändringar', 'Save changes')}
            </Button>
          </div>
        </div>
      </div>

      {/* SKU Selector */}
      <SKUSelector
        open={isSKUSelectorOpen}
        onOpenChange={setIsSKUSelectorOpen}
        onSelect={(skuId, quantity) => addItemMutation.mutate({ sku_id: skuId, quantity })}
        onRemove={(skuId) => {
          const item = items.find(i => i.sku_id === skuId);
          if (item) deleteItemMutation.mutate(item.id);
        }}
        onQuantityChange={(skuId, quantity) => {
          addItemMutation.mutate({ sku_id: skuId, quantity });
        }}
        existingSkuIds={items.map(i => i.sku_id)}
        existingQuantities={Object.fromEntries(items.map(i => [i.sku_id, localQuantities[i.id] ?? i.quantity]))}
      />

      {/* Template Selector */}
      <TemplateSelector
        open={isTemplateSelectorOpen}
        onOpenChange={setIsTemplateSelectorOpen}
        onSelect={handleAddFromTemplate}
      />

      {/* New BOM Revision Dialog with Reason Form */}
      <Dialog open={isRevisionDialogOpen} onOpenChange={setIsRevisionDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Skapa ny BOM-revision', 'Create new BOM revision')}</DialogTitle>
            <DialogDescription>
              {t(
                'En ny version (v' + ((bom?.version ?? 1) + 1) + ') skapas med alla nuvarande artiklar. Den nuvarande versionen (v' + (bom?.version ?? 1) + ') behålls som historik.',
                'A new version (v' + ((bom?.version ?? 1) + 1) + ') will be created with all current items. The current version (v' + (bom?.version ?? 1) + ') will be kept as history.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('Anledning till revision *', 'Reason for revision *')}</Label>
              <Select value={revisionReasonType} onValueChange={setRevisionReasonType}>
                <SelectTrigger data-testid="bom-revision-reason-trigger">
                  <SelectValue placeholder={t('Välj anledning...', 'Select reason...')} />
                </SelectTrigger>
                <SelectContent>
                  {REVISION_REASON_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {t(opt.label.sv, opt.label.en)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('Anteckning (valfritt)', 'Note (optional)')}</Label>
              <Textarea
                value={revisionReasonNote}
                onChange={(e) => setRevisionReasonNote(e.target.value)}
                placeholder={t('Beskriv ändringen...', 'Describe the change...')}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRevisionDialogOpen(false)}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button
              data-testid="bom-create-revision-submit-button"
              onClick={() => createRevisionMutation.mutate({ reasonType: revisionReasonType, reasonNote: revisionReasonNote })}
              disabled={!revisionReasonType || createRevisionMutation.isPending}
            >
              {createRevisionMutation.isPending
                ? t('Skapar...', 'Creating...')
                : t('Skapa revision', 'Create revision')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default BOMBuilder;
