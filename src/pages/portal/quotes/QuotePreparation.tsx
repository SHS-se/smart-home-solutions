import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ArrowLeft, ExternalLink, Send, Info, Loader2, AlertTriangle, Plus, Trash2, RefreshCw } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import QuoteVersionDropdown from '@/components/portal/quotes/QuoteVersionDropdown';
import { useQuoteVersioning } from '@/hooks/use-quote-versioning';
import BlurCommitInput from '@/components/ui/blur-commit-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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

const QuotePreparation: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isSending, setIsSending] = useState(false);
  const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
  const [isUpdatingFromBom, setIsUpdatingFromBom] = useState(false);

  // Quote versioning hook
  const {
    quoteFamily,
    createNewVersion,
    isCreatingVersion,
  } = useQuoteVersioning(id);

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

  // Fetch quote with BOM info (no more bom_price_revisions)
  const { data: quote } = useQuery({
    queryKey: ['quote', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('*, customers:customers_with_identity!quotes_customer_id_fkey(name, billing_email, contact_name, contact_email), boms(id, project_name, version)')
        .eq('id', id)
        .single();
      if (error) throw error;
      return { 
        ...data, 
        customer: (data as any).customers, 
        bom: (data as any).boms,
      };
    },
    enabled: isStaff && !!id,
  });

  const hasInvoice = !!quote?.stripe_invoice_id;

  // Fetch ALL quote lines
  const { data: lines = [], isSuccess: linesLoaded } = useQuery({
    queryKey: ['quote_lines', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quote_lines')
        .select('*')
        .eq('quote_id', id)
        .order('created_at')
        .order('id');
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

  // Update quote line mutation
  const updateQuoteLineMutation = useMutation({
    mutationFn: async ({ lineId, field, value }: { lineId: string; field: string; value: string | number }) => {
      const updateData: Record<string, unknown> = { [field]: value };
      
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

  // Update quote customer mutation
  const updateQuoteCustomerMutation = useMutation({
    mutationFn: async (customerId: string | null) => {
      const { error } = await supabase
        .from('quotes')
        .update({ customer_id: customerId })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quote', id] });
      toast({ title: t('Kund uppdaterad', 'Customer updated') });
    },
    onError: (error: any) => {
      toast({ title: t('Kunde inte uppdatera kund', 'Failed to update customer'), description: error.message, variant: 'destructive' });
    },
  });

  // Group lines by section
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

  // Calculate totals
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
  
  const vatTotal = lines.reduce((acc, l) => {
    const lineExVat = l.quantity * (l.unit_price_ex_vat ?? l.unit_price);
    const lineVatRate = l.vat_rate ?? 0.25;
    return acc + Math.round(lineExVat * lineVatRate * 100) / 100;
  }, 0);
  
  const totalIncVat = subtotalExVat + vatTotal;

  // Margin calculation for hardware
  const hardwareCostTotal = hardwareLines.reduce((acc, l) => {
    return acc + (l.quantity * (l.cost_ex_vat_at_time ?? 0));
  }, 0);
  const hardwareMarginKr = hardwareTotal - hardwareCostTotal;
  const hardwareMarginPct = hardwareCostTotal > 0 ? ((hardwareTotal - hardwareCostTotal) / hardwareCostTotal) * 100 : 0;

  const getMarginStatus = () => {
    if (hardwareMarginPct >= 40) return { label: t('Utmärkt', 'Excellent'), color: 'text-green-600' };
    if (hardwareMarginPct >= 25) return { label: t('Bra', 'Good'), color: 'text-primary' };
    if (hardwareMarginPct >= 15) return { label: 'OK', color: 'text-yellow-600' };
    return { label: t('Låg', 'Low'), color: 'text-destructive' };
  };
  const marginStatus = getMarginStatus();

  // "Update from BOM" - re-sync quantities from latest BOM
  const handleUpdateFromBom = async () => {
    if (!quote?.bom_id || !id) return;

    setIsUpdatingFromBom(true);
    try {
      // Fetch latest BOM items
      const { data: bomItems, error: bomError } = await supabase
        .from('bom_items')
        .select('sku_id, quantity')
        .eq('bom_id', quote.bom_id);
      if (bomError) throw bomError;

      // Build quantity map from BOM: sku_id -> quantity
      const bomQuantityMap: Record<string, number> = {};
      for (const item of bomItems || []) {
        bomQuantityMap[item.sku_id] = item.quantity;
      }

      // Create new version with updated hardware quantities
      const newQuote = await createNewVersion({ updatedHardwareQuantities: bomQuantityMap });
      
      toast({
        title: t('Offert uppdaterad från BOM', 'Quote updated from BOM'),
        description: t(`Version ${newQuote.version} skapad med uppdaterade antal.`, `Version ${newQuote.version} created with updated quantities.`),
      });
      navigate(`/portal/quotes/${newQuote.id}`);
    } catch (error: any) {
      toast({
        title: t('Kunde inte uppdatera från BOM', 'Failed to update from BOM'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsUpdatingFromBom(false);
    }
  };

  // Send quote via email
  const sendQuoteEmail = async () => {
    if (!quote?.customer_id || !quote?.customer?.name) {
      toast({ title: t('Kund krävs', 'Customer required'), description: t('Välj en kund innan du skickar', 'Select a customer before sending'), variant: 'destructive' });
      return;
    }

    setIsSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-quote-email', {
        body: { quote_id: id },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      queryClient.invalidateQueries({ queryKey: ['quote', id] });
      queryClient.invalidateQueries({ queryKey: ['quotes'] });
      queryClient.invalidateQueries({ queryKey: ['quote_events', id] });

      toast({ 
        title: t('Offert skickad!', 'Quote sent!'), 
        description: t(`Offert ${data.quote_number} skickad till ${data.recipient_email}`, `Quote ${data.quote_number} sent to ${data.recipient_email}`)
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

  // Create invoice from quote
  const createInvoiceFromQuote = async () => {
    if (!quote?.customer_id) {
      toast({ title: t('Kund krävs', 'Customer required'), description: t('Offerten måste ha en kund kopplad', 'Quote must have a customer attached'), variant: 'destructive' });
      return;
    }

    setIsCreatingInvoice(true);
    try {
      const lineItems = [
        ...hardwareLines.map(line => ({
          line_type: 'hardware',
          description: line.description,
          sku: line.original_sku_code || '',
          sku_id: line.sku_id,
          quantity: line.quantity,
          unit_price: line.unit_price_ex_vat ?? line.unit_price,
          category: 'Hardware',
        })),
        ...laborLines.map(line => ({
          line_type: 'labor',
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unit_price_ex_vat ?? line.unit_price,
        })),
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

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  const formatPrice = (value: number) => value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const currentVersion = quoteFamily.find(v => v.id === id);
  const isLatestVersion = currentVersion?.is_latest ?? true;
  const quoteStatus = quote?.status || 'draft';
  const isEditable = isLatestVersion && (quoteStatus === 'draft' || quoteStatus === 'revision_requested');
  const canSend = isLatestVersion && (quoteStatus === 'draft' || quoteStatus === 'revision_requested') && !!quote?.customer_id && hardwareLines.length > 0;
  const canCreateInvoice = quoteStatus === 'accepted' && !!quote?.customer_id;

  // Status badge helper
  const getStatusBadge = () => {
    switch (quoteStatus) {
      case 'draft':
        return <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>;
      case 'sent':
        return <Badge variant="default">{t('Skickad', 'Sent')}</Badge>;
      case 'viewed':
        return <Badge className="bg-blue-500/20 text-blue-700 border-0">{t('Visad', 'Viewed')}</Badge>;
      case 'accepted':
        return <Badge className="bg-green-500/20 text-green-700 border-0">{t('Accepterad', 'Accepted')}</Badge>;
      case 'declined':
        return <Badge variant="destructive">{t('Avvisad', 'Declined')}</Badge>;
      case 'revision_requested':
        return <Badge className="bg-amber-500/20 text-amber-700 border-0">{t('Ändring begärd', 'Revision requested')}</Badge>;
      case 'invoiced':
        return <Badge className="bg-primary/20 text-primary border-0">{t('Fakturerad', 'Invoiced')}</Badge>;
      case 'expired':
        return <Badge variant="secondary">{t('Utgången', 'Expired')}</Badge>;
      case 'cancelled':
        return <Badge variant="outline" className="text-muted-foreground">{t('Avbruten', 'Cancelled')}</Badge>;
      default:
        return <Badge variant="secondary">{quoteStatus}</Badge>;
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

        {/* Quote Info */}
        <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
          {quote && getStatusBadge()}
          {isEditable ? (
            <div className="flex items-center gap-2">
              <span>{t('Kund', 'Customer')}:</span>
              <Select
                value={quote?.customer_id || 'none'}
                onValueChange={(value) => updateQuoteCustomerMutation.mutate(value === 'none' ? null : value)}
              >
                <SelectTrigger className={`w-56 h-8 ${!quote?.customer_id ? 'border-destructive text-destructive' : ''}`}>
                  <SelectValue placeholder={t('Välj kund...', 'Select customer...')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('Ingen kund', 'No customer')}</SelectItem>
                  {customers.map((customer) => (
                    <SelectItem key={customer.id} value={customer.id!}>
                      {customer.name || customer.contact_name || t('Namnlös kund', 'Unnamed customer')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : quote?.customer?.name ? (
            <span>{t('Kund', 'Customer')}: <span className="text-foreground">{quote.customer.name}</span></span>
          ) : null}
          {quote?.bom?.project_name && (
            <span>{t('Projekt', 'Project')}: <span className="text-foreground">{quote.bom.project_name}</span></span>
          )}
          {quote?.quote_number && (
            <span>{t('Offert', 'Quote')}: <span className="text-foreground font-mono">{quote.quote_number}</span></span>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-4">
            {/* Hardware Section */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between py-4">
                <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
                  <span>{t('Hårdvara', 'Hardware')}</span>
                  {quote?.bom && (
                    <Badge variant="outline" className="font-mono text-xs">
                      BOM v{quote.bom_version ?? quote.bom.version}
                    </Badge>
                  )}
                </CardTitle>
                <div className="flex items-center gap-3 text-sm">
                  {quote?.bom_id && isEditable && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleUpdateFromBom}
                      disabled={isUpdatingFromBom || isCreatingVersion}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isUpdatingFromBom ? 'animate-spin' : ''}`} />
                      {t('Uppdatera från BOM', 'Update from BOM')}
                    </Button>
                  )}
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
                          <th className="px-4 pb-3 font-medium text-center" style={{ minWidth: '5rem' }}>{t('Antal', 'Qty')}</th>
                          <th className="px-4 pb-3 font-medium text-right" style={{ minWidth: '8rem' }}>{t('Å-pris', 'Unit price')}</th>
                          <th className="px-4 pb-3 font-medium text-right" style={{ minWidth: '8rem' }}>{t('Summa', 'Total')}</th>
                          <th className="px-4 pb-3 font-medium text-right" style={{ minWidth: '5rem' }}>{t('Marginal', 'Margin')}</th>
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
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="w-16 text-center mx-auto px-2 py-1.5 border border-border rounded-md bg-muted/50 text-sm cursor-not-allowed">
                                        {line.quantity}
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{t('Ändra antal via BOM (omfattningsändring)', 'Change quantity via BOM (scope change)')}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
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
                              <td className="px-4 py-4 text-right text-sm text-muted-foreground">
                                {(() => {
                                  const cost = line.cost_ex_vat_at_time;
                                  if (cost == null || cost === 0 || unitPrice === 0) return '—';
                                  const margin = ((unitPrice - cost) / unitPrice) * 100;
                                  return `${margin.toFixed(1)}%`;
                                })()}
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
                          {t('Antal ändras via BOM. Priser redigeras här. Använd "Uppdatera från BOM" för att synka antal.',
                             'Quantities are changed via BOM. Prices are edited here. Use "Update from BOM" to sync quantities.')}
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
                        <th className="px-4 pb-3 pt-2 font-medium text-center" style={{ minWidth: '5rem' }}>{t('Timmar', 'Hours')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-right" style={{ minWidth: '8rem' }}>{t('À-pris', 'Unit price')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-right" style={{ minWidth: '8rem' }}>{t('Summa', 'Total')}</th>
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
                        <th className="px-4 pb-3 pt-2 font-medium text-center" style={{ minWidth: '5rem' }}>{t('Antal', 'Qty')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-right" style={{ minWidth: '8rem' }}>{t('À-pris', 'Unit price')}</th>
                        <th className="px-4 pb-3 pt-2 font-medium text-right" style={{ minWidth: '8rem' }}>{t('Summa', 'Total')}</th>
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

                {/* Margin card - hardware only */}
                {hardwareLines.length > 0 && (
                  <div className="border-t border-border pt-4 space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground">{t('Marginal (hårdvara)', 'Margin (hardware)')}</h4>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{t('Kostnad', 'Cost')}:</span>
                      <span>{formatPrice(hardwareCostTotal)} kr</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{t('Försäljning', 'Revenue')}:</span>
                      <span>{formatPrice(hardwareTotal)} kr</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{t('Marginal (kr)', 'Margin (kr)')}:</span>
                      <span className="font-medium text-primary">+{formatPrice(hardwareMarginKr)} kr</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">{t('Marginal (%)', 'Margin (%)')}:</span>
                      <span className={`font-medium ${marginStatus.color}`}>{hardwareMarginPct.toFixed(1)}% — {marginStatus.label}</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div 
                        className="bg-primary h-2 rounded-full transition-all"
                        style={{ width: `${Math.min(100, hardwareMarginPct * 2)}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Action buttons */}
                <div className="pt-4 space-y-3">
                  <Button 
                    className="w-full"
                    onClick={sendQuoteEmail}
                    disabled={isSending || !canSend}
                  >
                    <Send className="h-4 w-4 mr-2" />
                    {isSending ? t('Skickar...', 'Sending...') : t('Skicka offert via e-post', 'Send quote via email')}
                  </Button>
                  {!quote?.customer_id && (
                    <p className="text-xs text-destructive text-center">
                      {t('Välj en kund för att skicka', 'Select a customer to send')}
                    </p>
                  )}
                  {quote?.customer_id && !isLatestVersion && (
                    <p className="text-xs text-muted-foreground text-center">
                      {t('Gå till senaste versionen för att skicka', 'Go to latest version to send')}
                    </p>
                  )}
                  <Button 
                    variant="success" 
                    className="w-full"
                    onClick={createInvoiceFromQuote}
                    disabled={isCreatingInvoice || !canCreateInvoice}
                  >
                    {isCreatingInvoice ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4 mr-2" />
                    )}
                    {t('Skapa faktura', 'Create Invoice')}
                  </Button>
                  {quoteStatus !== 'draft' && quoteStatus !== 'accepted' && !hasInvoice && (
                    <p className="text-xs text-muted-foreground text-center">
                      {t('Offerten måste vara accepterad för att skapa faktura', 'Quote must be accepted to create invoice')}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </PortalLayout>
  );
};

export default QuotePreparation;
