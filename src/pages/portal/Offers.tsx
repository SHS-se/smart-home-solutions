import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Eye } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import PortalLayout from '@/components/portal/PortalLayout';
import OfferPdfModal from '@/components/portal/offers/OfferPdfModal';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';

type QuoteSortColumn = 'created_at' | 'quote_number' | 'total_inc_vat' | 'status';

interface Quote {
  id: string;
  quote_number: string;
  status: string;
  stripe_status: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  is_latest: boolean;
  bom_id: string | null;
  stripe_quote_id: string | null;
  bom: {
    project_name: string;
  } | null;
  total_inc_vat: number | null;
}

const Offers: React.FC = () => {
  const { user, customerData, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewQuote, setPreviewQuote] = useState<Quote | null>(null);

  const { sortColumn, sortDirection, handleSort } = useTableSort<QuoteSortColumn>({
    defaultColumn: 'created_at',
    defaultDirection: 'desc',
  });

  const sortedQuotes = useMemo(() => {
    return sortItems(quotes, sortColumn as keyof Quote, sortDirection, {
      getValue: (quote) => {
        switch (sortColumn) {
          case 'created_at':
            return quote.created_at ? new Date(quote.created_at) : null;
          case 'quote_number':
            return quote.quote_number ?? '';
          case 'total_inc_vat':
            return quote.total_inc_vat ?? 0;
          case 'status':
            return (quote.stripe_status || quote.status) ?? '';
          default:
            return null;
        }
      },
    });
  }, [quotes, sortColumn, sortDirection]);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    const fetchQuotes = async () => {
      if (!customerData?.id) return;
      setLoading(true);
      setError(null);

      try {
        const { data, error: fetchError } = await supabase
          .from('quotes')
          .select(`
            id,
            quote_number,
            status,
            stripe_status,
            created_at,
            updated_at,
            version,
            is_latest,
            bom_id,
            stripe_quote_id,
            bom:boms(project_name)
          `)
          .eq('customer_id', customerData.id)
          .eq('is_test', customerData.is_test ?? false)
          .neq('status', 'draft')
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false });

        if (fetchError) throw fetchError;

        // Fetch totals from Stripe for quotes with stripe_quote_id
        const quoteIds = (data || []).map((q: any) => q.id);
        const totalsByQuoteId = new Map<string, number>();

        if (quoteIds.length > 0) {
          const { data: stripeData, error: stripeError } = await supabase.functions.invoke('get-stripe-quote-totals', {
            body: { quote_ids: quoteIds },
          });

          if (!stripeError && stripeData?.totals) {
            Object.entries(stripeData.totals).forEach(([quoteId, info]: [string, any]) => {
              // Stripe returns amount in öre (cents), convert to SEK
              if (info?.amount_total) {
                totalsByQuoteId.set(quoteId, info.amount_total / 100);
              }
            });
          }
        }

        const mappedQuotes: Quote[] = (data || []).map((q: any) => ({
          ...q,
          total_inc_vat: totalsByQuoteId.get(q.id) ?? null,
        }));

        setQuotes(mappedQuotes);
      } catch (err) {
        console.error('Error fetching quotes:', err);
        setError(t('Kunde inte hämta offerter.', 'Could not fetch offers.'));
      } finally {
        setLoading(false);
      }
    };

    if (!authLoading && customerData) {
      fetchQuotes();
    }
  }, [customerData, authLoading, t]);

  const handlePreviewPdf = (quote: Quote) => {
    if (!quote.stripe_quote_id) return;
    setPreviewQuote(quote);
  };

  const formatAmount = (amount: number | null) => {
    if (amount === null || amount === undefined) return '-';
    const formatted = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
    return `${formatted} SEK`;
  };

  const getStatusBadge = (status: string, stripeStatus: string | null) => {
    const displayStatus = stripeStatus || status;
    
    switch (displayStatus) {
      case 'open':
        return <Badge variant="outline">{t('Öppen', 'Open')}</Badge>;
      case 'accepted':
        return <Badge className="bg-energy/30 text-energy-darker border-0">{t('Accepterad', 'Accepted')}</Badge>;
      case 'canceled':
      case 'cancelled':
        return <Badge variant="secondary">{t('Avbruten', 'Cancelled')}</Badge>;
      case 'draft':
        return <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>;
      default:
        return <Badge variant="secondary">{displayStatus}</Badge>;
    }
  };

  if (authLoading || loading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  if (error) {
    return (
      <PortalLayout>
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-3xl font-medium">{t('Mina offerter', 'My Offers')}</h1>

        <Card>
          <CardHeader>
            <CardTitle>{t('Offerter', 'Offers')}</CardTitle>
            <CardDescription>
              {t('Dina offerter och prisförslag.', 'Your offers and price proposals.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {quotes.length === 0 ? (
              <p className="text-center text-muted-foreground py-12">
                {t('Du har inga offerter ännu.', 'You have no offers yet.')}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead<QuoteSortColumn>
                      column="created_at"
                      currentColumn={sortColumn}
                      currentDirection={sortDirection}
                      onSort={handleSort}
                      className="text-primary"
                    >
                      {t('Datum', 'Date')}
                    </SortableTableHead>
                    <SortableTableHead<QuoteSortColumn>
                      column="quote_number"
                      currentColumn={sortColumn}
                      currentDirection={sortDirection}
                      onSort={handleSort}
                      className="text-primary"
                    >
                      {t('Offertnummer', 'Quote Number')}
                    </SortableTableHead>
                    <SortableTableHead<QuoteSortColumn>
                      column="total_inc_vat"
                      currentColumn={sortColumn}
                      currentDirection={sortDirection}
                      onSort={handleSort}
                      className="text-right text-primary"
                    >
                      {t('Summa', 'Total')}
                    </SortableTableHead>
                    <SortableTableHead<QuoteSortColumn>
                      column="status"
                      currentColumn={sortColumn}
                      currentDirection={sortDirection}
                      onSort={handleSort}
                      className="text-primary"
                    >
                      {t('Status', 'Status')}
                    </SortableTableHead>
                    <TableHead className="text-primary">{t('Åtgärder', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedQuotes.map((quote) => (
                    <TableRow key={quote.id}>
                      <TableCell>
                        {new Date(quote.created_at).toLocaleDateString('sv-SE')}
                      </TableCell>
                      <TableCell className="font-medium">
                        {quote.quote_number}
                        {quote.version > 1 && (
                          <span className="text-muted-foreground ml-1">v{quote.version}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatAmount(quote.total_inc_vat)}
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(quote.status, quote.stripe_status)}
                      </TableCell>
                      <TableCell className="text-right">
                        {quote.stripe_quote_id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handlePreviewPdf(quote)}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <OfferPdfModal
        open={!!previewQuote}
        onOpenChange={(open) => !open && setPreviewQuote(null)}
        quoteId={previewQuote?.id ?? null}
        quoteNumber={previewQuote?.quote_number ?? ''}
      />
    </PortalLayout>
  );
};

export default Offers;
