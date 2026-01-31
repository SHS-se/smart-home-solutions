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
import { ArrowLeft, ExternalLink, Pencil, Send, Eye, Info, Loader2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import QuotePreviewDialog from '@/components/portal/quotes/QuotePreviewDialog';

interface QuoteLine {
  id: string;
  section: string;
  description: string;
  quantity: number;
  unit_price: number;
  unit_price_ex_vat: number | null;
  vat_rate: number | null;
  unit_price_inc_vat: number | null;
}

interface BomItemWithSku {
  id: string;
  quantity: number;
  sell_price_ex_vat_at_time: number | null;
  sku: {
    id: string;
    name: string;
    sku: string;
    category: string;
    sell_price_ex_vat: number | null;
  };
}

const QuotePreparation: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isSending, setIsSending] = useState(false);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [editingQuantities, setEditingQuantities] = useState<Record<string, number>>({});

  // Fetch quote with BOM version and pricing revision info
  const { data: quote } = useQuery({
    queryKey: ['quote', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('*, customers(org_name), boms(id, project_name, version), bom_price_revisions(id, revision, note, created_at)')
        .eq('id', id)
        .single();
      if (error) throw error;
      return { 
        ...data, 
        customer: (data as any).customers, 
        bom: (data as any).boms,
        price_revision: (data as any).bom_price_revisions 
      };
    },
    enabled: isStaff && !!id,
  });

  // Fetch quote lines (for labor and travel)
  const { data: lines = [] } = useQuery({
    queryKey: ['quote_lines', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quote_lines')
        .select('*')
        .eq('quote_id', id)
        .order('section');
      if (error) throw error;
      return data as QuoteLine[];
    },
    enabled: isStaff && !!id,
  });

  // Fetch BOM items with full SKU data
  const { data: bomItems = [] } = useQuery({
    queryKey: ['bom_items_full', quote?.bom_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bom_items')
        .select('id, quantity, sell_price_ex_vat_at_time, sku:skus(id, name, sku, category, sell_price_ex_vat)')
        .eq('bom_id', quote!.bom_id!)
        .order('created_at');
      if (error) throw error;
      return data as BomItemWithSku[];
    },
    enabled: isStaff && !!quote?.bom_id,
  });

  // Update BOM item quantity mutation
  const updateBomItemMutation = useMutation({
    mutationFn: async ({ itemId, quantity }: { itemId: string; quantity: number }) => {
      const { error } = await supabase
        .from('bom_items')
        .update({ quantity })
        .eq('id', itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bom_items_full', quote?.bom_id] });
    },
  });

  // Group lines by section
  const laborLines = lines.filter(l => l.section === 'labor');
  const travelLines = lines.filter(l => l.section === 'travel');

  // Calculate hardware total from BOM items
  const hardwareTotal = bomItems.reduce((acc, item) => {
    const unitPrice = item.sell_price_ex_vat_at_time ?? item.sku.sell_price_ex_vat ?? 0;
    return acc + (item.quantity * unitPrice);
  }, 0);

  // Calculate labor total
  const laborTotal = laborLines.reduce((acc, l) => {
    return acc + (l.quantity * (l.unit_price_ex_vat ?? l.unit_price));
  }, 0);

  // Calculate travel total
  const travelTotal = travelLines.reduce((acc, l) => {
    return acc + (l.quantity * (l.unit_price_ex_vat ?? l.unit_price));
  }, 0);

  const subtotalExVat = hardwareTotal + laborTotal + travelTotal;
  const vatTotal = subtotalExVat * 0.25;
  const totalIncVat = subtotalExVat + vatTotal;

  // Update quote totals mutation
  const updateQuoteTotalsMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('quotes')
        .update({
          hardware_total: hardwareTotal,
          labor_total: laborTotal,
          travel_total: travelTotal,
          subtotal_ex_vat: subtotalExVat,
          vat_total: vatTotal,
          total_inc_vat: totalIncVat,
        })
        .eq('id', id);
      if (error) throw error;
    },
  });

  // Send to Stripe
  const sendToStripe = async () => {
    if (!quote?.customer?.org_name) {
      toast({ title: t('Kund krävs', 'Customer required'), description: t('Offerten måste ha en kund kopplad', 'Quote must have a customer attached'), variant: 'destructive' });
      return;
    }

    setIsSending(true);
    try {
      await updateQuoteTotalsMutation.mutateAsync();

      const { data, error } = await supabase.functions.invoke('create-stripe-quote', {
        body: {
          quote_id: id,
          customer_name: quote.customer.org_name,
          hardware_total: hardwareTotal,
          labor_total: laborTotal,
          travel_total: travelTotal,
        },
      });

      if (error) throw error;

      await supabase
        .from('quotes')
        .update({ 
          stripe_quote_id: data.stripe_quote_id,
          status: 'sent',
        })
        .eq('id', id);

      queryClient.invalidateQueries({ queryKey: ['quote', id] });
      queryClient.invalidateQueries({ queryKey: ['quotes'] });

      toast({ 
        title: t('Offert skickad!', 'Quote sent!'), 
        description: t('Offerten har skapats i Stripe', 'Quote has been created in Stripe')
      });
    } catch (error: any) {
      toast({ 
        title: t('Kunde inte skicka offert', 'Failed to send quote'), 
        description: error.message,
        variant: 'destructive' 
      });
    } finally {
      setIsSending(false);
    }
  };

  // Preview quote
  const previewQuote = async () => {
    if (!quote?.stripe_quote_id) {
      setShowPreview(true);
      return;
    }

    setIsLoadingPdf(true);
    try {
      const { data, error } = await supabase.functions.invoke('get-stripe-quote-pdf', {
        body: { stripe_quote_id: quote.stripe_quote_id },
      });

      if (error) throw error;
      if (!data?.pdf_url) throw new Error('No PDF URL returned');

      window.open(data.pdf_url, '_blank');
    } catch (error: any) {
      toast({ 
        title: t('Kunde inte hämta PDF', 'Failed to get PDF'), 
        description: error.message,
        variant: 'destructive' 
      });
    } finally {
      setIsLoadingPdf(false);
    }
  };

  // Handle quantity change
  const handleQuantityChange = (itemId: string, value: string) => {
    const quantity = parseInt(value) || 0;
    setEditingQuantities(prev => ({ ...prev, [itemId]: quantity }));
  };

  const handleQuantityBlur = (itemId: string) => {
    const quantity = editingQuantities[itemId];
    if (quantity !== undefined) {
      updateBomItemMutation.mutate({ itemId, quantity });
      setEditingQuantities(prev => {
        const { [itemId]: _, ...rest } = prev;
        return rest;
      });
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
            to="/portal/quotes" 
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
          </Link>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{t('Offertförberedelse', 'Quote Preparation')}</h1>
            <p className="text-muted-foreground">
              {t('Organisera och förhandsgranska offert innan skicka till kund', 'Organize and preview quote before sending to customer')}
            </p>
          </div>
        </div>

        {/* Quote Info */}
        <div className="text-sm text-muted-foreground">
          {quote?.customer?.org_name && (
            <span className="mr-4">{t('Kund', 'Customer')}: <span className="text-foreground">{quote.customer.org_name}</span></span>
          )}
          {quote?.bom?.project_name && (
            <span className="mr-4">{t('Projekt', 'Project')}: <span className="text-foreground">{quote.bom.project_name}</span></span>
          )}
          <span>{t('Offert ID', 'Quote ID')}: <span className="text-foreground font-mono">#{quote?.quote_number}</span></span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-4">
            {/* Hardware Section - BOM Items Table */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between py-4">
                <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
                  <span>{t('Hårdvara', 'Hardware')}</span>
                  {quote?.bom && (
                    <Badge variant="outline" className="font-mono text-xs">
                      BOM v{quote.bom_version ?? quote.bom.version}
                    </Badge>
                  )}
                  {quote?.price_revision && (
                    <Badge variant="secondary" className="font-mono text-xs">
                      {t('Prisrev', 'Price rev')} r{quote.price_revision.revision}
                    </Badge>
                  )}
                </CardTitle>
                <div className="flex items-center gap-3 text-sm">
                  {quote?.bom_id && (
                    <>
                      <Link 
                        to={`/portal/boms/${quote.bom_id}`}
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {t('Visa hela BOM', 'View full BOM')}
                      </Link>
                      <Link 
                        to={`/portal/boms/${quote.bom_id}`}
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        {t('Redigera BOM', 'Edit BOM')}
                      </Link>
                    </>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {bomItems.length > 0 ? (
                  <>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="px-6 pb-3 font-medium">{t('Produkt', 'Product')}</th>
                          <th className="px-4 pb-3 font-medium">{t('SKU', 'SKU')}</th>
                          <th className="px-4 pb-3 font-medium text-center">{t('Antal', 'Qty')}</th>
                          <th className="px-4 pb-3 font-medium text-right">{t('Å-pris', 'Unit price')}</th>
                          <th className="px-4 pb-3 font-medium text-right">{t('Summa', 'Total')}</th>
                          <th className="px-6 pb-3 font-medium text-center">{t('Kategori', 'Category')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bomItems.map(item => {
                          const unitPrice = item.sell_price_ex_vat_at_time ?? item.sku.sell_price_ex_vat ?? 0;
                          const currentQty = editingQuantities[item.id] ?? item.quantity;
                          const lineTotal = currentQty * unitPrice;
                          
                          return (
                            <tr key={item.id} className="border-b border-border">
                              <td className="px-6 py-4 font-medium">{item.sku.name}</td>
                              <td className="px-4 py-4 text-muted-foreground font-mono text-sm">{item.sku.sku}</td>
                              <td className="px-4 py-4">
                                <Input
                                  type="number"
                                  value={currentQty}
                                  onChange={(e) => handleQuantityChange(item.id, e.target.value)}
                                  onBlur={() => handleQuantityBlur(item.id)}
                                  className="w-16 text-center h-9"
                                  min={0}
                                />
                              </td>
                              <td className="px-4 py-4 text-right text-muted-foreground">{formatPrice(unitPrice)} kr</td>
                              <td className="px-4 py-4 text-right font-medium">{formatPrice(lineTotal)} kr</td>
                              <td className="px-6 py-4 text-center">
                                <Badge variant="outline">{item.sku.category}</Badge>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    
                    {/* Hardware Subtotal */}
                    <div className="flex justify-end items-center gap-4 px-6 py-4 border-t border-border bg-muted/30">
                      <span className="font-medium">{t('Hårdvara delsumma', 'Hardware subtotal')}:</span>
                      <span className="text-lg font-semibold">{formatPrice(hardwareTotal)} kr</span>
                    </div>

                    {/* Info message */}
                    <div className="px-6 py-3 border-t border-border">
                      <div className="flex items-start gap-2 text-sm text-muted-foreground">
                        <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span>
                          {t('Hårdvarulistan genereras automatiskt från projektets BOM och utgör grunden för offerten.',
                             'The hardware list is automatically generated from the project BOM and forms the basis for the quote.')}
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="px-6 py-8 text-center text-muted-foreground">
                    {t('Ingen BOM kopplad till offerten', 'No BOM linked to this quote')}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Labor Section */}
            <Card>
              <CardHeader className="py-4">
                <CardTitle className="text-lg">{t('Arbete', 'Labor')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {laborLines.length > 0 ? (
                  laborLines.map(line => (
                    <div key={line.id} className="flex items-start justify-between">
                      <div>
                        <p className="font-medium">{line.description || t('Arbete', 'Labor')}</p>
                        <p className="text-sm text-muted-foreground">
                          {line.quantity} {t('timmar', 'hours')} × {formatPrice(line.unit_price_ex_vat ?? line.unit_price)} kr
                        </p>
                      </div>
                      <span className="font-medium">{formatPrice(line.quantity * (line.unit_price_ex_vat ?? line.unit_price))} kr</span>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground text-sm">{t('Inget arbete tillagt', 'No labor added')}</p>
                )}
              </CardContent>
            </Card>

            {/* Travel / Other Section */}
            <Card>
              <CardHeader className="py-4">
                <CardTitle className="text-lg">{t('Resa / Övrigt', 'Travel / Other')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {travelLines.length > 0 ? (
                  travelLines.map(line => (
                    <div key={line.id} className="flex items-start justify-between">
                      <div>
                        <p className="font-medium">{line.description || t('Resa', 'Travel')}</p>
                        <p className="text-sm text-muted-foreground">
                          {line.quantity} × {formatPrice(line.unit_price_ex_vat ?? line.unit_price)} kr
                        </p>
                      </div>
                      <span className="font-medium">{formatPrice(line.quantity * (line.unit_price_ex_vat ?? line.unit_price))} kr</span>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground text-sm">{t('Inga resekostnader tillagda', 'No travel costs added')}</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Summary Sidebar */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>{t('Sammanfattning', 'Summary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Section breakdown */}
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Hårdvara', 'Hardware')}:</span>
                    <span className="font-medium">{formatPrice(hardwareTotal)} kr</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Arbete', 'Labor')}:</span>
                    <span className="font-medium">{formatPrice(laborTotal)} kr</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Övrigt', 'Other')}:</span>
                    <span className="font-medium">{formatPrice(travelTotal)} kr</span>
                  </div>
                </div>

                <div className="border-t border-border pt-4 space-y-3">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Delsumma', 'Subtotal')}:</span>
                    <span className="font-medium">{formatPrice(subtotalExVat)} kr</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Moms (25%)', 'VAT (25%)')}:</span>
                    <span className="font-medium">{formatPrice(vatTotal)} kr</span>
                  </div>
                </div>

                <div className="border-t border-border pt-4 flex justify-between items-baseline">
                  <span className="font-medium">{t('Totalt', 'Total')}:</span>
                  <span className="text-2xl font-bold text-primary">{formatPrice(totalIncVat)} kr</span>
                </div>

                {/* Action buttons */}
                <div className="pt-4 space-y-3">
                  <Button 
                    className="w-full"
                    onClick={sendToStripe}
                    disabled={isSending || bomItems.length === 0 || quote?.status !== 'draft'}
                  >
                    <Send className="h-4 w-4 mr-2" />
                    {isSending ? t('Skickar...', 'Sending...') : t('Skicka till Stripe offert', 'Send to Stripe quote')}
                  </Button>
                  <Button 
                    variant="outline" 
                    className="w-full"
                    onClick={previewQuote}
                    disabled={isLoadingPdf}
                  >
                    {isLoadingPdf ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Eye className="h-4 w-4 mr-2" />
                    )}
                    {t('Förhandsgranska PDF', 'Preview PDF')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Local preview dialog */}
        <QuotePreviewDialog
          open={showPreview}
          onOpenChange={setShowPreview}
          quote={quote}
          lines={lines}
          bomItems={bomItems.map(item => ({
            id: item.id,
            quantity: item.quantity,
            sku: { name: item.sku.name, sku: item.sku.sku }
          }))}
          totals={{
            hardwareExVat: hardwareTotal,
            laborExVat: laborTotal,
            travelExVat: travelTotal,
            subtotalExVat,
            vatTotal,
            totalIncVat,
          }}
        />
      </div>
    </PortalLayout>
  );
};

export default QuotePreparation;
