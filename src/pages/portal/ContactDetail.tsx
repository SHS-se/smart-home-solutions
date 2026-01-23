import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Loader2, ArrowLeft, UserPlus, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import PortalLayout from '@/components/portal/PortalLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
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

const ContactDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user && isStaff && id) {
      fetchContact();
    }
  }, [user, isStaff, id]);

  const fetchContact = async () => {
    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, name, email, phone, message, created_at')
        .eq('id', id)
        .is('converted_to_customer_id', null)
        .single();

      if (error) throw error;
      setContact(data);
    } catch (error) {
      console.error('Error fetching contact:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte hämta kontakt', 'Could not fetch contact'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleConvertToCustomer = async () => {
    if (!contact) return;
    setConverting(true);
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

      toast({
        title: t('Kund skapad', 'Customer created'),
        description: t('Kontakten har konverterats till kund.', 'Contact has been converted to customer.'),
      });

      // Navigate to the new customer
      navigate(`/portal/customers/${newCustomer.id}/overview`);
    } catch (error) {
      console.error('Error converting contact:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte konvertera kontakten', 'Could not convert contact'),
        variant: 'destructive',
      });
    } finally {
      setConverting(false);
    }
  };

  const handleDelete = async () => {
    if (!contact) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from('contacts')
        .delete()
        .eq('id', contact.id);

      if (error) throw error;

      toast({
        title: t('Kontakt borttagen', 'Contact deleted'),
        description: t('Kontakten har tagits bort.', 'The contact has been deleted.'),
      });

      navigate('/portal/contacts');
    } catch (error) {
      console.error('Error deleting contact:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte ta bort kontakten', 'Could not delete contact'),
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  };

  if (authLoading || loading) {
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

  if (!contact) {
    return (
      <PortalLayout>
        <Alert variant="destructive">
          <AlertDescription>
            {t('Kontakten hittades inte eller har redan konverterats.', 'Contact not found or already converted.')}
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  const fields = [
    { label: t('Namn', 'Name'), value: contact.name },
    { label: t('E-post', 'Email'), value: contact.email },
    { label: t('Telefon', 'Phone'), value: contact.phone || '-' },
    { label: t('Datum', 'Date'), value: format(new Date(contact.created_at), 'yyyy-MM-dd HH:mm') },
  ];

  return (
    <PortalLayout>
      <div className="space-y-6">
        <Link
          to="/portal/contacts"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          {t('Tillbaka till kontakter', 'Back to contacts')}
        </Link>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <h1 className="text-2xl font-bold">{contact.name}</h1>
          <div className="flex gap-2">
            <Button
              onClick={handleConvertToCustomer}
              disabled={converting}
            >
              {converting ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <UserPlus className="w-4 h-4 mr-2" />
              )}
              {t('Gör till kund', 'Convert to customer')}
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={deleting}>
                  {deleting ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <Trash2 className="w-4 h-4 mr-2" />
                  )}
                  {t('Ta bort', 'Delete')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t('Ta bort kontakt?', 'Delete contact?')}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t(
                      'Denna åtgärd kan inte ångras. Kontakten kommer att tas bort permanent.',
                      'This action cannot be undone. The contact will be permanently deleted.'
                    )}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {t('Avbryt', 'Cancel')}
                  </AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}>
                    {t('Ta bort', 'Delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t('Kontaktinformation', 'Contact information')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {fields.map((field) => (
              <div key={field.label} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <span className="text-muted-foreground">{field.label}</span>
                <span className="sm:col-span-2">{field.value}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Meddelande', 'Message')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap">{contact.message}</p>
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default ContactDetail;
