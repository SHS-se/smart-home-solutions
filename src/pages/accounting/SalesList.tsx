import React, { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSEK, formatSEKDecimal } from '@/lib/accounting-utils';
import { buildSalesInvoiceJournalLines, computeSalesInvoiceTotals, resolveSalesPostingPeriod, OUTPUT_VAT_BY_RATE } from '@/lib/sales-accounting';
import { postSalesInvoice, getInvoiceEconomicDate } from '@/lib/sales-posting';
import { useSalesInvoices } from '@/hooks/use-sales-invoices';
import { toast } from 'sonner';
import { Info, AlertTriangle, CheckCircle } from 'lucide-react';

const SalesList: React.FC = () => {
  const { t, language } = useLanguage();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const boxFilter = searchParams.get('box');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [correctionReason, setCorrectionReason] = useState('');

  const { data: invoices, isLoading } = useSalesInvoices();

  const { data: periods } = useQuery({
    queryKey: ['acc-periods'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_periods').select('id, year, month, status, locked_at, locked_by, created_at, updated_at');
      return data || [];
    },
  });

  const rows = useMemo(() => {
    let list = invoices || [];
    if (boxFilter) {
      // Drill-down from the VAT declaration: box 05 = any posted sale,
      // boxes 10/11/12 = posted sales containing the matching VAT rate.
      const rateForBox = Object.entries(OUTPUT_VAT_BY_RATE).find(([, v]) => v.box === boxFilter)?.[0];
      list = list.filter(inv => inv.link && (boxFilter === '05' || inv.line_items.some(li => String(li.tax_rate) === rateForBox)));
    }
    return list;
  }, [invoices, boxFilter]);

  const postedRows = (invoices || []).filter(inv => inv.link);
  const totalNet = postedRows.reduce((s, inv) => s + computeSalesInvoiceTotals(inv.line_items).net, 0);
  const totalVat = postedRows.reduce((s, inv) => s + computeSalesInvoiceTotals(inv.line_items).vat, 0);
  const openReceivables = postedRows.reduce((s, inv) => s + Math.max(0, (inv.totals?.total ?? 0) - inv.paidAmount), 0);

  const selected = rows.find(inv => inv.id === selectedId) || null;
  const selectedResolution = selected && periods
    ? resolveSalesPostingPeriod(getInvoiceEconomicDate(selected) || '', periods)
    : null;
  const selectedJournal = selected
    ? buildSalesInvoiceJournalLines(selected.line_items, `${t('Försäljningsfaktura', 'Sales invoice')} ${selected.invoice_number}`)
    : [];

  const postInvoice = useMutation({
    mutationFn: async () => {
      if (!selected || !selected.totals) throw new Error(t('Fakturadata saknas', 'Invoice data missing'));
      return postSalesInvoice({
        supabase,
        userId: user?.id,
        invoice: selected,
        lineItems: selected.line_items,
        totals: selected.totals,
        correctionReason: correctionReason || undefined,
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['acc-sales-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['acc-journal'] });
      queryClient.invalidateQueries({ queryKey: ['acc-verification-options'] });
      toast.success(result.isCorrection
        ? t(`Bokförd som korrigering ${result.verificationNumber}`, `Posted as correction ${result.verificationNumber}`)
        : t(`Bokförd som ${result.verificationNumber}`, `Posted as ${result.verificationNumber}`));
      setSelectedId(null);
      setCorrectionReason('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleDateString(language === 'sv' ? 'sv-SE' : 'en-GB') : '–';

  return (
    <>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            {t('Försäljning', 'Sales')}
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="w-5 h-5 text-primary cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs text-xs">
                {t(
                  'Slutförda kundfakturor och deras bokföring. Vid bokföring debiteras 1510 Kundfordringar och intäkt samt utgående moms krediteras.',
                  'Finalized customer invoices and their accounting. Posting debits 1510 Accounts receivable and credits revenue and output VAT.'
                )}
              </TooltipContent>
            </Tooltip>
          </h1>
          <p className="text-muted-foreground mt-1">{t('Bokförda försäljningsfakturor', 'Posted sales invoices')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">{t('Total intäkt (exkl. moms)', 'Total revenue (excl. VAT)')}</p>
              <p className="text-xl font-bold mt-1">{formatSEK(totalNet)}</p>
            </CardContent>
          </Card>
          <Card className="border border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">{t('Utgående moms', 'Output VAT')}</p>
              <p className="text-xl font-bold mt-1">{formatSEK(totalVat)}</p>
            </CardContent>
          </Card>
          <Card className="border border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">{t('Kundfordringar', 'Accounts receivable')}</p>
              <p className="text-xl font-bold mt-1">{formatSEK(openReceivables)}</p>
            </CardContent>
          </Card>
        </div>

        {boxFilter && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm flex items-center justify-between">
            <span>{t(`Filtrerat på deklarationsruta ${boxFilter}`, `Filtered on declaration box ${boxFilter}`)}</span>
            <Link to="/accounting/sales" className="text-primary hover:underline">{t('Rensa filter', 'Clear filter')}</Link>
          </div>
        )}

        <Card className="border border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Faktura', 'Invoice')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Kund', 'Customer')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Datum', 'Date')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Belopp', 'Amount')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Status</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Verifikation', 'Verification')}</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">{t('Laddar...', 'Loading...')}</TableCell></TableRow>
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">{t('Inga slutförda försäljningsfakturor', 'No finalized sales invoices')}</TableCell></TableRow>
                ) : rows.map(inv => {
                  const total = inv.totals?.total ?? 0;
                  const fullyPaid = total > 0 && inv.paidAmount >= total - 0.005;
                  return (
                    <TableRow key={inv.id}>
                      <TableCell className="text-sm font-medium">{inv.invoice_number}</TableCell>
                      <TableCell className="text-sm">{inv.customer?.name || '–'}</TableCell>
                      <TableCell className="text-sm">{formatDate(getInvoiceEconomicDate(inv))}</TableCell>
                      <TableCell className="text-sm text-right">{formatSEKDecimal(total)}</TableCell>
                      <TableCell>
                        <div className="flex gap-1.5">
                          {inv.link ? (
                            <Badge className="bg-green-100 text-green-800 border-0 text-xs">{t('Bokförd', 'Posted')}</Badge>
                          ) : (
                            <Badge className="bg-amber-100 text-amber-800 border-0 text-xs">{t('Ej bokförd', 'Not posted')}</Badge>
                          )}
                          {fullyPaid ? (
                            <Badge className="bg-green-100 text-green-800 border-0 text-xs">{t('Betald', 'Paid')}</Badge>
                          ) : inv.paidAmount > 0 ? (
                            <Badge className="bg-amber-100 text-amber-800 border-0 text-xs">{t('Delvis betald', 'Partially paid')}</Badge>
                          ) : null}
                          {inv.link?.posting_reason?.startsWith('correction') && (
                            <Badge className="bg-blue-100 text-blue-800 border-0 text-xs">{t('Korrigering', 'Correction')}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-primary">
                        {inv.link?.verification?.verification_number ? (
                          <Link to={`/accounting/journal?verification=${inv.link.verification_id}`} className="hover:underline">
                            {inv.link.verification.verification_number}
                          </Link>
                        ) : '–'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant={inv.link ? 'outline' : 'default'} onClick={() => { setSelectedId(inv.id); setCorrectionReason(''); }}>
                          {inv.link ? t('Detaljer', 'Details') : t('Bokför', 'Post')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('Fakturadetaljer', 'Invoice details')}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div className="space-y-1.5 text-sm">
                <p className="text-xs uppercase text-muted-foreground font-medium tracking-wide">{t('Faktura snapshot', 'Invoice snapshot')}</p>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Fakturanummer', 'Invoice number')}:</span><span className="font-medium">{selected.invoice_number}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Kund', 'Customer')}:</span><span>{selected.customer?.name || '–'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Datum', 'Date')}:</span><span>{formatDate(getInvoiceEconomicDate(selected))}</span></div>
                <div className="flex justify-between border-t border-border pt-1.5"><span className="text-muted-foreground">{t('Totalt', 'Total')}:</span><span className="font-medium">{formatSEKDecimal(selected.totals?.total ?? 0)}</span></div>
              </div>

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
                    {selectedJournal.map((line, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">{line.account} {line.accountName}</TableCell>
                        <TableCell className="text-sm text-right">{line.debit > 0 ? formatSEKDecimal(line.debit) : '–'}</TableCell>
                        <TableCell className="text-sm text-right">{line.credit > 0 ? formatSEKDecimal(line.credit) : '–'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {selected.link ? (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <p>
                    {t('Fakturan är bokförd.', 'The invoice is posted.')}{' '}
                    <Link to={`/accounting/journal?verification=${selected.link.verification_id}`} className="text-primary hover:underline">
                      {t('Visa verifikation', 'View verification')} {selected.link.verification?.verification_number} →
                    </Link>
                  </p>
                </div>
              ) : (
                <>
                  {selectedResolution?.isCorrection && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm space-y-2">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                        <p className="text-amber-800">
                          {t(
                            `Fakturans period är låst (inlämnad momsdeklaration). Den bokförs som korrigering i första öppna period (${selectedResolution.verificationDate}) utan att den låsta perioden eller momsögonblicksbilden ändras.`,
                            `The invoice's period is locked (filed VAT declaration). It will be posted as a correction in the first open period (${selectedResolution.verificationDate}) without changing the locked period or the filed VAT snapshot.`
                          )}
                        </p>
                      </div>
                      <Textarea
                        placeholder={t('Anledning till korrigering...', 'Reason for correction...')}
                        value={correctionReason}
                        onChange={(e) => setCorrectionReason(e.target.value)}
                      />
                    </div>
                  )}
                  {!selectedResolution && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
                      {t('Ingen öppen bokföringsperiod hittades.', 'No open accounting period found.')}
                    </div>
                  )}
                  <div className="flex justify-end gap-3">
                    <Button variant="outline" onClick={() => setSelectedId(null)}>{t('Stäng', 'Close')}</Button>
                    <Button
                      onClick={() => postInvoice.mutate()}
                      disabled={postInvoice.isPending || !selectedResolution || (selectedResolution.isCorrection && !correctionReason.trim())}
                    >
                      {postInvoice.isPending
                        ? t('Bokför...', 'Posting...')
                        : selectedResolution?.isCorrection
                          ? t('Bokför som korrigering', 'Post as correction')
                          : t('Bokför', 'Post')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default SalesList;
