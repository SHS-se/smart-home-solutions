import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, Send } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { getEdgeFunctionErrorMessage } from '@/lib/edge-function-error';
import { getAuthenticatedFunctionHeaders } from '@/lib/supabase-function-auth';

interface Invoice {
  id: string;
  invoice_number: string | null;
  customer?: { name: string | null; billing_email?: string | null; contact_email?: string | null } | null;
}

interface InvoiceEmailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice;
}

const InvoiceEmailModal: React.FC<InvoiceEmailModalProps> = ({
  open,
  onOpenChange,
  invoice,
}) => {
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const defaultEmail = invoice.customer?.billing_email || invoice.customer?.contact_email || '';
  const defaultSubject = `Faktura ${invoice.invoice_number || ''} från Smart Home Solutions`;
  const defaultMessage = `Hej,

Här kommer din faktura ${invoice.invoice_number || ''}. Klicka på länken i e-postmeddelandet för att se fakturan och betalningsinformation.

Med vänliga hälsningar,
Smart Home Solutions`;

  const [to, setTo] = useState(defaultEmail);
  const [subject, setSubject] = useState(defaultSubject);
  const [message, setMessage] = useState(defaultMessage);

  const sendMutation = useMutation({
    mutationFn: async () => {
      const { data, error, response } = await supabase.functions.invoke('send-invoice-email', {
        headers: await getAuthenticatedFunctionHeaders(),
        body: {
          invoice_id: invoice.id,
          to,
          subject,
          message,
        },
      });
      if (error) throw new Error(await getEdgeFunctionErrorMessage(error, response));
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: t('E-post skickad!', 'Email sent!'),
        description: data?.public_url
          ? t('Kunden fick en länk till fakturan.', 'Customer received a link to the invoice.')
          : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['invoice-detail'] });
      queryClient.invalidateQueries({ queryKey: ['invoice_events', invoice.id] });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({
        title: t('Kunde inte skicka e-post', 'Failed to send email'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Skicka faktura', 'Send invoice')}</DialogTitle>
          <DialogDescription>
            {t(
              'Kunden får ett e-postmeddelande med en länk till fakturan och betalningsinformation.',
              'The customer will receive an email with a link to the invoice and payment details.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="email-to">{t('Till', 'To')}</Label>
            <Input
              id="email-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="email@example.com"
            />
          </div>

          <div>
            <Label htmlFor="email-subject">{t('Ämne', 'Subject')}</Label>
            <Input
              id="email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="email-message">{t('Meddelande', 'Message')}</Label>
            <Textarea
              id="email-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={6}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('Avbryt', 'Cancel')}
          </Button>
          <Button
            data-testid="invoice-email-send-button"
            onClick={() => sendMutation.mutate()}
            disabled={!to || !subject || !message || sendMutation.isPending}
          >
            {sendMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            {t('Skicka', 'Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default InvoiceEmailModal;
