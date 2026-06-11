import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { getDefaultInvoiceDueDate } from '@/lib/swedish-banking-days';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import BlurCommitInput from '@/components/ui/blur-commit-input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Send, Eye, Plus, Trash2, Loader2, Info, Link as LinkIcon, Package, Lock } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import SKUSelector from '@/components/portal/boms/SKUSelector';
import { useInvoiceBomRevision } from '@/hooks/use-invoice-bom-revision';
import { getEdgeFunctionErrorMessage } from '@/lib/edge-function-error';
import { getAuthenticatedFunctionHeaders } from '@/lib/supabase-function-auth';

interface LineItem {
  id?: string;
  line_type: 'hardware' | 'labor' | 'travel_other';
  description: string;
  sku?: string;
  sku_id?: string;
  quantity: number;
  unit_price: number;
  unit?: string;
  tax_rate: number;
  category?: string;
  sort_order: number;
}

interface Invoice {
  id: string;
  invoice_number: string | null;
  customer_id: string | null;
  bom_id: string | null;
  bom_version: number | null;
  quote_id: string | null;
  quote_number: string | null;
  status: string;
  is_test: boolean;
  due_date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  customer?: { id: string; name: string | null; billing_email?: string | null } | null;
  bom?: { id: string; project_name: string; version: number } | null;
}

const InvoiceDraftEditor: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  
  const invoiceId = searchParams.get('id');
  const fromQuoteId = searchParams.get('fromQuote');
  const fromBomId = searchParams.get('fromBom');

  const [isCreating, setIsCreating] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedBomId, setSelectedBomId] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string>(() => getDefaultInvoiceDueDate());
  const [isTest, setIsTest] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [isSKUSelectorOpen, setIsSKUSelectorOpen] = useState(false);

  // Fetch existing invoice if editing
  // staleTime: 0 ensures we always refetch on mount/focus to defeat bfcache staleness
  const { data: existingInvoice, isLoading: invoiceLoading } = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: async () => {
      if (!invoiceId) return null;
      const { data, error } = await supabase
        .from('invoices')
        .select('*, customer:customers_with_identity!invoices_customer_id_fkey(id, name, billing_email), bom:boms(id, project_name, version)')
        .eq('id', invoiceId)
        .single();
      if (error) throw error;

      // Fetch computed totals
      const { data: computed } = await supabase
        .from('invoice_computed_totals')
        .select('*')
        .eq('invoice_id', data.id)
        .maybeSingle();

      return {
        ...data,
        subtotal: computed?.subtotal ?? 0,
        tax: computed?.tax ?? 0,
        total: computed?.total ?? 0,
      } as Invoice;
    },
    enabled: !!invoiceId && isStaff,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // BOM revision hook
  const activeBomId = existingInvoice?.bom_id || selectedBomId;
  const bomRevision = useInvoiceBomRevision({
    invoiceId: invoiceId,
    bomId: activeBomId,
  });

  // Fetch line items for existing invoice
  // staleTime: 0 ensures we always refetch on mount/focus to defeat bfcache staleness
  const { data: existingLineItems, isFetched: lineItemsFetched, dataUpdatedAt } = useQuery({
    queryKey: ['invoice_line_items', invoiceId],
    queryFn: async () => {
      if (!invoiceId) return [];
      const { data, error } = await supabase
        .from('invoice_line_items')
        .select('*')
        .eq('invoice_id', invoiceId)
        .order('sort_order');
      if (error) throw error;
      return data as LineItem[];
    },
    enabled: !!invoiceId && isStaff,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // Fetch customers for selection
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

  // Fetch BOMs for selection
  const { data: boms = [] } = useQuery({
    queryKey: ['boms'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boms')
        .select('id, project_name, version, customer_id')
        .order('project_name');
      if (error) throw error;
      return data;
    },
    enabled: isStaff,
  });

  // Fetch BOM items when a BOM is selected
  const { data: bomItems } = useQuery({
    queryKey: ['bom_items_for_invoice', activeBomId],
    queryFn: async () => {
      if (!activeBomId) return [];
      const { data, error } = await supabase
        .from('bom_items')
        .select(`
          id,
          sku_id,
          quantity,
          cost_ex_vat_at_time,
          skus!bom_items_sku_id_fkey(sku, name, sell_price_ex_vat, vat_rate)
        `)
        .eq('bom_id', activeBomId);
      if (error) throw error;
      return data;
    },
    enabled: !!activeBomId && isStaff,
  });

  // Populate line items when BOM items are loaded (for new invoices only)
  useEffect(() => {
    if (bomItems && bomItems.length > 0 && !invoiceId) {
      const hardwareItems: LineItem[] = bomItems.map((item, idx) => {
        const sku = item.skus as { sku: string; name: string; sell_price_ex_vat: number | null; vat_rate: number } | null;
        const unitPrice = sku?.sell_price_ex_vat ?? 0;
        const vatRateRaw = sku?.vat_rate;
        const vatRatePct = vatRateRaw == null ? 25 : vatRateRaw <= 1 ? vatRateRaw * 100 : vatRateRaw;
        return {
          id: crypto.randomUUID(),
          line_type: 'hardware' as const,
          description: sku?.name || 'Unknown product',
          sku: sku?.sku || '',
          sku_id: item.sku_id,
          quantity: item.quantity,
          unit_price: unitPrice,
          tax_rate: vatRatePct,
          sort_order: idx,
        };
      });
      // Keep existing labor/travel items, replace hardware
      setLineItems(prev => [
        ...hardwareItems,
        ...prev.filter(i => i.line_type !== 'hardware'),
      ]);
    }
  }, [bomItems, invoiceId]);

  // Initialize state from existing invoice
  useEffect(() => {
    if (existingInvoice) {
      setSelectedCustomerId(existingInvoice.customer_id);
      setSelectedBomId(existingInvoice.bom_id);
      setDueDate(existingInvoice.due_date || getDefaultInvoiceDueDate());
      setIsTest(existingInvoice.is_test);
    }
  }, [existingInvoice]);

  // Hydrate line items from DB once per invoice (prevents auto-save from wiping rows on load)
  const initialLoadComplete = useRef(false);
  const lastHydratedAtRef = useRef<number>(0);
  const lastSavedIdsRef = useRef<string[]>([]);
  const restoredHardwareFromBomRef = useRef(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const skipNextAutosaveRef = useRef(false);
  const lineItemsRef = useRef<LineItem[]>([]);
  const deletedRef = useRef(false);

  // Always keep a ref to the latest lineItems so we can safely flush pending saves on navigation/unmount.
  useEffect(() => {
    lineItemsRef.current = lineItems;
  }, [lineItems]);

  useEffect(() => {
    // Reset refs when switching invoice
    initialLoadComplete.current = false;
    lastHydratedAtRef.current = 0;
    restoredHardwareFromBomRef.current = false;
    lastSavedIdsRef.current = [];
  }, [invoiceId]);

  // Re-hydrate local state whenever React Query fetches fresh data.
  useEffect(() => {
    if (!invoiceId) return;
    if (!lineItemsFetched) return;
    if (dataUpdatedAt <= lastHydratedAtRef.current) return;

    const items = (existingLineItems ?? []) as LineItem[];

    skipNextAutosaveRef.current = true;
    setLineItems(items);
    lastSavedIdsRef.current = items.map((i) => i.id).filter(Boolean) as string[];
    lastHydratedAtRef.current = dataUpdatedAt;
    initialLoadComplete.current = true;
  }, [invoiceId, lineItemsFetched, existingLineItems, dataUpdatedAt]);

  // Initialize from query params
  useEffect(() => {
    if (fromBomId && !invoiceId) {
      setSelectedBomId(fromBomId);
      const bom = boms.find(b => b.id === fromBomId);
      if (bom) {
        setSelectedCustomerId(bom.customer_id);
      }
    }
  }, [fromBomId, boms, invoiceId]);

  // Calculate totals
  const totals = useMemo(() => {
    const hardware = lineItems
      .filter(i => i.line_type === 'hardware')
      .reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const labor = lineItems
      .filter(i => i.line_type === 'labor')
      .reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const other = lineItems
      .filter(i => i.line_type === 'travel_other')
      .reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const subtotal = hardware + labor + other;
    const tax = subtotal * 0.25;
    return { hardware, labor, other, subtotal, tax, total: subtotal + tax };
  }, [lineItems]);

  // Create draft invoice
  const createDraftMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCustomerId) throw new Error('Customer is required');
      
      const { data, error, response } = await supabase.functions.invoke('create-draft-invoice', {
        headers: await getAuthenticatedFunctionHeaders(),
        body: {
          customer_id: selectedCustomerId,
          bom_id: selectedBomId,
          quote_id: fromQuoteId,
          due_date: dueDate || null,
          is_test: isTest,
          line_items: lineItems,
        },
      });
      if (error) throw new Error(await getEdgeFunctionErrorMessage(error, response));
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({ title: t('Fakturautkast skapat', 'Invoice draft created') });
      navigate(`/portal/invoices/new?id=${data.invoice_id}`, { replace: true });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (error: Error) => {
      toast({ 
        title: t('Kunde inte skapa faktura', 'Failed to create invoice'),
        description: error.message,
        variant: 'destructive'
      });
    },
  });

  // Save line items locally
  const syncLinesMutation = useMutation({
    mutationFn: async () => {
      if (!invoiceId) throw new Error('No invoice ID');

      await supabase.from('invoice_line_items').delete().eq('invoice_id', invoiceId);
      if (lineItems.length > 0) {
        const { error } = await supabase.from('invoice_line_items').insert(
          lineItems.map((item, idx) => {
            const existingCreatedAt = (item as LineItem & { created_at?: string | null }).created_at;
            return {
              id: item.id ?? crypto.randomUUID(),
              invoice_id: invoiceId,
              line_type: item.line_type,
              description: item.description,
              sku: item.sku ?? null,
              sku_id: item.sku_id ?? null,
              quantity: item.quantity,
              unit_price: item.unit_price,
              unit: item.unit ?? null,
              tax_rate: item.tax_rate,
              category: item.category ?? null,
              sort_order: idx,
              created_at: existingCreatedAt ?? new Date().toISOString(),
            };
          })
        );
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast({ title: t('Rader synkroniserade', 'Lines synced') });
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    },
    onError: (error: Error) => {
      toast({ 
        title: t('Synkronisering misslyckades', 'Sync failed'),
        description: error.message,
        variant: 'destructive'
      });
    },
  });

  // Finalize invoice
  const finalizeMutation = useMutation({
    mutationFn: async () => {
      if (!invoiceId) throw new Error('No invoice ID');
      
      // First sync lines
      await syncLinesMutation.mutateAsync();

      // Then finalize
      const { data, error, response } = await supabase.functions.invoke('finalize-new-invoice', {
        headers: await getAuthenticatedFunctionHeaders(),
        body: { invoice_id: invoiceId },
      });
      if (error) throw new Error(await getEdgeFunctionErrorMessage(error, response));
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({ title: t('Faktura fastställd!', 'Invoice finalized!') });
      navigate(`/portal/invoices/${data.invoice_number}`, { replace: true });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (error: Error) => {
      toast({ 
        title: t('Kunde inte fastställa faktura', 'Failed to finalize invoice'),
        description: error.message,
        variant: 'destructive'
      });
    },
  });

  // Update due date mutation
  const updateDueDateMutation = useMutation({
    mutationFn: async (newDueDate: string) => {
      if (!invoiceId) return;
      const { error } = await supabase
        .from('invoices')
        .update({ due_date: newDueDate || null })
        .eq('id', invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Kunde inte spara förfallodatum', 'Failed to save due date'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Save line items mutation (for auto-save)
  const saveLineItemsMutation = useMutation({
    mutationFn: async (items: LineItem[]) => {
      if (!invoiceId || deletedRef.current) return;

      const normalized = items.map((item, idx) => {
        const id = item.id ?? crypto.randomUUID();
        return {
          id,
          invoice_id: invoiceId,
          line_type: item.line_type,
          description: item.description,
          sku: item.sku ?? null,
          sku_id: item.sku_id ?? null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          unit: item.unit ?? null,
          tax_rate: item.tax_rate,
          category: item.category ?? null,
          sort_order: idx,
          created_at: new Date().toISOString(),
        };
      });

      const newIds = normalized.map((i) => i.id);
      const removedIds = lastSavedIdsRef.current.filter((id) => !newIds.includes(id));

      if (normalized.length > 0) {
        const { error } = await supabase
          .from('invoice_line_items')
          .upsert(normalized, { onConflict: 'id', ignoreDuplicates: false });
        if (error) throw error;
      }

      if (removedIds.length > 0) {
        const { error } = await supabase
          .from('invoice_line_items')
          .delete()
          .eq('invoice_id', invoiceId)
          .in('id', removedIds);
        if (error) throw error;
      }

      lastSavedIdsRef.current = newIds;
    },
    onError: (error: Error) => {
      toast({
        title: t('Kunde inte spara rader', 'Failed to save lines'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // If this invoice is linked to a BOM but hardware rows are missing, restore them from the BOM.
  useEffect(() => {
    if (!invoiceId) return;
    if (!existingInvoice?.bom_id) return;
    if (existingInvoice.status !== 'draft') return;
    if (!initialLoadComplete.current) return;
    if (restoredHardwareFromBomRef.current) return;
    if (!bomItems || bomItems.length === 0) return;

    const hasHardware = lineItems.some((i) => i.line_type === 'hardware');
    if (hasHardware) return;

    restoredHardwareFromBomRef.current = true;

    const hardwareItems: LineItem[] = bomItems.map((item, idx) => {
      const sku = item.skus as { sku: string; name: string; sell_price_ex_vat: number | null; vat_rate: number } | null;
      const unitPrice = sku?.sell_price_ex_vat ?? 0;
      const vatRateRaw = sku?.vat_rate;
      const vatRatePct = vatRateRaw == null ? 25 : vatRateRaw <= 1 ? vatRateRaw * 100 : vatRateRaw;
      return {
        id: crypto.randomUUID(),
        line_type: 'hardware' as const,
        description: sku?.name || 'Unknown product',
        sku: sku?.sku || '',
        sku_id: item.sku_id,
        quantity: item.quantity,
        unit_price: unitPrice,
        tax_rate: vatRatePct,
        sort_order: idx,
      };
    });

    const updated: LineItem[] = [
      ...hardwareItems,
      ...lineItems.filter((i) => i.line_type !== 'hardware'),
    ];

    setLineItems(updated);
    saveLineItemsMutation.mutate(updated);
  }, [
    invoiceId,
    existingInvoice?.bom_id,
    existingInvoice?.status,
    bomItems,
    lineItems,
    saveLineItemsMutation,
  ]);

  // Auto-save line items when they change (debounced)
  useEffect(() => {
    if (!invoiceId || !initialLoadComplete.current || deletedRef.current) return;

    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      saveLineItemsMutation.mutate(lineItemsRef.current);
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [lineItems, invoiceId, saveLineItemsMutation]);

  // Flush pending saves on unmount
  useEffect(() => {
    return () => {
      if (!invoiceId || !initialLoadComplete.current || deletedRef.current) return;
      if (!saveTimeoutRef.current) return;

      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
      saveLineItemsMutation.mutate(lineItemsRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  // Handle due date change with auto-save
  const handleDueDateChange = useCallback((newValue: string) => {
    setDueDate(newValue);
    if (invoiceId) {
      updateDueDateMutation.mutate(newValue);
    }
  }, [invoiceId, updateDueDateMutation]);

  // Add line item
  const addLineItem = (type: 'hardware' | 'labor' | 'travel_other') => {
    const defaults = 
      type === 'labor' ? { description: 'Installation', unit_price: 850 }
      : type === 'travel_other' ? { description: 'Resa', unit_price: 500 }
      : { description: '', unit_price: 0 };
    
    setLineItems(prev => [...prev, {
      id: crypto.randomUUID(),
      line_type: type,
      description: defaults.description,
      quantity: 1,
      unit_price: defaults.unit_price,
      tax_rate: 25,
      sort_order: prev.length,
    }]);
  };

  // Handle SKU selection from picker
  const handleSkuSelect = async (skuId: string, quantity: number) => {
    // Fetch SKU data
    const { data: skuData, error } = await supabase
      .from('skus')
      .select('sku, name, sell_price_ex_vat, vat_rate')
      .eq('id', skuId)
      .single();
    if (error || !skuData) {
      toast({ title: t('Kunde inte hämta SKU', 'Failed to fetch SKU'), variant: 'destructive' });
      return;
    }

    const unitPrice = skuData.sell_price_ex_vat ?? 0;
    const vatRateRaw = skuData.vat_rate;
    const vatRatePct = vatRateRaw == null ? 25 : vatRateRaw <= 1 ? vatRateRaw * 100 : vatRateRaw;

    // Add to invoice line items immediately
    setLineItems(prev => [...prev, {
      id: crypto.randomUUID(),
      line_type: 'hardware' as const,
      description: skuData.name,
      sku: skuData.sku,
      sku_id: skuId,
      quantity,
      unit_price: unitPrice,
      tax_rate: vatRatePct,
      sort_order: prev.length,
    }]);

    // Trigger BOM revision logic
    await bomRevision.handleSkuAddedFromInvoice(skuId, quantity, skuData);

    setIsSKUSelectorOpen(false);
  };

  // Update line item — sync quantity changes to BOM for hardware items
  const updateLineItem = (index: number, updates: Partial<LineItem>) => {
    setLineItems(prev => {
      const updated = prev.map((item, i) => i === index ? { ...item, ...updates } : item);

      // If quantity changed on a hardware line with a sku_id, sync to BOM
      if ('quantity' in updates) {
        const item = updated[index];
        if (item.line_type === 'hardware' && item.sku_id && activeBomId) {
          const allHw = updated
            .filter(i => i.line_type === 'hardware' && i.sku_id)
            .map(i => ({ sku_id: i.sku_id!, quantity: i.quantity }));
          bomRevision.syncQuantityToBom(item.sku_id, updates.quantity!, allHw);
        }
      }

      return updated;
    });
  };

  // Remove line item
  const removeLineItem = (index: number) => {
    const removedItem = lineItems[index];
    const next = lineItems.filter((_, i) => i !== index);
    skipNextAutosaveRef.current = true;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    setLineItems(next);

    // If removing a hardware line with a sku_id, sync removal to BOM
    if (removedItem.line_type === 'hardware' && removedItem.sku_id && activeBomId) {
      bomRevision.handleSkuRemovedFromInvoice(removedItem.sku_id);
    }

    if (invoiceId && initialLoadComplete.current) {
      saveLineItemsMutation.mutate(next);
    }
  };

  const formatPrice = (value: number) => {
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  if (invoiceLoading) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  const customer = existingInvoice?.customer || customers.find(c => c.id === selectedCustomerId);
  const bom = existingInvoice?.bom || boms.find(b => b.id === selectedBomId);
  const originalBomVersion = existingInvoice?.bom_version ?? bom?.version;
  const currentBomVersion = bomRevision.latestVersion?.version ?? originalBomVersion;
  const existingHardwareSkuIds = lineItems
    .filter(i => i.line_type === 'hardware' && i.sku_id)
    .map(i => i.sku_id!);

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('Fakturaförberedelse', 'Invoice Preparation')}</h1>
          <p className="text-muted-foreground">
            {t('Organisera och granska faktura innan den fastställs och skickas till kund', 'Organize and review invoice before it is finalized and sent to customer')}
          </p>
          {customer && (
            <div className="flex flex-wrap items-center gap-4 mt-2 text-sm">
              <span>
                <span className="text-muted-foreground">{t('Kund:', 'Customer:')}</span>{' '}
                <strong>{customer.name}</strong>
              </span>
              <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>
              {isTest && <Badge variant="outline">Test</Badge>}
              {bom && (
                <span>
                  <span className="text-muted-foreground">{t('Projekt:', 'Project:')}</span>{' '}
                  <strong>{bom.project_name}</strong>
                </span>
              )}
              {existingInvoice?.quote_number && (
                <span>
                  <span className="text-muted-foreground">{t('Från offert:', 'From quote:')}</span>{' '}
                   <Link to={`/portal/quotes/${existingInvoice.quote_id}`} className="text-primary hover:underline">
                    {existingInvoice.quote_number}
                  </Link>
                </span>
              )}
              {/* BOM metadata — moved from Hardware card */}
              {originalBomVersion && (
                <span>
                  <span className="text-muted-foreground">{t('Baserad på BOM:', 'Based on BOM:')}</span>{' '}
                  <strong>#{originalBomVersion}</strong>
                </span>
              )}
              {currentBomVersion && currentBomVersion !== originalBomVersion && (
                <span className="flex items-center gap-1">
                  <span className="text-muted-foreground">{t('Aktuell BOM:', 'Current BOM:')}</span>{' '}
                  <strong>#{currentBomVersion}</strong>
                </span>
              )}
              {bom && (
                <Link to={`/portal/boms/${bomRevision.latestVersion?.id || bom.id}`} className="text-primary hover:underline flex items-center gap-1">
                  <LinkIcon className="h-3 w-3" />
                  {t('Visa BOM', 'View BOM')}
                </Link>
              )}
            </div>
          )}
        </div>

        {/* Main content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left side - Line items */}
          <div className="lg:col-span-2 space-y-6">
            {/* Customer/BOM selection (only if no invoice exists yet) */}
            {!invoiceId && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">{t('Grunduppgifter', 'Basic information')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label>{t('Kund', 'Customer')} *</Label>
                    <Select value={selectedCustomerId || ''} onValueChange={setSelectedCustomerId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('Välj kund...', 'Select customer...')} />
                      </SelectTrigger>
                      <SelectContent>
                        {customers.map(c => (
                          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>{t('Materiallista (valfritt)', 'BOM (optional)')}</Label>
                    <Select 
                      value={selectedBomId || 'none'} 
                      onValueChange={(val) => setSelectedBomId(val === 'none' ? null : val)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('Välj BOM...', 'Select BOM...')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t('Ingen', 'None')}</SelectItem>
                        {boms.filter(b => !selectedCustomerId || b.customer_id === selectedCustomerId).map(b => (
                          <SelectItem key={b.id} value={b.id}>{b.project_name} (v{b.version})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Hardware section */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">
                  {t('Hårdvara', 'Hardware')}
                </CardTitle>
                <div className="flex gap-2">
                  {invoiceId && (
                    <Button variant="outline" size="sm" onClick={() => setIsSKUSelectorOpen(true)}>
                      <Package className="h-4 w-4 mr-1" />
                      {t('Lägg till SKU', 'Add SKU')}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => addLineItem('hardware')}>
                    <Plus className="h-4 w-4 mr-1" />
                    {t('Lägg till rad', 'Add row')}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase">{t('PRODUKT', 'PRODUCT')}</TableHead>
                      <TableHead className="text-xs uppercase">{t('SKU', 'SKU')}</TableHead>
                      <TableHead className="text-xs uppercase w-24">{t('ANTAL', 'QTY')}</TableHead>
                      <TableHead className="text-xs uppercase w-28">{t('Å-PRIS', 'UNIT')}</TableHead>
                      <TableHead className="text-xs uppercase text-right">{t('SUMMA', 'TOTAL')}</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lineItems.filter(i => i.line_type === 'hardware').length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-4">
                          {t('Inga hårdvaruartiklar', 'No hardware items')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      lineItems.map((item, idx) => item.line_type === 'hardware' && (
                        <TableRow key={item.id || idx}>
                          <TableCell>
                            <BlurCommitInput 
                              value={item.description}
                              onCommit={(val) => updateLineItem(idx, { description: val })}
                              placeholder={t('Produktnamn', 'Product name')}
                            />
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground font-mono">{item.sku || '—'}</span>
                          </TableCell>
                          <TableCell>
                            <BlurCommitInput 
                              type="number"
                              value={item.quantity}
                              onCommit={(val) => updateLineItem(idx, { quantity: parseFloat(val) || 1 })}
                              className="w-20"
                            />
                          </TableCell>
                          <TableCell>
                            <BlurCommitInput 
                              type="number"
                              value={item.unit_price}
                              onCommit={(val) => updateLineItem(idx, { unit_price: parseFloat(val) || 0 })}
                              className="w-24"
                            />
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatPrice(item.quantity * item.unit_price)}
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon" onClick={() => removeLineItem(idx)}>
                              <Trash2 className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                <div className="flex justify-end mt-4 text-sm">
                  <span className="text-muted-foreground mr-4">{t('Hårdvara delsumma:', 'Hardware subtotal:')}</span>
                  <span className="font-semibold">{formatPrice(totals.hardware)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Labor section */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">{t('Arbete', 'Labor')}</CardTitle>
                <Button variant="outline" size="sm" onClick={() => addLineItem('labor')}>
                  <Plus className="h-4 w-4 mr-1" />
                  {t('Lägg till rad', 'Add row')}
                </Button>
              </CardHeader>
              <CardContent>
                {lineItems.filter(i => i.line_type === 'labor').length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">{t('Inga arbetstimmar', 'No labor items')}</p>
                ) : (
                  <div className="space-y-2">
                    {lineItems.map((item, idx) => item.line_type === 'labor' && (
                      <div key={item.id || idx} className="flex items-center gap-3">
                        <BlurCommitInput 
                          className="flex-1"
                          value={item.description}
                          onCommit={(val) => updateLineItem(idx, { description: val })}
                          placeholder={t('Beskrivning', 'Description')}
                        />
                        <BlurCommitInput 
                          type="number"
                          value={item.quantity}
                          onCommit={(val) => updateLineItem(idx, { quantity: parseFloat(val) || 1 })}
                          className="w-20"
                        />
                        <span className="text-muted-foreground text-sm">{t('tim ×', 'hrs ×')}</span>
                        <BlurCommitInput 
                          type="number"
                          value={item.unit_price}
                          onCommit={(val) => updateLineItem(idx, { unit_price: parseFloat(val) || 0 })}
                          className="w-24"
                        />
                        <span className="text-muted-foreground text-sm">kr</span>
                        <span className="font-medium w-24 text-right">{formatPrice(item.quantity * item.unit_price)}</span>
                        <Button variant="ghost" size="icon" onClick={() => removeLineItem(idx)}>
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Travel/Other section */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">{t('Resa / Övrigt', 'Travel / Other')}</CardTitle>
                <Button variant="outline" size="sm" onClick={() => addLineItem('travel_other')}>
                  <Plus className="h-4 w-4 mr-1" />
                  {t('Lägg till rad', 'Add row')}
                </Button>
              </CardHeader>
              <CardContent>
                {lineItems.filter(i => i.line_type === 'travel_other').length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">{t('Inga övriga kostnader', 'No other costs')}</p>
                ) : (
                  <div className="space-y-2">
                    {lineItems.map((item, idx) => item.line_type === 'travel_other' && (
                      <div key={item.id || idx} className="flex items-center gap-3">
                        <BlurCommitInput 
                          className="flex-1"
                          value={item.description}
                          onCommit={(val) => updateLineItem(idx, { description: val })}
                          placeholder={t('Beskrivning', 'Description')}
                        />
                        <BlurCommitInput 
                          type="number"
                          value={item.quantity}
                          onCommit={(val) => updateLineItem(idx, { quantity: parseFloat(val) || 1 })}
                          className="w-20"
                        />
                        <span className="text-muted-foreground text-sm">×</span>
                        <BlurCommitInput 
                          type="number"
                          value={item.unit_price}
                          onCommit={(val) => updateLineItem(idx, { unit_price: parseFloat(val) || 0 })}
                          className="w-24"
                        />
                        <span className="text-muted-foreground text-sm">kr</span>
                        <span className="font-medium w-24 text-right">{formatPrice(item.quantity * item.unit_price)}</span>
                        <Button variant="ghost" size="icon" onClick={() => removeLineItem(idx)}>
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right side - Summary and actions */}
          <div className="space-y-6">
            {/* Summary card */}
            <Card>
              <CardHeader>
                <CardTitle>{t('Sammanfattning', 'Summary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Hårdvara:', 'Hardware:')}</span>
                  <span>{formatPrice(totals.hardware)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Arbete:', 'Labor:')}</span>
                  <span>{formatPrice(totals.labor)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Övrigt:', 'Other:')}</span>
                  <span>{formatPrice(totals.other)}</span>
                </div>
                <div className="border-t pt-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('Delsumma:', 'Subtotal:')}</span>
                    <span>{formatPrice(totals.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('Moms (25%):', 'VAT (25%):')}</span>
                    <span>{formatPrice(totals.tax)}</span>
                  </div>
                  <div className="flex justify-between text-lg font-bold mt-2">
                    <span>{t('Totalt:', 'Total:')}</span>
                    <span className="text-primary">{formatPrice(totals.total)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Invoice settings card */}
            <Card>
              <CardHeader>
                <CardTitle>{t('Fakturering', 'Invoicing')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <span className="text-sm text-muted-foreground">{t('Fakturanummer', 'Invoice number')}</span>
                  <p className="font-mono">—</p>
                  <p className="text-xs text-muted-foreground">{t('Tilldelas när fakturan fastställs', 'Assigned when invoice is finalized')}</p>
                </div>

                <div>
                  <Label htmlFor="due_date">{t('Förfallodatum', 'Due date')}</Label>
                  <Input 
                    id="due_date"
                    type="date"
                    value={dueDate}
                    onChange={(e) => handleDueDateChange(e.target.value)}
                  />
                </div>
                {/* Actions */}
                <div className="pt-4 space-y-2">
                  {!invoiceId ? (
                    <Button 
                      className="w-full"
                      onClick={() => createDraftMutation.mutate()}
                      disabled={!selectedCustomerId || createDraftMutation.isPending}
                    >
                      {createDraftMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {t('Skapa utkast', 'Create draft')}
                    </Button>
                  ) : (
                    <>
                      <Button 
                        data-testid="invoice-finalize-button"
                        className="w-full"
                        onClick={() => finalizeMutation.mutate()}
                        disabled={finalizeMutation.isPending || lineItems.length === 0}
                      >
                        {finalizeMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        <Send className="h-4 w-4 mr-2" />
                        {t('Fastställ faktura', 'Finalize invoice')}
                      </Button>
                      <Button 
                        variant="outline" 
                        className="w-full"
                        disabled={true}
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        {t('Förhandsgranska PDF', 'Preview PDF')}
                      </Button>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Info className="h-3 w-3" />
                        {t('PDF tillgänglig efter fastställd', 'PDF available after finalization')}
                      </p>
                      {existingInvoice?.status === 'draft' && (
                        <Button 
                          variant="destructive" 
                          className="w-full mt-4"
                          onClick={async () => {
                            if (!confirm(t('Är du säker på att du vill radera detta utkast?', 'Are you sure you want to delete this draft?'))) return;
                            deletedRef.current = true;
                            if (saveTimeoutRef.current) { clearTimeout(saveTimeoutRef.current); saveTimeoutRef.current = null; }
                            try {
                              await supabase.from('invoice_line_items').delete().eq('invoice_id', invoiceId!);
                              const { error } = await supabase.from('invoices').delete().eq('id', invoiceId!);
                              if (error) throw error;
                              toast({ title: t('Utkast raderat', 'Draft deleted') });
                              navigate('/portal/invoices');
                            } catch (err: any) {
                              toast({ title: t('Kunde inte radera', 'Could not delete'), description: err.message, variant: 'destructive' });
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          {t('Radera utkast', 'Delete draft')}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* SKU Selector Modal */}
      <SKUSelector
        open={isSKUSelectorOpen}
        onOpenChange={setIsSKUSelectorOpen}
        onSelect={handleSkuSelect}
        onRemove={(skuId) => {
          const idx = lineItems.findIndex(li => li.sku_id === skuId && li.line_type === 'hardware');
          if (idx !== -1) removeLineItem(idx);
        }}
        onQuantityChange={(skuId, quantity) => {
          const idx = lineItems.findIndex(li => li.sku_id === skuId && li.line_type === 'hardware');
          if (idx !== -1) updateLineItem(idx, { quantity });
        }}
        existingSkuIds={existingHardwareSkuIds}
        existingQuantities={Object.fromEntries(
          lineItems
            .filter(li => li.line_type === 'hardware' && li.sku_id)
            .map(li => [li.sku_id!, li.quantity])
        )}
      />

      {/* BOM Revision Confirmation Dialog */}
      <Dialog open={bomRevision.showRevisionDialog} onOpenChange={(open) => { if (!open) bomRevision.cancelRevision(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Skapa ny BOM-revision?', 'Create new BOM revision?')}</DialogTitle>
            <DialogDescription>
              {bomRevision.pendingAction?.type === 'remove_sku'
                ? t(
                    'Att ta bort denna artikel kräver en ny BOM-revision. Den nya revisionen kommer att exkludera artikeln.',
                    'Removing this item requires a new BOM revision. The new revision will exclude the item.'
                  )
                : bomRevision.pendingAction?.type === 'update_quantity'
                ? t(
                    'Att ändra antalet kräver en ny BOM-revision. Den nya revisionen kommer att spegla det uppdaterade antalet.',
                    'Changing the quantity requires a new BOM revision. The new revision will reflect the updated quantity.'
                  )
                : t(
                    'Att lägga till denna artikel skapar en ny redigerbar BOM-revision. BOM:en förblir redigerbar tills fakturan fastställs.',
                    'Adding this item will create a new editable BOM revision. The BOM will remain editable until the invoice is finalized.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={bomRevision.cancelRevision}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button onClick={bomRevision.confirmRevision} disabled={bomRevision.isCreatingRevision}>
              {bomRevision.isCreatingRevision && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Skapa revision och fortsätt', 'Create revision and continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default InvoiceDraftEditor;
