import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, FileText, MessageSquare, Loader2, Shield, Users, Package, Box, FileCheck, Settings, Database, Receipt, ClipboardList, Home, Zap, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import PortalLayout from '@/components/portal/PortalLayout';
import CustomerDashboardCards from '@/components/portal/CustomerDashboardCards';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { getAuthenticatedFunctionHeaders } from '@/lib/supabase-function-auth';

const Dashboard: React.FC = () => {
  const { user, isStaff, isAdmin, customerData, loading, refreshUserData } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useLanguage();
  
  const [ticketStats, setTicketStats] = useState({ open: 0, total: 0 });
  const [invoiceStats, setInvoiceStats] = useState({ total: 0, lastDate: '' });
  const [customerStats, setCustomerStats] = useState({ total: 0 });
  const [contactStats, setContactStats] = useState({ total: 0, unconverted: 0 });
  const [skuStats, setSkuStats] = useState({ total: 0 });
  const [templateStats, setTemplateStats] = useState({ total: 0 });
  const [bomStats, setBomStats] = useState({ total: 0 });
  const [quoteStats, setQuoteStats] = useState({ total: 0, draft: 0 });
  const [customerQuoteStats, setCustomerQuoteStats] = useState({ total: 0 });
  const [invoiceStats2, setInvoiceStats2] = useState({ total: 0, open: 0, paid: 0 });
  const [homeProfileStats, setHomeProfileStats] = useState({ answered: 0, total: 0, photos: 0 });
  const [canBootstrap, setCanBootstrap] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    const checkBootstrap = async () => {
      if (!user) return;
      
      // Check if staff table is empty and user has correct email domain
      const { data: isEmpty } = await supabase.rpc('is_staff_table_empty');
      const email = user.email || '';
      
      if (isEmpty && email.endsWith('@smarthomesolutions.se')) {
        setCanBootstrap(true);
      }
    };
    
    checkBootstrap();
  }, [user]);

  useEffect(() => {
    const fetchStats = async () => {
      if (!user) return;
      setStatsLoading(true);
      
      try {
        if (isStaff) {
          // Staff sees all tickets and Offerter & Material stats
          const [
            ticketsResult, 
            openTicketsResult, 
            customersResult, 
            contactsResult, 
            unconvertedContactsResult,
            skusResult,
            templatesResult,
            bomsResult,
            quotesResult,
            draftQuotesResult,
            invoicesResult,
            openInvoicesResult,
            paidInvoicesResult,
          ] = await Promise.all([
            supabase.from('tickets').select('*', { count: 'exact', head: true }),
            supabase.from('tickets').select('*', { count: 'exact', head: true }).neq('status', 'closed'),
            supabase.from('customers').select('*', { count: 'exact', head: true }),
            supabase.from('contacts').select('*', { count: 'exact', head: true }),
            supabase.from('contacts').select('*', { count: 'exact', head: true }).is('converted_to_customer_id', null),
            supabase.from('skus').select('*', { count: 'exact', head: true }),
            supabase.from('templates').select('*', { count: 'exact', head: true }),
            supabase.from('boms').select('*', { count: 'exact', head: true }),
            supabase.from('quotes').select('*', { count: 'exact', head: true }),
            supabase.from('quotes').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
            supabase.from('invoices').select('*', { count: 'exact', head: true }),
            supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('status', 'open'),
            supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('status', 'paid'),
          ]);
          
          setTicketStats({ open: openTicketsResult.count || 0, total: ticketsResult.count || 0 });
          setCustomerStats({ total: customersResult.count || 0 });
          setContactStats({ total: contactsResult.count || 0, unconverted: unconvertedContactsResult.count || 0 });
          setSkuStats({ total: skusResult.count || 0 });
          setTemplateStats({ total: templatesResult.count || 0 });
          setBomStats({ total: bomsResult.count || 0 });
          setQuoteStats({ total: quotesResult.count || 0, draft: draftQuotesResult.count || 0 });
          setInvoiceStats2({ total: invoicesResult.count || 0, open: openInvoicesResult.count || 0, paid: paidInvoicesResult.count || 0 });
        } else if (customerData) {
          // Customer sees their tickets
          const [
            totalTicketsRes,
            openTicketsRes,
            invoicesRes,
            quoteCountRes,
            homeQuestionsRes,
            homeAnswersRes,
            homePhotosRes,
          ] = await Promise.all([
            supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('customer_id', customerData.id),
            supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('customer_id', customerData.id).neq('status', 'closed'),
            supabase.from('invoices').select('issued_at', { count: 'exact' }).eq('customer_id', customerData.id).order('issued_at', { ascending: false }).limit(1),
            supabase.from('quotes').select('*', { count: 'exact', head: true }).eq('customer_id', customerData.id).eq('is_test', customerData.is_test ?? false).neq('status', 'draft').neq('status', 'cancelled'),
            supabase.from('home_questions').select('*', { count: 'exact', head: true }).eq('is_active', true),
            supabase.from('home_answers').select('*', { count: 'exact', head: true }).eq('customer_id', customerData.id).neq('answer_text', ''),
            supabase.from('home_photos').select('*', { count: 'exact', head: true }).eq('customer_id', customerData.id),
          ]);

          setTicketStats({ open: openTicketsRes.count || 0, total: totalTicketsRes.count || 0 });
          setCustomerQuoteStats({ total: quoteCountRes.count || 0 });
          setInvoiceStats({
            total: invoicesRes.count || 0,
            lastDate: invoicesRes.data?.[0]?.issued_at || '',
          });
          setHomeProfileStats({
            answered: homeAnswersRes.count || 0,
            total: homeQuestionsRes.count || 0,
            photos: homePhotosRes.count || 0,
          });
        }
      } catch (error) {
        console.error('Error fetching stats:', error);
      } finally {
        setStatsLoading(false);
      }
    };
    
    if (!loading) {
      fetchStats();
    }
  }, [user, isStaff, customerData, loading]);

  const handleBootstrap = async () => {
    if (!user) return;
    setBootstrapLoading(true);
    
    try {
      const { error } = await supabase
        .from('staff_users')
        .insert({ user_id: user.id, role: 'admin' });
      
      if (error) throw error;
      
      toast({
        title: t('Adminkonto skapat!', 'Admin account created!'),
        description: t('Du är nu en administratör.', 'You are now an admin user.'),
      });
      
      setCanBootstrap(false);
      await refreshUserData();
    } catch (error: any) {
      toast({
        title: t('Fel', 'Error'),
        description: error.message || t('Det gick inte att skapa adminkontot.', 'Failed to create admin account.'),
        variant: 'destructive',
      });
    } finally {
      setBootstrapLoading(false);
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

  // Show bootstrap UI if applicable
  if (canBootstrap) {
    return (
      <PortalLayout>
        <div className="max-w-lg mx-auto mt-12">
          <Card>
            <CardHeader className="text-center">
              <Shield className="w-12 h-12 mx-auto text-primary mb-4" />
              <CardTitle>{t('Personalstart', 'Staff Bootstrap')}</CardTitle>
            </CardHeader>
            <CardContent className="text-center">
              <p className="text-muted-foreground mb-6">
                {t(
                  'Inga personalkonton finns ännu. Eftersom du är inloggad med en @smarthomesolutions.se-e-post kan du bli den första administratören.',
                  'No staff accounts exist yet. Since you\'re logged in with an @smarthomesolutions.se email, you can become the first admin.'
                )}
              </p>
              <Button onClick={handleBootstrap} disabled={bootstrapLoading}>
                {bootstrapLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t('Gör detta konto till admin', 'Make this account admin')}
              </Button>
            </CardContent>
          </Card>
        </div>
      </PortalLayout>
    );
  }

  // Show message if user has no customer or staff association
  if (!isStaff && !customerData) {
    return (
      <PortalLayout>
        <Alert>
          <AlertDescription>
            {t(
              'Ditt konto är inte kopplat till någon kund. Kontakta support om du tror att detta är ett fel.',
              'Your account is not associated with any customer. Please contact support if you believe this is an error.'
            )}
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-8">
        <h1 className="text-3xl font-medium">
          {isStaff ? t('Personalöversikt', 'Staff Dashboard') : t('Kundportal', 'Customer Portal')}
        </h1>

        {isStaff ? (
          // Staff Dashboard
          <div className="space-y-8">
            {/* CRM Section */}
            <div>
              <h2 className="text-lg font-medium mb-4 text-muted-foreground">{t('CRM', 'CRM')}</h2>
              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/tickets')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <MessageSquare className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Supportärenden', 'Support Tickets')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-1">
                      {t('Öppna ärenden:', 'Open tickets:')} <strong>{ticketStats.open}</strong>
                    </p>
                    <p className="text-muted-foreground">
                      {t('Totalt ärenden:', 'Total tickets:')} <strong>{ticketStats.total}</strong>
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/customers')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Building2 className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Kunder', 'Customers')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">
                      {t('Antal kunder:', 'Total customers:')} <strong>{customerStats.total}</strong>
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/contacts')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Users className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Kontakter', 'Contacts')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-1">
                      {t('Ej konverterade:', 'Unconverted:')} <strong>{contactStats.unconverted}</strong>
                    </p>
                    <p className="text-muted-foreground">
                      {t('Totalt kontakter:', 'Total contacts:')} <strong>{contactStats.total}</strong>
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Offerter & Material Section */}
            <div>
              <h2 className="text-lg font-medium mb-4 text-muted-foreground">{t('Offerter & Material', 'Quotes & Materials')}</h2>
              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-5">
                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/skus')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Package className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('SKU-katalog', 'SKU Catalog')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-1">
                      {t('Hantera produkter och priser', 'Manage products and prices')}
                    </p>
                    <p className="text-muted-foreground">
                      {t('Produkter:', 'Products:')} <strong>{skuStats.total}</strong>
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/templates')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Box className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Mallpaket', 'Templates')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-1">
                      {t('Återanvändbara produktpaket', 'Reusable product bundles')}
                    </p>
                    <p className="text-muted-foreground">
                      {t('Mallar:', 'Templates:')} <strong>{templateStats.total}</strong>
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/boms')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <FileText className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Materiallistor', 'BOMs')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-1">
                      {t('Projektberäkningar', 'Project calculations')}
                    </p>
                    <p className="text-muted-foreground">
                      {t('Materiallistor:', 'BOMs:')} <strong>{bomStats.total}</strong>
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/quotes')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <FileCheck className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Offerter', 'Quotes')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-1">
                      {t('Skapa och skicka offerter', 'Create and send quotes')}
                    </p>
                    <p className="text-muted-foreground mb-1">
                      {t('Utkast:', 'Drafts:')} <strong>{quoteStats.draft}</strong>
                    </p>
                    <p className="text-muted-foreground">
                      {t('Totalt:', 'Total:')} <strong>{quoteStats.total}</strong>
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/invoices')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Receipt className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Fakturor', 'Invoices')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-1">
                      {t('Hantera fakturor', 'Manage invoices')}
                    </p>
                    <p className="text-muted-foreground mb-1">
                      {t('Öppna:', 'Open:')} <strong>{invoiceStats2.open}</strong> | {t('Betalda:', 'Paid:')} <strong>{invoiceStats2.paid}</strong>
                    </p>
                    <p className="text-muted-foreground">
                      {t('Totalt:', 'Total:')} <strong>{invoiceStats2.total}</strong>
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Settings (includes Questionnaire Manager) */}
            <div>
              <h2 className="text-lg font-medium mb-4 text-muted-foreground">{t('Inställningar', 'Settings')}</h2>
              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/settings/margins')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Settings className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Marginalregler', 'Margin Rules')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">
                      {t('Konfigurera marginaler per kategori', 'Configure margins per category')}
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/erd')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Database className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Databasdiagram', 'Database ERD')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">
                      {t('Visa relationer mellan tabeller', 'View table relationships')}
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={async () => {
                    toast({ title: t('Laddar ner backup...', 'Downloading backup...') });
                    try {
                      const res = await fetch(
                        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/dump-database`,
                        { headers: await getAuthenticatedFunctionHeaders() }
                      );
                      if (!res.ok) {
                        const err = await res.json();
                        throw new Error(err.error || 'Download failed');
                      }
                      const blob = await res.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `backup-${new Date().toISOString().slice(0,10)}.zip`;
                      a.click();
                      URL.revokeObjectURL(url);
                      toast({ title: t('Backup nedladdad!', 'Backup downloaded!') });
                    } catch (e: any) {
                      toast({ title: t('Fel', 'Error'), description: e.message, variant: 'destructive' });
                    }
                  }}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Download className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Databasbackup', 'Database Backup')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">
                      {t('Ladda ner fullständig backup (databas + filer)', 'Download full backup (database + files)')}
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/customers/questionnaire')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Home className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Hemprofilfrågor', 'Home Profile Questions')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">
                      {t('Hantera frågor som visas på kundens hemprofil', 'Manage questions shown on the customer home profile')}
                    </p>
                  </CardContent>
                </Card>

                <Card 
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => navigate('/portal/device-catalog')}
                >
                  <CardHeader className="flex flex-row items-center gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Box className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{t('Enhetskatalog', 'Device Catalog')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">
                      {t('Enhetsmallar, kalibrering och simuleringsverktyg', 'Device templates, calibration and simulation tools')}
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        ) : (
          // Customer Dashboard
          <CustomerDashboardCards
              basePath="/portal"
              customerName={customerData?.name || undefined}
              billingEmail={customerData?.billing_email || user?.email}
              statsLoading={statsLoading}
              homeProfileStats={homeProfileStats}
              invoiceStats={{ total: invoiceStats.total, lastDate: invoiceStats.lastDate || null }}
              ticketStats={ticketStats}
              quoteStats={{ total: customerQuoteStats.total }}
            />
        )}
      </div>
    </PortalLayout>
  );
};

export default Dashboard;
