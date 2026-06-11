import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ArrowLeft, ExternalLink, Send, Info, Loader2, AlertTriangle, Plus, Trash2, Save, RotateCcw } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { addDays, format, endOfDay } from 'date-fns';
import { sv, enUS } from 'date-fns/locale';
import { supersedeActiveQuotesInChain } from '@/lib/supersede-quotes';
import { toast } from '@/hooks/use-toast';
import QuoteVersionDropdown from '@/components/portal/quotes/QuoteVersionDropdown';
import { useQuoteVersioning } from '@/hooks/use-quote-versioning';
import { getQuoteStatusBadge } from '@/lib/quote-status-badge';
import { getEdgeFunctionErrorMessage } from '@/lib/edge-function-error';
import { getAuthenticatedFunctionHeaders } from '@/lib/supabase-function-auth';
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
  const { t, language } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isSending, setIsSending] = useState(false);
  const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
  const [expiryDays, setExpiryDays] = useState(7);
  
  const [isSaving, setIsSaving] = useState(false);
  const [showReissueDialog, setShowReissueDialog] = useState(false);
  const [reissueDate, setReissueDate] = useState<Date>(addDays(new Date(), 14));
  const [isReissuing, setIsReissuing] = useState(false);

  // Pending changes: { [lineId]: { field: value, ... } }
  const [pendingChanges, setPendingChanges] = useState<Record<string, Record<string, string | number>>>({});

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

  // Fetch quote with BOM info
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

  // Check if an invoice already exists for this quote
  const { data: linkedInvoice } = useQuery({
    queryKey: ['quote_invoice', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('invoices')
        .select('id')
        .eq('quote_id', id!)
        .limit(1)
        .maybeSingle();
      return data;
    },
    enabled: isStaff && !!id,
  });
  const hasInvoice = !!linkedInvoice;

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
  const defaultRowsInitialized = React.useRef(false);

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

  // --- Pending changes helpers ---
  const handleFieldChange = (lineId: string, field: string, value: string | number) => {
    setPendingChanges(prev => ({
      ...prev,
      [lineId]: { ...prev[lineId], [field]: value },
    }));
  };

  const getEffectiveUnitPrice = (line: QuoteLine): number => {
    if (pendingChanges[line.id]?.unit_price !== undefined) {
      return Number(pendingChanges[line.id].unit_price);
    }
    return line.unit_price_ex_vat ?? line.unit_price;
  };

  const getEffectiveQuantity = (line: QuoteLine): number => {
    if (pendingChanges[line.id]?.quantity !== undefined) {
      return Number(pendingChanges[line.id].quantity);
    }
    return line.quantity;
  };

  const getEffectiveDescription = (line: QuoteLine): string => {
    if (pendingChanges[line.id]?.description !== undefined) {
      return String(pendingChanges[line.id].description);
    }
    return line.description;
  };

  const hasUnsavedChanges = Object.keys(pendingChanges).length > 0;

  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [pendingNavigationPath, setPendingNavigationPath] = useState<string | null>(null);

  // Browser close/refresh warning
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  // Wrap navigate to intercept when unsaved changes exist
  const guardedNavigate = (path: string) => {
    if (hasUnsavedChanges) {
      setPendingNavigationPath(path);
      setShowUnsavedDialog(true);
    } else {
      navigate(path);
    }
  };

  // Save all pending changes to database
  const handleSaveChanges = async () => {
    const entries = Object.entries(pendingChanges);
    if (entries.length === 0) return;

    setIsSaving(true);
    try {
      await Promise.all(
        entries.map(async ([lineId, fields]) => {
          const updateData: Record<string, unknown> = {};
          for (const [field, val] of Object.entries(fields)) {
            updateData[field] = val;
            if (field === 'unit_price') {
              const numVal = typeof val === 'number' ? val : parseFloat(val as string) || 0;
              updateData.unit_price_ex_vat = numVal;
              updateData.unit_price_inc_vat = numVal * 1.25;
            }
          }
          const { error } = await supabase
            .from('quote_lines')
            .update(updateData)
            .eq('id', lineId);
          if (error) throw error;
        })
      );

      await queryClient.invalidateQueries({ queryKey: ['quote_lines', id] });
      setPendingChanges({});
      toast({ title: t('Ändringar sparade', 'Changes saved') });
    } catch (error: any) {
      toast({ title: t('Kunde inte spara', 'Failed to save'), description: error.message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

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

  // Calculate totals using effective (pending) values
  const hardwareTotal = hardwareLines.reduce((acc, l) => {
    return acc + (l.quantity * getEffectiveUnitPrice(l));
  }, 0);

  const laborTotal = laborLines.reduce((acc, l) => {
    return acc + (getEffectiveQuantity(l) * getEffectiveUnitPrice(l));
  }, 0);

  const travelTotal = travelLines.reduce((acc, l) => {
    return acc + (getEffectiveQuantity(l) * getEffectiveUnitPrice(l));
  }, 0);

  const subtotalExVat = hardwareTotal + laborTotal + travelTotal;
  
  const vatTotal = lines.reduce((acc, l) => {
    const qty = ['labor', 'travel'].includes(l.section) ? getEffectiveQuantity(l) : l.quantity;
    const price = getEffectiveUnitPrice(l);
    const lineExVat = qty * price;
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


  // Send quote via email
  const sendQuoteEmail = async () => {
    if (!quote?.customer_id || !quote?.customer?.name) {
      toast({ title: t('Kund krävs', 'Customer required'), description: t('Välj en kund innan du skickar', 'Select a customer before sending'), variant: 'destructive' });
      return;
    }

    setIsSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-quote-email', {
        body: { quote_id: id, expires_in_days: expiryDays },
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

      const { data, error, response } = await supabase.functions.invoke('create-draft-invoice', {
        headers: await getAuthenticatedFunctionHeaders(),
        body: {
          customer_id: quote.customer_id,
          bom_id: quote.bom_id,
          quote_id: quote.id,
          is_test: quote.is_test || false,
          line_items: lineItems,
        },
      });

      if (error) throw new Error(await getEdgeFunctionErrorMessage(error, response));

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
  const isSuperseded = quoteStatus === 'superseded';
  const isEditable = isLatestVersion && !isSuperseded && (quoteStatus === 'draft' || quoteStatus === 'revision_requested');
  const canSend = isLatestVersion && !isSuperseded && (quoteStatus === 'draft' || quoteStatus === 'revision_requested') && !!quote?.customer_id && hardwareLines.length > 0 && !hasUnsavedChanges;
  const canCreateInvoice = quoteStatus === 'accepted' && !!quote?.customer_id;
  const isExpired = quoteStatus === 'expired';

  // Reissue handler for expired quotes
  const handleReissue = async () => {
    if (!id || !quote) return;
    setIsReissuing(true);
    try {
      const rootId = (quote as any).parent_quote_id || quote.id;

      const { data: maxVersionData } = await supabase
        .from('quotes')
        .select('version')
        .or(`id.eq.${rootId},parent_quote_id.eq.${rootId}`)
        .order('version', { ascending: false })
        .limit(1)
        .single();

      const newVersion = (maxVersionData?.version || 1) + 1;

      await supabase
        .from('quotes')
        .update({ is_latest: false })
        .or(`id.eq.${rootId},parent_quote_id.eq.${rootId}`);

      const { data: existingLines } = await supabase
        .from('quote_lines')
        .select('*')
        .eq('quote_id', quote.id);

      const { data: newQuote, error: createError } = await supabase
        .from('quotes')
        .insert({
          version: newVersion,
          parent_quote_id: rootId,
          supersedes_quote_id: quote.id,
          is_latest: true,
          bom_id: quote.bom_id,
          bom_version: quote.bom_version,
          customer_id: quote.customer_id,
          status: 'draft',
          created_by: quote.created_by,
          is_test: (quote as any).is_test || false,
          expires_at: endOfDay(reissueDate).toISOString(),
        })
        .select()
        .single();

      if (createError) throw createError;

      if (existingLines && existingLines.length > 0) {
        const copiedLines = existingLines.map(line => ({
          quote_id: newQuote.id,
          section: line.section,
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unit_price,
          unit_price_ex_vat: line.unit_price_ex_vat,
          vat_rate: line.vat_rate,
          unit_price_inc_vat: line.unit_price_inc_vat,
          sku_id: line.sku_id,
          cost_ex_vat_at_time: line.cost_ex_vat_at_time,
          original_sku_name: line.original_sku_name,
          original_sku_code: line.original_sku_code,
          pricing_source: line.pricing_source,
          source_bom_id: line.source_bom_id,
          source_bom_item_id: line.source_bom_item_id,
          source_bom_version: line.source_bom_version,
        }));
        await supabase.from('quote_lines').insert(copiedLines);
      }

      await supabase
        .from('quotes')
        .update({
          status: 'superseded',
          superseded_by_quote_id: newQuote.id,
          superseded_at: new Date().toISOString(),
          is_latest: false,
        } as any)
        .eq('id', quote.id);

      if (quote.bom_id) {
        await supersedeActiveQuotesInChain({ newQuoteId: newQuote.id, bomId: quote.bom_id });
      }

      await supabase.from('quote_events').insert([
        {
          quote_id: quote.id,
          event_type: 'reissued',
          actor_type: 'staff',
          metadata: { reissued_as_quote_id: newQuote.id },
        },
        {
          quote_id: newQuote.id,
          event_type: 'created',
          actor_type: 'staff',
          metadata: { reissued_from_quote_id: quote.id },
        },
      ]);

      queryClient.invalidateQueries({ queryKey: ['quote_family'] });
      queryClient.invalidateQueries({ queryKey: ['quotes'] });
      setShowReissueDialog(false);
      
      toast({ title: t('Ny offert skapad', 'New quote created'), description: t('Du omdirigeras till den nya offerten', 'Redirecting to the new quote') });
      navigate(`/portal/quotes/${newQuote.id}`);
    } catch (error: any) {
      toast({ title: t('Kunde inte skapa ny offert', 'Failed to create new quote'), description: error.message, variant: 'destructive' });
    } finally {
      setIsReissuing(false);
    }
  };

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start gap-4">
          <button 
            onClick={() => guardedNavigate('/portal/quotes')}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground self-center"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold">{t('Offertförberedelse', 'Quote Preparation')}</h1>
              <QuoteVersionDropdown versions={quoteFamily} currentQuoteId={id || ''} />
              {getQuoteStatusBadge(quoteStatus, t)}
            </div>
            <p className="text-muted-foreground">
              {t('Organisera och förhandsgranska offert innan skicka till kund', 'Organize and preview quote before sending to customer')}
            </p>
            <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
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
          </div>
        </div>

        {/* Superseded banner */}
        {isSuperseded && (
          <Alert className="border-muted bg-muted/50">
            <Info className="h-4 w-4 text-muted-foreground" />
            <AlertDescription className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t(
                  `Denna offert har ersatts av en nyare version.`,
                  `This quote has been superseded by a newer version.`
                )}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if ((quote as any)?.superseded_by_quote_id) {
                    navigate(`/portal/quotes/${(quote as any).superseded_by_quote_id}`);
                  } else {
                    const latest = quoteFamily.find(v => v.is_latest);
                    if (latest) navigate(`/portal/quotes/${latest.id}`);
                  }
                }}
              >
                {t('Gå till senaste', 'Go to latest')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Supersedes banner - shown on quotes that replace another */}
        {!isSuperseded && (quote as any)?.supersedes_quote_id && (
          <Alert className="border-primary/30 bg-primary/5">
            <Info className="h-4 w-4 text-primary" />
            <AlertDescription className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t('Denna offert ersätter en tidigare offert.', 'This quote supersedes a previous quote.')}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(`/portal/quotes/${(quote as any).supersedes_quote_id}`)}
              >
                {t('Visa föregående', 'View previous')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Older version warning */}
        {!isLatestVersion && !isSuperseded && (
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
                          const effectivePrice = getEffectiveUnitPrice(line);
                          const lineTotal = line.quantity * effectivePrice;
                          
                          return (
                            <tr key={line.id} className="border-b border-border">
                              <td className="px-6 py-4">
                                <BlurCommitInput
                                  value={getEffectiveDescription(line)}
                                  onCommit={(value) => handleFieldChange(line.id, 'description', value)}
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
                                  value={effectivePrice}
                                  onCommit={(value) => handleFieldChange(line.id, 'unit_price', parseFloat(value) || 0)}
                                  className="w-24 text-right h-9"
                                  min={0}
                                  disabled={!isEditable}
                                />
                              </td>
                              <td className="px-4 py-4 text-right font-medium">{formatPrice(lineTotal)} kr</td>
                              <td className="px-4 py-4 text-right text-sm text-muted-foreground">
                                {(() => {
                                  const cost = line.cost_ex_vat_at_time;
                                  if (cost == null || cost === 0) return '—';
                                  const margin = ((effectivePrice - cost) / cost) * 100;
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
                        const effectivePrice = getEffectiveUnitPrice(line);
                        const effectiveQty = getEffectiveQuantity(line);
                        const lineTotal = effectiveQty * effectivePrice;
                        
                        return (
                          <tr key={line.id} className="border-b border-border">
                            <td className="px-6 py-3">
                              <BlurCommitInput
                                value={getEffectiveDescription(line)}
                                onCommit={(value) => handleFieldChange(line.id, 'description', value)}
                                className="h-9"
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <BlurCommitInput
                                type="number"
                                value={effectiveQty}
                                onCommit={(value) => handleFieldChange(line.id, 'quantity', parseFloat(value) || 0)}
                                className="w-20 text-center h-9"
                                min={0}
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <BlurCommitInput
                                type="number"
                                value={effectivePrice}
                                onCommit={(value) => handleFieldChange(line.id, 'unit_price', parseFloat(value) || 0)}
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
                        const effectivePrice = getEffectiveUnitPrice(line);
                        const effectiveQty = getEffectiveQuantity(line);
                        const lineTotal = effectiveQty * effectivePrice;
                        
                        return (
                          <tr key={line.id} className="border-b border-border">
                            <td className="px-6 py-3">
                              <BlurCommitInput
                                value={getEffectiveDescription(line)}
                                onCommit={(value) => handleFieldChange(line.id, 'description', value)}
                                className="h-9"
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <BlurCommitInput
                                type="number"
                                value={effectiveQty}
                                onCommit={(value) => handleFieldChange(line.id, 'quantity', parseFloat(value) || 0)}
                                className="w-20 text-center h-9"
                                min={0}
                                disabled={!isEditable}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <BlurCommitInput
                                type="number"
                                value={effectivePrice}
                                onCommit={(value) => handleFieldChange(line.id, 'unit_price', parseFloat(value) || 0)}
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

                {/* Quote validity */}
                <div className="border-t border-border pt-4 space-y-2">
                  <label className="text-sm font-medium text-muted-foreground">
                    {t('Offertens giltighetstid', 'Quote validity')}
                  </label>
                  {isEditable ? (
                    <div className="flex items-center gap-2">
                      <BlurCommitInput
                        type="number"
                        value={expiryDays}
                        onCommit={(value) => setExpiryDays(Math.max(1, parseInt(value) || 7))}
                        className="w-20 h-9 text-center"
                        min={1}
                      />
                      <span className="text-sm text-muted-foreground">{t('dagar', 'days')}</span>
                    </div>
                  ) : quote?.expires_at ? (
                    <div className="text-sm">
                      <span>
                        {t('Giltig till', 'Valid until')}{' '}
                        <span className="font-medium">
                          {new Date(quote.expires_at).toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' })}
                        </span>
                      </span>
                      {isExpired && (
                        <>
                          {' — '}
                          <button
                            onClick={() => setShowReissueDialog(true)}
                            className="inline-flex items-center gap-1 text-destructive font-semibold hover:underline cursor-pointer"
                            role="button"
                            tabIndex={0}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            {t('Utgången', 'Expired')}
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('Ej angiven', 'Not set')}</p>
                  )}
                </div>

                {/* Action buttons */}
                <div className="pt-4 space-y-3">
                  {isEditable && (
                    <Button 
                      data-testid="quote-save-button"
                      className="w-full bg-[#F6C573] text-foreground hover:bg-[#E5B463] disabled:bg-[#E8DCC4] disabled:text-muted-foreground"
                      size="lg"
                      onClick={handleSaveChanges}
                      disabled={!hasUnsavedChanges || isSaving}
                    >
                      <Save className="h-4 w-4 mr-2" />
                      {isSaving ? t('Sparar...', 'Saving...') : t('Spara ändringar', 'Save changes')}
                    </Button>
                  )}
                  <Button 
                    data-testid="quote-send-email-button"
                    className="w-full"
                    size="lg"
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
                    data-testid="quote-create-invoice-button"
                    variant="success" 
                    className="w-full"
                    size="lg"
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

      {/* Unsaved changes navigation dialog */}
      <Dialog open={showUnsavedDialog} onOpenChange={(open) => {
        if (!open) {
          setShowUnsavedDialog(false);
          setPendingNavigationPath(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Osparade ändringar', 'Unsaved changes')}</DialogTitle>
            <DialogDescription>
              {t(
                'Du har osparade ändringar. Vill du spara innan du lämnar?',
                'You have unsaved changes. Would you like to save before leaving?'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => {
              setShowUnsavedDialog(false);
              if (pendingNavigationPath) navigate(pendingNavigationPath);
              setPendingNavigationPath(null);
            }}>
              {t('Lämna utan att spara', 'Leave without saving')}
            </Button>
            <Button onClick={async () => {
              await handleSaveChanges();
              setShowUnsavedDialog(false);
              if (pendingNavigationPath) navigate(pendingNavigationPath);
              setPendingNavigationPath(null);
            }}>
              {t('Spara och lämna', 'Save and leave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reissue quote dialog */}
      <Dialog open={showReissueDialog} onOpenChange={setShowReissueDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Ge ut offert på nytt', 'Reissue quote')}</DialogTitle>
            <DialogDescription>
              {t(
                'En ny offert med nytt offertnummer skapas. Den gamla offerten markeras som ersatt.',
                'A new quote with a new quote number will be created. The old quote will be marked as superseded.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('Giltig till', 'Valid until')}</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left font-normal">
                    {format(reissueDate, 'PPP', { locale: language === 'sv' ? sv : enUS })}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={reissueDate}
                    onSelect={(date) => date && setReissueDate(date)}
                    disabled={(date) => date < new Date()}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowReissueDialog(false)} disabled={isReissuing}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button onClick={handleReissue} disabled={isReissuing}>
              {isReissuing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Skapa ny offert', 'Create new quote')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default QuotePreparation;
