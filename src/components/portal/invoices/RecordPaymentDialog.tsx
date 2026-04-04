import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { getEdgeFunctionErrorMessage } from '@/lib/edge-function-error';
import { getAuthenticatedFunctionHeaders } from '@/lib/supabase-function-auth';

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceTotal: number | null;
  onRecorded: () => void;
}

const todayIsoDate = () => new Date().toISOString().split('T')[0];

const RecordPaymentDialog: React.FC<RecordPaymentDialogProps> = ({
  open,
  onOpenChange,
  invoiceId,
  invoiceNumber,
  invoiceTotal,
  onRecorded,
}) => {
  const { t } = useLanguage();
  const [paymentDate, setPaymentDate] = useState(todayIsoDate());
  const [amount, setAmount] = useState(invoiceTotal ? invoiceTotal.toFixed(2) : '');
  const [method, setMethod] = useState('bankgiro');
  const [reference, setReference] = useState(invoiceNumber || '');
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPaymentDate(todayIsoDate());
    setAmount(invoiceTotal ? invoiceTotal.toFixed(2) : '');
    setMethod('bankgiro');
    setReference(invoiceNumber || '');
    setNote('');
  }, [open, invoiceNumber, invoiceTotal]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new Error('Ange ett giltigt belopp');
      }

      const { data, error, response } = await supabase.functions.invoke('record-invoice-payment', {
        headers: await getAuthenticatedFunctionHeaders(),
        body: {
          invoice_id: invoiceId,
          payment_date: paymentDate,
          amount: parsedAmount,
          method,
          reference,
          note,
        },
      });

      if (error) throw new Error(await getEdgeFunctionErrorMessage(error, response));
      if (data?.error) throw new Error(data.error);

      toast({
        title: t('Betalning registrerad', 'Payment recorded'),
        description: data?.fully_paid
          ? t('Fakturan markerades som betald.', 'The invoice was marked as paid.')
          : t('Betalningen sparades.', 'The payment was saved.'),
      });

      onRecorded();
      onOpenChange(false);
    } catch (error) {
      toast({
        title: t('Kunde inte registrera betalning', 'Failed to record payment'),
        description: error instanceof Error ? error.message : 'Okant fel',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Registrera betalning', 'Record payment')}</DialogTitle>
          <DialogDescription>
            {t(
              'Spara en manuell betalning for den har fakturan. Fakturan markeras som betald nar hela beloppet ar registrerat.',
              'Save a manual payment for this invoice. The invoice is marked paid when the full amount has been recorded.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="payment-date">{t('Betalningsdatum', 'Payment date')}</Label>
            <Input
              id="payment-date"
              type="date"
              value={paymentDate}
              onChange={(event) => setPaymentDate(event.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="payment-amount">{t('Belopp', 'Amount')}</Label>
            <Input
              id="payment-amount"
              type="number"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>

          <div>
            <Label>{t('Metod', 'Method')}</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bankgiro">Bankgiro</SelectItem>
                <SelectItem value="bank_transfer">{t('Bankoverforing', 'Bank transfer')}</SelectItem>
                <SelectItem value="cash">{t('Kontant', 'Cash')}</SelectItem>
                <SelectItem value="other">{t('Ovrigt', 'Other')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="payment-reference">{t('Referens', 'Reference')}</Label>
            <Input
              id="payment-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="payment-note">{t('Anteckning', 'Note')}</Label>
            <Textarea
              id="payment-note"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('Avbryt', 'Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('Spara betalning', 'Save payment')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RecordPaymentDialog;
