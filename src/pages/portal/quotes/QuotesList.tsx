import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
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
import { FileText, Trash2, ExternalLink, Search } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';

interface Quote {
  id: string;
  quote_number: string;
  version: number;
  is_latest: boolean;
  hardware_total: number;
  labor_total: number;
  travel_total: number;
  stripe_quote_id: string | null;
  status: string;
  created_at: string;
  customer?: { org_name: string | null };
  bom?: { project_name: string };
}

type SortColumn = 'quote_number' | 'customer' | 'project' | 'total' | 'status' | 'created_at';
type StatusFilter = 'all' | 'draft' | 'sent' | 'accepted' | 'declined' | 'latest';

const getStatusBadge = (status: string) => {
  switch (status) {
    case 'draft':
      return <Badge variant="secondary">Utkast</Badge>;
    case 'sent':
      return <Badge variant="default">Skickad</Badge>;
    case 'accepted':
      return <Badge className="bg-primary text-primary-foreground">Accepterad</Badge>;
    case 'declined':
      return <Badge variant="destructive">Avvisad</Badge>;
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('latest');

  // Fetch quotes
  const { data: quotes = [], isLoading } = useQuery({
    queryKey: ['quotes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('*, customers(org_name), boms(project_name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data.map(q => ({
        ...q,
        customer: (q as any).customers,
        bom: (q as any).boms,
        version: q.version ?? 1,
        is_latest: q.is_latest ?? true,
      })) as Quote[];
    },
    enabled: isStaff,
  });

  // Filter quotes
  const filteredQuotes = useMemo(() => {
    return quotes.filter(quote => {
      // Status filter
      if (statusFilter === 'latest') {
        if (!quote.is_latest) return false;
      } else if (statusFilter !== 'all') {
        if (quote.status !== statusFilter) return false;
      }

      // Search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesQuoteNumber = quote.quote_number.toLowerCase().includes(query);
        const matchesCustomer = quote.customer?.org_name?.toLowerCase().includes(query);
        const matchesProject = quote.bom?.project_name?.toLowerCase().includes(query);
        if (!matchesQuoteNumber && !matchesCustomer && !matchesProject) return false;
      }

      return true;
    });
  }, [quotes, statusFilter, searchQuery]);

  // Sort quotes
  const sortedQuotes = useMemo(() => {
    return sortItems(filteredQuotes, sortColumn as keyof Quote, sortDirection, {
      getValue: (quote) => {
        switch (sortColumn) {
          case 'customer':
            return quote.customer?.org_name ?? '';
          case 'project':
            return quote.bom?.project_name ?? '';
          case 'total':
            return quote.hardware_total + quote.labor_total + quote.travel_total;
          case 'created_at':
            return new Date(quote.created_at);
          default:
            return quote[sortColumn as keyof Quote] as string;
        }
      },
    });
  }, [filteredQuotes, sortColumn, sortDirection]);

  // Delete quote mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('quotes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quotes'] });
      toast({ title: t('Offert raderad', 'Quote deleted') });
    },
  });

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
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">{t('Senaste versioner', 'Latest versions')}</SelectItem>
              <SelectItem value="all">{t('Alla versioner', 'All versions')}</SelectItem>
              <SelectItem value="draft">{t('Utkast', 'Draft')}</SelectItem>
              <SelectItem value="sent">{t('Skickade', 'Sent')}</SelectItem>
              <SelectItem value="accepted">{t('Accepterade', 'Accepted')}</SelectItem>
              <SelectItem value="declined">{t('Avvisade', 'Declined')}</SelectItem>
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
                  const total = quote.hardware_total + quote.labor_total + quote.travel_total;
                  const totalWithVat = total * 1.25;
                  return (
                    <TableRow key={quote.id} className={!quote.is_latest ? 'opacity-60' : ''}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Link 
                            to={`/portal/quotes/${quote.id}`}
                            className="font-mono font-medium hover:text-primary"
                          >
                            #{quote.quote_number}
                          </Link>
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
                        {quote.customer?.org_name || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        {quote.bom?.project_name || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {totalWithVat.toLocaleString('sv-SE')} kr
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(quote.status)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(quote.created_at), 'PP', { locale: sv })}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="icon" asChild>
                            <Link to={`/portal/quotes/${quote.id}`}>
                              <FileText className="h-4 w-4" />
                            </Link>
                          </Button>
                          {quote.stripe_quote_id && (
                            <Button variant="ghost" size="icon" asChild>
                              <a 
                                href={`https://dashboard.stripe.com/quotes/${quote.stripe_quote_id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            </Button>
                          )}
                          {quote.status === 'draft' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                if (confirm(t('Radera denna offert?', 'Delete this quote?'))) {
                                  deleteMutation.mutate(quote.id);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
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
    </PortalLayout>
  );
};

export default QuotesList;
