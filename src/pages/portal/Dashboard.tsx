import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, FileText, MessageSquare, Loader2, Shield } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

const Dashboard: React.FC = () => {
  const { user, isStaff, isAdmin, customerData, loading, refreshUserData } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [ticketStats, setTicketStats] = useState({ open: 0, total: 0 });
  const [invoiceStats, setInvoiceStats] = useState({ total: 0, lastDate: '' });
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
          // Staff sees all tickets
          const { count: totalTickets } = await supabase
            .from('tickets')
            .select('*', { count: 'exact', head: true });
          
          const { count: openTickets } = await supabase
            .from('tickets')
            .select('*', { count: 'exact', head: true })
            .neq('status', 'closed');
          
          setTicketStats({ open: openTickets || 0, total: totalTickets || 0 });
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
        title: 'Admin account created!',
        description: 'You are now an admin user.',
      });
      
      setCanBootstrap(false);
      await refreshUserData();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to create admin account.',
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
              <CardTitle>Staff Bootstrap</CardTitle>
            </CardHeader>
            <CardContent className="text-center">
              <p className="text-muted-foreground mb-6">
                No staff accounts exist yet. Since you're logged in with an @smarthomesolutions.se email,
                you can become the first admin.
              </p>
              <Button onClick={handleBootstrap} disabled={bootstrapLoading}>
                {bootstrapLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Make this account admin
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
            Your account is not associated with any customer. Please contact support if you believe this is an error.
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-8">
        <h1 className="text-3xl font-medium">
          {isStaff ? 'Staff Dashboard' : 'Customer Portal'}
        </h1>

        {isStaff ? (
          // Staff Dashboard
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center gap-4">
                <div className="p-2 rounded-lg bg-primary/10">
                  <MessageSquare className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-lg">Support Tickets</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground mb-1">
                  Open tickets: <strong>{ticketStats.open}</strong>
                </p>
                <p className="text-muted-foreground mb-4">
                  Total tickets: <strong>{ticketStats.total}</strong>
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/portal/tickets">View all tickets</Link>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center gap-4">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Building2 className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-lg">Customers</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground mb-4">
                  Manage customer accounts and users.
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/portal/customers">View customers</Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : (
          // Customer Dashboard
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center gap-4">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Building2 className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-lg">Account</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground mb-1">
                  Company: <strong>{customerData?.org_name || 'N/A'}</strong>
                </p>
                <p className="text-muted-foreground mb-4">
                  Contact: {customerData?.billing_email || user?.email}
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/portal/account">View account</Link>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center gap-4">
                <div className="p-2 rounded-lg bg-primary/10">
                  <FileText className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-lg">Billing</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground mb-1">
                  Invoices: <strong>{invoiceStats.total} total</strong>
                </p>
                <p className="text-muted-foreground mb-4">
                  Last invoice: {invoiceStats.lastDate || 'N/A'}
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/portal/billing">View billing</Link>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center gap-4">
                <div className="p-2 rounded-lg bg-primary/10">
                  <MessageSquare className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-lg">Support Tickets</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground mb-1">
                  Open tickets: <strong>{ticketStats.open}</strong>
                </p>
                <p className="text-muted-foreground mb-4">
                  Total tickets: {ticketStats.total}
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/portal/tickets">View tickets</Link>
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
