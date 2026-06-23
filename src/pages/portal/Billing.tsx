import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, CreditCard, CheckCircle, AlertCircle, Eye, FileText } from 'lucide-react';
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
import TableFilterBar from '@/components/portal/TableFilterBar';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';
import InvoicePdfModal from '@/components/portal/invoices/InvoicePdfModal';

type InvoiceSortColumn = 'issued_at' | 'due_date' | 'invoice_number' | 'computed_total' | 'status';

interface Invoice {
  id: string;
  invoice_number: string | null;
  issued_at: string | null;
  due_date: string | null;
  currency: string | null;
  status: string | null;
  is_test?: boolean;
  computed_total: number | null;
}

interface SubscriptionStatus {
  subscribed: boolean;
  subscription_end: string | null;
  cancel_at_period_end?: boolean;
}

interface BillingProps {
  customerId?: string;
  isStaffView?: boolean;
  customerName?: string;
}

const Billing: React.FC<BillingProps> = ({ customerId: propCustomerId, isStaffView = false, customerName }) => {
  const { user, customerData, loading, isStaff } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const resolvedCustomerId = propCustomerId || customerData?.id;
  
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [viewFilter, setViewFilter] = useState<string>('all');

  const { sortColumn, sortDirection, handleSort } = useTableSort<InvoiceSortColumn>({
    defaultColumn: 'issued_at',
    defaultDirection: 'desc',
  });

  // Filter invoices by status and search query
  const filteredInvoices = useMemo(() => {
    let filtered = invoices;

    // Apply status filter
    if (viewFilter === 'all') {
      // For customers, hide voided invoices even in "all" view
      if (!isStaffView) {
        filtered = filtered.filter((inv) => inv.status?.toLowerCase() !== 'void');
      }
    } else {
      // Specific status filter
      filtered = filtered.filter((inv) => inv.status?.toLowerCase() === viewFilter);
    }

    // Apply search
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((inv) =>
        (inv.invoice_number && inv.invoice_number.toLowerCase().includes(q))
      );
    }

    return filtered;
  }, [invoices, viewFilter, searchQuery]);

  const sortedInvoices = useMemo(() => {
    return sortItems(filteredInvoices, sortColumn as keyof Invoice, sortDirection, {
      getValue: (inv) => {
        switch (sortColumn) {
          case 'issued_at':
            return inv.issued_at ? new Date(inv.issued_at) : null;
          case 'due_date':
            return inv.due_date ? new Date(inv.due_date) : null;
          case 'invoice_number':
            return inv.invoice_number ?? '';
          case 'computed_total':
            return inv.computed_total ?? 0;
          case 'status':
            return inv.status ?? '';
          default:
            return null;
        }
      },
    });
  }, [filteredInvoices, sortColumn, sortDirection]);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  // Check subscription on load
  useEffect(() => {
    if (!loading && resolvedCustomerId) {
      checkSubscription();
    }
  }, [resolvedCustomerId, loading]);

  const checkSubscription = async () => {
    setSubscriptionLoading(true);
    try {
      const body = isStaffView && resolvedCustomerId
        ? { customer_id: resolvedCustomerId }
        : undefined;
      const { data, error } = await supabase.functions.invoke('check-subscription', {
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
      });
      if (error) throw error;
      setSubscriptionStatus(data);
    } catch (error) {
      console.error('Error checking subscription:', error);
    } finally {
      setSubscriptionLoading(false);
    }
  };

  const fetchInvoices = async () => {
    if (!resolvedCustomerId) return;
    setInvoicesLoading(true);

    try {
      const { data, error } = await supabase
        .from('invoices')
        .select(`
          id,
          invoice_number,
          issued_at,
          due_date,
          currency,
          status,
          is_test
        `)
        .eq('customer_id', resolvedCustomerId)
        .order('issued_at', { ascending: false });

      if (error) throw error;

      const invoicesData = (data || []) as Array<{ id: string; invoice_number: string; issued_at: string; due_date: string; currency: string; status: string; is_test: boolean }>;
      const invoiceIds = invoicesData.map((inv) => inv.id).filter(Boolean);

      const totalsByInvoiceId = new Map<string, number>();
      if (invoiceIds.length > 0) {
        const { data: totalsData, error: totalsError } = await supabase
          .from('invoice_computed_totals')
          .select('invoice_id,total')
          .in('invoice_id', invoiceIds);

        if (totalsError) {
          console.warn('Could not fetch invoice_computed_totals:', totalsError);
        } else {
          (totalsData || []).forEach((row) => {
            if (row?.invoice_id && typeof row.total === 'number') {
              totalsByInvoiceId.set(row.invoice_id, row.total);
            }
          });
        }
      }

      const mappedInvoices: Invoice[] = invoicesData.map((inv) => {
        const computed = totalsByInvoiceId.get(inv.id) ?? null;

        return {
          id: inv.id,
          invoice_number: inv.invoice_number,
          issued_at: inv.issued_at,
          due_date: inv.due_date,
          currency: inv.currency,
          status: inv.status,
          is_test: inv.is_test,
          computed_total: computed,
        };
      });

      setInvoices(mappedInvoices);
    } catch (error) {
      console.error('Error fetching invoices:', error);
    } finally {
      setInvoicesLoading(false);
    }
  };

  useEffect(() => {
    if (!loading && resolvedCustomerId) {
      fetchInvoices();
    }
  }, [resolvedCustomerId, loading, isStaffView]);


  if (loading) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  // Staff viewing their own billing page (not customer view) - show info message
  if (!isStaffView && isStaff) {
    return (
      <>
        <Alert>
          <AlertDescription>
            {t(
              'Personalkonton har ingen faktureringsinformation. Använd kundsidan för att se kundfakturor.',
              "Staff accounts don't have billing information. Use the Customers page to view customer invoices."
            )}
          </AlertDescription>
        </Alert>
      </>
    );
  }

  if (!resolvedCustomerId) {
    return (
      <>
        <Alert>
          <AlertDescription>
            {t('Ingen kunddata hittades. Kontakta support.', 'No customer data found. Please contact support.')}
          </AlertDescription>
        </Alert>
      </>
    );
  }

  const formatAmount = (amount: number | null, currency: string | null) => {
    if (amount === null || amount === undefined) return '-';
    const formatted = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
    return `${formatted} ${currency?.toUpperCase() || 'SEK'}`;
  };

  const getStatusBadge = (status: string | null) => {
    if (!status) return null;
    const lowerStatus = status.toLowerCase();
    
    const statusLabels: Record<string, string> = {
      paid: t('Betald', 'Paid'),
      pending: t('Väntande', 'Pending'),
      sent: t('Skickad', 'Sent'),
      overdue: t('Förfallen', 'Overdue'),
      open: t('Öppen', 'Open'),
      draft: t('Utkast', 'Draft'),
      void: t('Makulerad', 'Void'),
    };
    
    const label = statusLabels[lowerStatus] || status;
    
    if (lowerStatus === 'paid') {
      return <Badge className="bg-energy/30 text-energy-darker border-0">{label}</Badge>;
    }
    if (lowerStatus === 'pending' || lowerStatus === 'sent' || lowerStatus === 'open') {
      return <Badge variant="outline">{label}</Badge>;
    }
    if (lowerStatus === 'overdue') {
      return <Badge variant="destructive">{label}</Badge>;
    }
    return <Badge variant="secondary">{label}</Badge>;
  };

  const canDownloadInvoice = (status: string | null) => {
    if (!status) return false;
    const lower = status.toLowerCase();
    return ['open', 'paid', 'overdue'].includes(lower);
  };

  const handlePreviewInvoice = (invoice: Invoice) => {
    setSelectedInvoice(invoice);
    setPdfModalOpen(true);
  };

  return (
    <>
      <div className="space-y-6">
        <h1 className="text-3xl font-medium">
          {isStaffView ? t('Fakturering', 'Billing') : t('Fakturering', 'Billing & invoices')}
        </h1>

        {/* Subscription Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="w-5 h-5" />
              {t('Prenumeration', 'Subscription')}
            </CardTitle>
            <CardDescription>
              {isStaffView
                ? t('Kundens prenumerationsstatus.', "Customer's subscription status.")
                : t('Din månatliga prenumeration på Smart Home Solutions-tjänster.', 'Your monthly Smart Home Solutions service subscription.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {subscriptionLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('Laddar...', 'Loading...')}
              </div>
            ) : subscriptionStatus?.subscribed ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  {subscriptionStatus.cancel_at_period_end ? (
                    <Badge variant="outline" className="flex items-center gap-1 border-warning text-warning">
                      <AlertCircle className="w-3 h-3" />
                      {t('Avbryts', 'Cancels')}
                    </Badge>
                  ) : (
                    <Badge className="bg-energy/30 text-energy-darker border-0 flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      {t('Aktiv', 'Active')}
                    </Badge>
                  )}
                  <span className="text-sm text-muted-foreground">
                    {subscriptionStatus.cancel_at_period_end 
                      ? t('Avslutas', 'Ends')
                      : t('Förnyas', 'Renews')}: {subscriptionStatus.subscription_end 
                      ? new Date(subscriptionStatus.subscription_end).toLocaleDateString('sv-SE') 
                      : '-'}
                  </span>
                </div>
                {subscriptionStatus.cancel_at_period_end && (
                  <Alert variant="default" className="border-warning/50 bg-warning/10">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <AlertDescription className="text-foreground">
                      {isStaffView
                        ? t(
                            'Kundens prenumeration är schemalagd att avslutas.',
                            "The customer's subscription is scheduled to cancel."
                          )
                        : t(
                            'Din prenumeration är schemalagd att avslutas. Du har tillgång till tjänsten fram till slutdatumet.',
                            'Your subscription is scheduled to cancel. You will have access until the end date.'
                          )}
                    </AlertDescription>
                  </Alert>
                )}
                <p className="text-2xl font-semibold">249 kr<span className="text-sm font-normal text-muted-foreground">/{t('månad', 'month')}</span></p>
                {!isStaffView && (
                  <p className="text-sm text-muted-foreground">
                    {t('Kontakta oss för att hantera din prenumeration.', 'Contact us to manage your subscription.')}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-muted-foreground">
                  {isStaffView
                    ? t('Kunden har ingen aktiv prenumeration.', "The customer doesn't have an active subscription.")
                    : t('Du har ingen aktiv prenumeration.', "You don't have an active subscription.")}
                </p>
                {!isStaffView && (
                  <div className="p-4 border rounded-lg bg-muted/30">
                    <p className="text-2xl font-semibold">249 kr<span className="text-sm font-normal text-muted-foreground">/{t('månad', 'month')}</span></p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t('Kontakta oss för att starta en prenumeration.', 'Contact us to start a subscription.')}
                    </p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Invoices Card */}
        <Card>
          <CardHeader>
            <CardTitle>{t('Fakturor', 'Invoices')}</CardTitle>
            <CardDescription>
              {isStaffView
                ? t('Kundens fakturor.', "Customer's invoices.")
                : t('Dina betalningshistorik och fakturor.', 'Your payment history and invoices.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Search & filter bar */}
            <div className="mb-4">
              <TableFilterBar
                filterValue={viewFilter}
                onFilterChange={setViewFilter}
                filterOptions={[
                  { value: 'all', label: t('Visa alla', 'Show all') },
                  { value: 'open', label: t('Öppna', 'Open') },
                  { value: 'paid', label: t('Betalda', 'Paid') },
                  { value: 'overdue', label: t('Förfallna', 'Overdue') },
                  ...(isStaffView ? [
                    { value: 'void', label: t('Makulerade', 'Voided') },
                    { value: 'draft', label: t('Utkast', 'Draft') },
                  ] : []),
                ]}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                searchPlaceholder={t('Sök fakturanummer...', 'Search invoice number...')}
              />
            </div>

            {invoicesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : sortedInvoices.length === 0 ? (
              <p className="text-center text-muted-foreground py-12">
                {t('Inga fakturor hittades.', 'No invoices found.')}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead<InvoiceSortColumn>
                      column="issued_at"
                      currentColumn={sortColumn}
                      currentDirection={sortDirection}
                      onSort={handleSort}
                      className="text-primary text-center"
                    >
                      {t('Datum', 'Date')}
                    </SortableTableHead>
                    <SortableTableHead<InvoiceSortColumn>
                      column="due_date"
                      currentColumn={sortColumn}
                      currentDirection={sortDirection}
                      onSort={handleSort}
                      className="text-primary text-center"
                    >
                      {t('Förfallodatum', 'Due date')}
                    </SortableTableHead>
                    <SortableTableHead<InvoiceSortColumn>
                      column="invoice_number"
                      currentColumn={sortColumn}
                      currentDirection={sortDirection}
                      onSort={handleSort}
                      className="text-primary text-center"
                    >
                      {t('Fakturanummer', 'Invoice number')}
                    </SortableTableHead>
                    <SortableTableHead<InvoiceSortColumn>
                      column="computed_total"
                      currentColumn={sortColumn}
                      currentDirection={sortDirection}
                      onSort={handleSort}
                      className="text-primary text-center"
                    >
                      {t('Summa', 'Total')}
                    </SortableTableHead>
                    <SortableTableHead<InvoiceSortColumn>
                      column="status"
                      currentColumn={sortColumn}
                      currentDirection={sortDirection}
                      onSort={handleSort}
                      className="text-primary text-center"
                    >
                      {t('Status', 'Status')}
                    </SortableTableHead>
                    <TableHead className="text-primary text-center">{t('Åtgärder', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedInvoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell className="text-center">{invoice.issued_at ? new Date(invoice.issued_at).toLocaleDateString('sv-SE') : 'N/A'}</TableCell>
                      <TableCell className="text-center">{invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('sv-SE') : '-'}</TableCell>
                      <TableCell className="text-center">{invoice.invoice_number || invoice.id.slice(0, 8)}</TableCell>
                      <TableCell className="text-center">{formatAmount(invoice.computed_total, invoice.currency)}</TableCell>
                      <TableCell className="text-center">{getStatusBadge(invoice.status)}</TableCell>
                      <TableCell className="text-center">
                        {canDownloadInvoice(invoice.status) ? (
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/portal/billing/invoices/${invoice.id}`)}
                            >
                              <FileText className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handlePreviewInvoice(invoice)}
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <InvoicePdfModal
          open={pdfModalOpen}
          onOpenChange={setPdfModalOpen}
          invoiceId={selectedInvoice?.id ?? null}
          invoiceNumber={selectedInvoice?.invoice_number || selectedInvoice?.id.slice(0, 8) || ''}
        />
      </div>
    </>
  );
};

export default Billing;
