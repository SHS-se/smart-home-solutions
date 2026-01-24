import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Download, CreditCard, RefreshCw, Settings, CheckCircle, AlertCircle } from 'lucide-react';
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
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface Invoice {
  id: string;
  external_id: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  pdf_url: string | null;
}

interface SubscriptionStatus {
  subscribed: boolean;
  subscription_end: string | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end?: boolean;
}

const Billing: React.FC = () => {
  const { user, customerData, loading, isStaff } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  // Show toast for checkout result
  useEffect(() => {
    if (searchParams.get('success') === 'true') {
      toast({
        title: t('Prenumeration aktiverad!', 'Subscription activated!'),
        description: t('Tack för din prenumeration.', 'Thank you for subscribing.'),
      });
      // Clear URL params
      window.history.replaceState({}, '', '/portal/billing');
      // Refresh subscription status
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
  }, [searchParams]);

  const checkSubscription = async () => {
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
    if (!customerData) return;
    setInvoicesLoading(true);

    try {
      const { data, error } = await supabase
        .from('invoices')
        .select('*')
        .eq('customer_id', customerData.id)
        .order('date', { ascending: false });

      if (error) throw error;
      setInvoices(data || []);
    } catch (error) {
      console.error('Error fetching invoices:', error);
    } finally {
      setInvoicesLoading(false);
    }
  };

  const syncInvoices = async () => {
    setSyncLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-invoices');
      if (error) throw error;
      if (data?.synced > 0) {
        toast({
          title: t('Fakturor synkroniserade', 'Invoices synced'),
          description: t(`${data.synced} fakturor uppdaterades.`, `${data.synced} invoices updated.`),
        });
        fetchInvoices();
      }
    } catch (error) {
      console.error('Error syncing invoices:', error);
    } finally {
      setSyncLoading(false);
    }
  };

  useEffect(() => {
    if (!loading && customerData) {
      fetchInvoices();
      checkSubscription();
      syncInvoices();
    }
  }, [customerData, loading]);

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

  if (loading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  if (isStaff) {
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

  if (!customerData) {
    return (
      <PortalLayout>
        <Alert>
          <AlertDescription>
            {t('Ingen kunddata hittades. Kontakta support.', 'No customer data found. Please contact support.')}
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  const formatAmount = (amount: number | null, currency: string | null) => {
    if (amount === null) return 'N/A';
    const formatted = new Intl.NumberFormat('sv-SE').format(amount);
    return `${formatted} ${currency || 'kr'}`;
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

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-3xl font-medium">{t('Fakturering', 'Billing & invoices')}</h1>

        {/* Subscription Card */}
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
                      ? new Date(subscriptionStatus.subscription_end).toLocaleDateString() 
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

        {/* Invoices Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{t('Fakturor', 'Invoices')}</CardTitle>
                <CardDescription>
                  {t('Dina betalningshistorik och fakturor.', 'Your payment history and invoices.')}
                </CardDescription>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={syncInvoices} 
                disabled={syncLoading}
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${syncLoading ? 'animate-spin' : ''}`} />
                {t('Synkronisera', 'Sync')}
              </Button>
            </div>
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
                    <TableHead className="text-primary">{t('Datum', 'Date')}</TableHead>
                    <TableHead className="text-primary">{t('Fakturanummer', 'Invoice number')}</TableHead>
                    <TableHead className="text-primary">{t('Belopp', 'Amount')}</TableHead>
                    <TableHead className="text-primary">{t('Status', 'Status')}</TableHead>
                    <TableHead className="text-primary">{t('Ladda ner', 'Download')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell>{invoice.date || 'N/A'}</TableCell>
                      <TableCell>{invoice.external_id || invoice.id.slice(0, 8)}</TableCell>
                      <TableCell>{formatAmount(invoice.amount, invoice.currency)}</TableCell>
                      <TableCell>{getStatusBadge(invoice.status)}</TableCell>
                      <TableCell>
                        {invoice.pdf_url ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            asChild
                          >
                            <a href={invoice.pdf_url} target="_blank" rel="noopener noreferrer">
                              <Download className="w-4 h-4" />
                            </a>
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
      </div>
    </PortalLayout>
  );
};

export default Billing;
