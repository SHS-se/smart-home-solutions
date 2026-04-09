import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import DocumentPreview from '@/components/accounting/DocumentPreview';
import PurchaseUploadForm from '@/components/accounting/PurchaseUploadForm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  PURCHASE_STATUS_LABELS, PURCHASE_STATUS_LABELS_EN, PURCHASE_STATUS_COLORS,
  PAYMENT_SOURCE_LABELS, PAYMENT_SOURCE_LABELS_EN,
  VAT_TREATMENT_LABELS, VAT_TREATMENT_LABELS_EN,
  formatExchangeRate, formatSEK, formatSEKDecimal, buildJournalPreview,
  getPurchaseBlockers,
} from '@/lib/accounting-utils';
import type { PaymentSource, VatTreatment } from '@/lib/accounting-utils';
import {
  buildPurchaseVatSummary,
  describeJournalOriginalAmount,
  formatCurrencyAmount,
  getPurchaseExchangeSnapshot,
  isForeignCurrency,
} from '@/lib/accounting-fx';
import { toast } from 'sonner';
import { ArrowLeft, AlertTriangle, Eye, CheckCircle } from 'lucide-react';

const PurchaseDetail: React.FC = () => {
  const { purchaseId } = useParams<{ purchaseId: string }>();
  const { user } = useAuth();
  const { t, language } = useLanguage();
  const queryClient = useQueryClient();

  const statusLabels = language === 'sv' ? PURCHASE_STATUS_LABELS : PURCHASE_STATUS_LABELS_EN;
  const paymentLabels = language === 'sv' ? PAYMENT_SOURCE_LABELS : PAYMENT_SOURCE_LABELS_EN;
  const vatLabels = language === 'sv' ? VAT_TREATMENT_LABELS : VAT_TREATMENT_LABELS_EN;

  const { data: purchase, isLoading } = useQuery({
    queryKey: ['acc-purchase', purchaseId],
    queryFn: async () => {
      const { data } = await supabase.from('acc_purchases').select('*, supplier:acc_suppliers(*)').eq('id', purchaseId!).single();
      return data;
    },
    enabled: !!purchaseId,
  });

  const { data: lines } = useQuery({
    queryKey: ['acc-purchase-lines', purchaseId],
    queryFn: async () => {
      const { data } = await supabase.from('acc_purchase_lines').select('*').eq('purchase_id', purchaseId!).order('sort_order');
      return data || [];
    },
    enabled: !!purchaseId,
  });
  const supplierName = (purchase?.supplier as Tables<'acc_suppliers'> | null)?.name || '';
  const purchaseFx = getPurchaseExchangeSnapshot(purchase);
  const isForeignDocument = isForeignCurrency(purchaseFx.originalCurrency);

  const { data: documentUrl, isLoading: isDocumentLoading } = useQuery({
    queryKey: ['acc-purchase-document', purchaseId, purchase?.document_file_path],
    queryFn: async () => {
      if (!purchase?.document_file_path) return null;
      const { data, error } = await supabase.storage
        .from('purchase-documents')
        .createSignedUrl(purchase.document_file_path, 3600);
      if (error) throw error;
      return data?.signedUrl || null;
    },
    enabled: !!purchase?.document_file_path,
  });

  const updateLine = useMutation({
    mutationFn: async ({ lineId, updates }: { lineId: string; updates: Record<string, unknown> }) => {
      const { error } = await supabase.from('acc_purchase_lines').update(updates).eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['acc-purchase-lines', purchaseId] }),
  });

  const postPurchase = useMutation({
    mutationFn: async () => {
      if (!purchase || !lines) throw new Error('Data missing');
      if (isForeignDocument && (
        purchaseFx.exchangeRateSource === 'LEGACY_UNCONVERTED' ||
        !purchaseFx.exchangeRate ||
        !purchaseFx.exchangeRateDate
      )) {
        throw new Error(t(
          'Utkastet saknar giltig ECB-konvertering till SEK. Kör valutareparation innan bokföring.',
          'This draft is missing a valid ECB conversion to SEK. Run currency repair before posting.',
        ));
      }
      const blockers = getPurchaseBlockers({
        ...purchase, supplier_id: purchase.supplier_id,
        lines: lines.map(l => ({ vat_treatment: l.vat_treatment, net_amount: Number(l.net_amount), vat_amount: Number(l.vat_amount), gross_amount: Number(l.gross_amount) })),
        gross_amount: Number(purchase.gross_amount), net_amount: Number(purchase.net_amount), vat_amount: Number(purchase.vat_amount),
      });
      const errors = blockers.filter(b => b.type === 'error');
      if (errors.length > 0) throw new Error(errors[0].message);

      const docDate = new Date(purchase.document_date);
      const { data: period } = await supabase.from('acc_periods').select('id').eq('year', docDate.getFullYear()).eq('month', docDate.getMonth() + 1).single();
      if (!period) throw new Error(t('Ingen bokföringsperiod hittades för dokumentdatum', 'No accounting period found for document date'));

      const { data: vNum } = await supabase.rpc('allocate_acc_verification_number');
      const verificationNumber = vNum as unknown as string;

      const { data: verification, error: vErr } = await supabase.from('acc_verifications').insert({
        verification_number: verificationNumber,
        verification_date: purchase.posting_date || purchase.document_date,
        description: purchase.description || `${t('Inköp', 'Purchase')} ${supplierName}`.trim(),
        period_id: period.id, source_type: 'purchase', source_id: purchase.id,
        is_posted: true, posted_at: new Date().toISOString(), posted_by: user?.id, created_by: user?.id,
      }).select().single();
      if (vErr) throw vErr;

      const journalPreview = buildJournalPreview(
        lines.map(l => ({ expense_account: l.expense_account, vat_treatment: l.vat_treatment as VatTreatment, net_amount: Number(l.net_amount), vat_amount: Number(l.vat_amount), gross_amount: Number(l.gross_amount), description: l.description })),
        purchase.payment_source as PaymentSource, purchase.description || '',
      );
      const primaryVatTreatment = (lines[0]?.vat_treatment as VatTreatment | undefined) || 'needs_review';
      const journalInserts = journalPreview.map((jl, i) => {
        let originalAmount: number | null = null;
        if (jl.account === '2641') {
          originalAmount = describeJournalOriginalAmount('input_vat', primaryVatTreatment, purchaseFx);
        } else if (jl.account === '2614' || jl.account === '2645') {
          originalAmount = describeJournalOriginalAmount('reverse_charge_vat', primaryVatTreatment, purchaseFx);
        } else if (jl.account === '2018' || jl.account === '1930') {
          originalAmount = describeJournalOriginalAmount('payment', primaryVatTreatment, purchaseFx);
        } else if (jl.debit > 0) {
          originalAmount = describeJournalOriginalAmount('expense', primaryVatTreatment, purchaseFx);
        }

        return {
          verification_id: verification.id,
          account: jl.account,
          account_name: jl.accountName,
          description: jl.description,
          debit: jl.debit,
          credit: jl.credit,
          sort_order: i,
          original_currency: purchaseFx.originalCurrency,
          original_amount: originalAmount,
          exchange_rate_source: purchaseFx.exchangeRateSource,
          exchange_rate_date: purchaseFx.exchangeRateDate,
          exchange_rate: purchaseFx.exchangeRate,
          exchange_rate_overridden: purchaseFx.exchangeRateOverridden,
          converted_amount_sek: jl.debit > 0 ? jl.debit : jl.credit,
        };
      });
      const { error: jErr } = await supabase.from('acc_journal_lines').insert(journalInserts);
      if (jErr) throw jErr;

      const { error: pErr } = await supabase.from('acc_purchases').update({
        status: 'posted', verification_id: verification.id, posting_date: purchase.posting_date || purchase.document_date,
      }).eq('id', purchase.id);
      if (pErr) throw pErr;
      return verificationNumber;
    },
    onSuccess: (vNum) => {
      queryClient.invalidateQueries({ queryKey: ['acc-purchase', purchaseId] });
      queryClient.invalidateQueries({ queryKey: ['acc-purchases'] });
      toast.success(t(`Bokförd som ${vNum}`, `Posted as ${vNum}`));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !purchase) {
    return <AccountingLayout><div className="py-12 text-center text-muted-foreground">{t('Laddar...', 'Loading...')}</div></AccountingLayout>;
  }

  const blockers = getPurchaseBlockers({
    ...purchase, supplier_id: purchase.supplier_id,
    lines: (lines || []).map(l => ({ vat_treatment: l.vat_treatment, net_amount: Number(l.net_amount), vat_amount: Number(l.vat_amount), gross_amount: Number(l.gross_amount) })),
    gross_amount: Number(purchase.gross_amount), net_amount: Number(purchase.net_amount), vat_amount: Number(purchase.vat_amount),
  });
  const errors = blockers.filter(b => b.type === 'error');
  const warnings = blockers.filter(b => b.type === 'warning');
  const fxPostingBlocked = isForeignDocument && (
    purchaseFx.exchangeRateSource === 'LEGACY_UNCONVERTED' ||
    !purchaseFx.exchangeRate ||
    !purchaseFx.exchangeRateDate
  );
  if (fxPostingBlocked) {
    errors.push({
      type: 'error',
      message: t(
        'Utkastet saknar giltig ECB-konvertering till SEK. Kör valutareparation innan bokföring.',
        'This draft is missing a valid ECB conversion to SEK. Run currency repair before posting.',
      ),
    });
  }
  const canPost = errors.length === 0 && purchase.status !== 'posted';
  const primaryLine = lines?.[0] || null;

  const journalPreview = lines && lines.length > 0
    ? buildJournalPreview(
        lines.map(l => ({ expense_account: l.expense_account, vat_treatment: l.vat_treatment as VatTreatment, net_amount: Number(l.net_amount), vat_amount: Number(l.vat_amount), gross_amount: Number(l.gross_amount), description: l.description })),
        purchase.payment_source as PaymentSource, purchase.description || '',
      )
    : [];
  const vatSummary = buildPurchaseVatSummary(
    (lines || []).map((line) => ({
      expense_account: line.expense_account,
      vat_treatment: line.vat_treatment as VatTreatment,
      net_amount: Number(line.net_amount),
      vat_amount: Number(line.vat_amount),
      gross_amount: Number(line.gross_amount),
      description: line.description,
    })),
    purchaseFx,
  );

  return (
    <AccountingLayout>
      <div className="space-y-6">
        <Link to="/accounting/purchases" className="text-primary text-sm hover:underline flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> {t('Tillbaka till lista', 'Back to list')}
        </Link>

        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('Granska inköp', 'Review purchase')}</h1>
            <p className="text-muted-foreground text-sm mt-1">
              {supplierName || t('Okänd leverantör', 'Unknown supplier')} · {purchase.document_date}
            </p>
          </div>
          <Badge className={`${PURCHASE_STATUS_COLORS[purchase.status as keyof typeof PURCHASE_STATUS_COLORS]} border-0`}>
            {statusLabels[purchase.status as keyof typeof statusLabels]}
          </Badge>
        </div>

        {errors.length > 0 && purchase.status !== 'posted' && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-red-800">{t('Blockerad för bokföring', 'Blocked for posting')}</p>
              <ul className="text-sm text-red-700 mt-1 space-y-0.5">{errors.map((b, i) => <li key={i}>• {b.message}</li>)}</ul>
            </div>
          </div>
        )}

        {warnings.length > 0 && purchase.status !== 'posted' && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
            <div>{warnings.map((b, i) => <p key={i} className="text-sm text-amber-800">{b.message}</p>)}</div>
          </div>
        )}

        {isForeignDocument && purchaseFx.exchangeRateSource === 'LEGACY_UNCONVERTED' && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-primary">{t('Valutaomräkning behöver repareras', 'Foreign-currency conversion needs repair')}</p>
              <p className="text-sm text-blue-900/80 mt-1">
                {t('Det här köpet skapades innan ECB-konvertering sparades korrekt. Reparera det innan bokföring eller momsgranskning.', 'This purchase was created before ECB conversion was persisted correctly. Repair it before posting or VAT review.')}
              </p>
            </div>
            <Link to="/accounting/integrity/currency-repair">
              <Button variant="outline" size="sm">{t('Öppna reparationskö', 'Open repair queue')}</Button>
            </Link>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card className="border border-border">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="text-base">{t('Underlag', 'Document')}</CardTitle>
                {documentUrl && (
                  <Button variant="ghost" size="sm" onClick={() => window.open(documentUrl, '_blank', 'noopener,noreferrer')}>
                    <Eye className="w-4 h-4 mr-1" /> {t('Fullskärm', 'Full screen')}
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {isDocumentLoading ? (
                  <div className="bg-muted rounded-lg p-8 text-center">
                    <p className="text-sm text-muted-foreground">{t('Laddar dokument...', 'Loading document...')}</p>
                  </div>
                ) : documentUrl ? (
                  <div className="h-[28rem]">
                    <DocumentPreview fileUrl={documentUrl} fileName={purchase.document_file_path} />
                  </div>
                ) : (
                  <div className="bg-muted rounded-lg p-8 text-center">
                    <p className="text-sm text-muted-foreground">{t('Inget underlag uppladdat', 'No document uploaded')}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border border-border">
              <CardHeader><CardTitle className="text-base">{t('Radklassificering', 'Line classification')}</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Beskrivning', 'Description')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Konto', 'Account')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Momsbehandling', 'VAT treatment')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Belopp', 'Amount')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(lines || []).map((line) => (
                      <TableRow key={line.id}>
                        <TableCell className="text-sm">{line.description || '—'}</TableCell>
                        <TableCell>
                          {purchase.status === 'posted' ? (
                            <span className="text-sm">{line.expense_account}</span>
                          ) : (
                            <Input className="w-20 h-8 text-sm" value={line.expense_account} onChange={(e) => updateLine.mutate({ lineId: line.id, updates: { expense_account: e.target.value } })} />
                          )}
                        </TableCell>
                        <TableCell>
                          {purchase.status === 'posted' ? (
                            <span className="text-sm">{vatLabels[line.vat_treatment as keyof typeof vatLabels]}</span>
                          ) : (
                            <Select value={line.vat_treatment} onValueChange={(v) => updateLine.mutate({ lineId: line.id, updates: { vat_treatment: v } })}>
                              <SelectTrigger className="h-8 text-sm w-52"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {Object.entries(vatLabels).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium">
                          <div>{formatSEKDecimal(Number(line.gross_amount))}</div>
                          {isForeignDocument && lines?.length === 1 && (
                            <div className="text-xs font-normal text-muted-foreground">
                              {formatCurrencyAmount(purchaseFx.originalGross, purchaseFx.originalCurrency)}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card className="border border-border">
              <CardHeader><CardTitle className="text-base">{t('Bokföring', 'Journal entry')}</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Konto', 'Account')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Namn', 'Name')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Debet', 'Debit')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Kredit', 'Credit')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {journalPreview.map((jl, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm font-medium">{jl.account}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{jl.accountName}</TableCell>
                        <TableCell className="text-right text-sm">{jl.debit > 0 ? formatSEKDecimal(jl.debit) : '–'}</TableCell>
                        <TableCell className="text-right text-sm">{jl.credit > 0 ? formatSEKDecimal(jl.credit) : '–'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <PurchaseUploadForm
              purchase={purchase}
              purchaseLine={primaryLine}
              disabled={purchase.status === 'posted'}
              title={t('Utkastdetaljer', 'Draft details')}
              submitLabel={t('Spara utkast', 'Save draft')}
            />

            <Card className="border border-border">
              <CardHeader><CardTitle className="text-base">{t('Momssammanställning', 'VAT summary')}</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div><p className="text-xs text-muted-foreground">{t('Betalkälla', 'Payment source')}</p><p>{paymentLabels[purchase.payment_source as keyof typeof paymentLabels]}</p></div>
                {purchase.posting_date && <div><p className="text-xs text-muted-foreground">{t('Bokföringsdatum', 'Posting date')}</p><p>{purchase.posting_date}</p></div>}
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Original valuta', 'Original currency')}</span><span>{purchaseFx.originalCurrency}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Originalt netto', 'Original net')}</span><span>{formatCurrencyAmount(purchaseFx.originalNet, purchaseFx.originalCurrency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Original moms', 'Original VAT')}</span><span>{formatCurrencyAmount(purchaseFx.originalVat, purchaseFx.originalCurrency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Originalt brutto', 'Original gross')}</span><span>{formatCurrencyAmount(purchaseFx.originalGross, purchaseFx.originalCurrency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Kurskälla', 'Rate source')}</span><span>{purchaseFx.exchangeRateSource}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Kursdatum', 'Rate date')}</span><span>{purchaseFx.exchangeRateDate || '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Använd kurs', 'Applied rate')}</span><span>{formatExchangeRate(purchaseFx.exchangeRate)}</span></div>
                {purchaseFx.exchangeRateOverridden && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    {t('Manuell överstyrning', 'Manual override')}: {purchaseFx.exchangeRateOverrideReason || '—'}
                  </div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Omräknat netto', 'Converted net')}</span><span>{formatSEKDecimal(vatSummary.reverseChargeBaseSek > 0 ? vatSummary.reverseChargeBaseSek : purchaseFx.convertedNetSek)}</span></div>
                {primaryLine?.vat_treatment === 'reverse_charge' ? (
                  <>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Skattepliktig bas i SEK', 'Taxable base in SEK')}</span><span>{formatSEKDecimal(vatSummary.reverseChargeBaseSek)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Utgående moms i SEK', 'Output VAT in SEK')}</span><span>{formatSEKDecimal(vatSummary.reverseChargeOutputVatSek)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Ingående moms i SEK', 'Input VAT in SEK')}</span><span>{formatSEKDecimal(vatSummary.reverseChargeInputVatSek)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Nettoeffekt moms', 'Net VAT effect')}</span><span>{formatSEKDecimal(vatSummary.reverseChargeOutputVatSek - vatSummary.reverseChargeInputVatSek)}</span></div>
                  </>
                ) : (
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Avdragsgill moms i SEK', 'Deductible VAT in SEK')}</span><span>{formatSEKDecimal(vatSummary.deductibleInputVatSek || purchaseFx.convertedVatSek)}</span></div>
                )}
                <div className="flex justify-between font-semibold border-t border-border pt-2 mt-2"><span>{t('Betalningsbelopp i SEK', 'Payment amount in SEK')}</span><span>{formatSEKDecimal(vatSummary.paymentAccountAmountSek)}</span></div>
              </CardContent>
            </Card>

            {purchase.status !== 'posted' && (
              <Button className="w-full" disabled={!canPost || postPurchase.isPending} onClick={() => postPurchase.mutate()}>
                {postPurchase.isPending ? t('Bokför...', 'Posting...') : t('Bokför faktura', 'Post invoice')}
              </Button>
            )}

            {purchase.status === 'posted' && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <span className="text-sm text-green-800 font-medium">{t('Bokförd', 'Posted')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default PurchaseDetail;
