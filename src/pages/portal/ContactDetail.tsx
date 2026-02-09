import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Loader2, ArrowLeft, UserPlus, Trash2, Send, Mail, MessageSquare, Globe } from 'lucide-react';
import { format } from 'date-fns';
import PortalLayout from '@/components/portal/PortalLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
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
  email_token: string;
  created_at: string;
}

interface ContactMessage {
  id: string;
  contact_id: string;
  body: string;
  author_type: 'lead' | 'staff';
  author_email: string;
  source: 'form' | 'email' | 'portal';
  created_at: string;
}

const ContactDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();

  const [contact, setContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [converting, setConverting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user && isStaff && id) {
      fetchContact();
      fetchMessages();
    }
  }, [user, isStaff, id]);

  const fetchContact = async () => {
    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, name, email, phone, message, email_token, created_at')
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

  const fetchMessages = async () => {
    try {
      const { data, error } = await supabase
        .from('contact_messages')
        .select('*')
        .eq('contact_id', id)
        .order('created_at', { ascending: true });

      if (error) throw error;
      setMessages(data as ContactMessage[] || []);
    } catch (error) {
      console.error('Error fetching messages:', error);
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleSendReply = async () => {
    if (!contact || !replyText.trim()) return;
    setSending(true);

    try {
      // Get current session for auth header
      const { data: session } = await supabase.auth.getSession();
      
      // Store message in contact_messages
      const { error: insertError } = await supabase
        .from('contact_messages')
        .insert({
          contact_id: contact.id,
          body: replyText.trim(),
          author_type: 'staff',
          author_email: user?.email || 'staff@smarthomesolutions.se',
          source: 'portal',
        });

      if (insertError) throw insertError;

      // Send email to the lead via edge function
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-sales-reply`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.session?.access_token}`,
          },
          body: JSON.stringify({
            contact_id: contact.id,
            message: replyText.trim(),
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Error sending email:', errorData);
        // Message was saved, just warn about email
        toast({
          title: t('Svar sparat', 'Reply saved'),
          description: t(
            'Meddelandet sparades men e-posten kunde inte skickas.',
            'The message was saved but the email could not be sent.'
          ),
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('Svar skickat', 'Reply sent'),
          description: t(
            'Ditt svar har skickats till kunden.',
            'Your reply has been sent to the customer.'
          ),
        });
      }

      setReplyText('');
      fetchMessages();
    } catch (error) {
      console.error('Error sending reply:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte skicka svar', 'Could not send reply'),
        variant: 'destructive',
      });
    } finally {
      setSending(false);
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
          contact_id: contact.id,
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

      // Update the customer with the contact_id link
      const { error: linkError } = await supabase
        .from('customers')
        .update({ contact_id: contact.id })
        .eq('id', newCustomer.id);

      if (linkError) throw linkError;

      // Invite customer - creates auth user and sends welcome email
      const { data: session } = await supabase.auth.getSession();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-customer`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.session?.access_token}`,
          },
          body: JSON.stringify({ customer_id: newCustomer.id }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        console.error('Invite error:', result.error);
        toast({
          title: t('Kund skapad', 'Customer created'),
          description: t(
            'Kunden skapades men inbjudan kunde inte skickas. Kontrollera e-postadressen.',
            'Customer created but invitation could not be sent. Please check the email address.'
          ),
          variant: 'destructive',
        });
      } else if (result.warning) {
        toast({
          title: t('Kund skapad', 'Customer created'),
          description: t(
            'Kunden skapades men e-post kunde inte skickas.',
            'Customer created but email could not be sent.'
          ),
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('Kund skapad och inbjuden', 'Customer created and invited'),
          description: t(
            'En inbjudan har skickats till kundens e-post.',
            'An invitation has been sent to the customer\'s email.'
          ),
        });
      }

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
      const { data: session } = await supabase.auth.getSession();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-contact`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.session?.access_token}`,
          },
          body: JSON.stringify({ contact_id: contact.id }),
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Delete failed');
      }

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

  const getSourceIcon = (source: string) => {
    switch (source) {
      case 'form':
        return <Globe className="w-3 h-3" />;
      case 'email':
        return <Mail className="w-3 h-3" />;
      case 'portal':
        return <MessageSquare className="w-3 h-3" />;
      default:
        return null;
    }
  };

  const getSourceLabel = (source: string) => {
    switch (source) {
      case 'form':
        return t('Kontaktformulär', 'Contact form');
      case 'email':
        return t('E-post', 'Email');
      case 'portal':
        return t('Portal', 'Portal');
      default:
        return source;
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

        {/* Conversation Thread */}
        <Card>
          <CardHeader>
            <CardTitle>{t('Konversation', 'Conversation')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {messagesLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : messages.length === 0 ? (
              // Fallback: show the original message if no messages yet
              <div className="p-4 rounded-lg bg-muted/50 border">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{contact.name}</span>
                    <Badge variant="secondary" className="text-xs flex items-center gap-1">
                      <Globe className="w-3 h-3" />
                      {t('Kontaktformulär', 'Contact form')}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(contact.created_at), 'yyyy-MM-dd HH:mm')}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{contact.message}</p>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`p-4 rounded-lg border ${
                      msg.author_type === 'staff'
                        ? 'bg-primary/5 border-primary/20 ml-4'
                        : 'bg-muted/50 mr-4'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {msg.author_type === 'staff'
                            ? t('Personal', 'Staff')
                            : contact.name}
                        </span>
                        <Badge variant="secondary" className="text-xs flex items-center gap-1">
                          {getSourceIcon(msg.source)}
                          {getSourceLabel(msg.source)}
                        </Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(msg.created_at), 'yyyy-MM-dd HH:mm')}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{msg.body}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Reply Form */}
            <div className="border-t pt-4 mt-4">
              <div className="space-y-3">
                <Textarea
                  placeholder={t('Skriv ett svar...', 'Write a reply...')}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  rows={4}
                  disabled={sending}
                />
                <div className="flex justify-end">
                  <Button
                    onClick={handleSendReply}
                    disabled={!replyText.trim() || sending}
                  >
                    {sending ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : (
                      <Send className="w-4 h-4 mr-2" />
                    )}
                    {t('Skicka svar', 'Send reply')}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default ContactDetail;
