import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import BlurCommitInput from '@/components/ui/blur-commit-input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Plus, Trash2, Send, Eye, Info, Loader2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

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

const QuotePreparation: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isSending, setIsSending] = useState(false);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);

  // Fetch quote
  const { data: quote } = useQuery({
    queryKey: ['quote', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('*, customers(org_name), boms(project_name)')
        .eq('id', id)
        .single();
      if (error) throw error;
      return { ...data, customer: (data as any).customers, bom: (data as any).boms };
    },
    enabled: isStaff && !!id,
  });

  // Fetch quote lines
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

  // Add line mutation with VAT-aware pricing
  const addLineMutation = useMutation({
    mutationFn: async (data: { section: string; description: string; quantity: number; unit_price: number }) => {
      const vatRate = 0.25;
      const unitPriceExVat = data.unit_price;
      const unitPriceIncVat = unitPriceExVat * (1 + vatRate);
      
      const { error } = await supabase.from('quote_lines').insert({
        quote_id: id,
        ...data,
        unit_price_ex_vat: unitPriceExVat,
        vat_rate: vatRate,
        unit_price_inc_vat: unitPriceIncVat,
        pricing_source: 'manual',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quote_lines', id] });
    },
  });

  // Update line mutation
  const updateLineMutation = useMutation({
    mutationFn: async ({ lineId, updates }: { lineId: string; updates: Partial<QuoteLine> }) => {
      // If unit_price is being updated, also update VAT fields
      let finalUpdates = { ...updates };
      if (updates.unit_price !== undefined) {
        const vatRate = 0.25;
        finalUpdates = {
          ...updates,
          unit_price_ex_vat: updates.unit_price,
          unit_price_inc_vat: updates.unit_price * (1 + vatRate),
        };
      }
      
      const { error } = await supabase
        .from('quote_lines')
        .update(finalUpdates)
        .eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quote_lines', id] });
      queryClient.invalidateQueries({ queryKey: ['quote', id] });
    },
  });

  // Delete line mutation
  const deleteLineMutation = useMutation({
    mutationFn: async (lineId: string) => {
      const { error } = await supabase.from('quote_lines').delete().eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quote_lines', id] });
    },
  });

  // Group lines by section
  const hardwareLines = lines.filter(l => l.section === 'hardware');
  const laborLines = lines.filter(l => l.section === 'labor');
  const travelLines = lines.filter(l => l.section === 'travel');

  // Calculate totals with VAT
  const calculateSectionTotals = (sectionLines: QuoteLine[]) => {
    return sectionLines.reduce((acc, l) => {
      const exVat = (l.unit_price_ex_vat ?? l.unit_price) * l.quantity;
      const vatRate = l.vat_rate ?? 0.25;
      const incVat = (l.unit_price_inc_vat ?? l.unit_price * (1 + vatRate)) * l.quantity;
      return {
        exVat: acc.exVat + exVat,
        incVat: acc.incVat + incVat,
      };
    }, { exVat: 0, incVat: 0 });
  };

  const hardwareTotals = calculateSectionTotals(hardwareLines);
  const laborTotals = calculateSectionTotals(laborLines);
  const travelTotals = calculateSectionTotals(travelLines);
  
  const subtotalExVat = hardwareTotals.exVat + laborTotals.exVat + travelTotals.exVat;
  const totalIncVat = hardwareTotals.incVat + laborTotals.incVat + travelTotals.incVat;
  const vatTotal = totalIncVat - subtotalExVat;

  // Update quote totals mutation
  const updateQuoteTotalsMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('quotes')
        .update({
          hardware_total: hardwareTotals.exVat,
          labor_total: laborTotals.exVat,
          travel_total: travelTotals.exVat,
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
      // First update quote totals
      await updateQuoteTotalsMutation.mutateAsync();

      const { data, error } = await supabase.functions.invoke('create-stripe-quote', {
        body: {
          quote_id: id,
          customer_name: quote.customer.org_name,
          hardware_total: hardwareTotals.exVat,
          labor_total: laborTotals.exVat,
          travel_total: travelTotals.exVat,
        },
      });

      if (error) throw error;

      // Update quote with Stripe quote ID
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

  // Preview PDF from Stripe
  const previewPdf = async () => {
    if (!quote?.stripe_quote_id) {
      toast({ 
        title: t('Offert ej skickad', 'Quote not sent'), 
        description: t('Skicka offerten till Stripe först för att kunna förhandsgranska PDF', 'Send the quote to Stripe first to preview the PDF'),
        variant: 'destructive' 
      });
      return;
    }

    setIsLoadingPdf(true);
    try {
      const { data, error } = await supabase.functions.invoke('get-stripe-quote-pdf', {
        body: { stripe_quote_id: quote.stripe_quote_id },
      });

      if (error) throw error;
      if (!data?.pdf_url) throw new Error('No PDF URL returned');

      // Open PDF in new tab
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

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  const formatPrice = (value: number) => value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const renderSection = (
    title: string, 
    sectionLines: QuoteLine[], 
    sectionKey: string,
    unitLabel: string = 'st'
  ) => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-4">
        <div className="flex items-center gap-2">
          <CardTitle className="text-lg">{title}</CardTitle>
          <Badge variant="secondary">{sectionLines.length}</Badge>
        </div>
        <Button 
          variant="ghost" 
          size="sm"
          onClick={() => addLineMutation.mutate({
            section: sectionKey,
            description: '',
            quantity: 1,
            unit_price: 0,
          })}
        >
          <Plus className="h-4 w-4 mr-1" />
          {t('Lägg till rad', 'Add row')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {sectionLines.map(line => (
          <div key={line.id} className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
            <BlurCommitInput
              value={line.description}
              onCommit={(val) => updateLineMutation.mutate({ 
                lineId: line.id, 
                updates: { description: val } 
              })}
              placeholder={t('Beskrivning', 'Description')}
              className="flex-1"
            />
            <BlurCommitInput
              type="number"
              value={line.quantity}
              onCommit={(val) => updateLineMutation.mutate({ 
                lineId: line.id, 
                updates: { quantity: parseFloat(val) || 0 } 
              })}
              className="w-20 text-center"
            />
            <span className="text-muted-foreground text-sm">{unitLabel} ×</span>
            <BlurCommitInput
              type="number"
              value={line.unit_price}
              onCommit={(val) => updateLineMutation.mutate({ 
                lineId: line.id, 
                updates: { unit_price: parseFloat(val) || 0 } 
              })}
              className="w-24 text-right"
            />
            <span className="text-muted-foreground text-sm">kr</span>
            <span className="w-24 text-right font-medium">
              {formatPrice(line.quantity * line.unit_price)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => deleteLineMutation.mutate(line.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {sectionLines.length === 0 && (
          <p className="text-center text-muted-foreground py-4">
            {t('Inga rader tillagda', 'No rows added')}
          </p>
        )}
      </CardContent>
    </Card>
  );

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
            {renderSection(t('Hårdvara', 'Hardware'), hardwareLines, 'hardware')}
            {renderSection(t('Arbete', 'Labor'), laborLines, 'labor', 'tim')}
            {renderSection(t('Resa / Övrigt', 'Travel / Other'), travelLines, 'travel')}
          </div>

          {/* Summary Sidebar */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>{t('Sammanfattning', 'Summary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Section breakdown */}
                <div className="space-y-2 text-sm">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('Uppdelning (ex moms)', 'Breakdown (ex VAT)')}</p>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Hårdvara', 'Hardware')}:</span>
                    <span>{formatPrice(hardwareTotals.exVat)} kr</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Arbete', 'Labor')}:</span>
                    <span>{formatPrice(laborTotals.exVat)} kr</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Övrigt', 'Other')}:</span>
                    <span>{formatPrice(travelTotals.exVat)} kr</span>
                  </div>
                </div>

                <div className="border-t border-border pt-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Delsumma (ex moms)', 'Subtotal (ex VAT)')}:</span>
                    <span className="font-medium">{formatPrice(subtotalExVat)} kr</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('Moms (25%)', 'VAT (25%)')}:</span>
                    <span className="font-medium">{formatPrice(vatTotal)} kr</span>
                  </div>
                </div>

                <div className="border-t border-border pt-4 flex justify-between">
                  <span className="font-medium">{t('Totalt (inkl moms)', 'Total (incl VAT)')}:</span>
                  <span className="text-2xl font-bold text-primary">{formatPrice(totalIncVat)} kr</span>
                </div>

                {quote?.status === 'draft' && (
                  <div className="bg-primary/10 text-primary p-3 rounded-lg flex items-start gap-2 text-sm">
                    <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    <span>
                      {t('Offert klar för granskning. Använd "Förhandsgranska PDF" för att se hur offerten ser ut för kunden.', 
                         'Quote ready for review. Use "Preview PDF" to see how the quote looks for the customer.')}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-4">
          <Button 
            size="lg" 
            className="flex-1"
            onClick={sendToStripe}
            disabled={isSending || lines.length === 0 || quote?.status !== 'draft'}
          >
            <Send className="h-4 w-4 mr-2" />
            {isSending ? t('Skickar...', 'Sending...') : t('Skicka till Stripe offert', 'Send to Stripe quote')}
          </Button>
          <Button 
            variant="outline" 
            size="lg"
            onClick={previewPdf}
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
      </div>
    </PortalLayout>
  );
};

export default QuotePreparation;
