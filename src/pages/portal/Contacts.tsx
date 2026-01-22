import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search, UserPlus } from 'lucide-react';
import { format } from 'date-fns';
import PortalLayout from '@/components/portal/PortalLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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
  const [convertingId, setConvertingId] = useState<string | null>(null);

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

  const handleConvertToCustomer = async (contact: Contact) => {
    setConvertingId(contact.id);
    try {
      // Create new customer
      const { data: newCustomer, error: customerError } = await supabase
        .from('customers')
        .insert({
          org_name: contact.name,
          billing_email: contact.email,
          phone: contact.phone,
        })
        .select('id')
        .single();

      if (customerError) throw customerError;

      // Update contact with customer reference
      const { error: updateError } = await supabase
        .from('contacts')
        .update({
          converted_to_customer_id: newCustomer.id,
          converted_at: new Date().toISOString(),
        })
        .eq('id', contact.id);

      if (updateError) throw updateError;

      // Remove from local state
      setContacts((prev) => prev.filter((c) => c.id !== contact.id));

      toast({
        title: t('Kund skapad', 'Customer created'),
        description: (
          <span>
            {t('Kontakten har konverterats till kund.', 'Contact has been converted to customer.')}{' '}
            <a
              href={`/portal/customers/${newCustomer.id}/overview`}
              className="underline font-medium"
            >
              {t('Visa kund', 'View customer')}
            </a>
          </span>
        ),
      });
    } catch (error) {
      console.error('Error converting contact:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte konvertera kontakten', 'Could not convert contact'),
        variant: 'destructive',
      });
    } finally {
      setConvertingId(null);
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
                      <TableHead className="hidden lg:table-cell">{t('Meddelande', 'Message')}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t('Datum', 'Date')}</TableHead>
                      <TableHead className="text-right">{t('Åtgärder', 'Actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredContacts.map((contact) => (
                      <TableRow key={contact.id}>
                        <TableCell className="font-medium">{contact.name}</TableCell>
                        <TableCell>{contact.email}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          {contact.phone || '-'}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell max-w-xs truncate">
                          {contact.message}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {format(new Date(contact.created_at), 'yyyy-MM-dd')}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            onClick={() => handleConvertToCustomer(contact)}
                            disabled={convertingId === contact.id}
                          >
                            {convertingId === contact.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <>
                                <UserPlus className="w-4 h-4 mr-1" />
                                <span className="hidden sm:inline">
                                  {t('Gör till kund', 'Convert')}
                                </span>
                              </>
                            )}
                          </Button>
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
