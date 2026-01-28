import React, { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { FileText, Trash2, ExternalLink } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';

interface Quote {
  id: string;
  quote_number: string;
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
      })) as Quote[];
    },
    enabled: isStaff,
  });

  // Sort quotes
  const sortedQuotes = useMemo(() => {
    return sortItems(quotes, sortColumn as keyof Quote, sortDirection, {
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
  }, [quotes, sortColumn, sortDirection]);

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

        {/* Quotes Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead column="quote_number" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('Offert ID', 'Quote ID')}
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
              ) : quotes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    {t('Inga offerter skapade ännu. Skapa en BOM först.', 'No quotes created yet. Create a BOM first.')}
                  </TableCell>
                </TableRow>
              ) : (
                sortedQuotes.map(quote => {
                  const total = quote.hardware_total + quote.labor_total + quote.travel_total;
                  const totalWithVat = total * 1.25;
                  return (
                    <TableRow key={quote.id}>
                      <TableCell>
                        <Link 
                          to={`/portal/quotes/${quote.id}`}
                          className="font-mono font-medium hover:text-primary"
                        >
                          #{quote.quote_number}
                        </Link>
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
