import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, MessageSquare, FileText, User, UserCheck } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

interface ContactPreview {
  contact: { name: string; email: string; phone: string | null };
  messages: Array<{ id: string; body: string; author_type: string; created_at: string }>;
  draftAnswerCount: number;
  intakeEventCount: number;
  linkedCustomer: { id: string; name: string | null; billing_email: string | null } | null;
  hasAuthUser: boolean;
}

interface DeleteContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  onDeleted: () => void;
}

export const DeleteContactDialog: React.FC<DeleteContactDialogProps> = ({
  open,
  onOpenChange,
  contactId,
  onDeleted,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [preview, setPreview] = useState<ContactPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open || !contactId) {
      setPreview(null);
      return;
    }

    const fetchPreview = async () => {
      setLoading(true);
      try {
        const { data: session } = await supabase.auth.getSession();
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-contact`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.session?.access_token}`,
            },
            body: JSON.stringify({ contact_id: contactId, mode: 'preview' }),
          }
        );
        if (!response.ok) throw new Error('Failed to fetch preview');
        setPreview(await response.json());
      } catch (err) {
        console.error('Error fetching contact delete preview:', err);
        toast({
          title: t('Fel', 'Error'),
          description: t('Kunde inte hämta kontaktdata', 'Could not fetch contact data'),
          variant: 'destructive',
        });
        onOpenChange(false);
      } finally {
        setLoading(false);
      }
    };

    fetchPreview();
  }, [open, contactId]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-contact`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.session?.access_token}`,
          },
          body: JSON.stringify({ contact_id: contactId }),
        }
      );
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Delete failed');
      }
      toast({
        title: t('Kontakt borttagen', 'Contact deleted'),
        description: t('Kontakten och all kopplad data har tagits bort.', 'Contact and all linked data have been removed.'),
      });
      onDeleted();
    } catch (err: any) {
      console.error('Error deleting contact:', err);
      toast({
        title: t('Fel', 'Error'),
        description: err.message || t('Kunde inte ta bort kontakten', 'Could not delete contact'),
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
      onOpenChange(false);
    }
  };

  const hasLinkedData = preview && (
    preview.messages.length > 0 ||
    preview.draftAnswerCount > 0 ||
    preview.hasAuthUser
  );

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" />
            {t('Ta bort kontakt?', 'Delete contact?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {preview?.contact?.name
              ? t(
                  `Du håller på att ta bort "${preview.contact.name}" (${preview.contact.email}). Denna åtgärd kan inte ångras.`,
                  `You are about to delete "${preview.contact.name}" (${preview.contact.email}). This action cannot be undone.`
                )
              : t(
                  'Du håller på att ta bort denna kontakt. Denna åtgärd kan inte ångras.',
                  'You are about to delete this contact. This action cannot be undone.'
                )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              {t('Hämtar kopplad data...', 'Fetching linked data...')}
            </span>
          </div>
        ) : preview && (
          <div className="space-y-3 text-sm">
            {hasLinkedData && (
              <p className="font-medium text-destructive">
                {t('Följande data kommer också att raderas:', 'The following data will also be deleted:')}
              </p>
            )}

            {/* Messages */}
            {preview.messages.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <MessageSquare className="w-4 h-4 text-muted-foreground" />
                  {t('Meddelanden', 'Messages')} ({preview.messages.length})
                </div>
                <ul className="ml-6 space-y-0.5 text-muted-foreground">
                  {preview.messages.slice(0, 5).map((m) => (
                    <li key={m.id} className="truncate max-w-sm">
                      {m.author_type === 'staff' ? '↩ ' : '→ '}
                      {m.body.substring(0, 80)}{m.body.length > 80 ? '…' : ''}
                    </li>
                  ))}
                  {preview.messages.length > 5 && (
                    <li className="italic">
                      {t(`…och ${preview.messages.length - 5} till`, `…and ${preview.messages.length - 5} more`)}
                    </li>
                  )}
                </ul>
              </div>
            )}

            {/* Draft answers */}
            {preview.draftAnswerCount > 0 && (
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <span>{preview.draftAnswerCount} {t('utkast-hemprofilsvar', 'draft home profile answers')}</span>
              </div>
            )}

            {/* Auth user */}
            {preview.hasAuthUser && (
              <div className="flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-muted-foreground" />
                <span>{t('Inloggningskonto kommer att raderas', 'Login account will be deleted')}</span>
              </div>
            )}

            {/* Linked customer warning */}
            {preview.linkedCustomer && (
              <div className="border-t pt-2 mt-2 text-muted-foreground">
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4" />
                  <span>
                    {t(
                      `Kopplad kund "${preview.linkedCustomer.name || preview.linkedCustomer.billing_email}" kommer att frikopplas men inte raderas.`,
                      `Linked customer "${preview.linkedCustomer.name || preview.linkedCustomer.billing_email}" will be unlinked but not deleted.`
                    )}
                  </span>
                </div>
              </div>
            )}

            {!hasLinkedData && (
              <p className="text-muted-foreground">
                {t('Ingen kopplad data hittades.', 'No linked data found.')}
              </p>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>
            {t('Avbryt', 'Cancel')}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting || loading}
          >
            {deleting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {t('Radera permanent', 'Delete permanently')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
