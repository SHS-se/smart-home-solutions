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
import { Card, CardContent } from '@/components/ui/card';
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
import { Plus, TestTube, Eye, Mail, Search } from 'lucide-react';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';
import { toast } from '@/hooks/use-toast';
import InvoiceActionsMenu from '@/components/portal/invoices/InvoiceActionsMenu';
import InvoicePdfModal from '@/components/portal/invoices/InvoicePdfModal';
import { cn } from '@/lib/utils';

interface Invoice {
  id: string;
  invoice_number: string | null;
  stripe_invoice_id: string | null;
  status: string;
  is_test: boolean;
  due_date: string | null;
  total: number | null;
  created_at: string;
  last_emailed_at: string | null;
  customer?: { name: string | null; contact_name: string | null } | null;
  bom?: { project_name: string } | null;
}

type SortColumn = 'invoice_number' | 'customer' | 'project' | 'created_at' | 'due_date' | 'total' | 'status';
type StatusFilter = 'draft' | 'open' | 'paid' | 'overdue' | 'void';
type ViewFilter = 'active' | 'include_void' | 'include_test' | 'all';

const getStatusBadge = (status: string, dueDate: string | null, t: (sv: string, en: string) => string) => {
  // Check for overdue
  if (status === 'open' && dueDate) {
    const due = new Date(dueDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (due < today) {
      return <Badge variant="destructive">{t('Förfallen', 'Overdue')}</Badge>;
    }
  }
  
  switch (status) {
    case 'draft':
      return <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>;
    case 'open':
      return <Badge variant="sky">{t('Öppen', 'Open')}</Badge>;
    case 'paid':
      return <Badge className="bg-green-600 text-white">{t('Betald', 'Paid')}</Badge>;
    case 'overdue':
      return <Badge variant="destructive">{t('Förfallen', 'Overdue')}</Badge>;
    case 'void':
      return <Badge variant="destructive">{t('Makulerad', 'Voided')}</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
};

// Helper to determine effective status (including overdue derivation)
const getEffectiveStatus = (invoice: Invoice): StatusFilter => {
  if (invoice.status === 'open' && invoice.due_date) {
    const due = new Date(invoice.due_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (due < today) {
      return 'overdue';
    }
  }
  return invoice.status as StatusFilter;
};

const InvoicesList: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { sortColumn, sortDirection, handleSort } = useTableSort<SortColumn>({ 
    defaultColumn: 'created_at', 
    defaultDirection: 'desc' 
  });

  const [activeFilters, setActiveFilters] = useState<StatusFilter[]>([]);
  const [pdfModalInvoice, setPdfModalInvoice] = useState<Invoice | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewFilter, setViewFilter] = useState<ViewFilter>('active');

  // Fetch invoices with computed totals
  // staleTime: 0 ensures we always refetch on mount/focus to defeat bfcache staleness
  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices'],
    queryFn: async () => {
      // Fetch invoices
      const { data: invoicesData, error: invoicesError } = await supabase
        .from('invoices')
        .select('*, customer:customers_with_identity!invoices_customer_id_fkey(name, contact_name), bom:boms(project_name)')
        .order('created_at', { ascending: false });
      if (invoicesError) throw invoicesError;

      // Fetch computed totals
      const { data: totalsData, error: totalsError } = await supabase
        .from('invoice_computed_totals')
        .select('*');
      if (totalsError) throw totalsError;

      // Create a map for quick lookup
      const totalsMap = new Map(totalsData?.map(t => [t.invoice_id, t]) || []);

      return invoicesData.map(inv => {
        const computed = totalsMap.get(inv.id);
        return {
          ...inv,
          // Use computed total
          total: computed?.total ?? 0,
        };
      }) as Invoice[];
    },
    enabled: isStaff,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // Mark/Unmark test mutation
  const markTestMutation = useMutation({
    mutationFn: async ({ invoiceId, markAsTest }: { invoiceId: string; markAsTest: boolean }) => {
      const { error } = await supabase
        .from('invoices')
        .update({ is_test: markAsTest })
        .eq('id', invoiceId);
      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast({ 
        title: variables.markAsTest 
          ? t('Faktura markerad som test', 'Invoice marked as test')
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

  // Calculate KPI stats
  const stats = useMemo(() => {
    const draft = invoices.filter(i => i.status === 'draft').length;
    const open = invoices.filter(i => {
      if (i.status !== 'open') return false;
      // Exclude overdue from open count
      if (i.due_date) {
        const due = new Date(i.due_date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (due < today) return false;
      }
      return true;
    }).length;
    const paid = invoices.filter(i => i.status === 'paid').length;
    const overdue = invoices.filter(i => {
      if (i.status !== 'open' || !i.due_date) return false;
      const due = new Date(i.due_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return due < today;
    }).length;
    const voided = invoices.filter(i => i.status === 'void').length;
    return { draft, open, paid, overdue, voided };
  }, [invoices]);

  // Toggle filter
  const toggleFilter = (filter: StatusFilter) => {
    setActiveFilters(prev => 
      prev.includes(filter) 
        ? prev.filter(f => f !== filter)
        : [...prev, filter]
    );
  };

  // Filter and sort invoices
  const filteredAndSortedInvoices = useMemo(() => {
    let filtered = invoices;
    
    // Apply view filter (test/void visibility)
    filtered = filtered.filter(invoice => {
      switch (viewFilter) {
        case 'active':
          // Hide test and voided invoices
          if (invoice.is_test) return false;
          if (invoice.status === 'void') return false;
          break;
        case 'include_void':
          // Show voided but hide test
          if (invoice.is_test) return false;
          break;
        case 'include_test':
          // Show test but hide voided
          if (invoice.status === 'void') return false;
          break;
        case 'all':
          // Show everything
          break;
      }
      return true;
    });
    
    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(invoice => {
        const matchesInvoiceNumber = invoice.invoice_number?.toLowerCase().includes(query);
        const matchesCustomer = invoice.customer?.name?.toLowerCase().includes(query);
        const matchesProject = invoice.bom?.project_name?.toLowerCase().includes(query);
        return matchesInvoiceNumber || matchesCustomer || matchesProject;
      });
    }
    
    // Apply status filters if any are active
    if (activeFilters.length > 0) {
      filtered = filtered.filter(invoice => {
        const effectiveStatus = getEffectiveStatus(invoice);
        return activeFilters.includes(effectiveStatus);
      });
    }
    
    return sortItems(filtered, sortColumn as keyof Invoice, sortDirection, {
      getValue: (invoice) => {
        switch (sortColumn) {
          case 'customer':
          return invoice.customer?.name || invoice.customer?.contact_name || '';
          case 'project':
            return invoice.bom?.project_name ?? '';
          case 'created_at':
            return new Date(invoice.created_at);
          case 'due_date':
            return invoice.due_date ? new Date(invoice.due_date) : new Date(0);
          case 'total':
            return invoice.total ?? 0;
          default:
            return invoice[sortColumn as keyof Invoice] as string;
        }
      },
    });
  }, [invoices, sortColumn, sortDirection, activeFilters, viewFilter, searchQuery]);

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  const formatPrice = (value: number | null) => {
    if (value === null) return '—';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
  };

  return (
    <PortalLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('Fakturor', 'Invoices')}</h1>
            <p className="text-muted-foreground">
              {t('Hantera och skicka fakturor till kunder', 'Manage and send invoices to customers')}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => navigate('/portal/invoices/new')}>
              <Plus className="h-4 w-4 mr-2" />
              {t('Skapa faktura', 'Create invoice')}
            </Button>
          </div>
        </div>

        {/* Search and View Filter */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('Sök faktura, kund eller projekt...', 'Search invoice, customer or project...')}
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
              <SelectItem value="include_void">{t('Inkl. makulerade', 'Include voided')}</SelectItem>
              <SelectItem value="include_test">{t('Inkl. test', 'Include test')}</SelectItem>
              <SelectItem value="all">{t('Visa alla', 'Show all')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Status Filter Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card 
            className={cn(
              "cursor-pointer transition-all hover:border-primary/50",
              activeFilters.includes('draft') && "ring-2 ring-primary border-primary"
            )}
            onClick={() => toggleFilter('draft')}
          >
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Utkast', 'Drafts')}</p>
              <p className="text-2xl font-bold">{stats.draft}</p>
            </CardContent>
          </Card>
          <Card 
            className={cn(
              "cursor-pointer transition-all hover:border-primary/50",
              activeFilters.includes('open') && "ring-2 ring-primary border-primary"
            )}
            onClick={() => toggleFilter('open')}
          >
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Öppna', 'Open')}</p>
              <p className="text-2xl font-bold text-primary">{stats.open}</p>
            </CardContent>
          </Card>
          <Card 
            className={cn(
              "cursor-pointer transition-all hover:border-primary/50",
              activeFilters.includes('paid') && "ring-2 ring-primary border-primary"
            )}
            onClick={() => toggleFilter('paid')}
          >
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Betalda', 'Paid')}</p>
              <p className="text-2xl font-bold text-green-600">{stats.paid}</p>
            </CardContent>
          </Card>
          <Card 
            className={cn(
              "cursor-pointer transition-all hover:border-destructive/50",
              activeFilters.includes('overdue') && "ring-2 ring-destructive border-destructive"
            )}
            onClick={() => toggleFilter('overdue')}
          >
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Förfallna', 'Overdue')}</p>
              <p className="text-2xl font-bold text-destructive">{stats.overdue}</p>
            </CardContent>
          </Card>
          <Card 
            className={cn(
              "cursor-pointer transition-all hover:border-muted-foreground/50",
              activeFilters.includes('void') && "ring-2 ring-muted-foreground border-muted-foreground"
            )}
            onClick={() => toggleFilter('void')}
          >
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Makulerad', 'Voided')}</p>
              <p className="text-2xl font-bold text-muted-foreground">{stats.voided}</p>
            </CardContent>
          </Card>
        </div>

        {/* Invoices Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead column="invoice_number" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('FAKTURANUMMER', 'INVOICE NUMBER')}
                </SortableTableHead>
                <SortableTableHead column="customer" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('KUND', 'CUSTOMER')}
                </SortableTableHead>
                <SortableTableHead column="project" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('PROJEKT', 'PROJECT')}
                </SortableTableHead>
                <SortableTableHead column="created_at" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('SKAPAD DATUM', 'CREATED DATE')}
                </SortableTableHead>
                <SortableTableHead column="due_date" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                  {t('FÖRFALLODATUM', 'DUE DATE')}
                </SortableTableHead>
                <SortableTableHead column="total" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort} className="text-right">
                  {t('TOTAL', 'TOTAL')}
                </SortableTableHead>
                <TableHead className="text-muted-foreground text-xs uppercase">
                  {t('STATUS', 'STATUS')}
                </TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase text-right">
                  {t('ÅTGÄRDER', 'ACTIONS')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    {t('Laddar...', 'Loading...')}
                  </TableCell>
                </TableRow>
              ) : filteredAndSortedInvoices.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    {invoices.length === 0 
                      ? t('Inga fakturor skapade ännu.', 'No invoices created yet.')
                      : t('Inga fakturor matchar din sökning.', 'No invoices match your search.')
                    }
                  </TableCell>
                </TableRow>
              ) : (
                filteredAndSortedInvoices.map(invoice => (
                  <TableRow 
                    key={invoice.id} 
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => {
                      if (invoice.status === 'draft') {
                        navigate(`/portal/invoices/new?id=${invoice.id}`);
                      } else {
                        navigate(`/portal/invoices/${invoice.invoice_number || invoice.id}`);
                      }
                    }}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium">
                          {invoice.invoice_number || '—'}
                        </span>
                        {invoice.is_test && (
                          <Badge variant="outline" className="text-xs">
                            <TestTube className="h-3 w-3 mr-1" />
                            {t('Test', 'Test')}
                          </Badge>
                        )}
                        {invoice.last_emailed_at && (
                          <Badge variant="outline" className="text-xs border-primary/50 text-primary">
                            <Mail className="h-3 w-3 mr-1" />
                            {t('Skickad', 'Sent')}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {invoice.customer?.name || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      {invoice.bom?.project_name || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(invoice.created_at), 'yyyy-MM-dd', { locale: sv })}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {invoice.due_date ? format(new Date(invoice.due_date), 'yyyy-MM-dd', { locale: sv }) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatPrice(invoice.total)}
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(invoice.status, invoice.due_date, t)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {invoice.stripe_invoice_id && (
                          <Button 
                            variant="ghost" 
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPdfModalInvoice(invoice);
                            }}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                        <InvoiceActionsMenu
                          isTest={invoice.is_test}
                          status={invoice.status}
                          onMarkTest={() => markTestMutation.mutate({ invoiceId: invoice.id, markAsTest: true })}
                          onUnmarkTest={() => markTestMutation.mutate({ invoiceId: invoice.id, markAsTest: false })}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* PDF modal */}
        {pdfModalInvoice && (
          <InvoicePdfModal
            open={!!pdfModalInvoice}
            onOpenChange={(open) => !open && setPdfModalInvoice(null)}
            stripeInvoiceId={pdfModalInvoice.stripe_invoice_id}
            invoiceNumber={pdfModalInvoice.invoice_number || pdfModalInvoice.id}
          />
        )}
      </div>
    </PortalLayout>
  );
};

export default InvoicesList;
