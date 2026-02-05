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
import { ArrowLeft, Plus, Trash2, FileText, Package, Pencil, Check, X, Copy, ScrollText, Save, Info } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import SKUSelector from '@/components/portal/boms/SKUSelector';
import TemplateSelector from '@/components/portal/boms/TemplateSelector';
import QuantityInput from '@/components/portal/boms/QuantityInput';

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
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ['bom', id] });
      const previous = queryClient.getQueryData(['bom', id]);
      // Optimistically update the cached BOM
      queryClient.setQueryData(['bom', id], (old: any) => old ? { ...old, ...updates } : old);
      return { previous };
    },
    onError: (error: any, _updates, context) => {
      // Roll back on error
      if (context?.previous) {
        queryClient.setQueryData(['bom', id], context.previous);
      }
      toast({ title: t('Kunde inte uppdatera BOM', 'Failed to update BOM'), description: error.message, variant: 'destructive' });
    },
    onSettled: () => {
      // Always refetch after mutation settles to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['bom', id] });
      queryClient.invalidateQueries({ queryKey: ['bom_quotes', id] });
      setIsEditingProject(false);
    },
    onSuccess: () => {
      toast({ title: t('BOM uppdaterad', 'BOM updated') });
    },
  });

  // Create new BOM version mutation
  const createNewVersionMutation = useMutation({
    mutationFn: async () => {
      const newVersion = (bom?.version ?? 1) + 1;

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

  // Add item mutation (scope only - just sku_id, quantity, cost reference)
  const addItemMutation = useMutation({
    mutationFn: async (data: { sku_id: string; quantity: number }) => {
      // Fetch SKU cost for internal reference
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

  // Create quote from BOM - fetches current SKU pricing at creation time
  const createQuote = async () => {
    try {
      const freshItems = items;

      // Fetch current SKU pricing for all items
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
        })
        .select()
        .single();
      if (error) throw error;

      // Create hardware quote_lines with current SKU pricing snapshot
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

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

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
              <Badge variant="outline" className="font-mono">
                BOM v{bom?.version || 1}
              </Badge>
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
                          {quote.quote_number ? `#${quote.quote_number}` : `v${quote.version}`}
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

        {/* Scope info note */}
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            {t(
              'BOM beskriver vad som ska installeras. Priser hanteras i offerten.',
              'BOM describes what will be installed. Prices are managed in the quote.'
            )}
          </AlertDescription>
        </Alert>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 mb-4">
          <Button onClick={() => setIsSKUSelectorOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('Lägg till SKU', 'Add SKU')}
          </Button>
          <Button variant="outline" onClick={() => setIsTemplateSelectorOpen(true)}>
            <Package className="h-4 w-4 mr-2" />
            {t('Lägg till från mall', 'Add from template')}
          </Button>
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
          {/* Main Content - Items Table (scope only) */}
          <div className="lg:col-span-2">
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs uppercase">SKU</TableHead>
                    <TableHead className="text-xs uppercase">{t('Produktnamn', 'Product Name')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Antal', 'Qty')}</TableHead>
                    <TableHead className="text-xs uppercase text-right">{t('Kostnad ex', 'Cost ex')}</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                        {t('Lägg till SKUs för att börja bygga din BOM', 'Add SKUs to start building your BOM')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map(item => {
                      const qty = localQuantities[item.id] ?? item.quantity;
                      const unitCostEx = item.cost_ex_vat_at_time ?? 0;
                      const costEx = unitCostEx * qty;
                      
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

                <div className="border-t border-border pt-4 flex justify-between">
                  <span className="text-muted-foreground">{t('Total kostnad (ex moms)', 'Total cost (ex VAT)')}:</span>
                  <span className="font-medium">{formatPrice(totals.costEx)} kr</span>
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
