import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Building2, FileText, MessageSquare, ArrowLeft, Trash2, ClipboardList, AlertCircle, Home } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

const CustomerViewDashboard: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading, error, refetch } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { toast } = useToast();

  const [ticketStats, setTicketStats] = useState({ open: 0, total: 0 });
  const [invoiceStats, setInvoiceStats] = useState({ total: 0, lastDate: null as string | null });
  const [quoteStats, setQuoteStats] = useState({ actionRequired: 0, total: 0 });
  const [statsLoading, setStatsLoading] = useState(true);
  const [homeProfileStats, setHomeProfileStats] = useState({ answered: 0, total: 0, photos: 0 });
  const [isDeleting, setIsDeleting] = useState(false);
  

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
    if (!authLoading && !isStaff) {
      navigate('/portal');
    }
  }, [user, isStaff, authLoading, navigate]);

  const handleDeleteCustomer = async () => {
    if (!customerId) return;
    setIsDeleting(true);

    try {
      const { error: deleteError } = await supabase
        .from('customers')
        .delete()
        .eq('id', customerId);

      if (deleteError) throw deleteError;

      toast({
        title: t('Kund raderad', 'Customer deleted'),
        description: t('Kunden har tagits bort.', 'The customer has been removed.'),
      });

      navigate('/portal/customers');
    } catch (err) {
      console.error('Error deleting customer:', err);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte radera kunden.', 'Could not delete the customer.'),
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };


  useEffect(() => {
    const fetchStats = async () => {
      if (!customerId) return;
      setStatsLoading(true);

      try {
        const [ticketsRes, invoicesRes, quotesRes, homeQRes, homeARes, homePRes] = await Promise.all([
          supabase.from('tickets').select('status').eq('customer_id', customerId),
          supabase.from('invoices').select('issued_at').eq('customer_id', customerId).order('issued_at', { ascending: false }),
          supabase.from('quotes').select('status').eq('customer_id', customerId).eq('is_latest', true),
          supabase.from('home_questions').select('*', { count: 'exact', head: true }).eq('is_active', true),
          supabase.from('home_answers').select('*', { count: 'exact', head: true }).eq('customer_id', customerId),
          supabase.from('home_photos').select('*', { count: 'exact', head: true }).eq('customer_id', customerId),
        ]);

        if (ticketsRes.data) {
          const openCount = ticketsRes.data.filter(t => t.status !== 'closed').length;
          setTicketStats({ open: openCount, total: ticketsRes.data.length });
        }
        if (invoicesRes.data) {
          setInvoiceStats({ total: invoicesRes.data.length, lastDate: invoicesRes.data[0]?.issued_at || null });
        }
        if (quotesRes.data) {
          const actionCount = quotesRes.data.filter(q => q.status === 'revision_requested').length;
          setQuoteStats({ actionRequired: actionCount, total: quotesRes.data.length });
        }
        setHomeProfileStats({
          answered: homeARes.count || 0,
          total: homeQRes.count || 0,
          photos: homePRes.count || 0,
        });
      } catch (err) {
        console.error('Error fetching stats:', err);
      } finally {
        setStatsLoading(false);
      }
    };

    if (!customerLoading && customerId) {
      fetchStats();
    }
  }, [customerId, customerLoading]);

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
          to="/portal/customers" 
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till kunder', 'Back to customers')}
        </Link>

        {/* Customer name header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-medium">
                {customerData.name || t('Namnlös kund', 'Unnamed customer')}
              </h1>
            </div>
            <p className="text-muted-foreground mt-1">
              {t('Visar kundvy', 'Viewing customer portal')}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="w-4 h-4 mr-2" />
                  {t('Radera', 'Delete')}
                </Button>
              </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('Är du säker?', 'Are you sure?')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    'Är du säker på att du vill radera denna kund? Denna åtgärd kan inte ångras.',
                    'Are you sure you wish to delete this customer? This action cannot be undone.'
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t('Avbryt', 'Cancel')}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDeleteCustomer}
                  disabled={isDeleting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {isDeleting ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : null}
                  {t('Bekräfta', 'Confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          </div>
        </div>

        {/* Stats cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t('Konto', 'Account')}</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{customerData.name || '-'}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {customerData.billing_email || t('Ingen e-post', 'No email')}
              </p>
              <Link 
                to={`/portal/customers/${customerId}/account`}
                className="text-sm text-primary hover:underline mt-2 inline-block"
              >
                {t('Visa detaljer', 'View details')} →
              </Link>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer transition-colors hover:bg-muted/50"
            onClick={() => navigate(`/portal/customers/${customerId}/home-profile`)}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t('Hemprofil', 'Home Profile')}</CardTitle>
              <Home className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t('Besvarade:', 'Answered:')} <strong>{homeProfileStats.answered} / {homeProfileStats.total}</strong>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('Foton:', 'Photos:')} <strong>{homeProfileStats.photos}</strong>
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t('Fakturor', 'Invoices')}</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{invoiceStats.total}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {invoiceStats.lastDate 
                      ? `${t('Senaste:', 'Latest:')} ${new Date(invoiceStats.lastDate).toLocaleDateString()}`
                      : t('Inga fakturor', 'No invoices')
                    }
                  </p>
                  <Link 
                    to={`/portal/customers/${customerId}/billing`}
                    className="text-sm text-primary hover:underline mt-2 inline-block"
                  >
                    {t('Visa alla', 'View all')} →
                  </Link>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t('Ärenden', 'Tickets')}</CardTitle>
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{ticketStats.open}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('öppna av', 'open of')} {ticketStats.total} {t('totalt', 'total')}
                  </p>
                  <Link 
                    to={`/portal/customers/${customerId}/tickets`}
                    className="text-sm text-primary hover:underline mt-2 inline-block"
                  >
                    {t('Visa alla', 'View all')} →
                  </Link>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t('Offerter', 'Quotes')}</CardTitle>
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-bold">{quoteStats.actionRequired}</span>
                    {quoteStats.actionRequired > 0 && (
                      <AlertCircle className="h-5 w-5 text-amber-500" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('att hantera av', 'to handle of')} {quoteStats.total} {t('totalt', 'total')}
                  </p>
                  <Link 
                    to={`/portal/customers/${customerId}/offers`}
                    className="text-sm text-primary hover:underline mt-2 inline-block"
                  >
                    {t('Visa alla', 'View all')} →
                  </Link>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewDashboard;
