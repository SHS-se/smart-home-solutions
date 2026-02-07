import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
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
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';

type QuoteSortColumn = 'created_at' | 'quote_number' | 'total_inc_vat' | 'status';

interface Quote {
  id: string;
  quote_number: string | null;
  status: string;
  created_at: string;
  version: number;
  is_latest: boolean;
  parent_quote_id: string | null;
  bom_id: string | null;
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

  const { sortColumn, sortDirection, handleSort } = useTableSort<QuoteSortColumn>({
    defaultColumn: 'created_at',
    defaultDirection: 'desc',
  });

  // Group by quote chain and pick only the latest revision per chain
  const latestPerChain = useMemo(() => {
    const chains = new Map<string, Quote[]>();
    quotes.forEach(q => {
      const chainId = q.parent_quote_id || q.id;
      if (!chains.has(chainId)) chains.set(chainId, []);
      chains.get(chainId)!.push(q);
    });
    return Array.from(chains.values()).map(group =>
      group.reduce((latest, q) => q.version > latest.version ? q : latest)
    );
  }, [quotes]);

  const sortedOffers = useMemo(() => {
    return sortItems(latestPerChain, sortColumn as keyof Quote, sortDirection, {
      getValue: (quote) => {
        switch (sortColumn) {
          case 'created_at':
            return quote.created_at ? new Date(quote.created_at) : null;
          case 'quote_number':
            return quote.quote_number ?? '';
          case 'total_inc_vat':
            return quote.total_inc_vat ?? 0;
          case 'status':
            return quote.status ?? '';
          default:
            return null;
        }
      },
    });
  }, [latestPerChain, sortColumn, sortDirection]);

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
        // Fetch quotes
        const { data, error: fetchError } = await supabase
          .from('quotes')
          .select(`
            id,
            quote_number,
            status,
            created_at,
            version,
            is_latest,
            parent_quote_id,
            bom_id,
            bom:boms(project_name)
          `)
          .eq('customer_id', customerData.id)
          .eq('is_test', customerData.is_test ?? false)
          .neq('status', 'draft')
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false });

        if (fetchError) throw fetchError;

        // Fetch computed totals
        const quoteIds = (data || []).map((q: any) => q.id);
        let totalsMap = new Map<string, number>();
        
        if (quoteIds.length > 0) {
          const { data: totals } = await supabase
            .from('quote_computed_totals')
            .select('quote_id, total_inc_vat')
            .in('quote_id', quoteIds);
          
          if (totals) {
            totals.forEach(t => {
              if (t.quote_id) totalsMap.set(t.quote_id, t.total_inc_vat || 0);
            });
          }
        }

        const mappedQuotes: Quote[] = (data || []).map((q: any) => ({
          ...q,
          total_inc_vat: totalsMap.get(q.id) ?? null,
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

  const formatAmount = (amount: number | null) => {
    if (amount === null || amount === undefined) return '-';
    const formatted = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
    return `${formatted} kr`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
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
      default:
        return <Badge variant="secondary">{status}</Badge>;
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
            {sortedOffers.length === 0 ? (
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
                    <TableHead className="text-primary">
                      {t('Projekt', 'Project')}
                    </TableHead>
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
                      className="text-primary text-right"
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedOffers.map((quote) => (
                    <TableRow
                      key={quote.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => navigate(`/portal/offers/${quote.id}`)}
                    >
                      <TableCell>
                        {new Date(quote.created_at).toLocaleDateString('sv-SE')}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {quote.bom?.project_name || '—'}
                      </TableCell>
                      <TableCell className="font-medium font-mono">
                        {quote.quote_number || '—'}
                        {quote.version > 1 && (
                          <span className="text-muted-foreground ml-1 text-xs">v{quote.version}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatAmount(quote.total_inc_vat)}
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(quote.status)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default Offers;
