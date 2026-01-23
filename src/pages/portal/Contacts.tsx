import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search } from 'lucide-react';
import PortalLayout from '@/components/portal/PortalLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
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
}

const Contacts: React.FC = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();
  
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user && isStaff) {
      fetchContacts();
    }
  }, [user, isStaff]);

  const fetchContacts = async () => {
    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, name, email, phone, message, created_at')
        .is('converted_to_customer_id', null)
        .order('created_at', { ascending: false });

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

  const filteredContacts = contacts.filter((contact) => {
    const query = searchQuery.toLowerCase();
    return (
      contact.name.toLowerCase().includes(query) ||
      contact.email.toLowerCase().includes(query) ||
      (contact.phone && contact.phone.toLowerCase().includes(query))
    );
  });

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
          <h1 className="text-2xl font-bold">{t('Kontakter', 'Contacts')}</h1>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t('Sök kontakter...', 'Search contacts...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t('Kontaktformulärinlämningar', 'Contact Form Submissions')}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : filteredContacts.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                {searchQuery
                  ? t('Inga kontakter hittades', 'No contacts found')
                  : t('Inga kontakter ännu', 'No contacts yet')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Namn', 'Name')}</TableHead>
                      <TableHead>{t('E-post', 'Email')}</TableHead>
                      <TableHead className="hidden md:table-cell">{t('Telefon', 'Phone')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredContacts.map((contact) => (
                      <TableRow
                        key={contact.id}
                        className="cursor-pointer hover:bg-muted/50"
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
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default Contacts;
