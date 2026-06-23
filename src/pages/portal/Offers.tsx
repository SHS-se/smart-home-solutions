import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, FileText, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import TableFilterBar from '@/components/portal/TableFilterBar';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { getQuoteStatusBadge } from '@/lib/quote-status-badge';

interface QuoteRow {
  id: string;
  quote_number: string | null;
  version: number;
  is_latest: boolean;
  status: string;
  created_at: string;
  updated_at: string;
  bom_project_name: string | null;
  total_inc_vat: number;
}

interface OffersProps {
  customerId?: string;
  isStaffView?: boolean;
  customerName?: string;
}

const Offers: React.FC<OffersProps> = ({ customerId: propCustomerId, isStaffView = false, customerName }) => {
  const { user, customerData, loading: authLoading, isStaff } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const resolvedCustomerId = propCustomerId || customerData?.id;

  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
  }, [user, authLoading, navigate]);

  useEffect(() => {
    const fetchQuotes = async () => {
      if (!resolvedCustomerId) return;
      setQuotesLoading(true);
      setError(null);

      try {
        let query = supabase
          .from('quotes')
          .select('id, quote_number, version, is_latest, status, created_at, updated_at, boms(project_name)')
          .eq('customer_id', resolvedCustomerId)
          .order('created_at', { ascending: false });

        // Customer view: hide draft/cancelled/superseded
        if (!isStaffView && !isStaff) {
          query = query
            .neq('status', 'draft')
            .neq('status', 'cancelled')
            .neq('status', 'superseded');
        }

        const { data: quotesData, error: quotesError } = await query;

        if (quotesError) throw quotesError;

        // Fetch computed totals
        const quoteIds = (quotesData || []).map(q => q.id);
        let totalsMap = new Map<string, number>();
        if (quoteIds.length > 0) {
          const { data: totalsData } = await supabase
            .from('quote_computed_totals')
            .select('quote_id, total_inc_vat')
            .in('quote_id', quoteIds);
          if (totalsData) {
            totalsMap = new Map(totalsData.map(t => [t.quote_id!, t.total_inc_vat ?? 0]));
          }
        }

        setQuotes((quotesData || []).map(q => ({
          id: q.id,
          quote_number: q.quote_number,
          version: q.version ?? 1,
          is_latest: q.is_latest ?? true,
          status: q.status,
          created_at: q.created_at,
          updated_at: q.updated_at,
          bom_project_name: (q as { boms?: { project_name?: string } }).boms?.project_name || null,
          total_inc_vat: totalsMap.get(q.id) ?? 0,
        })));
      } catch (err) {
        console.error('Error fetching quotes:', err);
        setError(t('Kunde inte hämta offerter.', 'Could not fetch offers.'));
      } finally {
        setQuotesLoading(false);
      }
    };

    if (!authLoading && resolvedCustomerId) {
      fetchQuotes();
    }
  }, [resolvedCustomerId, authLoading, isStaffView, isStaff, t]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('sv-SE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatAmount = (amount: number) => {
    return amount.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
  };

  const filteredQuotes = quotes.filter((quote) => {
    if (statusFilter !== 'all' && quote.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const matchesNumber = quote.quote_number?.toLowerCase().includes(query);
      const matchesProject = quote.bom_project_name?.toLowerCase().includes(query);
      if (!matchesNumber && !matchesProject) return false;
    }
    return true;
  });

  const handleRowClick = (quote: QuoteRow) => {
    if (isStaffView && propCustomerId) {
      navigate(`/portal/customers/${propCustomerId}/offers/${quote.id}`);
    } else {
      navigate(`/portal/offers/${quote.id}`);
    }
  };


  if (authLoading || quotesLoading) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </>
    );
  }

  // Status filter options: staff sees all, customer sees limited
  const showAllStatuses = isStaffView || isStaff;

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-medium">
            {isStaffView ? t('Offerter', 'Quotes') : t('Mina offerter', 'My Offers')}
          </h1>
        </div>

        {/* Filters */}
        <TableFilterBar
          filterValue={statusFilter}
          onFilterChange={setStatusFilter}
          filterOptions={[
            { value: 'all', label: t('Alla statusar', 'All statuses') },
            ...(showAllStatuses ? [{ value: 'draft', label: t('Utkast', 'Draft') }] : []),
            { value: 'sent', label: t('Skickad', 'Sent') },
            { value: 'viewed', label: t('Visad', 'Viewed') },
            { value: 'revision_requested', label: t('Ändring begärd', 'Revision requested') },
            { value: 'accepted', label: t('Accepterad', 'Accepted') },
            { value: 'declined', label: t('Avvisad', 'Declined') },
            { value: 'invoiced', label: t('Fakturerad', 'Invoiced') },
            { value: 'expired', label: t('Utgången', 'Expired') },
            ...(showAllStatuses ? [
              { value: 'cancelled', label: t('Avbruten', 'Cancelled') },
              { value: 'superseded', label: t('Ersatt', 'Superseded') },
            ] : []),
          ]}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchPlaceholder={t('Sök på offertnummer eller projekt...', 'Search by quote number or project...')}
        />

        <Card>
          <CardContent className="pt-6">
            {filteredQuotes.length === 0 ? (
              <div className="text-center py-12">
                <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">
                  {t('Inga offerter hittades.', 'No quotes found.')}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-primary">{t('Offert', 'Quote')}</TableHead>
                    <TableHead className="text-primary">{t('Projekt', 'Project')}</TableHead>
                    <TableHead className="text-primary">{t('Status', 'Status')}</TableHead>
                    <TableHead className="text-primary text-right">{t('Total ink. moms', 'Total inc. VAT')}</TableHead>
                    <TableHead className="text-primary">{t('Senaste aktivitet', 'Last activity')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredQuotes.map((quote) => (
                    <TableRow
                      key={quote.id}
                      className={`cursor-pointer hover:bg-muted/50 ${quote.status === 'revision_requested' ? 'bg-amber-500/5' : ''}`}
                      onClick={() => handleRowClick(quote)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium">
                            {quote.quote_number ? `#${quote.quote_number}` : <span className="text-muted-foreground italic">—</span>}
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
                        </div>
                      </TableCell>
                      <TableCell>
                        {quote.bom_project_name || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {getQuoteStatusBadge(quote.status, t)}
                          {quote.status === 'revision_requested' && (
                            <AlertCircle className="h-4 w-4 text-amber-500" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatAmount(quote.total_inc_vat)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(quote.updated_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
};

export default Offers;
