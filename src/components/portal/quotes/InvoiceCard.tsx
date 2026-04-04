import React, { useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  FileText,
  Send,
  XCircle,
  CheckCircle2,
  Loader2,
  Receipt,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { getEdgeFunctionErrorMessage } from '@/lib/edge-function-error';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import InvoiceEmailModal from '../invoices/InvoiceEmailModal';
import InvoicePdfModal from '../invoices/InvoicePdfModal';

interface InvoiceCardProps {
  quote: {
    id: string;
    quote_number: string | null;
    invoice_status: string | null;
    invoice_number: string | null;
    invoice_due_date: string | null;
    invoice_subtotal: number | null;
    invoice_vat: number | null;
    invoice_total: number | null;
    subtotal_ex_vat: number | null;
    vat_total: number | null;
    total_inc_vat: number | null;
    customer?: { name: string | null; billing_email?: string | null; contact_email?: string | null } | null;
    bom?: { project_name: string } | null;
  };
  /** The local invoice ID, if known */
  invoiceId?: string | null;
}

const InvoiceCard: React.FC<InvoiceCardProps> = ({ quote, invoiceId }) => {
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const [isCreating, setIsCreating] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isVoiding, setIsVoiding] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showPdfModal, setShowPdfModal] = useState(false);

  const invoiceStatus = quote.invoice_status || 'not_created';
  const hasInvoice = invoiceStatus !== 'not_created';
  const isDraft = invoiceStatus === 'draft';
  const isOpen = invoiceStatus === 'open';
  const isPaid = invoiceStatus === 'paid';
  const isVoid = invoiceStatus === 'void' || invoiceStatus === 'voided';
  const isUncollectible = invoiceStatus === 'uncollectible';

  const formatPrice = (value: number | null) => {
    if (value === null) return '\u2014';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '\u2014';
    return new Date(dateStr).toLocaleDateString('sv-SE');
  };

  const getStatusBadge = () => {
    switch (invoiceStatus) {
      case 'not_created':
        return <Badge variant="outline">{t('Ej skapad', 'Not created')}</Badge>;
      case 'draft':
        return <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>;
      case 'open':
        return <Badge variant="secondary">{t('\u00d6ppen', 'Open')}</Badge>;
      case 'paid':
        return <Badge className="bg-green-600">{t('Betald', 'Paid')}</Badge>;
      case 'void':
      case 'voided':
        return <Badge variant="destructive">{t('Makulerad', 'Voided')}</Badge>;
      case 'uncollectible':
        return <Badge variant="destructive">{t('Ej indrivningsbar', 'Uncollectible')}</Badge>;
      default:
        return <Badge variant="outline">{invoiceStatus}</Badge>;
    }
  };

  const handleCreateInvoice = async () => {
    setIsCreating(true);
    try {
      const { data, error, response } = await supabase.functions.invoke('create-invoice-from-quote', {
        body: { quote_id: quote.id },
      });
      if (error) throw new Error(await getEdgeFunctionErrorMessage(response ?? error));
      if (data.error) throw new Error(data.error);

      toast({
        title: t('Faktura skapad!', 'Invoice created!'),
        description: t('Fakturan \u00e4r nu ett utkast.', 'The invoice is now a draft.'),
      });
      queryClient.invalidateQueries({ queryKey: ['quote', quote.id] });
      queryClient.invalidateQueries({ queryKey: ['quote_events', quote.id] });
    } catch (error: any) {
      toast({
        title: t('Kunde inte skapa faktura', 'Failed to create invoice'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsCreating(false);
      setShowCreateDialog(false);
    }
  };

  const handleFinalizeInvoice = async () => {
    setIsFinalizing(true);
    try {
      const { data, error } = await supabase.functions.invoke('finalize-invoice', {
        body: { quote_id: quote.id },
      });
      if (error) throw error;
      if (data.error) throw new Error(data.error);

      toast({
        title: t('Faktura fastst\u00e4lld!', 'Invoice finalized!'),
        description: data.invoice_number
          ? `${t('Fakturanummer', 'Invoice number')}: ${data.invoice_number}`
          : t('Fakturan \u00e4r nu \u00f6ppen.', 'The invoice is now open.'),
      });
      queryClient.invalidateQueries({ queryKey: ['quote', quote.id] });
      queryClient.invalidateQueries({ queryKey: ['billing_events', quote.id] });
    } catch (error: any) {
      toast({
        title: t('Kunde inte fastst\u00e4lla faktura', 'Failed to finalize invoice'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsFinalizing(false);
      setShowFinalizeDialog(false);
    }
  };

  const handleVoidInvoice = async () => {
    setIsVoiding(true);
    try {
      const { data, error } = await supabase.functions.invoke('void-invoice', {
        body: { quote_id: quote.id },
      });
      if (error) throw error;
      if (data.error) throw new Error(data.error);

      toast({
        title: t('Faktura makulerad', 'Invoice voided'),
        description: t('Fakturan har makulerats.', 'The invoice has been voided.'),
      });
      queryClient.invalidateQueries({ queryKey: ['quote', quote.id] });
      queryClient.invalidateQueries({ queryKey: ['billing_events', quote.id] });
    } catch (error: any) {
      toast({
        title: t('Kunde inte makulera faktura', 'Failed to void invoice'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsVoiding(false);
      setShowVoidDialog(false);
    }
  };

  const subtotal = quote.invoice_subtotal ?? quote.subtotal_ex_vat;
  const vat = quote.invoice_vat ?? quote.vat_total;
  const total = quote.invoice_total ?? quote.total_inc_vat;

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5" />
              {t('Fakturering', 'Invoicing')}
            </CardTitle>
            {getStatusBadge()}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('Fakturanummer', 'Invoice number')}:</span>
              <span className="font-mono">{quote.invoice_number || '\u2014'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('F\u00f6rfallodatum', 'Due date')}:</span>
              <span>{formatDate(quote.invoice_due_date)}</span>
            </div>
            <div className="border-t border-border pt-2 mt-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('Delsumma', 'Subtotal')}:</span>
                <span>{formatPrice(subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('Moms', 'VAT')}:</span>
                <span>{formatPrice(vat)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>{t('Totalt', 'Total')}:</span>
                <span>{formatPrice(total)}</span>
              </div>
            </div>
          </div>

          {/* PDF download */}
          {hasInvoice && (isOpen || isPaid) && invoiceId && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowPdfModal(true)}
              >
                <FileText className="h-4 w-4 mr-1" />
                {t('Visa PDF', 'View PDF')}
              </Button>
            </div>
          )}

          {isPaid && (
            <div className="flex items-center gap-2 text-green-600 bg-green-50 dark:bg-green-950/30 rounded-md p-3">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-medium">{t('Fakturan \u00e4r betald', 'Invoice is paid')}</span>
            </div>
          )}

          {isVoid && (
            <div className="flex items-center gap-2 text-destructive bg-destructive/10 rounded-md p-3">
              <XCircle className="h-5 w-5" />
              <span className="font-medium">{t('Fakturan \u00e4r makulerad', 'Invoice is voided')}</span>
            </div>
          )}

          <div className="space-y-2 pt-2">
            {!hasInvoice && (
              <Button onClick={() => setShowCreateDialog(true)} disabled={isCreating} className="w-full">
                {isCreating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Receipt className="h-4 w-4 mr-2" />}
                {t('Skapa faktura fr\u00e5n offert', 'Create invoice from quote')}
              </Button>
            )}

            {hasInvoice && isDraft && (
              <Button onClick={() => setShowFinalizeDialog(true)} disabled={isFinalizing} className="w-full">
                {isFinalizing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                {t('Fastst\u00e4ll faktura', 'Finalize invoice')}
              </Button>
            )}

            {hasInvoice && (isOpen || isPaid) && (
              <Button variant="outline" onClick={() => setShowEmailModal(true)} className="w-full">
                <Send className="h-4 w-4 mr-2" />
                {t('Skicka faktura (e-post)', 'Send invoice (email)')}
              </Button>
            )}

            {hasInvoice && !isPaid && !isVoid && !isUncollectible && (
              <Button variant="outline" onClick={() => setShowVoidDialog(true)} disabled={isVoiding} className="w-full text-destructive hover:text-destructive">
                {isVoiding ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <XCircle className="h-4 w-4 mr-2" />}
                {t('Makulera faktura', 'Void invoice')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Skapa faktura?', 'Create invoice?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Detta skapar en faktura baserat p\u00e5 offerten. Fakturan skapas som utkast och kan redigeras innan den fastst\u00e4lls.',
                'This will create an invoice based on the quote. The invoice is created as a draft and can be edited before finalizing.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Tillbaka', 'Back')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleCreateInvoice} disabled={isCreating}>
              {isCreating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Skapa faktura', 'Create invoice')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showFinalizeDialog} onOpenChange={setShowFinalizeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Fastst\u00e4ll faktura?', 'Finalize invoice?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Detta fastst\u00e4ller fakturan, tilldelar ett fakturanummer och g\u00f6r den klar f\u00f6r utskick.',
                'This will finalize the invoice, assign an invoice number and make it ready to send.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Tillbaka', 'Back')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleFinalizeInvoice} disabled={isFinalizing}>
              {isFinalizing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Fastst\u00e4ll', 'Finalize')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showVoidDialog} onOpenChange={setShowVoidDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Makulera faktura?', 'Void invoice?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Detta makulerar fakturan. Fakturanumret beh\u00e5lls men fakturan kan inte l\u00e4ngre betalas.',
                'This will void the invoice. The invoice number is kept but the invoice can no longer be paid.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Tillbaka', 'Back')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleVoidInvoice}
              disabled={isVoiding}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isVoiding && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Makulera', 'Void')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Email Modal */}
      {invoiceId && (
        <InvoiceEmailModal
          open={showEmailModal}
          onOpenChange={setShowEmailModal}
          invoice={{
            id: invoiceId,
            invoice_number: quote.invoice_number,
            customer: quote.customer,
          }}
        />
      )}

      {/* PDF Modal */}
      {invoiceId && (
        <InvoicePdfModal
          open={showPdfModal}
          onOpenChange={setShowPdfModal}
          invoiceId={invoiceId}
          invoiceNumber={quote.invoice_number || ''}
        />
      )}
    </>
  );
};

export default InvoiceCard;
