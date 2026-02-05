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
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Loader2, Send, Paperclip } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface Invoice {
  id: string;
  invoice_number: string | null;
  stripe_invoice_id: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf_url: string | null;
  customer?: { name: string | null; billing_email?: string | null } | null;
  bom?: { project_name: string } | null;
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

  const defaultEmail = invoice.customer?.billing_email || '';
  const defaultSubject = `Faktura ${invoice.invoice_number || ''} från Smart Home Solutions`;
  const defaultMessage = `Hej,

Bifogat finner du faktura ${invoice.invoice_number || ''}.

Med vänliga hälsningar,
Smart Home Solutions`;

  const [to, setTo] = useState(defaultEmail);
  const [subject, setSubject] = useState(defaultSubject);
  const [message, setMessage] = useState(defaultMessage);
  const [includePaymentLink, setIncludePaymentLink] = useState(true);
  const [attachPdf, setAttachPdf] = useState(!!invoice.stripe_invoice_id);

  const sendMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('send-new-invoice-email', {
        body: {
          invoice_id: invoice.id,
          to,
          subject,
          message,
          include_payment_link: includePaymentLink,
          attach_pdf: attachPdf,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: t('E-post skickad!', 'Email sent!') });
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
            {t('Skicka fakturan via e-post till kunden.', 'Send the invoice via email to the customer.')}
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

          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="include-payment"
                checked={includePaymentLink}
                onCheckedChange={(checked) => setIncludePaymentLink(!!checked)}
                disabled={!invoice.hosted_invoice_url}
              />
              <Label htmlFor="include-payment" className="font-normal">
                {t('Inkludera betalningslänk', 'Include payment link')}
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="attach-pdf"
                checked={attachPdf}
                onCheckedChange={(checked) => setAttachPdf(!!checked)}
                disabled={!invoice.stripe_invoice_id}
              />
              <Label htmlFor="attach-pdf" className="font-normal flex items-center gap-1">
                <Paperclip className="h-3 w-3" />
                {t('Bifoga PDF-fil', 'Attach PDF file')}
              </Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('Avbryt', 'Cancel')}
          </Button>
          <Button
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
