import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Users, Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { supabase } from '@/integrations/supabase/client';

interface Customer {
  id: string;
  org_name: string | null;
  billing_email: string | null;
  phone: string | null;
  created_at: string;
}

const Customers: React.FC = () => {
  const { user, isStaff, loading } = useAuth();
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
    if (!loading && !isStaff) {
      navigate('/portal');
    }
  }, [user, isStaff, loading, navigate]);

  useEffect(() => {
    const fetchCustomers = async () => {
      if (!isStaff) return;
      setCustomersLoading(true);

      try {
        const { data, error } = await supabase
          .from('customers')
          .select('*')
          .order('org_name', { ascending: true });

        if (error) throw error;
        setCustomers(data || []);
      } catch (error) {
        console.error('Error fetching customers:', error);
      } finally {
        setCustomersLoading(false);
      }
    };

    if (!loading && isStaff) {
      fetchCustomers();
    }
  }, [isStaff, loading]);

  const filteredCustomers = customers.filter((customer) => {
    const searchLower = searchQuery.toLowerCase();
    return (
      customer.org_name?.toLowerCase().includes(searchLower) ||
      customer.billing_email?.toLowerCase().includes(searchLower) ||
      customer.phone?.includes(searchQuery)
    );
  });

  if (loading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  if (!isStaff) {
    return (
      <PortalLayout>
        <Alert>
          <AlertDescription>
            You don't have permission to view this page.
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <h1 className="text-3xl font-medium">Customers</h1>
        </div>

        {/* Search */}
        <div className="max-w-md">
          <Input
            placeholder="Search customers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Customers Table */}
        <Card>
          <CardContent className="pt-6">
            {customersLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : filteredCustomers.length === 0 ? (
              <div className="text-center py-12">
                <Building2 className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No customers found.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-primary">Company</TableHead>
                    <TableHead className="text-primary">Email</TableHead>
                    <TableHead className="text-primary">Phone</TableHead>
                    <TableHead className="text-primary">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCustomers.map((customer) => (
                    <TableRow key={customer.id}>
                      <TableCell className="font-medium">
                        {customer.org_name || 'Unnamed'}
                      </TableCell>
                      <TableCell>{customer.billing_email || '-'}</TableCell>
                      <TableCell>{customer.phone || '-'}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/portal/customers/${customer.id}`}>
                            View
                          </Link>
                        </Button>
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

export default Customers;
