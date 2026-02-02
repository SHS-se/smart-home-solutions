import React, { useState, useEffect, useRef } from 'react';
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
import { ArrowLeft, ExternalLink, Pencil, Send, Eye, Info, Loader2, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import QuotePriceDiffModal from '@/components/portal/quotes/QuotePriceDiffModal';
import QuoteVersionDropdown from '@/components/portal/quotes/QuoteVersionDropdown';
import QuoteOutdatedBanner from '@/components/portal/quotes/QuoteOutdatedBanner';
import QuoteUpdateConfirmDialog from '@/components/portal/quotes/QuoteUpdateConfirmDialog';
import QuotePdfModal from '@/components/portal/quotes/QuotePdfModal';
import { useQuoteVersioning } from '@/hooks/use-quote-versioning';
import BlurCommitInput from '@/components/ui/blur-commit-input';

interface QuoteLine {
  id: string;
  section: string;
  description: string;
  quantity: number;
  unit_price: number;
  unit_price_ex_vat: number | null;
  vat_rate: number | null;
  unit_price_inc_vat: number | null;
  sku_id: string | null;
  original_sku_name: string | null;
  original_sku_code: string | null;
  cost_ex_vat_at_time: number | null;
  source_bom_id: string | null;
}

interface PriceDiffResult {
  items: Array<{
    sku_id: string;
    sku_name: string;
    sku_code: string;
    quantity: number;
    old_unit_price: number;
    new_unit_price: number;
    delta_per_unit: number;
    delta_total: number;
  }>;
  old_total_ex_vat: number;
  new_total_ex_vat: number;
  delta_total_ex_vat: number;
  old_total_inc_vat: number;
  new_total_inc_vat: number;
  delta_total_inc_vat: number;
}

const QuotePreparation: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isSending, setIsSending] = useState(false);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
  
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [priceDiff, setPriceDiff] = useState<PriceDiffResult | null>(null);

  // Quote versioning hook
  const {
    quoteFamily,
    pricingStatus,
    computePriceDiff,
    createNewVersion,
    isCreatingVersion,
  } = useQuoteVersioning(id);

  // Fetch quote with BOM version and pricing revision info
  const { data: quote } = useQuery({
    queryKey: ['quote', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('*, customers(org_name, billing_email), boms(id, project_name, version), bom_price_revisions(id, revision, note, created_at)')
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

  // Fetch ALL quote lines (hardware, labor, travel) - single source of truth
  const { data: lines = [], isSuccess: linesLoaded } = useQuery({
    queryKey: ['quote_lines', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quote_lines')
        .select('*')
        .eq('quote_id', id)
        .order('created_at');
      if (error) throw error;
      return data as QuoteLine[];
    },
    enabled: isStaff && !!id,
  });

  // Track if we've already initialized default rows
  const defaultRowsInitialized = useRef(false);

  // Auto-create default Labor and Travel rows if none exist
  useEffect(() => {
    if (!linesLoaded || !id || defaultRowsInitialized.current) return;
    
    const laborLines = lines.filter(l => l.section === 'labor');
    const travelLines = lines.filter(l => l.section === 'travel');
    
    const createDefaults = async () => {
      let created = false;
      
      if (laborLines.length === 0) {
        await supabase.from('quote_lines').insert({
          quote_id: id,
          section: 'labor',
          description: 'Installation',
          quantity: 1,
          unit_price: 850,
          unit_price_ex_vat: 850,
          vat_rate: 0.25,
          unit_price_inc_vat: 850 * 1.25,
        });
        created = true;
      }
      
      if (travelLines.length === 0) {
        await supabase.from('quote_lines').insert({
          quote_id: id,
          section: 'travel',
          description: 'Resa',
          quantity: 1,
          unit_price: 500,
          unit_price_ex_vat: 500,
          vat_rate: 0.25,
          unit_price_inc_vat: 500 * 1.25,
        });
        created = true;
      }
      
      if (created) {
        queryClient.invalidateQueries({ queryKey: ['quote_lines', id] });
      }
    };
    
    defaultRowsInitialized.current = true;
    createDefaults();
  }, [linesLoaded, lines, id, queryClient]);

  // Add quote line mutation
  const addQuoteLineMutation = useMutation({
    mutationFn: async ({ section, description, quantity, unitPrice }: { section: string; description: string; quantity: number; unitPrice: number }) => {
      const { error } = await supabase
        .from('quote_lines')
        .insert({
          quote_id: id!,
          section,
          description,
          quantity,
          unit_price: unitPrice,
          unit_price_ex_vat: unitPrice,
          vat_rate: 0.25,
          unit_price_inc_vat: unitPrice * 1.25,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quote_lines', id] });
    },
  });

  // Update quote line mutation (works for hardware, labor, travel - all sections)
  const updateQuoteLineMutation = useMutation({
    mutationFn: async ({ lineId, field, value }: { lineId: string; field: string; value: string | number }) => {
      const updateData: Record<string, unknown> = { [field]: value };
      
      // If updating unit_price, also update related fields
      if (field === 'unit_price') {
        const numValue = typeof value === 'number' ? value : parseFloat(value as string) || 0;
        updateData.unit_price_ex_vat = numValue;
        updateData.unit_price_inc_vat = numValue * 1.25;
      }
      
      const { error } = await supabase
        .from('quote_lines')
        .update(updateData)
        .eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quote_lines', id] });
    },
  });

  // Delete quote line mutation
  const deleteQuoteLineMutation = useMutation({
    mutationFn: async (lineId: string) => {
      const { error } = await supabase
        .from('quote_lines')
        .delete()
        .eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quote_lines', id] });
    },
  });

  // Group lines by section - all from quote_lines (single source of truth)
  const hardwareLines = lines.filter(l => l.section === 'hardware');
  const laborLines = lines.filter(l => l.section === 'labor');
  const travelLines = lines.filter(l => l.section === 'travel');

  // Add new row handlers
  const handleAddLaborLine = () => {
    addQuoteLineMutation.mutate({
      section: 'labor',
      description: t('Installation', 'Installation'),
      quantity: 1,
      unitPrice: 850,
    });
  };

  const handleAddTravelLine = () => {
    addQuoteLineMutation.mutate({
      section: 'travel',
      description: t('Resa', 'Travel'),
      quantity: 1,
      unitPrice: 500,
    });
  };

  // Calculate totals from quote_lines (single source of truth)
  const hardwareTotal = hardwareLines.reduce((acc, l) => {
    return acc + (l.quantity * (l.unit_price_ex_vat ?? l.unit_price));
  }, 0);

  const laborTotal = laborLines.reduce((acc, l) => {
    return acc + (l.quantity * (l.unit_price_ex_vat ?? l.unit_price));
  }, 0);

  const travelTotal = travelLines.reduce((acc, l) => {
    return acc + (l.quantity * (l.unit_price_ex_vat ?? l.unit_price));
  }, 0);

  const subtotalExVat = hardwareTotal + laborTotal + travelTotal;
  const vatTotal = subtotalExVat * 0.25;
  const totalIncVat = subtotalExVat + vatTotal;

  // Send to Stripe - uses quote_lines as source of truth
  const sendToStripe = async () => {
    if (!quote?.customer?.org_name) {
      toast({ title: t('Kund krävs', 'Customer required'), description: t('Offerten måste ha en kund kopplad', 'Quote must have a customer attached'), variant: 'destructive' });
      return;
    }

    setIsSending(true);
    try {
      // Prepare itemized hardware items from quote_lines
      const hardwareItems = hardwareLines.map(line => ({
        name: line.description,
        sku: line.original_sku_code || '',
        quantity: line.quantity,
        unit_price_ex_vat: line.unit_price_ex_vat ?? line.unit_price,
      }));

      // Prepare itemized labor lines
      const laborLinesData = laborLines.map(line => ({
        description: line.description || t('Installation', 'Installation'),
        quantity: line.quantity,
        unit_price_ex_vat: line.unit_price_ex_vat ?? line.unit_price,
      }));

      // Prepare itemized travel lines
      const travelLinesData = travelLines.map(line => ({
        description: line.description || t('Resa', 'Travel'),
        quantity: line.quantity,
        unit_price_ex_vat: line.unit_price_ex_vat ?? line.unit_price,
      }));

      const { data, error } = await supabase.functions.invoke('create-stripe-quote', {
        body: {
          quote_id: id,
          customer_name: quote.customer.org_name,
          hardware_items: hardwareItems,
          labor_lines: laborLinesData,
          travel_lines: travelLinesData,
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

  // Preview Stripe quote PDF
  const previewQuote = async () => {
    if (!quote?.stripe_quote_id) {
      toast({ 
        title: t('Ingen Stripe-offert', 'No Stripe quote'), 
        description: t('Skicka offerten till Stripe först för att generera en PDF', 'Send the quote to Stripe first to generate a PDF'),
        variant: 'destructive' 
      });
      return;
    }

    setIsLoadingPdf(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error('Not authenticated');

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-stripe-quote-pdf`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ stripe_quote_id: quote.stripe_quote_id }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }

      setPdfUrl(data.url);
      setShowPdfModal(true);
      
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

  // Create invoice from quote - uses quote_lines as source
  const createInvoiceFromQuote = async () => {
    if (!quote?.customer_id) {
      toast({ title: t('Kund krävs', 'Customer required'), description: t('Offerten måste ha en kund kopplad', 'Quote must have a customer attached'), variant: 'destructive' });
      return;
    }

    setIsCreatingInvoice(true);
    try {
      // Prepare line items from quote_lines (single source of truth)
      const lineItems = [
        // Hardware items from quote_lines
        ...hardwareLines.map(line => ({
          line_type: 'hardware',
          description: line.description,
          sku: line.original_sku_code || '',
          sku_id: line.sku_id,
          quantity: line.quantity,
          unit_price: line.unit_price_ex_vat ?? line.unit_price,
          category: 'Hardware',
        })),
        // Labor lines
        ...laborLines.map(line => ({
          line_type: 'labor',
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unit_price_ex_vat ?? line.unit_price,
        })),
        // Travel/other lines
        ...travelLines.map(line => ({
          line_type: 'travel_other',
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unit_price_ex_vat ?? line.unit_price,
        })),
      ];

      const { data, error } = await supabase.functions.invoke('create-draft-invoice', {
        body: {
          customer_id: quote.customer_id,
          bom_id: quote.bom_id,
          quote_id: quote.id,
          is_test: quote.is_test || false,
          line_items: lineItems,
        },
      });

      if (error) throw error;

      toast({ 
        title: t('Fakturautkast skapad!', 'Invoice draft created!'), 
        description: t('Du omdirigeras till fakturautkastet', 'Redirecting to the invoice draft'),
      });

      navigate(`/portal/invoices/new?id=${data.invoice_id}`);
    } catch (error: any) {
      toast({ 
        title: t('Kunde inte skapa faktura', 'Failed to create invoice'), 
        description: error.message,
        variant: 'destructive' 
      });
    } finally {
      setIsCreatingInvoice(false);
    }
  };

  // Handle show diff
  const handleShowDiff = async () => {
    const diff = await computePriceDiff();
    setPriceDiff(diff);
    setShowDiffModal(true);
  };

  // Handle update quote to new version
  const handleUpdateQuote = async () => {
    try {
      const newQuote = await createNewVersion();
      toast({
        title: t('Ny offertversion skapad!', 'New quote version created!'),
        description: t(`Version ${newQuote.version} har skapats med uppdaterade priser.`, `Version ${newQuote.version} has been created with updated prices.`),
      });
      navigate(`/portal/quotes/${newQuote.id}`);
    } catch (error: any) {
      toast({
        title: t('Kunde inte skapa ny version', 'Failed to create new version'),
        description: error.message,
        variant: 'destructive',
      });
    }
    setShowUpdateConfirm(false);
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  const formatPrice = (value: number) => value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const currentVersion = quoteFamily.find(v => v.id === id);
  const isLatestVersion = currentVersion?.is_latest ?? true;
  const isSent = quote?.status === 'sent';
  const isEditable = isLatestVersion && !isSent;

  // Status badge helper
  const getStatusBadge = () => {
    const status = quote?.status || 'draft';
    switch (status) {
      case 'draft':
        return <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>;
      case 'sent':
        return <Badge variant="default">{t('Skickad', 'Sent')}</Badge>;
      case 'accepted':
        return <Badge variant="secondary">{t('Accepterad', 'Accepted')}</Badge>;
      case 'rejected':
        return <Badge variant="destructive">{t('Avvisad', 'Rejected')}</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

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
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{t('Offertförberedelse', 'Quote Preparation')}</h1>
              <QuoteVersionDropdown versions={quoteFamily} currentQuoteId={id || ''} />
            </div>
            <p className="text-muted-foreground">
              {t('Organisera och förhandsgranska offert innan skicka till kund', 'Organize and preview quote before sending to customer')}
            </p>
          </div>
        </div>

        {/* Older version warning */}
        {!isLatestVersion && (
          <Alert className="border-amber-500 bg-amber-500/10">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="flex items-center justify-between">
              <span className="text-amber-700 dark:text-amber-400">
                {t('Du tittar på en äldre offertversion.', 'You are viewing an older quote version.')}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const latest = quoteFamily.find(v => v.is_latest);
                  if (latest) navigate(`/portal/quotes/${latest.id}`);
                }}
              >
                {t('Gå till senaste', 'Go to latest')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Outdated pricing banner */}
        {pricingStatus?.isOutdated && isLatestVersion && (
          <QuoteOutdatedBanner
            quoteRevision={pricingStatus.quoteRevision!}
            latestRevision={pricingStatus.latestRevision!}
            onUpdate={() => setShowUpdateConfirm(true)}
            onShowDiff={handleShowDiff}
            isUpdating={isCreatingVersion}
          />
        )}

        {/* Quote Info */}
        <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
          {quote && getStatusBadge()}
          {quote?.customer?.org_name && (
            <span>{t('Kund', 'Customer')}: <span className="text-foreground">{quote.customer.org_name}</span></span>
          )}
          {quote?.bom?.project_name && (
            <span>{t('Projekt', 'Project')}: <span className="text-foreground">{quote.bom.project_name}</span></span>
          )}
          <span>{t('Offert ID', 'Quote ID')}: <span className="text-foreground font-mono">#{quote?.quote_number}</span></span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-4">
            {/* Hardware Section - from quote_lines (single source of truth) */}
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
                    <Link 
                      to={`/portal/boms/${quote.bom_id}`}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t('Visa BOM', 'View BOM')}
                    </Link>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {hardwareLines.length > 0 ? (
                  <>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="px-6 pb-3 font-medium">{t('Produkt', 'Product')}</th>
                          <th className="px-4 pb-3 font-medium">{t('SKU', 'SKU')}</th>
                          <th className="px-4 pb-3 font-medium text-center">{t('Antal', 'Qty')}</th>
                          <th className="px-4 pb-3 font-medium text-right">{t('Å-pris', 'Unit price')}</th>
                          <th className="px-4 pb-3 font-medium text-right">{t('Summa', 'Total')}</th>
                          <th className="px-4 pb-3 font-medium w-12"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {hardwareLines.map(line => {
                          const unitPrice = line.unit_price_ex_vat ?? line.unit_price;
                          const lineTotal = line.quantity * unitPrice;
                          
                          return (
                            <tr key={line.id} className="border-b border-border">
                              <td className="px-6 py-4">
                                <BlurCommitInput
                                  value={line.description}
                                  onCommit={(value) => updateQuoteLineMutation.mutate({ lineId: line.id, field: 'description', value })}
                                  className="h-9"
                                  disabled={!isEditable}
                                />
                              </td>
                              <td className="px-4 py-4 text-muted-foreground font-mono text-sm">
                                {line.original_sku_code || '—'}
                              </td>
                              <td className="px-4 py-4">
                                <BlurCommitInput
                                  type="number"
                                  value={line.quantity}
                                  onCommit={(value) => updateQuoteLineMutation.mutate({ lineId: line.id, field: 'quantity', value: parseInt(value) || 0 })}
                                  className="w-16 text-center h-9"
                                  min={0}
                                  disabled={!isEditable}
                                />
                              </td>
                              <td className="px-4 py-4">
                                <BlurCommitInput
                                  type="number"
                                  value={unitPrice}
                                  onCommit={(value) => updateQuoteLineMutation.mutate({ lineId: line.id, field: 'unit_price', value: parseFloat(value) || 0 })}
                                  className="w-24 text-right h-9"
                                  min={0}
                                  disabled={!isEditable}
                                />
                              </td>
                              <td className="px-4 py-4 text-right font-medium">{formatPrice(lineTotal)} kr</td>
                              <td className="px-4 py-4">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => deleteQuoteLineMutation.mutate(line.id)}
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                  disabled={!isEditable}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
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
                          {t('Hårdvarulistan är en oberoende kopia från BOM vid offertskapande. Ändringar här påverkar inte BOM.',
                             'The hardware list is an independent copy from the BOM at quote creation. Changes here do not affect the BOM.')}
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="px-6 py-8 text-center text-muted-foreground">
                    {t('Ingen hårdvara på offerten', 'No hardware on this quote')}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Labor Section */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between py-4">
                <CardTitle className="text-lg">{t('Arbete', 'Labor')}</CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddLaborLine}
                  disabled={!isEditable}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t('Lägg till rad', 'Add row')}
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                {laborLines.length > 0 ? (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-6 pb-3 pt-2 font-medium">{t('Beskrivning', 'Description')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-center">{t('Timmar', 'Hours')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-right">{t('À-pris', 'Unit price')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-right">{t('Summa', 'Total')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {laborLines.map(line => {
                        const unitPrice = line.unit_price_ex_vat ?? line.unit_price;
                        const lineTotal = line.quantity * unitPrice;
                        
                        return (
                          <tr key={line.id} className="border-b border-border">
                            <td className="px-6 py-3">
                              <BlurCommitInput
                                value={line.description}
                                onCommit={(value) => updateQuoteLineMutation.mutate({ lineId: line.id, field: 'description', value })}
                                className="h-9"
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <BlurCommitInput
                                type="number"
                                value={line.quantity}
                                onCommit={(value) => updateQuoteLineMutation.mutate({ lineId: line.id, field: 'quantity', value: parseFloat(value) || 0 })}
                                className="w-20 text-center h-9"
                                min={0}
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <BlurCommitInput
                                type="number"
                                value={unitPrice}
                                onCommit={(value) => updateQuoteLineMutation.mutate({ lineId: line.id, field: 'unit_price', value: parseFloat(value) || 0 })}
                                className="w-24 text-right h-9"
                                min={0}
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3 text-right font-medium">{formatPrice(lineTotal)} kr</td>
                            <td className="px-4 py-3">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => deleteQuoteLineMutation.mutate(line.id)}
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                disabled={!isEditable}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="px-6 py-4 text-muted-foreground text-sm">{t('Inget arbete tillagt', 'No labor added')}</div>
                )}
                {laborLines.length > 0 && (
                  <div className="flex justify-end items-center gap-4 px-6 py-3 border-t border-border bg-muted/30">
                    <span className="font-medium">{t('Arbete delsumma', 'Labor subtotal')}:</span>
                    <span className="text-lg font-semibold">{formatPrice(laborTotal)} kr</span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Travel / Other Section */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between py-4">
                <CardTitle className="text-lg">{t('Resa / Övrigt', 'Travel / Other')}</CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddTravelLine}
                  disabled={!isEditable}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t('Lägg till rad', 'Add row')}
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                {travelLines.length > 0 ? (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-6 pb-3 pt-2 font-medium">{t('Beskrivning', 'Description')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-center">{t('Antal', 'Qty')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-right">{t('À-pris', 'Unit price')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-right">{t('Summa', 'Total')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {travelLines.map(line => {
                        const unitPrice = line.unit_price_ex_vat ?? line.unit_price;
                        const lineTotal = line.quantity * unitPrice;
                        
                        return (
                          <tr key={line.id} className="border-b border-border">
                            <td className="px-6 py-3">
                              <BlurCommitInput
                                value={line.description}
                                onCommit={(value) => updateQuoteLineMutation.mutate({ lineId: line.id, field: 'description', value })}
                                className="h-9"
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <BlurCommitInput
                                type="number"
                                value={line.quantity}
                                onCommit={(value) => updateQuoteLineMutation.mutate({ lineId: line.id, field: 'quantity', value: parseFloat(value) || 0 })}
                                className="w-20 text-center h-9"
                                min={0}
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <BlurCommitInput
                                type="number"
                                value={unitPrice}
                                onCommit={(value) => updateQuoteLineMutation.mutate({ lineId: line.id, field: 'unit_price', value: parseFloat(value) || 0 })}
                                className="w-24 text-right h-9"
                                min={0}
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3 text-right font-medium">{formatPrice(lineTotal)} kr</td>
                            <td className="px-4 py-3">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => deleteQuoteLineMutation.mutate(line.id)}
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                disabled={!isEditable}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="px-6 py-4 text-muted-foreground text-sm">{t('Inga resekostnader tillagda', 'No travel costs added')}</div>
                )}
                {travelLines.length > 0 && (
                  <div className="flex justify-end items-center gap-4 px-6 py-3 border-t border-border bg-muted/30">
                    <span className="font-medium">{t('Resa/övrigt delsumma', 'Travel/other subtotal')}:</span>
                    <span className="text-lg font-semibold">{formatPrice(travelTotal)} kr</span>
                  </div>
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
                    disabled={isSending || hardwareLines.length === 0 || quote?.status !== 'draft' || !isLatestVersion}
                  >
                    <Send className="h-4 w-4 mr-2" />
                    {isSending ? t('Skickar...', 'Sending...') : t('Skicka till Stripe offert', 'Send to Stripe quote')}
                  </Button>
                  {!isLatestVersion && (
                    <p className="text-xs text-muted-foreground text-center">
                      {t('Gå till senaste versionen för att skicka', 'Go to latest version to send')}
                    </p>
                  )}
                  <Button 
                    variant="outline" 
                    className="w-full"
                    onClick={previewQuote}
                    disabled={isLoadingPdf || !quote?.stripe_quote_id}
                  >
                    {isLoadingPdf ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Eye className="h-4 w-4 mr-2" />
                    )}
                    {t('Förhandsgranska PDF', 'Preview PDF')}
                  </Button>
                  {!quote?.stripe_quote_id && (
                    <p className="text-xs text-muted-foreground text-center">
                      {t('Skicka till Stripe först för att ladda ner', 'Send to Stripe first to download')}
                    </p>
                  )}
                  <Button 
                    variant="success" 
                    className="w-full"
                    onClick={createInvoiceFromQuote}
                    disabled={isCreatingInvoice || !quote?.customer_id || !quote?.stripe_quote_id}
                  >
                    {isCreatingInvoice ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4 mr-2" />
                    )}
                    {t('Skapa faktura', 'Create Invoice')}
                  </Button>
                </div>
              </CardContent>
            </Card>

          </div>
        </div>


        {/* Price diff modal */}
        <QuotePriceDiffModal
          open={showDiffModal}
          onOpenChange={setShowDiffModal}
          diff={priceDiff}
          quoteRevision={pricingStatus?.quoteRevision || 1}
          latestRevision={pricingStatus?.latestRevision || 1}
        />

        {/* Update confirm dialog */}
        <QuoteUpdateConfirmDialog
          open={showUpdateConfirm}
          onOpenChange={setShowUpdateConfirm}
          currentVersion={currentVersion?.version || 1}
          targetRevision={pricingStatus?.latestRevision || 1}
          onConfirm={handleUpdateQuote}
        />

        {/* PDF Preview Modal */}
        <QuotePdfModal
          open={showPdfModal}
          onOpenChange={(open) => {
            setShowPdfModal(open);
            if (!open) setPdfUrl(null);
          }}
          pdfUrl={pdfUrl}
          quoteNumber={quote?.quote_number || ''}
        />
      </div>
    </PortalLayout>
  );
};

export default QuotePreparation;