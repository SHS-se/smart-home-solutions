import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft, FileText, Search, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
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

const CustomerViewOffers: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading, error } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !isStaff) navigate('/portal');
  }, [user, isStaff, authLoading, navigate]);

  useEffect(() => {
    const fetchQuotes = async () => {
      if (!customerId) return;
      setQuotesLoading(true);

      try {
        // Fetch quotes with BOM project name
        const { data: quotesData, error: quotesError } = await supabase
          .from('quotes')
          .select('id, quote_number, version, is_latest, status, created_at, updated_at, boms(project_name)')
          .eq('customer_id', customerId)
          .order('created_at', { ascending: false });

        if (quotesError) throw quotesError;

        // Fetch computed totals for these quotes
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
          bom_project_name: (q as any).boms?.project_name || null,
          total_inc_vat: totalsMap.get(q.id) ?? 0,
        })));
      } catch (err) {
        console.error('Error fetching quotes:', err);
      } finally {
        setQuotesLoading(false);
      }
    };

    if (!customerLoading && customerId) {
      fetchQuotes();
    }
  }, [customerId, customerLoading]);

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
    // Status filter
    if (statusFilter !== 'all' && quote.status !== statusFilter) return false;

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const matchesNumber = quote.quote_number?.toLowerCase().includes(query);
      const matchesProject = quote.bom_project_name?.toLowerCase().includes(query);
      if (!matchesNumber && !matchesProject) return false;
    }

    return true;
  });

  if (authLoading || customerLoading) {
    return (
      <CustomerViewLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </CustomerViewLayout>
    );
  }

  if (error || !customerData) {
    return (
      <CustomerViewLayout>
        <Alert variant="destructive">
          <AlertDescription>
            {error || t('Kunde inte hitta kunden.', 'Customer not found.')}
          </AlertDescription>
        </Alert>
      </CustomerViewLayout>
    );
  }

  return (
    <CustomerViewLayout>
      <div className="space-y-6">
        {/* Back link */}
        <Link
          to={`/portal/customers/${customerId}/overview`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till kundöversikt', 'Back to customer overview')}
        </Link>

        <div>
          <h1 className="text-3xl font-medium">{t('Offerter', 'Quotes')}</h1>
          <p className="text-muted-foreground">
            {customerData.name || t('Namnlös kund', 'Unnamed customer')}
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder={t('Alla statusar', 'All statuses')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Alla statusar', 'All statuses')}</SelectItem>
              <SelectItem value="draft">{t('Utkast', 'Draft')}</SelectItem>
              <SelectItem value="sent">{t('Skickad', 'Sent')}</SelectItem>
              <SelectItem value="viewed">{t('Visad', 'Viewed')}</SelectItem>
              <SelectItem value="revision_requested">{t('Ändring begärd', 'Revision requested')}</SelectItem>
              <SelectItem value="accepted">{t('Accepterad', 'Accepted')}</SelectItem>
              <SelectItem value="declined">{t('Avvisad', 'Declined')}</SelectItem>
              <SelectItem value="invoiced">{t('Fakturerad', 'Invoiced')}</SelectItem>
              <SelectItem value="expired">{t('Utgången', 'Expired')}</SelectItem>
              <SelectItem value="cancelled">{t('Avbruten', 'Cancelled')}</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex-1">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('Sök på offertnummer eller projekt...', 'Search by quote number or project...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        </div>

        <Card>
          <CardContent className="pt-6">
            {quotesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : filteredQuotes.length === 0 ? (
              <div className="text-center py-12">
                <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">{t('Inga offerter hittades.', 'No quotes found.')}</p>
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
                      onClick={() => navigate(`/portal/customers/${customerId}/offers/${quote.id}`)}
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
    </CustomerViewLayout>
  );
};

export default CustomerViewOffers;
