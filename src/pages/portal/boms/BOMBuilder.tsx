import React, { useState } from 'react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, Plus, Trash2, FileText, Package } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import SKUSelector from '@/components/portal/boms/SKUSelector';
import TemplateSelector from '@/components/portal/boms/TemplateSelector';

interface BOMItem {
  id: string;
  sku_id: string;
  quantity: number;
  cost: number | null;
  sell_price: number | null;
  sku: {
    sku: string;
    name: string;
    category: string;
    cost_ex_vat: number | null;
    default_margin: number | null;
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

  // Fetch BOM
  const { data: bom } = useQuery({
    queryKey: ['bom', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boms')
        .select('*, customers(org_name)')
        .eq('id', id)
        .single();
      if (error) throw error;
      return { ...data, customer: (data as any).customers };
    },
    enabled: isStaff && !!id,
  });

  // Fetch BOM items
  const { data: items = [] } = useQuery({
    queryKey: ['bom_items', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bom_items')
        .select('*, skus(*)')
        .eq('bom_id', id);
      if (error) throw error;
      return data.map(item => ({
        ...item,
        sku: (item as any).skus,
      })) as BOMItem[];
    },
    enabled: isStaff && !!id,
  });

  // Fetch margin rules
  const { data: marginRules = [] } = useQuery({
    queryKey: ['margin_rules'],
    queryFn: async () => {
      const { data, error } = await supabase.from('margin_rules').select('*');
      if (error) throw error;
      return data;
    },
  });

  // Calculate sell price
  const calculateSellPrice = (cost: number, category: string, customMargin?: number) => {
    const rule = marginRules.find(r => r.category === category);
    const margin = customMargin ?? rule?.margin_percent ?? 0;
    const rounding = rule?.rounding ?? 5;
    const rawPrice = cost * (1 + margin / 100);
    return Math.round(rawPrice / rounding) * rounding;
  };

  // Add item mutation
  const addItemMutation = useMutation({
    mutationFn: async (data: { sku_id: string; quantity: number }) => {
      // Fetch SKU details
      const { data: sku, error: skuError } = await supabase
        .from('skus')
        .select('*')
        .eq('id', data.sku_id)
        .single();
      if (skuError) throw skuError;

      const sellPrice = sku.cost_ex_vat 
        ? calculateSellPrice(sku.cost_ex_vat, sku.category, sku.default_margin)
        : null;

      const { error } = await supabase.from('bom_items').upsert({
        bom_id: id,
        sku_id: data.sku_id,
        quantity: data.quantity,
        cost: sku.cost_ex_vat,
        sell_price: sellPrice,
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

  // Calculate totals
  const totals = items.reduce(
    (acc, item) => {
      const cost = (item.cost || 0) * item.quantity;
      const sell = (item.sell_price || 0) * item.quantity;
      return {
        cost: acc.cost + cost,
        sell: acc.sell + sell,
        margin: acc.margin + (sell - cost),
        items: acc.items + item.quantity,
      };
    },
    { cost: 0, sell: 0, margin: 0, items: 0 }
  );

  const marginPercent = totals.cost > 0 ? ((totals.sell - totals.cost) / totals.cost) * 100 : 0;

  // Create quote from BOM
  const createQuote = async () => {
    try {
      // quote_number is auto-generated by database trigger
      const { data: quote, error } = await supabase
        .from('quotes')
        .insert({
          bom_id: id,
          customer_id: bom?.customer_id || null,
          hardware_total: totals.sell,
          labor_total: 0,
          travel_total: 0,
          quote_number: '', // Will be overwritten by trigger
        } as any)
        .select()
        .single();
      if (error) throw error;

      // Add hardware line
      await supabase.from('quote_lines').insert({
        quote_id: quote.id,
        section: 'hardware',
        description: `Hårdvara (från BOM #${bom?.id.slice(0, 8)})`,
        quantity: 1,
        unit_price: totals.sell,
      });

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

  // Get margin status
  const getMarginStatus = () => {
    if (marginPercent >= 40) return { label: 'Utmärkt', color: 'text-green-600' };
    if (marginPercent >= 25) return { label: 'Bra', color: 'text-primary' };
    if (marginPercent >= 15) return { label: 'OK', color: 'text-yellow-600' };
    return { label: 'Låg', color: 'text-destructive' };
  };

  const marginStatus = getMarginStatus();

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
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">BOM Builder</h1>
              <Badge variant="outline">v{bom?.version || 1}</Badge>
            </div>
            <p className="text-muted-foreground">
              {bom?.customer?.org_name && (
                <span className="mr-2">{t('Kund', 'Customer')}: {bom.customer.org_name}</span>
              )}
              {t('Projekt', 'Project')}: {bom?.project_name}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-4">
            {/* Actions */}
            <div className="flex gap-2">
              <Button onClick={() => setIsSKUSelectorOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                {t('Lägg till SKU', 'Add SKU')}
              </Button>
              <Button variant="outline" onClick={() => setIsTemplateSelectorOpen(true)}>
                <Package className="h-4 w-4 mr-2" />
                {t('Lägg till från mall', 'Add from template')}
              </Button>
            </div>

            {/* Items Table */}
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs uppercase">SKU</TableHead>
                    <TableHead className="text-xs uppercase">{t('Produktnamn', 'Product Name')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Antal', 'Qty')}</TableHead>
                    <TableHead className="text-xs uppercase text-right">{t('Kostnad', 'Cost')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Säljpris', 'Sell Price')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Marginal %', 'Margin %')}</TableHead>
                    <TableHead className="text-xs uppercase text-right">{t('Radtotal', 'Row Total')}</TableHead>
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
                      const marginPct = item.cost && item.sell_price 
                        ? Math.round(((item.sell_price - item.cost) / item.cost) * 100)
                        : null;
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-mono">{item.sku.sku}</TableCell>
                          <TableCell>{item.sku.name}</TableCell>
                          <TableCell className="text-center">
                            <Input
                              type="number"
                              min="1"
                              value={item.quantity}
                              onChange={(e) => {
                                const qty = parseInt(e.target.value) || 1;
                                updateItemMutation.mutate({ itemId: item.id, updates: { quantity: qty } });
                              }}
                              className="w-16 text-center mx-auto"
                            />
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {item.cost ? `${item.cost} kr` : '—'}
                          </TableCell>
                          <TableCell className="text-center">
                            <Input
                              type="number"
                              value={item.sell_price || ''}
                              onChange={(e) => {
                                const price = parseFloat(e.target.value) || 0;
                                updateItemMutation.mutate({ itemId: item.id, updates: { sell_price: price } });
                              }}
                              className="w-24 text-center mx-auto"
                            />
                          </TableCell>
                          <TableCell className="text-center">
                            <span className={marginPct && marginPct >= 25 ? 'text-primary' : 'text-muted-foreground'}>
                              {marginPct !== null ? `${marginPct}%` : '—'}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {((item.sell_price || 0) * item.quantity).toLocaleString('sv-SE')} kr
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
                  <span className="text-muted-foreground">{t('Total hårdvarukostnad', 'Total hardware cost')}:</span>
                  <span className="font-medium">{totals.cost.toLocaleString('sv-SE')} kr</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('Total säljpris', 'Total sell price')}:</span>
                  <span className="font-medium">{totals.sell.toLocaleString('sv-SE')} kr</span>
                </div>
                <div className="border-t border-border pt-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Marginal (kr)', 'Margin (kr)')}:</span>
                    <span className="font-medium text-primary">+{totals.margin.toLocaleString('sv-SE')} kr</span>
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
              disabled={items.length === 0}
            >
              <FileText className="h-4 w-4 mr-2" />
              {t('Skapa offert från BOM', 'Create quote from BOM')}
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
    </PortalLayout>
  );
};

export default BOMBuilder;
