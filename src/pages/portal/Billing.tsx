import React, { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, CreditCard, Settings, CheckCircle, AlertCircle, Eye, ArrowLeft } from 'lucide-react';
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
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';
import InvoicePdfModal from '@/components/portal/invoices/InvoicePdfModal';

type InvoiceSortColumn = 'issued_at' | 'due_date' | 'invoice_number' | 'computed_total' | 'status';

interface Invoice {
  id: string;
  invoice_number: string | null;
  stripe_invoice_id: string | null;
  issued_at: string | null;
  due_date: string | null;
  currency: string | null;
  status: string | null;
  pdf_url: string | null;
  is_test?: boolean;
  computed_total: number | null;
}

interface SubscriptionStatus {
  subscribed: boolean;
  subscription_end: string | null;
  stripe_subscription_id: string | null;
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
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  
  const resolvedCustomerId = propCustomerId || customerData?.id;
  
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  const { sortColumn, sortDirection, handleSort } = useTableSort<InvoiceSortColumn>({
    defaultColumn: 'issued_at',
    defaultDirection: 'desc',
  });

  const sortedInvoices = useMemo(() => {
    return sortItems(invoices, sortColumn as keyof Invoice, sortDirection, {
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
  }, [invoices, sortColumn, sortDirection]);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  // Show toast for checkout result (customer view only)
  useEffect(() => {
    if (isStaffView) return;
    if (searchParams.get('success') === 'true') {
      toast({
        title: t('Prenumeration aktiverad!', 'Subscription activated!'),
        description: t('Tack för din prenumeration.', 'Thank you for subscribing.'),
      });
      window.history.replaceState({}, '', '/portal/billing');
      checkSubscription();
      syncInvoices();
    } else if (searchParams.get('canceled') === 'true') {
      toast({
        title: t('Avbruten', 'Canceled'),
        description: t('Betalningen avbröts.', 'Payment was canceled.'),
        variant: 'destructive',
      });
      window.history.replaceState({}, '', '/portal/billing');
    }
  }, [searchParams, isStaffView]);

  const checkSubscription = async () => {
    if (isStaffView) {
      setSubscriptionLoading(false);
      return;
    }
    setSubscriptionLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('check-subscription');
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
          stripe_invoice_id,
          issued_at,
          due_date,
          amount,
          currency,
          status,
          pdf_url,
          is_test
        `)
        .eq('customer_id', resolvedCustomerId)
        .order('issued_at', { ascending: false });

      if (error) throw error;

      const invoicesData = (data || []) as any[];
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
          (totalsData || []).forEach((row: any) => {
            if (row?.invoice_id && typeof row.total === 'number') {
              totalsByInvoiceId.set(row.invoice_id, row.total);
            }
          });
        }
      }

      const mappedInvoices: Invoice[] = invoicesData.map((inv: any) => {
        const stripeAmount = typeof inv.amount === 'number' ? inv.amount : null;
        const computed = totalsByInvoiceId.get(inv.id) ?? null;
        const total = inv.stripe_invoice_id ? stripeAmount : (computed ?? stripeAmount);
        
        return {
          id: inv.id,
          invoice_number: inv.invoice_number,
          stripe_invoice_id: inv.stripe_invoice_id,
          issued_at: inv.issued_at,
          due_date: inv.due_date,
          currency: inv.currency,
          status: inv.status,
          pdf_url: inv.pdf_url,
          is_test: inv.is_test,
          computed_total: total,
        };
      });

      setInvoices(mappedInvoices);
    } catch (error) {
      console.error('Error fetching invoices:', error);
    } finally {
      setInvoicesLoading(false);
    }
  };

  const syncInvoices = async () => {
    if (isStaffView) return;
    try {
      const { data, error } = await supabase.functions.invoke('sync-invoices');
      if (error) throw error;
      if (data?.synced > 0) {
        fetchInvoices();
      }
    } catch (error) {
      console.error('Error syncing invoices:', error);
    }
  };

  useEffect(() => {
    if (!loading && resolvedCustomerId) {
      fetchInvoices();
      checkSubscription();
      if (!isStaffView) {
        syncInvoices();
      }
    }
  }, [resolvedCustomerId, loading, isStaffView]);

  const handleCheckout = async () => {
    setCheckoutLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout');
      if (error) throw error;
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (error) {
      console.error('Error creating checkout:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte starta betalning.', 'Could not start payment.'),
        variant: 'destructive',
      });
    } finally {
      setCheckoutLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('customer-portal');
      if (error) throw error;
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (error) {
      console.error('Error opening customer portal:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte öppna hanteringssidan.', 'Could not open management page.'),
        variant: 'destructive',
      });
    } finally {
      setPortalLoading(false);
    }
  };

  const Layout = isStaffView ? CustomerViewLayout : PortalLayout;

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  // Staff viewing their own billing page (not customer view) - show info message
  if (!isStaffView && isStaff) {
    return (
      <PortalLayout>
        <Alert>
          <AlertDescription>
            {t(
              'Personalkonton har ingen faktureringsinformation. Använd kundsidan för att se kundfakturor.',
              "Staff accounts don't have billing information. Use the Customers page to view customer invoices."
            )}
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  if (!resolvedCustomerId) {
    return (
      <Layout>
        <Alert>
          <AlertDescription>
            {t('Ingen kunddata hittades. Kontakta support.', 'No customer data found. Please contact support.')}
          </AlertDescription>
        </Alert>
      </Layout>
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
    <Layout>
      <div className="space-y-6">
        {isStaffView && (
          <Link
            to="/portal/customers"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('Tillbaka till kunder', 'Back to customers')}
          </Link>
        )}

        <h1 className="text-3xl font-medium">
          {isStaffView ? t('Fakturor', 'Invoices') : t('Fakturering', 'Billing & invoices')}
        </h1>
        {isStaffView && customerName && (
          <p className="text-muted-foreground">{customerName}</p>
        )}

        {/* Subscription Card - only for customer self-view */}
        {!isStaffView && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="w-5 h-5" />
                {t('Prenumeration', 'Subscription')}
              </CardTitle>
              <CardDescription>
                {t('Din månatliga prenumeration på Smart Home Solutions-tjänster.', 'Your monthly Smart Home Solutions service subscription.')}
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
                        {t(
                          'Din prenumeration är schemalagd att avslutas. Du har tillgång till tjänsten fram till slutdatumet.',
                          'Your subscription is scheduled to cancel. You will have access until the end date.'
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                  <p className="text-2xl font-semibold">249 kr<span className="text-sm font-normal text-muted-foreground">/{t('månad', 'month')}</span></p>
                  <Button 
                    variant="outline" 
                    onClick={handleManageSubscription} 
                    disabled={portalLoading}
                  >
                    {portalLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : (
                      <Settings className="w-4 h-4 mr-2" />
                    )}
                    {subscriptionStatus.cancel_at_period_end 
                      ? t('Återuppta prenumeration', 'Resume subscription')
                      : t('Hantera prenumeration', 'Manage subscription')}
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-muted-foreground">
                    {t('Du har ingen aktiv prenumeration.', "You don't have an active subscription.")}
                  </p>
                  <div className="p-4 border rounded-lg bg-muted/30">
                    <p className="text-2xl font-semibold">249 kr<span className="text-sm font-normal text-muted-foreground">/{t('månad', 'month')}</span></p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t('Smart Home Solutions månadsabonnemang', 'Smart Home Solutions monthly subscription')}
                    </p>
                  </div>
                  <Button onClick={handleCheckout} disabled={checkoutLoading}>
                    {checkoutLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : (
                      <CreditCard className="w-4 h-4 mr-2" />
                    )}
                    {t('Prenumerera nu', 'Subscribe now')}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

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
            {invoicesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : invoices.length === 0 ? (
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
                        {canDownloadInvoice(invoice.status) && invoice.stripe_invoice_id ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handlePreviewInvoice(invoice)}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
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
          stripeInvoiceId={selectedInvoice?.stripe_invoice_id ?? null}
          invoiceNumber={selectedInvoice?.invoice_number || selectedInvoice?.id.slice(0, 8) || ''}
        />
      </div>
    </Layout>
  );
};

export default Billing;
