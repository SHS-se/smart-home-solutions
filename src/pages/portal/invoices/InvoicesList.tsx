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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { Plus, TestTube, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';
import { toast } from '@/hooks/use-toast';
import InvoiceActionsMenu from '@/components/portal/invoices/InvoiceActionsMenu';

interface Invoice {
  id: string;
  invoice_number: string | null;
  stripe_invoice_id: string | null;
  status: string;
  is_test: boolean;
  due_date: string | null;
  total: number | null;
  created_at: string;
  customer?: { org_name: string | null } | null;
  bom?: { project_name: string } | null;
}

type SortColumn = 'invoice_number' | 'customer' | 'project' | 'created_at' | 'due_date' | 'total' | 'status';

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
      return <Badge variant="secondary">{t('Öppen', 'Open')}</Badge>;
    case 'paid':
      return <Badge className="bg-green-600 text-white">{t('Betald', 'Paid')}</Badge>;
    case 'overdue':
      return <Badge variant="destructive">{t('Förfallen', 'Overdue')}</Badge>;
    case 'void':
      return <Badge variant="outline" className="text-muted-foreground">{t('Makulerad', 'Voided')}</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
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

  

  // Fetch invoices
  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('invoices')
        .select('*, customer:customers(org_name), bom:boms(project_name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as Invoice[];
    },
    enabled: isStaff,
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
    const total = invoices.length;
    const draft = invoices.filter(i => i.status === 'draft').length;
    const open = invoices.filter(i => i.status === 'open').length;
    const paid = invoices.filter(i => i.status === 'paid').length;
    const overdue = invoices.filter(i => {
      if (i.status !== 'open' || !i.due_date) return false;
      const due = new Date(i.due_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return due < today;
    }).length;
    return { total, draft, open, paid, overdue };
  }, [invoices]);

  // Sort invoices
  const sortedInvoices = useMemo(() => {
    return sortItems(invoices, sortColumn as keyof Invoice, sortDirection, {
      getValue: (invoice) => {
        switch (sortColumn) {
          case 'customer':
            return invoice.customer?.org_name ?? '';
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
  }, [invoices, sortColumn, sortDirection]);

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  const formatPrice = (value: number | null) => {
    if (value === null) return '—';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
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

        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Totalt', 'Total')}</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Utkast', 'Drafts')}</p>
              <p className="text-2xl font-bold">{stats.draft}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Öppna', 'Open')}</p>
              <p className="text-2xl font-bold text-primary">{stats.open}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Betalda', 'Paid')}</p>
              <p className="text-2xl font-bold text-green-600">{stats.paid}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t('Förfallna', 'Overdue')}</p>
              <p className="text-2xl font-bold text-destructive">{stats.overdue}</p>
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
              ) : sortedInvoices.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    {t('Inga fakturor skapade ännu.', 'No invoices created yet.')}
                  </TableCell>
                </TableRow>
              ) : (
                sortedInvoices.map(invoice => (
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
                      </div>
                    </TableCell>
                    <TableCell>
                      {invoice.customer?.org_name || <span className="text-muted-foreground">—</span>}
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
                            asChild
                            onClick={(e) => e.stopPropagation()}
                          >
                            <a 
                              href={`https://dashboard.stripe.com/invoices/${invoice.stripe_invoice_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
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
      </div>
    </PortalLayout>
  );
};

export default InvoicesList;
