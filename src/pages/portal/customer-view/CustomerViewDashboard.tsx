import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Building2, FileText, MessageSquare, ArrowLeft, Trash2, FlaskConical } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
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
  const [statsLoading, setStatsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTogglingTest, setIsTogglingTest] = useState(false);

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

  const handleToggleTest = async (checked: boolean) => {
    if (!customerId) return;
    setIsTogglingTest(true);

    try {
      const { error: updateError } = await supabase
        .from('customers')
        .update({ is_test: checked })
        .eq('id', customerId);

      if (updateError) throw updateError;

      toast({
        title: checked ? t('Testkund aktiverad', 'Test customer enabled') : t('Testkund avaktiverad', 'Test customer disabled'),
        description: checked 
          ? t('Kunden använder nu Stripe sandbox.', 'Customer now uses Stripe sandbox.')
          : t('Kunden använder nu Stripe live.', 'Customer now uses Stripe live.'),
      });

      refetch?.();
    } catch (err) {
      console.error('Error toggling test status:', err);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte uppdatera teststatus.', 'Could not update test status.'),
        variant: 'destructive',
      });
    } finally {
      setIsTogglingTest(false);
    }
  };

  useEffect(() => {
    const fetchStats = async () => {
      if (!customerId) return;
      setStatsLoading(true);

      try {
        // Fetch ticket stats
        const { data: tickets } = await supabase
          .from('tickets')
          .select('status')
          .eq('customer_id', customerId);

        if (tickets) {
          const openCount = tickets.filter(t => t.status !== 'closed').length;
          setTicketStats({ open: openCount, total: tickets.length });
        }

        // Fetch invoice stats
        const { data: invoices } = await supabase
          .from('invoices')
          .select('issued_at')
          .eq('customer_id', customerId)
          .order('issued_at', { ascending: false });

        if (invoices) {
          setInvoiceStats({
            total: invoices.length,
            lastDate: invoices[0]?.issued_at || null,
          });
        }
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
              {customerData.is_test && (
                <Badge variant="secondary">
                  <FlaskConical className="w-3 h-3 mr-1" />
                  Test
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-1">
              {t('Visar kundvy', 'Viewing customer portal')}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="test-mode"
                checked={customerData.is_test ?? false}
                onCheckedChange={handleToggleTest}
                disabled={isTogglingTest}
              />
              <Label htmlFor="test-mode" className="text-sm text-muted-foreground cursor-pointer">
                {t('Testkund', 'Test customer')}
              </Label>
            </div>
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
        <div className="grid gap-4 md:grid-cols-3">
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
        </div>
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewDashboard;
