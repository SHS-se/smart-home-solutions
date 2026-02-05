import React, { useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, Plus, Trash2, FileText, Package, Pencil, Check, X, Copy, BadgePlus, ScrollText, Save } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import SKUSelector from '@/components/portal/boms/SKUSelector';
import TemplateSelector from '@/components/portal/boms/TemplateSelector';
import QuantityInput from '@/components/portal/boms/QuantityInput';
import PricingRevisionDropdown from '@/components/portal/boms/PricingRevisionDropdown';
import { useBomPricingRevisions } from '@/hooks/use-bom-pricing-revisions';

interface BOMItem {
  id: string;
  sku_id: string;
  quantity: number;
  cost_ex_vat_at_time: number | null;
  sell_price_ex_vat_at_time: number | null;
  vat_rate_at_time: number | null;
  sell_price_inc_vat_at_time: number | null;
  pricing_source: string | null;
  // Legacy fields
  cost: number | null;
  sell_price: number | null;
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

const BOMBuilder: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isSKUSelectorOpen, setIsSKUSelectorOpen] = useState(false);
  const [isTemplateSelectorOpen, setIsTemplateSelectorOpen] = useState(false);
  const [isNewVersionDialogOpen, setIsNewVersionDialogOpen] = useState(false);
  const [isEditingProject, setIsEditingProject] = useState(false);
  const [editedProjectName, setEditedProjectName] = useState('');

  // Local state for unsaved quantity changes
  const [localQuantities, setLocalQuantities] = useState<Record<string, number>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Fetch BOM
  const { data: bom } = useQuery({
    queryKey: ['bom', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boms')
        .select('*, customers(name)')
        .eq('id', id)
        .single();
      if (error) throw error;
      return { ...data, customer: (data as any).customers };
    },
    enabled: isStaff && !!id,
  });

  // Fetch associated quotes (only active - not cancelled, not test)
  const { data: associatedQuotes = [] } = useQuery({
    queryKey: ['bom_quotes', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('id, quote_number, version, is_latest, status, is_test, created_at')
        .eq('bom_id', id)
        .eq('is_test', false)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: isStaff && !!id,
  });

  // Fetch BOM items with SKU pricing data
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

  // Pricing revisions hook
  const {
    revisions,
    latestRevision,
    createRevision,
    isCreatingRevision,
    revertRevision,
    isReverting,
    ensureRevisionExists,
  } = useBomPricingRevisions(id, t);

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

  // Update BOM mutation
  const updateBOMMutation = useMutation({
    mutationFn: async (updates: { project_name?: string; customer_id?: string | null }) => {
      const { error } = await supabase
        .from('boms')
        .update(updates)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bom', id] });
      setIsEditingProject(false);
      toast({ title: t('BOM uppdaterad', 'BOM updated') });
    },
    onError: (error: any) => {
      toast({ title: t('Kunde inte uppdatera BOM', 'Failed to update BOM'), description: error.message, variant: 'destructive' });
    },
  });

  // Create new BOM version mutation
  const createNewVersionMutation = useMutation({
    mutationFn: async () => {
      // Get the max version for this project
      const newVersion = (bom?.version ?? 1) + 1;

      // Create new BOM with incremented version
      const { data: newBom, error: bomError } = await supabase
        .from('boms')
        .insert({
          project_name: bom?.project_name,
          customer_id: bom?.customer_id,
          version: newVersion,
        })
        .select()
        .single();
      if (bomError) throw bomError;

      // Copy all items to new BOM
      if (items.length > 0) {
        const newItems = items.map(item => ({
          bom_id: newBom.id,
          sku_id: item.sku_id,
          quantity: item.quantity,
          cost_ex_vat_at_time: item.cost_ex_vat_at_time,
          sell_price_ex_vat_at_time: item.sell_price_ex_vat_at_time,
          vat_rate_at_time: item.vat_rate_at_time,
          sell_price_inc_vat_at_time: item.sell_price_inc_vat_at_time,
          pricing_source: item.pricing_source,
          cost: item.cost,
          sell_price: item.sell_price,
        }));

        const { error: itemsError } = await supabase
          .from('bom_items')
          .insert(newItems);
        if (itemsError) throw itemsError;
      }

      return newBom;
    },
    onSuccess: (newBom) => {
      setIsNewVersionDialogOpen(false);
      toast({ 
        title: t('Ny BOM-version skapad', 'New BOM version created'),
        description: `v${newBom.version}`
      });
      navigate(`/portal/boms/${newBom.id}`);
    },
    onError: (error: any) => {
      toast({ title: t('Kunde inte skapa ny version', 'Failed to create new version'), description: error.message, variant: 'destructive' });
    },
  });

  // Add item mutation with VAT-aware snapshot
  const addItemMutation = useMutation({
    mutationFn: async (data: { sku_id: string; quantity: number }) => {
      // Fetch SKU details with pricing
      const { data: sku, error: skuError } = await supabase
        .from('skus')
        .select('cost_ex_vat_computed, vat_rate, sell_price_ex_vat, sell_price_inc_vat')
        .eq('id', data.sku_id)
        .single();
      if (skuError) throw skuError;

      const { error } = await supabase.from('bom_items').upsert({
        bom_id: id,
        sku_id: data.sku_id,
        quantity: data.quantity,
        // Snapshot current pricing
        cost_ex_vat_at_time: sku.cost_ex_vat_computed,
        sell_price_ex_vat_at_time: sku.sell_price_ex_vat,
        vat_rate_at_time: sku.vat_rate,
        sell_price_inc_vat_at_time: sku.sell_price_inc_vat,
        pricing_source: 'sku',
        // Legacy fields for compatibility
        cost: sku.cost_ex_vat_computed,
        sell_price: sku.sell_price_ex_vat,
      }, { onConflict: 'bom_id,sku_id' });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bom_items', id] });
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
      // Wait for refetch to complete BEFORE clearing local state
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

  // Calculate totals using local quantities for live preview
  const totals = items.reduce(
    (acc, item) => {
      const qty = localQuantities[item.id] ?? item.quantity;
      const unitCostEx = item.cost_ex_vat_at_time ?? item.cost ?? 0;
      const unitSellEx = item.sell_price_ex_vat_at_time ?? item.sell_price ?? 0;
      const vatRate = item.vat_rate_at_time ?? 0.25;
      const unitSellInc = item.sell_price_inc_vat_at_time ?? unitSellEx * (1 + vatRate);
      
      const costEx = unitCostEx * qty;
      const sellEx = unitSellEx * qty;
      const sellInc = unitSellInc * qty;
      const vatAmount = sellInc - sellEx;
      
      return {
        costEx: acc.costEx + costEx,
        sellEx: acc.sellEx + sellEx,
        vatAmount: acc.vatAmount + vatAmount,
        sellInc: acc.sellInc + sellInc,
        margin: acc.margin + (sellEx - costEx),
        items: acc.items + qty,
      };
    },
    { costEx: 0, sellEx: 0, vatAmount: 0, sellInc: 0, margin: 0, items: 0 }
  );

  const marginPercent = totals.costEx > 0 ? ((totals.sellEx - totals.costEx) / totals.costEx) * 100 : 0;

  // Create quote from BOM - copies individual items as quote_lines snapshots
  const createQuote = async () => {
    try {
      // Use current items directly (no pending changes allowed when button is enabled)
      const freshItems = items;

      // Ensure a pricing revision exists (create r1 if none)
      const revision = await ensureRevisionExists(freshItems);

      const { data: quote, error } = await supabase
        .from('quotes')
        .insert({
          bom_id: id,
          bom_version: bom?.version ?? 1,
          bom_price_revision_id: revision.id,
          customer_id: bom?.customer_id || null,
          quote_number: '',
        })
        .select()
        .single();
      if (error) throw error;

      // Create individual hardware quote_lines for each BOM item (snapshot)
      // This ensures quote is independent of BOM - edits to quote don't mutate BOM
      const hardwareLines = freshItems.map(item => ({
        quote_id: quote.id,
        section: 'hardware',
        description: item.sku.name,
        quantity: item.quantity,
        unit_price: item.sell_price_ex_vat_at_time ?? item.sell_price ?? 0,
        unit_price_ex_vat: item.sell_price_ex_vat_at_time ?? item.sell_price ?? 0,
        vat_rate: item.vat_rate_at_time ?? 0.25,
        unit_price_inc_vat: item.sell_price_inc_vat_at_time ?? ((item.sell_price_ex_vat_at_time ?? item.sell_price ?? 0) * 1.25),
        sku_id: item.sku_id,
        original_sku_name: item.sku.name,
        original_sku_code: item.sku.sku,
        cost_ex_vat_at_time: item.cost_ex_vat_at_time ?? item.cost ?? 0,
        pricing_source: 'bom',
        source_bom_id: id,
        source_bom_item_id: item.id,
      }));

      if (hardwareLines.length > 0) {
        const { error: linesError } = await supabase.from('quote_lines').insert(hardwareLines);
        if (linesError) throw linesError;
      }

      navigate(`/portal/quotes/${quote.id}`);
    } catch (error: any) {
      toast({ title: t('Kunde inte skapa offert', 'Failed to create quote'), description: error.message, variant: 'destructive' });
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

  // Handle create pricing revision
  const handleCreatePricingRevision = () => {
    createRevision(items);
  };

  // Handle revert pricing revision
  const handleRevertRevision = (targetRevision: any) => {
    revertRevision({ targetRevision, currentBomItems: items });
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  // Get margin status
  const getMarginStatus = () => {
    if (marginPercent >= 40) return { label: 'Utmärkt', color: 'text-green-600' };
    if (marginPercent >= 25) return { label: 'Bra', color: 'text-primary' };
    if (marginPercent >= 15) return { label: 'OK', color: 'text-yellow-600' };
    return { label: 'Låg', color: 'text-destructive' };
  };

  const marginStatus = getMarginStatus();

  const formatPrice = (value: number) => value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <PortalLayout>
      <div className="space-y-6">
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
              {/* BOM Version Badge */}
              <Badge variant="outline" className="font-mono">
                BOM v{bom?.version || 1}
              </Badge>
              {/* Pricing Revision Dropdown */}
              <PricingRevisionDropdown
                revisions={revisions}
                latestRevision={latestRevision}
                onRevert={handleRevertRevision}
                isReverting={isReverting}
              />
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
                >
                  <SelectTrigger className="w-[200px] h-8 text-sm">
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
              
              {/* Project name - editable */}
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">{t('Projekt', 'Project')}:</span>
                {isEditingProject ? (
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
                      setEditedProjectName(bom?.project_name || '');
                      setIsEditingProject(true);
                    }}
                  >
                    <span>{bom?.project_name}</span>
                    <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                )}
              </div>
              
              {/* Associated Quotes */}
              {associatedQuotes.length > 0 && (
                <div className="flex items-center gap-2">
                  <ScrollText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground text-sm">{t('Offerter', 'Quotes')}:</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {associatedQuotes.map((quote) => (
                      <Link
                        key={quote.id}
                        to={`/portal/quotes/${quote.id}`}
                        className="inline-flex items-center gap-1"
                      >
                        <Badge 
                          variant={quote.is_latest ? "default" : "secondary"}
                          className="font-mono text-xs hover:bg-primary/80 cursor-pointer"
                        >
                          #{quote.quote_number}
                          {quote.version > 1 && ` v${quote.version}`}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Actions - outside grid for proper alignment */}
        <div className="flex flex-wrap gap-2 mb-4">
          <Button onClick={() => setIsSKUSelectorOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('Lägg till SKU', 'Add SKU')}
          </Button>
          <Button variant="outline" onClick={() => setIsTemplateSelectorOpen(true)}>
            <Package className="h-4 w-4 mr-2" />
            {t('Lägg till från mall', 'Add from template')}
          </Button>
          {items.length > 0 && (
            <Button 
              variant="outline" 
              onClick={handleCreatePricingRevision}
              disabled={isCreatingRevision}
            >
              <BadgePlus className="h-4 w-4 mr-2" />
              {t('Skapa ny prisrevision', 'Create new pricing revision')}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => setIsNewVersionDialogOpen(true)}
            disabled={createNewVersionMutation.isPending}
          >
            <Copy className="h-4 w-4 mr-2" />
            {t('Skapa ny BOM-revision', 'Create new BOM revision')}
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          {/* Main Content - Items Table */}
          <div className="lg:col-span-2">
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs uppercase">SKU</TableHead>
                    <TableHead className="text-xs uppercase">{t('Produktnamn', 'Product Name')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Antal', 'Qty')}</TableHead>
                    <TableHead className="text-xs uppercase text-right">{t('Kostnad ex', 'Cost ex')}</TableHead>
                    <TableHead className="text-xs uppercase text-right">{t('Sälj ex', 'Sell ex')}</TableHead>
                    <TableHead className="text-xs uppercase text-right">{t('Sälj inkl', 'Sell incl')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Marginal', 'Margin')}</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        {t('Lägg till SKUs för att börja bygga din BOM', 'Add SKUs to start building your BOM')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map(item => {
                      const qty = localQuantities[item.id] ?? item.quantity;
                      const unitCostEx = item.cost_ex_vat_at_time ?? item.cost ?? 0;
                      const unitSellEx = item.sell_price_ex_vat_at_time ?? item.sell_price ?? 0;
                      const unitSellInc = item.sell_price_inc_vat_at_time ?? unitSellEx * 1.25;
                      const costEx = unitCostEx * qty;
                      const sellEx = unitSellEx * qty;
                      const sellInc = unitSellInc * qty;
                      const marginPct = unitCostEx > 0 ? Math.round(((unitSellEx - unitCostEx) / unitCostEx) * 100) : null;
                      
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-mono">{item.sku.sku}</TableCell>
                          <TableCell>{item.sku.name}</TableCell>
                          <TableCell className="text-center">
                            <QuantityInput
                              value={localQuantities[item.id] ?? item.quantity}
                              onCommit={(qty) => handleLocalQuantityChange(item.id, qty)}
                              className="w-16 text-center mx-auto"
                            />
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {costEx ? `${formatPrice(costEx)} kr` : '—'}
                          </TableCell>
                          <TableCell className="text-right">
                            {sellEx ? `${formatPrice(sellEx)} kr` : '—'}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {sellInc ? `${formatPrice(sellInc)} kr` : '—'}
                          </TableCell>
                          <TableCell className="text-center">
                            <span className={marginPct && marginPct >= 25 ? 'text-primary' : 'text-muted-foreground'}>
                              {marginPct !== null ? `${marginPct}%` : '—'}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteItemMutation.mutate(item.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </Card>
          </div>

          {/* Summary Sidebar */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>{t('Sammanfattning', 'Summary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('Total kostnad (ex moms)', 'Total cost (ex VAT)')}:</span>
                  <span className="font-medium">{formatPrice(totals.costEx)} kr</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('Total säljpris (ex moms)', 'Total sell (ex VAT)')}:</span>
                  <span className="font-medium">{formatPrice(totals.sellEx)} kr</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('Moms (25%)', 'VAT (25%)')}:</span>
                  <span className="font-medium">{formatPrice(totals.vatAmount)} kr</span>
                </div>
                <div className="border-t border-border pt-4 flex justify-between">
                  <span className="font-medium">{t('Totalt (inkl moms)', 'Total (incl VAT)')}:</span>
                  <span className="text-xl font-bold text-primary">{formatPrice(totals.sellInc)} kr</span>
                </div>

                <div className="border-t border-border pt-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Marginal (kr)', 'Margin (kr)')}:</span>
                    <span className="font-medium text-primary">+{formatPrice(totals.margin)} kr</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Marginal (%)', 'Margin (%)')}:</span>
                    <span className="font-medium text-primary">{marginPercent.toFixed(1)}%</span>
                  </div>
                </div>

                <div className="border-t border-border pt-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-muted-foreground">{t('Marginal status', 'Margin status')}</span>
                    <span className={`font-medium ${marginStatus.color}`}>{marginStatus.label}</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div 
                      className="bg-primary h-2 rounded-full transition-all"
                      style={{ width: `${Math.min(100, marginPercent * 2)}%` }}
                    />
                  </div>
                </div>

                <div className="border-t border-border pt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Antal SKUs', 'SKU count')}:</span>
                    <span>{items.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Totalt antal enheter', 'Total units')}:</span>
                    <span>{totals.items}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Button 
              className="w-full" 
              size="lg" 
              onClick={createQuote}
              disabled={items.length === 0 || hasUnsavedChanges}
            >
              <FileText className="h-4 w-4 mr-2" />
              {t('Skapa offert från BOM', 'Create quote from BOM')}
            </Button>

            <Button 
              className="w-full bg-[#F6C573] text-foreground hover:bg-[#E5B463] disabled:bg-[#E8DCC4] disabled:text-muted-foreground"
              size="lg"
              onClick={handleSaveChanges}
              disabled={!hasUnsavedChanges || isSaving}
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
        existingSkuIds={items.map(i => i.sku_id)}
      />

      {/* Template Selector */}
      <TemplateSelector
        open={isTemplateSelectorOpen}
        onOpenChange={setIsTemplateSelectorOpen}
        onSelect={handleAddFromTemplate}
      />

      {/* New BOM Version Confirmation Dialog */}
      <AlertDialog open={isNewVersionDialogOpen} onOpenChange={setIsNewVersionDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Skapa ny BOM-revision?', 'Create new BOM revision?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Detta skapar en ny version av denna BOM (v' + ((bom?.version ?? 1) + 1) + '). Den nuvarande versionen (v' + (bom?.version ?? 1) + ') behålls som historik.',
                 'This will create a new version of this BOM (v' + ((bom?.version ?? 1) + 1) + '). The current version (v' + (bom?.version ?? 1) + ') will be kept as history.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Avbryt', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => createNewVersionMutation.mutate()}>
              {t('Skapa ny version', 'Create new version')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PortalLayout>
  );
};

export default BOMBuilder;
