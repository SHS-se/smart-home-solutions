import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search } from 'lucide-react';
import PortalLayout from '@/components/portal/PortalLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  created_at: string;
  converted_to_customer_id: string | null;
}

type FilterType = 'leads' | 'converted' | 'all';
type SortColumn = 'name' | 'email' | 'phone';

const Contacts: React.FC = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();
  
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('leads');
  const { sortColumn, sortDirection, handleSort } = useTableSort<SortColumn>({ defaultColumn: 'name' });

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user && isStaff) {
      fetchContacts();
    }
  }, [user, isStaff, filter]);

  const fetchContacts = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('contacts')
        .select('id, name, email, phone, message, created_at, converted_to_customer_id')
        .order('created_at', { ascending: false });

      if (filter === 'leads') {
        query = query.is('converted_to_customer_id', null);
      } else if (filter === 'converted') {
        query = query.not('converted_to_customer_id', 'is', null);
      }

      const { data, error } = await query;

      if (error) throw error;
      setContacts(data || []);
    } catch (error) {
      console.error('Error fetching contacts:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte hämta kontakter', 'Could not fetch contacts'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const filteredContacts = useMemo(() => {
    const filtered = contacts.filter((contact) => {
      const query = searchQuery.toLowerCase();
      return (
        contact.name.toLowerCase().includes(query) ||
        contact.email.toLowerCase().includes(query) ||
        (contact.phone && contact.phone.toLowerCase().includes(query))
      );
    });
    return sortItems(filtered, sortColumn, sortDirection);
  }, [contacts, searchQuery, sortColumn, sortDirection]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isStaff) {
    return (
      <PortalLayout>
        <Alert variant="destructive">
          <AlertDescription>
            {t('Du har inte behörighet att visa denna sida.', 'You do not have permission to view this page.')}
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <h1 className="text-3xl font-medium">{t('Kontakter', 'Contacts')}</h1>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <Select value={filter} onValueChange={(value: FilterType) => setFilter(value)}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="leads">{t('Leads', 'Leads')}</SelectItem>
              <SelectItem value="converted">{t('Konverterade', 'Converted')}</SelectItem>
              <SelectItem value="all">{t('Alla', 'All')}</SelectItem>
            </SelectContent>
          </Select>
          
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t('Sök kontakter...', 'Search contacts...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {/* Contacts Table */}
        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">
                  {searchQuery
                    ? t('Inga kontakter hittades', 'No contacts found')
                    : t('Inga kontakter ännu', 'No contacts yet')}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead column="name" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('Namn', 'Name')}
                    </SortableTableHead>
                    <SortableTableHead column="email" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('E-post', 'Email')}
                    </SortableTableHead>
                    <SortableTableHead column="phone" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort} className="hidden md:table-cell">
                      {t('Telefon', 'Phone')}
                    </SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredContacts.map((contact) => (
                    <TableRow
                      key={contact.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/portal/contacts/${contact.id}`)}
                    >
                      <TableCell className="font-medium">{contact.name}</TableCell>
                      <TableCell>{contact.email}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {contact.phone || '-'}
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

export default Contacts;
