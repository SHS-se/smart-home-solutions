import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, FileText, MessageSquare, Loader2, Shield, Users, Package, Box, FileCheck, Settings } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

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
          ]);
          
          setTicketStats({ open: openTicketsResult.count || 0, total: ticketsResult.count || 0 });
          setCustomerStats({ total: customersResult.count || 0 });
          setContactStats({ total: contactsResult.count || 0, unconverted: unconvertedContactsResult.count || 0 });
          setSkuStats({ total: skusResult.count || 0 });
          setTemplateStats({ total: templatesResult.count || 0 });
          setBomStats({ total: bomsResult.count || 0 });
          setQuoteStats({ total: quotesResult.count || 0, draft: draftQuotesResult.count || 0 });
        } else if (customerData) {
          // Customer sees their tickets
          const { count: totalTickets } = await supabase
            .from('tickets')
            .select('*', { count: 'exact', head: true })
            .eq('customer_id', customerData.id);
          
          const { count: openTickets } = await supabase
            .from('tickets')
            .select('*', { count: 'exact', head: true })
            .eq('customer_id', customerData.id)
            .neq('status', 'closed');
          
          const { data: invoices, count: invoiceCount } = await supabase
            .from('invoices')
            .select('date', { count: 'exact' })
            .eq('customer_id', customerData.id)
            .order('date', { ascending: false })
            .limit(1);
          
          setTicketStats({ open: openTickets || 0, total: totalTickets || 0 });
          setInvoiceStats({
            total: invoiceCount || 0,
            lastDate: invoices?.[0]?.date || '',
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
              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
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
                      {t('Utkast:', 'Drafts:')} <strong>{quoteStats.draft}</strong>
                    </p>
                    <p className="text-muted-foreground">
                      {t('Totalt:', 'Total:')} <strong>{quoteStats.total}</strong>
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Settings */}
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
              </div>
            </div>
          </div>
        ) : (
          // Customer Dashboard
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center gap-4">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Building2 className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-lg">{t('Konto', 'Account')}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground mb-1">
                  {t('Företag:', 'Company:')} <strong>{customerData?.org_name || 'N/A'}</strong>
                </p>
                <p className="text-muted-foreground mb-4">
                  {t('Kontakt:', 'Contact:')} {customerData?.billing_email || user?.email}
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/portal/account">{t('Visa konto', 'View account')}</Link>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center gap-4">
                <div className="p-2 rounded-lg bg-primary/10">
                  <FileText className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-lg">{t('Fakturor', 'Billing')}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground mb-1">
                  {t('Fakturor:', 'Invoices:')} <strong>{invoiceStats.total} {t('totalt', 'total')}</strong>
                </p>
                <p className="text-muted-foreground mb-4">
                  {t('Senaste faktura:', 'Last invoice:')} {invoiceStats.lastDate || 'N/A'}
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/portal/billing">{t('Visa fakturor', 'View billing')}</Link>
                </Button>
              </CardContent>
            </Card>

            <Card>
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
                <p className="text-muted-foreground mb-4">
                  {t('Totalt ärenden:', 'Total tickets:')} {ticketStats.total}
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/portal/tickets">{t('Visa ärenden', 'View tickets')}</Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </PortalLayout>
  );
};

export default Dashboard;
