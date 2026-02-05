import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { Eye, Loader2, Search, TestTube } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';
import QuoteActionsMenu from '@/components/portal/quotes/QuoteActionsMenu';
import QuoteCancelDialog from '@/components/portal/quotes/QuoteCancelDialog';
import QuotePdfModal from '@/components/portal/quotes/QuotePdfModal';

interface Quote {
  id: string;
  quote_number: string | null;
  version: number;
  is_latest: boolean;
  is_test: boolean;
  computed_total_inc_vat: number;
  stripe_quote_id: string | null;
  status: string;
  created_at: string;
  customer?: { name: string | null; contact_name: string | null };
  bom?: { project_name: string };
}

type SortColumn = 'quote_number' | 'customer' | 'project' | 'total' | 'status' | 'created_at';
type ViewFilter = 'active' | 'include_cancelled' | 'include_test' | 'all';

const getStatusBadge = (status: string, t: (sv: string, en: string) => string) => {
  switch (status) {
    case 'draft':
      return <Badge variant="secondary">{t('Utkast', 'Draft')}</Badge>;
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
      return <Badge variant="secondary">{status}</Badge>;
  }
};

const QuotesList: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { sortColumn, sortDirection, handleSort } = useTableSort<SortColumn>({ 
    defaultColumn: 'created_at', 
    defaultDirection: 'desc' 
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [viewFilter, setViewFilter] = useState<ViewFilter>('active');
  
  // Cancel dialog state
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [quoteToCancel, setQuoteToCancel] = useState<Quote | null>(null);
  
  // PDF preview state
  const [downloadingPdfId, setDownloadingPdfId] = useState<string | null>(null);
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfQuoteNumber, setPdfQuoteNumber] = useState<string>('');
  const [isCancelling, setIsCancelling] = useState(false);

  // Fetch quotes with computed totals
  const { data: quotes = [], isLoading } = useQuery({
    queryKey: ['quotes'],
    queryFn: async () => {
      // Fetch quotes
      const { data: quotesData, error: quotesError } = await supabase
        .from('quotes')
        .select('*, customers:customers_with_identity!quotes_customer_id_fkey(name, contact_name), boms(project_name)')
        .order('created_at', { ascending: false });
      if (quotesError) throw quotesError;

      // Fetch computed totals
      const { data: totalsData, error: totalsError } = await supabase
        .from('quote_computed_totals')
        .select('*');
      if (totalsError) throw totalsError;

      // Create a map for quick lookup
      const totalsMap = new Map(totalsData?.map(t => [t.quote_id, t]) || []);

      return quotesData.map(q => {
        const computed = totalsMap.get(q.id);
        return {
          ...q,
          customer: (q as any).customers,
          bom: (q as any).boms,
          version: q.version ?? 1,
          is_latest: q.is_latest ?? true,
          is_test: (q as any).is_test ?? false,
          // Use computed totals
          computed_total_inc_vat: computed?.total_inc_vat ?? 0,
        };
      }) as Quote[];
    },
    enabled: isStaff,
  });

  // Filter quotes based on view filter
  const filteredQuotes = useMemo(() => {
    return quotes.filter(quote => {
      // View filter logic
      switch (viewFilter) {
        case 'active':
          // Hide test and cancelled quotes, show only latest versions
          if (quote.is_test) return false;
          if (quote.status === 'cancelled') return false;
          if (!quote.is_latest) return false;
          break;
        case 'include_cancelled':
          // Show cancelled but hide test, only latest
          if (quote.is_test) return false;
          if (!quote.is_latest) return false;
          break;
        case 'include_test':
          // Show test but hide cancelled, only latest
          if (quote.status === 'cancelled') return false;
          if (!quote.is_latest) return false;
          break;
        case 'all':
          // Show everything including all versions
          break;
      }

      // Search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesQuoteNumber = quote.quote_number?.toLowerCase().includes(query);
        const matchesCustomer = quote.customer?.name?.toLowerCase().includes(query);
        const matchesProject = quote.bom?.project_name?.toLowerCase().includes(query);
        if (!matchesQuoteNumber && !matchesCustomer && !matchesProject) return false;
      }

      return true;
    });
  }, [quotes, viewFilter, searchQuery]);

  // Sort quotes
  const sortedQuotes = useMemo(() => {
    return sortItems(filteredQuotes, sortColumn as keyof Quote, sortDirection, {
      getValue: (quote) => {
        switch (sortColumn) {
          case 'customer':
          return quote.customer?.name || quote.customer?.contact_name || '';
          case 'project':
            return quote.bom?.project_name ?? '';
          case 'total':
            return quote.computed_total_inc_vat;
          case 'created_at':
            return new Date(quote.created_at);
          default:
            return quote[sortColumn as keyof Quote] as string;
        }
      },
    });
  }, [filteredQuotes, sortColumn, sortDirection]);

  // Mark/Unmark test mutation
  const markTestMutation = useMutation({
    mutationFn: async ({ quoteId, markAsTest }: { quoteId: string; markAsTest: boolean }) => {
      const { data, error } = await supabase.functions.invoke('mark-quote-test', {
        body: { quote_id: quoteId, mark_as_test: markAsTest },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['quotes'] });
      toast({ 
        title: variables.markAsTest 
          ? t('Offert markerad som test', 'Quote marked as test')
          : t('Testmarkering borttagen', 'Test mark removed')
      });
    },
    onError: (error: Error) => {
      toast({ 
        title: t('Fel', 'Error'),
        description: error.message,
        variant: 'destructive'
      });
    },
  });

  // Cancel quote handler
  const handleCancelQuote = async (reason?: string) => {
    if (!quoteToCancel) return;
    
    setIsCancelling(true);
    try {
      const { data, error } = await supabase.functions.invoke('cancel-quote', {
        body: { quote_id: quoteToCancel.id, reason },
      });
      
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      queryClient.invalidateQueries({ queryKey: ['quotes'] });
      toast({ title: t('Offert avbruten', 'Quote cancelled') });
      setCancelDialogOpen(false);
      setQuoteToCancel(null);
    } catch (error: unknown) {
      const err = error as Error;
      toast({ 
        title: t('Kunde inte avbryta i Stripe. Inga ändringar gjordes.', 'Could not cancel in Stripe. No changes were made.'),
        description: err.message,
        variant: 'destructive'
      });
    } finally {
      setIsCancelling(false);
    }
  };

  // Preview PDF handler
  const handlePreviewPdf = async (quote: Quote) => {
    if (!quote.stripe_quote_id) return;
    
    setDownloadingPdfId(quote.id);
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
          body: JSON.stringify({ stripe_quote_id: quote.stripe_quote_id, is_test: quote.is_test }),
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

      // Set the signed URL and open the modal
      setPdfUrl(data.url);
      setPdfQuoteNumber(quote.quote_number || quote.stripe_quote_id || '');
      setShowPdfModal(true);
      
    } catch (error: unknown) {
      const err = error as Error;
      toast({ 
        title: t('Kunde inte ladda ner PDF', 'Failed to download PDF'),
        description: err.message,
        variant: 'destructive'
      });
    } finally {
      setDownloadingPdfId(null);
    }
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('Offerter', 'Quotes')}</h1>
          <p className="text-muted-foreground">
            {t('Hantera och skicka offerter till kunder', 'Manage and send quotes to customers')}
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('Sök offert, kund eller projekt...', 'Search quote, customer or project...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={viewFilter} onValueChange={(v) => setViewFilter(v as ViewFilter)}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t('Aktiva (standard)', 'Active (default)')}</SelectItem>
              <SelectItem value="include_cancelled">{t('Inkl. avbrutna', 'Include cancelled')}</SelectItem>
              <SelectItem value="include_test">{t('Inkl. test', 'Include test')}</SelectItem>
              <SelectItem value="all">{t('Visa alla', 'Show all')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Quotes Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead column="quote_number" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('Offert', 'Quote')}
                </SortableTableHead>
                <SortableTableHead column="customer" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('Kund', 'Customer')}
                </SortableTableHead>
                <SortableTableHead column="project" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('Projekt', 'Project')}
                </SortableTableHead>
                <SortableTableHead column="total" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort} className="text-right">
                  {t('Total', 'Total')}
                </SortableTableHead>
                <SortableTableHead column="status" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('Status', 'Status')}
                </SortableTableHead>
                <SortableTableHead column="created_at" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('Skapad', 'Created')}
                </SortableTableHead>
                <TableHead className="text-muted-foreground text-xs uppercase text-right">{t('Åtgärder', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    {t('Laddar...', 'Loading...')}
                  </TableCell>
                </TableRow>
              ) : sortedQuotes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    {quotes.length === 0 
                      ? t('Inga offerter skapade ännu. Skapa en BOM först.', 'No quotes created yet. Create a BOM first.')
                      : t('Inga offerter matchar din sökning.', 'No quotes match your search.')
                    }
                  </TableCell>
                </TableRow>
              ) : (
                sortedQuotes.map(quote => {
                  const totalWithVat = quote.computed_total_inc_vat ?? 0;
                  return (
                    <TableRow 
                      key={quote.id} 
                      className={`cursor-pointer hover:bg-muted/50 ${!quote.is_latest || quote.status === 'cancelled' ? 'opacity-60' : ''}`}
                      onClick={() => navigate(`/portal/quotes/${quote.id}`)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium">
                            {quote.quote_number ? `#${quote.quote_number}` : <span className="text-muted-foreground italic">Utkast</span>}
                          </span>
                          {quote.version > 1 && (
                            <Badge variant="outline" className="font-mono text-xs">
                              v{quote.version}
                            </Badge>
                          )}
                          {!quote.is_latest && (
                            <Badge variant="secondary" className="text-xs">
                              {t('Äldre', 'Old')}
                            </Badge>
                          )}
                          {quote.is_test && (
                            <Badge variant="outline" className="text-xs">
                              <TestTube className="h-3 w-3 mr-1" />
                              {t('Test', 'Test')}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {quote.customer?.name || quote.customer?.contact_name || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        {quote.bom?.project_name || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {totalWithVat.toLocaleString('sv-SE')} kr
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(quote.status, t)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(quote.created_at), 'PP', { locale: sv })}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <QuoteActionsMenu
                            isTest={quote.is_test}
                            status={quote.status}
                            onMarkTest={() => markTestMutation.mutate({ quoteId: quote.id, markAsTest: true })}
                            onUnmarkTest={() => markTestMutation.mutate({ quoteId: quote.id, markAsTest: false })}
                            onCancel={() => {
                              setQuoteToCancel(quote);
                              setCancelDialogOpen(true);
                            }}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Cancel Confirmation Dialog */}
      <QuoteCancelDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        quoteNumber={quoteToCancel?.quote_number ?? ''}
        onConfirm={handleCancelQuote}
        isLoading={isCancelling}
      />

      {/* PDF Preview Modal */}
      <QuotePdfModal
        open={showPdfModal}
        onOpenChange={(open) => {
          setShowPdfModal(open);
          if (!open) setPdfUrl(null);
        }}
        pdfUrl={pdfUrl}
        quoteNumber={pdfQuoteNumber}
      />
    </PortalLayout>
  );
};

export default QuotesList;
