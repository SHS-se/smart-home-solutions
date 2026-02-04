import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Building2, FlaskConical } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';
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
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { CustomerActionsMenu } from '@/components/portal/customers/CustomerActionsMenu';

interface Customer {
  id: string;
  org_name: string | null;
  billing_email: string | null;
  phone: string | null;
  created_at: string;
  is_test: boolean;
}

type SortColumn = 'org_name' | 'billing_email' | 'phone';
type TestFilter = 'all' | 'live' | 'test';

const Customers: React.FC = () => {
  const { user, isStaff, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [testFilter, setTestFilter] = useState<TestFilter>('live');
  const { sortColumn, sortDirection, handleSort } = useTableSort<SortColumn>({ defaultColumn: 'org_name' });

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
    if (!loading && !isStaff) {
      navigate('/portal');
    }
  }, [user, isStaff, loading, navigate]);

  const fetchCustomers = useCallback(async () => {
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
  }, [isStaff]);

  useEffect(() => {
    if (!loading && isStaff) {
      fetchCustomers();
    }
  }, [isStaff, loading, fetchCustomers]);

  const filteredCustomers = useMemo(() => {
    const filtered = customers.filter((customer) => {
      // Test filter
      if (testFilter === 'live' && customer.is_test) return false;
      if (testFilter === 'test' && !customer.is_test) return false;
      
      // Search filter
      const searchLower = searchQuery.toLowerCase();
      return (
        customer.org_name?.toLowerCase().includes(searchLower) ||
        customer.billing_email?.toLowerCase().includes(searchLower) ||
        customer.phone?.includes(searchQuery)
      );
    });
    return sortItems(filtered, sortColumn, sortDirection);
  }, [customers, searchQuery, testFilter, sortColumn, sortDirection]);

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
            {t('Du har inte behörighet att visa denna sida.', "You don't have permission to view this page.")}
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <h1 className="text-3xl font-medium">{t('Kunder', 'Customers')}</h1>
        </div>

        {/* Search and Filter */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 max-w-md">
            <Input
              placeholder={t('Sök kunder...', 'Search customers...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Select value={testFilter} onValueChange={(value: TestFilter) => setTestFilter(value)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="live">{t('Live', 'Live')}</SelectItem>
              <SelectItem value="test">{t('Test', 'Test')}</SelectItem>
              <SelectItem value="all">{t('Alla', 'All')}</SelectItem>
            </SelectContent>
          </Select>
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
                <p className="text-muted-foreground">{t('Inga kunder hittades.', 'No customers found.')}</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead column="org_name" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('Kundnamn', 'Customer Name')}
                    </SortableTableHead>
                    <SortableTableHead column="billing_email" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('E-post', 'Email')}
                    </SortableTableHead>
                    <SortableTableHead column="phone" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('Telefon', 'Phone')}
                    </SortableTableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCustomers.map((customer) => (
                    <TableRow 
                      key={customer.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => navigate(`/portal/customers/${customer.id}/overview`)}
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {customer.org_name || t('Namnlös', 'Unnamed')}
                          {customer.is_test && (
                            <Badge variant="secondary" className="text-xs">
                              <FlaskConical className="w-3 h-3 mr-1" />
                              Test
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{customer.billing_email || '-'}</TableCell>
                      <TableCell>{customer.phone || '-'}</TableCell>
                      <TableCell>
                        <CustomerActionsMenu
                          customerId={customer.id}
                          isTest={customer.is_test}
                          onUpdated={fetchCustomers}
                        />
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
