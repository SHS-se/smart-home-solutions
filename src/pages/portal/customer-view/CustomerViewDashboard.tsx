import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Building2, FileText, MessageSquare, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

const CustomerViewDashboard: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading, error } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [ticketStats, setTicketStats] = useState({ open: 0, total: 0 });
  const [invoiceStats, setInvoiceStats] = useState({ total: 0, lastDate: null as string | null });
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
    if (!authLoading && !isStaff) {
      navigate('/portal');
    }
  }, [user, isStaff, authLoading, navigate]);

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
          .select('date')
          .eq('customer_id', customerId)
          .order('date', { ascending: false });

        if (invoices) {
          setInvoiceStats({
            total: invoices.length,
            lastDate: invoices[0]?.date || null,
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
        <div>
          <h1 className="text-3xl font-medium">
            {customerData.org_name || t('Namnlös kund', 'Unnamed customer')}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t('Visar kundvy', 'Viewing customer portal')}
          </p>
        </div>

        {/* Stats cards */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t('Konto', 'Account')}</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{customerData.org_name || '-'}</div>
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
