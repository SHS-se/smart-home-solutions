import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import CustomerDashboardCards from '@/components/portal/CustomerDashboardCards';
import { DeleteCustomerDialog } from '@/components/portal/customers/DeleteCustomerDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

const CustomerViewDashboard: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading, error } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { toast } = useToast();

  const [ticketStats, setTicketStats] = useState({ open: 0, total: 0 });
  const [invoiceStats, setInvoiceStats] = useState({ total: 0, lastDate: null as string | null });
  const [quoteStats, setQuoteStats] = useState({ actionRequired: 0, total: 0 });
  const [homeProfileStats, setHomeProfileStats] = useState({ answered: 0, total: 0, photos: 0 });
  const [statsLoading, setStatsLoading] = useState(true);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !isStaff) navigate('/portal');
  }, [user, isStaff, authLoading, navigate]);

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
          supabase.from('home_answers').select('*', { count: 'exact', head: true }).eq('customer_id', customerId).neq('answer_text', ''),
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
    if (!customerLoading && customerId) fetchStats();
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

  const basePath = `/portal/customers/${customerId}`;

  return (
    <CustomerViewLayout>
      <div className="space-y-6">
        <Link
          to="/portal/customers"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till kunder', 'Back to customers')}
        </Link>

        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-medium">
              {customerData.name || t('Namnlös kund', 'Unnamed customer')}
            </h1>
            <p className="text-muted-foreground mt-1">
              {t('Visar kundvy', 'Viewing customer portal')}
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="w-4 h-4 mr-2" />
            {t('Radera', 'Delete')}
          </Button>
        </div>

        {customerId && (
          <DeleteCustomerDialog
            open={showDeleteDialog}
            onOpenChange={setShowDeleteDialog}
            customerId={customerId}
            onDeleted={() => navigate('/portal/customers')}
          />
        )}
        </div>

        <CustomerDashboardCards
          basePath={basePath}
          customerName={customerData.name || undefined}
          billingEmail={customerData.billing_email || undefined}
          statsLoading={statsLoading}
          homeProfileStats={homeProfileStats}
          invoiceStats={invoiceStats}
          ticketStats={ticketStats}
          quoteStats={{ total: quoteStats.total, actionRequired: quoteStats.actionRequired }}
        />
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewDashboard;
