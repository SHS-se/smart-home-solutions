import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSEK, formatSEKDecimal, getAccountName } from '@/lib/accounting-utils';
import { buildCustomerPaymentJournalLines, STRIPE_CLEARING_ACCOUNT, type CustomerPaymentMethod } from '@/lib/sales-accounting';
import { recordAndPostCustomerPayment } from '@/lib/sales-posting';
import { useSalesInvoices } from '@/hooks/use-sales-invoices';
import { toast } from 'sonner';
import { Info, Plus, AlertTriangle } from 'lucide-react';

const PAYMENT_METHODS: CustomerPaymentMethod[] = ['bankgiro', 'manual', 'stripe'];

const PaymentsList: React.FC = () => {
  const { t, language } = useLanguage();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ invoiceId: '', paymentDate: '', amount: '', method: 'bankgiro' as CustomerPaymentMethod });

  const { data: invoices } = useSalesInvoices();

  const { data: payments, isLoading } = useQuery({
    queryKey: ['acc-invoice-payments'],
    queryFn: async () => {
      const [{ data: paymentRows }, { data: verifications }] = await Promise.all([
        supabase
          .from('invoice_payments')
          .select('id, invoice_id, payment_date, amount, method, reference, note, invoice:invoices(invoice_number)')
          .order('payment_date', { ascending: false }),
        supabase
          .from('acc_verifications')
          .select('id, source_id, verification_number')
          .eq('source_type', 'customer_payment')
          .eq('is_posted', true),
      ]);
      return (paymentRows || []).map(p => ({
        ...p,
        verification: (verifications || []).find(v => v.source_id === p.id) || null,
      }));
    },
  });

  // Stripe clearing balance (1580): payments in, no inferred fees/payouts —
  // a non-zero balance is expected until payouts are booked manually.
  const { data: stripeClearing } = useQuery({
    queryKey: ['acc-stripe-clearing-balance'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_journal_lines').select('debit, credit').eq('account', STRIPE_CLEARING_ACCOUNT);
      return (data || []).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    },
  });

  const unpostedCount = (payments || []).filter(p => !p.verification).length;
  const selectedInvoice = (invoices || []).find(inv => inv.id === form.invoiceId) || null;
  const previewLines = selectedInvoice && Number(form.amount) > 0
    ? buildCustomerPaymentJournalLines(Number(form.amount), form.method, `${t('Kundbetalning', 'Customer payment')} ${selectedInvoice.invoice_number}`)
    : [];

  const recordPayment = useMutation({
    mutationFn: async () => {
      if (!selectedInvoice) throw new Error(t('Välj faktura', 'Select an invoice'));
      if (!form.paymentDate) throw new Error(t('Ange betalningsdatum', 'Enter a payment date'));
      return recordAndPostCustomerPayment({
        supabase,
        userId: user?.id,
        invoice: selectedInvoice,
        paymentDate: form.paymentDate,
        amount: Number(form.amount),
        method: form.method,
      });
    },
    onSuccess: (verificationNumber) => {
      queryClient.invalidateQueries({ queryKey: ['acc-invoice-payments'] });
      queryClient.invalidateQueries({ queryKey: ['acc-sales-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['acc-stripe-clearing-balance'] });
      queryClient.invalidateQueries({ queryKey: ['acc-journal'] });
      toast.success(t(`Betalning bokförd som ${verificationNumber}`, `Payment posted as ${verificationNumber}`));
      setDialogOpen(false);
      setForm({ invoiceId: '', paymentDate: '', amount: '', method: 'bankgiro' });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openDialogForInvoice = () => {
    setForm({ invoiceId: '', paymentDate: '', amount: '', method: 'bankgiro' });
    setDialogOpen(true);
  };

  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleDateString(language === 'sv' ? 'sv-SE' : 'en-GB') : '–';

  const methodLabel = (method: string) => method === 'stripe'
    ? 'Stripe'
    : method === 'bankgiro'
      ? 'Bankgiro'
      : t('Manuell', 'Manual');

  return (
    <AccountingLayout>
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              {t('Betalningar & Matchning', 'Payments & Matching')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-5 h-5 text-primary cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs text-xs">
                  {t(
                    'Registrera och bokför kundbetalningar mot fakturor. Bankgiro/manuella betalningar bokförs mot 1930 Företagskonto, Stripe-betalningar mot 1580 Stripe clearing.',
                    'Record and post customer payments against invoices. Bankgiro/manual payments post to 1930 Company bank, Stripe payments to 1580 Stripe clearing.'
                  )}
                </TooltipContent>
              </Tooltip>
            </h1>
            <p className="text-muted-foreground mt-1">{t('Matcha inkommande betalningar mot fakturor', 'Match incoming payments against invoices')}</p>
          </div>
          <Button onClick={openDialogForInvoice}><Plus className="w-4 h-4 mr-2" />{t('Registrera betalning', 'Record payment')}</Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">{t('Totalt betalningar', 'Total payments')}</p>
              <p className="text-xl font-bold mt-1">{payments?.length ?? '–'}</p>
            </CardContent>
          </Card>
          <Card className="border border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">{t('Ej bokförda', 'Not posted')}</p>
              <p className={`text-xl font-bold mt-1 ${unpostedCount > 0 ? 'text-amber-700' : ''}`}>{unpostedCount}</p>
            </CardContent>
          </Card>
          <Card className="border border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">{t('Stripe clearing (1580) saldo', 'Stripe clearing (1580) balance')}</p>
              <p className={`text-xl font-bold mt-1 ${Math.abs(stripeClearing ?? 0) > 0.005 ? 'text-amber-700' : ''}`}>{stripeClearing == null ? '–' : formatSEK(stripeClearing)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t('avgifter/utbetalningar bokförs separat', 'fees/payouts are booked separately')}</p>
            </CardContent>
          </Card>
        </div>

        {Math.abs(stripeClearing ?? 0) > 0.005 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-800">
              {t(
                `Stripe clearing (1580) har ett saldo på ${formatSEKDecimal(stripeClearing!)} — Stripe-avgift och utbetalning till bank är ännu inte bokförda. Inga avgifter härleds automatiskt.`,
                `Stripe clearing (1580) has a balance of ${formatSEKDecimal(stripeClearing!)} — the Stripe fee and bank payout are not yet booked. No fees are inferred automatically.`
              )}
            </p>
          </div>
        )}

        <Card className="border border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Datum', 'Date')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Faktura', 'Invoice')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Metod', 'Method')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Belopp', 'Amount')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Status</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Verifikation', 'Verification')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">{t('Laddar...', 'Loading...')}</TableCell></TableRow>
                ) : (payments || []).length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-12 text-muted-foreground">{t('Inga registrerade betalningar', 'No recorded payments')}</TableCell></TableRow>
                ) : (payments || []).map(p => (
                  <TableRow key={p.id}>
                    <TableCell className="text-sm">{formatDate(p.payment_date)}</TableCell>
                    <TableCell className="text-sm font-medium">{(p.invoice as { invoice_number: string | null } | null)?.invoice_number || '–'}</TableCell>
                    <TableCell className="text-sm">{methodLabel(p.method)}</TableCell>
                    <TableCell className="text-sm text-right">{formatSEKDecimal(Number(p.amount))}</TableCell>
                    <TableCell>
                      {p.verification ? (
                        <Badge className="bg-green-100 text-green-800 border-0 text-xs">{t('Bokförd', 'Posted')}</Badge>
                      ) : (
                        <Badge className="bg-amber-100 text-amber-800 border-0 text-xs">{t('Ej bokförd', 'Not posted')}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-primary">
                      {p.verification ? (
                        <Link to={`/accounting/journal?verification=${p.verification.id}`} className="hover:underline">
                          {p.verification.verification_number}
                        </Link>
                      ) : '–'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('Registrera betalning', 'Record payment')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('Faktura', 'Invoice')}</label>
              <Select
                value={form.invoiceId}
                onValueChange={(invoiceId) => {
                  const invoice = (invoices || []).find(inv => inv.id === invoiceId);
                  const openAmount = invoice ? Math.max(0, (invoice.totals?.total ?? 0) - invoice.paidAmount) : 0;
                  setForm(f => ({ ...f, invoiceId, amount: openAmount > 0 ? String(openAmount) : f.amount }));
                }}
              >
                <SelectTrigger><SelectValue placeholder={t('Välj faktura...', 'Select invoice...')} /></SelectTrigger>
                <SelectContent>
                  {(invoices || []).map(inv => (
                    <SelectItem key={inv.id} value={inv.id}>
                      {inv.invoice_number} · {inv.customer?.name || '–'} · {formatSEKDecimal(inv.totals?.total ?? 0)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('Betalningsdatum', 'Payment date')}</label>
                <Input type="date" value={form.paymentDate} onChange={(e) => setForm(f => ({ ...f, paymentDate: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('Belopp (SEK)', 'Amount (SEK)')}</label>
                <Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('Metod', 'Method')}</label>
              <Select value={form.method} onValueChange={(method) => setForm(f => ({ ...f, method: method as CustomerPaymentMethod }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map(method => (
                    <SelectItem key={method} value={method}>{methodLabel(method)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {previewLines.length > 0 && (
              <div>
                <p className="text-xs uppercase text-muted-foreground font-medium tracking-wide mb-2">{t('Bokföring', 'Accounting')}</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Konto', 'Account')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Debet', 'Debit')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Kredit', 'Credit')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewLines.map((line, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">{line.account} {line.accountName || getAccountName(line.account)}</TableCell>
                        <TableCell className="text-sm text-right">{line.debit > 0 ? formatSEKDecimal(line.debit) : '–'}</TableCell>
                        <TableCell className="text-sm text-right">{line.credit > 0 ? formatSEKDecimal(line.credit) : '–'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {form.method === 'stripe' && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                {t(
                  'Stripe-betalningar bokförs mot 1580 Stripe clearing. Avgift och utbetalning till bank bokförs separat när underlag finns — inget härleds automatiskt.',
                  'Stripe payments post to 1580 Stripe clearing. Fee and bank payout are booked separately when source data exists — nothing is inferred automatically.'
                )}
              </div>
            )}

            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('Avbryt', 'Cancel')}</Button>
              <Button
                onClick={() => recordPayment.mutate()}
                disabled={recordPayment.isPending || !form.invoiceId || !form.paymentDate || !(Number(form.amount) > 0)}
              >
                {recordPayment.isPending ? t('Bokför...', 'Posting...') : t('Registrera & bokför', 'Record & post')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AccountingLayout>
  );
};

export default PaymentsList;
