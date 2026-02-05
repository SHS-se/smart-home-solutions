import React, { useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  FileText, 
  ExternalLink, 
  Send, 
  XCircle, 
  CheckCircle2, 
  Loader2,
  Receipt,
  AlertCircle
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
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
import InvoiceEmailModal from './InvoiceEmailModal';

interface InvoiceCardProps {
  quote: {
    id: string;
    quote_number: string | null;
    stripe_quote_id: string | null;
    stripe_invoice_id: string | null;
    invoice_status: string | null;
    invoice_number: string | null;
    invoice_due_date: string | null;
    invoice_hosted_url: string | null;
    invoice_pdf_url: string | null;
    invoice_subtotal: number | null;
    invoice_vat: number | null;
    invoice_total: number | null;
    subtotal_ex_vat: number | null;
    vat_total: number | null;
    total_inc_vat: number | null;
    customer?: { name: string | null; billing_email?: string | null } | null;
    bom?: { project_name: string } | null;
  };
}

const InvoiceCard: React.FC<InvoiceCardProps> = ({ quote }) => {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  
  const [isCreating, setIsCreating] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isVoiding, setIsVoiding] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);

  const invoiceStatus = quote.invoice_status || 'not_created';
  const hasInvoice = !!quote.stripe_invoice_id && invoiceStatus !== 'not_created';
  const isDraft = invoiceStatus === 'draft';
  const isOpen = invoiceStatus === 'open';
  const isPaid = invoiceStatus === 'paid';
  const isVoid = invoiceStatus === 'void' || invoiceStatus === 'voided';
  const isUncollectible = invoiceStatus === 'uncollectible';

  const formatPrice = (value: number | null) => {
    if (value === null) return '—';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('sv-SE');
  };

  const getStatusBadge = () => {
    switch (invoiceStatus) {
      case 'not_created':
        return <Badge variant="outline">{t('Ej skapad', 'Not created')}</Badge>;
      case 'draft':
        return <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>;
      case 'open':
        return <Badge variant="secondary">{t('Öppen', 'Open')}</Badge>;
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
      const { data, error } = await supabase.functions.invoke('convert-quote-to-invoice', {
        body: { quote_id: quote.id },
      });

      if (error) throw error;
      if (data.error) throw new Error(data.error);

      toast({
        title: t('Faktura skapad!', 'Invoice created!'),
        description: t(`Fakturanummer: ${data.invoice_number}`, `Invoice number: ${data.invoice_number}`),
      });

      queryClient.invalidateQueries({ queryKey: ['quote', quote.id] });
      queryClient.invalidateQueries({ queryKey: ['billing_events', quote.id] });
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
        title: t('Faktura fastställd!', 'Invoice finalized!'),
        description: t('Fakturan är nu öppen och kan betalas.', 'The invoice is now open and can be paid.'),
      });

      queryClient.invalidateQueries({ queryKey: ['quote', quote.id] });
      queryClient.invalidateQueries({ queryKey: ['billing_events', quote.id] });
    } catch (error: any) {
      toast({
        title: t('Kunde inte fastställa faktura', 'Failed to finalize invoice'),
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
        description: t('Fakturan har makulerats i Stripe.', 'The invoice has been voided in Stripe.'),
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

  // Use invoice totals if available, otherwise fallback to quote totals
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
          {/* Invoice info */}
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('Fakturanummer', 'Invoice number')}:</span>
              <span className="font-mono">{quote.invoice_number || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('Förfallodatum', 'Due date')}:</span>
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

          {/* Payment/PDF links */}
          {hasInvoice && (isOpen || isPaid) && (
            <div className="flex gap-2">
              {quote.invoice_hosted_url && (
                <Button
                  variant="default"
                  size="sm"
                  className="flex-1"
                  onClick={() => window.open(quote.invoice_hosted_url!, '_blank')}
                >
                  <ExternalLink className="h-4 w-4 mr-1" />
                  {t('Öppna betalning', 'Open payment')}
                </Button>
              )}
              {quote.invoice_pdf_url && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(quote.invoice_pdf_url!, '_blank')}
                >
                  <FileText className="h-4 w-4 mr-1" />
                  PDF
                </Button>
              )}
            </div>
          )}

          {/* Paid indicator */}
          {isPaid && (
            <div className="flex items-center gap-2 text-green-600 bg-green-50 dark:bg-green-950/30 rounded-md p-3">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-medium">{t('Fakturan är betald', 'Invoice is paid')}</span>
            </div>
          )}

          {/* Void indicator */}
          {isVoid && (
            <div className="flex items-center gap-2 text-destructive bg-destructive/10 rounded-md p-3">
              <XCircle className="h-5 w-5" />
              <span className="font-medium">{t('Fakturan är makulerad', 'Invoice is voided')}</span>
            </div>
          )}

          {/* Action buttons */}
          <div className="space-y-2 pt-2">
            {/* Create invoice */}
            {!hasInvoice && quote.stripe_quote_id && (
              <Button
                onClick={() => setShowCreateDialog(true)}
                disabled={isCreating}
                className="w-full"
              >
                {isCreating ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Receipt className="h-4 w-4 mr-2" />
                )}
                {t('Skapa faktura från offert', 'Create invoice from quote')}
              </Button>
            )}

            {/* No Stripe quote warning */}
            {!quote.stripe_quote_id && !hasInvoice && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <AlertCircle className="h-4 w-4" />
                <span>{t('Skicka offerten till Stripe först', 'Send quote to Stripe first')}</span>
              </div>
            )}

            {/* Finalize invoice */}
            {hasInvoice && isDraft && (
              <Button
                onClick={() => setShowFinalizeDialog(true)}
                disabled={isFinalizing}
                className="w-full"
              >
                {isFinalizing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                )}
                {t('Fastställ faktura', 'Finalize invoice')}
              </Button>
            )}

            {/* Send email */}
            {hasInvoice && (isOpen || isPaid) && (
              <Button
                variant="outline"
                onClick={() => setShowEmailModal(true)}
                className="w-full"
              >
                <Send className="h-4 w-4 mr-2" />
                {t('Skicka faktura (e-post)', 'Send invoice (email)')}
              </Button>
            )}

            {/* Void invoice */}
            {hasInvoice && !isPaid && !isVoid && !isUncollectible && (
              <Button
                variant="outline"
                onClick={() => setShowVoidDialog(true)}
                disabled={isVoiding}
                className="w-full text-destructive hover:text-destructive"
              >
                {isVoiding ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4 mr-2" />
                )}
                {t('Makulera faktura', 'Void invoice')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Create Invoice Dialog */}
      <AlertDialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Skapa faktura?', 'Create invoice?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Detta skapar en faktura i Stripe baserat på offerten. Åtgärden kan inte ångras, men fakturan kan makuleras.',
                'This will create an invoice in Stripe based on the quote. This action cannot be undone, but the invoice can be voided.'
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

      {/* Finalize Invoice Dialog */}
      <AlertDialog open={showFinalizeDialog} onOpenChange={setShowFinalizeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Fastställ faktura?', 'Finalize invoice?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Detta fastställer fakturan och gör den betalbar för kunden.',
                'This will finalize the invoice and make it payable by the customer.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Tillbaka', 'Back')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleFinalizeInvoice} disabled={isFinalizing}>
              {isFinalizing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Fastställ', 'Finalize')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Void Invoice Dialog */}
      <AlertDialog open={showVoidDialog} onOpenChange={setShowVoidDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Makulera faktura?', 'Void invoice?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Detta makulerar fakturan i Stripe. Kunden kan inte längre betala via länken.',
                'This will void the invoice in Stripe. The customer can no longer pay using the link.'
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
      <InvoiceEmailModal
        open={showEmailModal}
        onOpenChange={setShowEmailModal}
        quote={quote}
      />
    </>
  );
};

export default InvoiceCard;
