import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, FileText, Receipt, Ticket, Package, Home, Camera, MessageSquare, Cpu } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { getResponseErrorMessage } from '@/lib/http-response';

interface LinkedDataPreview {
  customer: { name: string | null; billing_email: string | null; contact_id: string | null } | null;
  contact: { id: string; name: string; email: string } | null;
  quotes: Array<{ id: string; quote_number: string | null; status: string; total_inc_vat: number | null }>;
  invoices: Array<{ id: string; invoice_number: string | null; status: string | null; amount: number | null }>;
  tickets: Array<{ id: string; ticket_number: string | null; title: string; status: string }>;
  boms: Array<{ id: string; project_name: string; version: number }>;
  homes: Array<{ id: string; name: string }>;
  homeAnswerCount: number;
  homePhotoCount: number;
  deviceCount: number;
}

interface DeleteCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  onDeleted: () => void;
}

export const DeleteCustomerDialog: React.FC<DeleteCustomerDialogProps> = ({
  open,
  onOpenChange,
  customerId,
  onDeleted,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [preview, setPreview] = useState<LinkedDataPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open || !customerId) {
      setPreview(null);
      return;
    }

    const fetchPreview = async () => {
      setLoading(true);
      try {
        const { data: session } = await supabase.auth.getSession();
        const fallbackMessage = t('Kunde inte hämta kunddata', 'Could not fetch customer data');
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-customer`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.session?.access_token}`,
            },
            body: JSON.stringify({ customer_id: customerId, mode: 'preview' }),
          }
        );
        if (!response.ok) {
          throw new Error(await getResponseErrorMessage(response, fallbackMessage));
        }
        const data = await response.json();
        setPreview(data);
      } catch (err) {
        const description = err instanceof Error
          ? err.message
          : t('Kunde inte hämta kunddata', 'Could not fetch customer data');
        console.error('Error fetching delete preview:', err);
        toast({
          title: t('Fel', 'Error'),
          description,
          variant: 'destructive',
        });
        onOpenChange(false);
      } finally {
        setLoading(false);
      }
    };

    fetchPreview();
  }, [open, customerId]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-customer`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.session?.access_token}`,
          },
          body: JSON.stringify({ customer_id: customerId }),
        }
      );
      if (!response.ok) {
        throw new Error(
          await getResponseErrorMessage(
            response,
            t('Kunde inte radera kunden', 'Could not delete customer'),
          ),
        );
      }
      toast({
        title: t('Kund raderad', 'Customer deleted'),
        description: t('Kunden och all kopplad data har tagits bort.', 'Customer and all linked data have been removed.'),
      });
      onDeleted();
    } catch (err) {
      console.error('Error deleting customer:', err);
      toast({
        title: t('Fel', 'Error'),
        description: err.message || t('Kunde inte radera kunden', 'Could not delete customer'),
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
      onOpenChange(false);
    }
  };

  const formatCurrency = (amount: number | null) => {
    if (amount == null) return '';
    return ` (${amount.toLocaleString('sv-SE')} SEK)`;
  };

  const statusLabel = (status: string) => {
    const map: Record<string, string> = {
      draft: t('Utkast', 'Draft'),
      open: t('Öppen', 'Open'),
      sent: t('Skickad', 'Sent'),
      accepted: t('Accepterad', 'Accepted'),
      cancelled: t('Avbruten', 'Cancelled'),
      paid: t('Betald', 'Paid'),
      void: t('Makulerad', 'Void'),
      overdue: t('Förfallen', 'Overdue'),
      closed: t('Stängd', 'Closed'),
      revision_requested: t('Revision begärd', 'Revision requested'),
      declined: t('Avvisad', 'Declined'),
      expired: t('Utgången', 'Expired'),
    };
    return map[status] || status;
  };

  const hasLinkedData = preview && (
    preview.quotes.length > 0 ||
    preview.invoices.length > 0 ||
    preview.tickets.length > 0 ||
    preview.boms.length > 0 ||
    preview.homes.length > 0 ||
    preview.deviceCount > 0
  );

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" />
            {t('Radera kund?', 'Delete customer?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {preview?.customer?.name
              ? t(
                  `Du håller på att radera "${preview.customer.name}". Denna åtgärd kan inte ångras.`,
                  `You are about to delete "${preview.customer.name}". This action cannot be undone.`
                )
              : t(
                  'Du håller på att radera denna kund. Denna åtgärd kan inte ångras.',
                  'You are about to delete this customer. This action cannot be undone.'
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

            {/* Quotes */}
            {preview.quotes.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  {t('Offerter', 'Quotes')} ({preview.quotes.length})
                </div>
                <ul className="ml-6 space-y-0.5 text-muted-foreground">
                  {preview.quotes.map((q) => (
                    <li key={q.id}>
                      {q.quote_number || '—'}{' '}
                      <Badge variant="outline" className="text-xs ml-1">{statusLabel(q.status)}</Badge>
                      {formatCurrency(q.total_inc_vat)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Invoices */}
            {preview.invoices.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <Receipt className="w-4 h-4 text-muted-foreground" />
                  {t('Fakturor', 'Invoices')} ({preview.invoices.length})
                </div>
                <ul className="ml-6 space-y-0.5 text-muted-foreground">
                  {preview.invoices.map((inv) => (
                    <li key={inv.id}>
                      {inv.invoice_number || t('Utkast', 'Draft')}{' '}
                      <Badge variant="outline" className="text-xs ml-1">{statusLabel(inv.status || 'draft')}</Badge>
                      {formatCurrency(inv.amount)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Tickets */}
            {preview.tickets.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <Ticket className="w-4 h-4 text-muted-foreground" />
                  {t('Ärenden', 'Tickets')} ({preview.tickets.length})
                </div>
                <ul className="ml-6 space-y-0.5 text-muted-foreground">
                  {preview.tickets.map((tk) => (
                    <li key={tk.id}>
                      {tk.ticket_number || '—'}: {tk.title}{' '}
                      <Badge variant="outline" className="text-xs ml-1">{statusLabel(tk.status)}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* BOMs */}
            {preview.boms.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <Package className="w-4 h-4 text-muted-foreground" />
                  {t('Materiallistor', 'BOMs')} ({preview.boms.length})
                </div>
                <ul className="ml-6 space-y-0.5 text-muted-foreground">
                  {preview.boms.map((b) => (
                    <li key={b.id}>
                      {b.project_name} (v{b.version})
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Homes & related counts */}
            {preview.homes.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <Home className="w-4 h-4 text-muted-foreground" />
                  {t('Bostäder', 'Homes')} ({preview.homes.length})
                </div>
                <ul className="ml-6 space-y-0.5 text-muted-foreground">
                  {preview.homes.map((h) => (
                    <li key={h.id}>{h.name}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Summary counts for home-related data */}
            {(preview.homeAnswerCount > 0 || preview.homePhotoCount > 0 || preview.deviceCount > 0) && (
              <div className="ml-6 space-y-0.5 text-muted-foreground">
                {preview.homeAnswerCount > 0 && (
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-3 h-3" />
                    {preview.homeAnswerCount} {t('hemprofilsvar', 'home profile answers')}
                  </div>
                )}
                {preview.homePhotoCount > 0 && (
                  <div className="flex items-center gap-2">
                    <Camera className="w-3 h-3" />
                    {preview.homePhotoCount} {t('foton', 'photos')}
                  </div>
                )}
                {preview.deviceCount > 0 && (
                  <div className="flex items-center gap-2">
                    <Cpu className="w-3 h-3" />
                    {preview.deviceCount} {t('enheter', 'devices')}
                  </div>
                )}
              </div>
            )}

            {/* Contact info */}
            {preview.contact && (
              <div className="border-t pt-2 mt-2 text-muted-foreground">
                <p>
                  {t(
                    `Kontakten "${preview.contact.name}" (${preview.contact.email}) kommer att frikopplas men inte raderas.`,
                    `Contact "${preview.contact.name}" (${preview.contact.email}) will be unlinked but not deleted.`
                  )}
                </p>
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
