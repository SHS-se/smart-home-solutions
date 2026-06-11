import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Building2, ClipboardList } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { CustomerActionsMenu } from '@/components/portal/customers/CustomerActionsMenu';

interface Customer {
  id: string;
  name: string | null;
  billing_email: string | null;
  phone: string | null;
  created_at: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

type SortColumn = 'name' | 'billing_email' | 'phone';

const Customers: React.FC = () => {
  const { user, isStaff, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const { sortColumn, sortDirection, handleSort } = useTableSort<SortColumn>({ defaultColumn: 'name' });

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
        .from('customers_with_identity')
        .select('id, name, billing_email, phone, created_at, contact_name, contact_email, contact_phone')
        .order('name', { ascending: true });

      if (error) throw error;
      setCustomers((data || []) as Customer[]);
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
    const searchLower = searchQuery.toLowerCase();
    const filtered = customers.filter((customer) => (
      customer.name?.toLowerCase().includes(searchLower) ||
      customer.billing_email?.toLowerCase().includes(searchLower) ||
      customer.phone?.includes(searchQuery)
    ));
    return sortItems(filtered, sortColumn, sortDirection);
  }, [customers, searchQuery, sortColumn, sortDirection]);

  if (loading) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  if (!isStaff) {
    return (
      <>
        <Alert>
          <AlertDescription>
            {t('Du har inte behörighet att visa denna sida.', "You don't have permission to view this page.")}
          </AlertDescription>
        </Alert>
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <h1 className="text-3xl font-medium">{t('Kunder', 'Customers')}</h1>
          <Button variant="outline" asChild>
            <Link to="/portal/customers/questionnaire">
              <ClipboardList className="w-4 h-4" />
              {t('Frågeformulär', 'Questionnaire')}
            </Link>
          </Button>
        </div>

        {/* Search */}
        <div className="max-w-md">
          <Input
            placeholder={t('Sök kunder...', 'Search customers...')}
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
                <p className="text-muted-foreground">{t('Inga kunder hittades.', 'No customers found.')}</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead column="name" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('Kundnamn', 'Customer Name')}
                    </SortableTableHead>
                    <SortableTableHead column="billing_email" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('E-post', 'Email')}
                    </SortableTableHead>
                    <SortableTableHead column="phone" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('Telefon', 'Phone')}
                    </SortableTableHead>
                    <TableHead className="w-12">
                      {t('Åtgärder', 'Actions')}
                    </TableHead>
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
                        {customer.name || t('Namnlös', 'Unnamed')}
                      </TableCell>
                      <TableCell>{customer.contact_email || customer.billing_email || '-'}</TableCell>
                      <TableCell>{customer.contact_phone || customer.phone || '-'}</TableCell>
                      <TableCell>
                        <CustomerActionsMenu
                          customerId={customer.id}
                          customerName={customer.name || t('Namnlös', 'Unnamed')}
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
    </>
  );
};

export default Customers;
