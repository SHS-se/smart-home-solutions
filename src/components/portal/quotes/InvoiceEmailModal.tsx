import React, { useState, useEffect } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Send, Loader2, ExternalLink, FileText } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface InvoiceEmailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quote: {
    id: string;
    quote_number: string;
    invoice_number: string | null;
    invoice_hosted_url: string | null;
    invoice_pdf_url: string | null;
    invoice_due_date: string | null;
    invoice_total: number | null;
    total_inc_vat: number | null;
    customer?: { name: string | null; billing_email?: string | null } | null;
    bom?: { project_name: string } | null;
  };
}

const InvoiceEmailModal: React.FC<InvoiceEmailModalProps> = ({ 
  open, 
  onOpenChange, 
  quote 
}) => {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [isSending, setIsSending] = useState(false);
  
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [includePaymentLink, setIncludePaymentLink] = useState(true);
  const [includePdfLink, setIncludePdfLink] = useState(true);

  const formatPrice = (value: number | null) => {
    if (value === null) return '—';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('sv-SE');
  };

  // Generate email template when modal opens
  useEffect(() => {
    if (open) {
      const customerEmail = quote.customer?.billing_email || '';
      const projectName = quote.bom?.project_name || quote.quote_number;
      const invoiceNumber = quote.invoice_number || quote.quote_number;
      const total = quote.invoice_total ?? quote.total_inc_vat;
      const dueDate = formatDate(quote.invoice_due_date);

      setTo(customerEmail);
      setSubject(`Faktura ${invoiceNumber} – ${projectName}`);
      setBody(
`Hej,

Tack för er beställning! Bifogat finner ni er faktura för ${projectName}.

Fakturainformation:
- Fakturanummer: ${invoiceNumber}
- Totalbelopp (inkl. moms): ${formatPrice(total)}
- Förfallodatum: ${dueDate}

Vid frågor, kontakta oss på support@smarthomesolutions.se.

Med vänliga hälsningar,
Smart Home Solutions`
      );
      setIncludePaymentLink(!!quote.invoice_hosted_url);
      setIncludePdfLink(!!quote.invoice_pdf_url);
    }
  }, [open, quote]);

  const handleSend = async () => {
    if (!to.trim()) {
      toast({
        title: t('E-postadress krävs', 'Email address required'),
        variant: 'destructive',
      });
      return;
    }

    setIsSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-invoice-email', {
        body: {
          quote_id: quote.id,
          to: to.trim(),
          subject,
          body,
          include_payment_link: includePaymentLink,
          include_pdf_link: includePdfLink,
        },
      });

      if (error) throw error;
      if (data.error) throw new Error(data.error);

      toast({
        title: t('E-post skickad!', 'Email sent!'),
        description: t(`Fakturan har skickats till ${to}`, `Invoice has been sent to ${to}`),
      });

      queryClient.invalidateQueries({ queryKey: ['billing_events', quote.id] });
      queryClient.invalidateQueries({ queryKey: ['quote_emails', quote.id] });
      onOpenChange(false);
    } catch (error: any) {
      toast({
        title: t('Kunde inte skicka e-post', 'Failed to send email'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            {t('Skicka faktura', 'Send invoice')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* To */}
          <div className="space-y-2">
            <Label htmlFor="to">{t('Till', 'To')}</Label>
            <Input
              id="to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="kund@example.com"
            />
          </div>

          {/* Subject */}
          <div className="space-y-2">
            <Label htmlFor="subject">{t('Ämne', 'Subject')}</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          {/* Body */}
          <div className="space-y-2">
            <Label htmlFor="body">{t('Meddelande', 'Message')}</Label>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="font-mono text-sm"
            />
          </div>

          {/* Include links */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="includePaymentLink"
                checked={includePaymentLink}
                onCheckedChange={(checked) => setIncludePaymentLink(!!checked)}
                disabled={!quote.invoice_hosted_url}
              />
              <Label 
                htmlFor="includePaymentLink" 
                className={!quote.invoice_hosted_url ? 'text-muted-foreground' : ''}
              >
                {t('Inkludera betallänk', 'Include payment link')}
              </Label>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="includePdfLink"
                checked={includePdfLink}
                onCheckedChange={(checked) => setIncludePdfLink(!!checked)}
                disabled={!quote.invoice_pdf_url}
              />
              <Label 
                htmlFor="includePdfLink"
                className={!quote.invoice_pdf_url ? 'text-muted-foreground' : ''}
              >
                {t('Inkludera PDF-länk', 'Include PDF link')}
              </Label>
            </div>
          </div>

          {/* Preview links */}
          {(includePaymentLink || includePdfLink) && (
            <Card className="bg-muted/50">
              <CardContent className="p-4 space-y-2">
                <p className="text-sm font-medium text-muted-foreground">
                  {t('Inkluderade länkar:', 'Included links:')}
                </p>
                {includePaymentLink && quote.invoice_hosted_url && (
                  <div className="flex items-center gap-2 text-sm">
                    <ExternalLink className="h-4 w-4 text-primary" />
                    <span className="text-primary">{t('Betallänk', 'Payment link')}</span>
                    <span className="text-muted-foreground truncate flex-1 font-mono text-xs">
                      {quote.invoice_hosted_url.substring(0, 50)}...
                    </span>
                  </div>
                )}
                {includePdfLink && quote.invoice_pdf_url && (
                  <div className="flex items-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-primary" />
                    <span className="text-primary">{t('PDF-länk', 'PDF link')}</span>
                    <span className="text-muted-foreground truncate flex-1 font-mono text-xs">
                      {quote.invoice_pdf_url.substring(0, 50)}...
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('Avbryt', 'Cancel')}
          </Button>
          <Button onClick={handleSend} disabled={isSending || !to.trim()}>
            {isSending ? (
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
