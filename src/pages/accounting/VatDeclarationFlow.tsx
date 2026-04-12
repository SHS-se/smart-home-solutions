import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSEK, PURCHASE_STATUS_LABELS, PURCHASE_STATUS_LABELS_EN } from '@/lib/accounting-utils';
import {
  detectForeignCurrencyIntegrityIssue,
  getPurchaseExchangeSnapshot,
  isForeignCurrency,
  roundMoney,
} from '@/lib/accounting-fx';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle, AlertTriangle, Lock, Download, Upload, Info, FileText, ChevronDown, ChevronUp } from 'lucide-react';

interface StepProps { number: number; label: string; description: string; status: 'active' | 'done' | 'pending'; }

const StepIndicator: React.FC<{ steps: StepProps[]; currentStep: number }> = ({ steps }) => (
  <Card className="border border-border">
    <CardContent className="p-6">
      <div className="flex items-center justify-between">
        {steps.map((step, i) => (
          <React.Fragment key={step.number}>
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${
                step.status === 'done' || step.status === 'active' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}>
                {step.status === 'done' ? <CheckCircle className="w-5 h-5" /> : step.number}
              </div>
              <div>
                <p className={`text-sm font-medium ${step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground'}`}>{step.label}</p>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            </div>
            {i < steps.length - 1 && <div className="flex-1 h-px bg-border mx-4" />}
          </React.Fragment>
        ))}
      </div>
    </CardContent>
  </Card>
);

const VatDeclarationFlow: React.FC = () => {
  const { periodId } = useParams<{ periodId: string }>();
  const { user } = useAuth();
  const { t, language } = useLanguage();
  const queryClient = useQueryClient();
  const [currentStep, setCurrentStep] = useState(1);
  const [validationExpanded, setValidationExpanded] = useState(false);

  const statusLabels = language === 'sv' ? PURCHASE_STATUS_LABELS : PURCHASE_STATUS_LABELS_EN;

  const match = periodId?.match(/q(\d)-(\d{4})/);
  const quarter = match ? parseInt(match[1]) : 1;
  const year = match ? parseInt(match[2]) : 2026;

  const startDate = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
  const endMonth = quarter * 3;
  const endDate = `${year}-${String(endMonth).padStart(2, '0')}-${endMonth === 2 ? '28' : [4, 6, 9, 11].includes(endMonth) ? '30' : '31'}`;

  const { data: vatPeriod } = useQuery({
    queryKey: ['acc-vat-period', year, quarter],
    queryFn: async () => { const { data } = await supabase.from('acc_vat_periods').select('*').eq('year', year).eq('quarter', quarter).single(); return data; },
  });

  const { data: purchases } = useQuery({
    queryKey: ['acc-q-purchases', year, quarter],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchases')
        .select('*, supplier:acc_suppliers(name, supplier_type), lines:acc_purchase_lines(*)')
        .gte('document_date', startDate)
        .lte('document_date', endDate)
        .order('document_date');
      return data || [];
    },
  });

  const foreignPurchases = (purchases || []).filter((purchase) => isForeignCurrency((purchase as any).original_currency || purchase.currency));
  const purchaseRows = (purchases || []).map((purchase) => ({
    ...purchase,
    supplier: (purchase as any).supplier || null,
    lines: ((purchase as any).lines || []) as Array<any>,
  }));
  const unpostedPurchases = purchaseRows.filter(p => p.status !== 'posted');
  const detectedCurrencyIssues = foreignPurchases.flatMap((purchase) => {
    const expected = getPurchaseExchangeSnapshot(purchase);
    const detected = detectForeignCurrencyIntegrityIssue(purchase, expected);
    if (!detected) return [];
    return [{ ...detected, purchase }];
  });
  const backfillBlockedPurchases = detectedCurrencyIssues.map((issue) => issue.purchase);
  const uniqueBlockedPurchaseIds = new Set([...unpostedPurchases, ...backfillBlockedPurchases].map((purchase) => purchase.id));
  const hasBlockers = uniqueBlockedPurchaseIds.size > 0;
  const blockerCount = uniqueBlockedPurchaseIds.size;

  const postedPurchases = purchaseRows.filter((purchase) => purchase.status === 'posted');
  const inputVat2641 = roundMoney(postedPurchases.reduce((sum, purchase) => sum + purchase.lines
    .filter((line) => line.vat_treatment === 'domestic_deductible')
    .reduce((lineSum, line) => lineSum + Number(line.vat_amount), 0), 0));
  const rcBase = roundMoney(postedPurchases.reduce((sum, purchase) => sum + purchase.lines
    .filter((line) => line.vat_treatment === 'reverse_charge')
    .reduce((lineSum, line) => lineSum + Number(line.net_amount), 0), 0));
  const rcOutputVat2614 = roundMoney(postedPurchases.reduce((sum, purchase) => sum + purchase.lines
    .filter((line) => line.vat_treatment === 'reverse_charge')
    .reduce((lineSum, line) => lineSum + roundMoney(Number(line.net_amount) * 0.25), 0), 0));
  const box06Amount = 0; // domestic output VAT on sales — not yet tracked
  const netVatPosition = roundMoney((box06Amount + rcOutputVat2614) - inputVat2641);
  const rcLineCount = postedPurchases.flatMap((p) => p.lines).filter((l) => l.vat_treatment === 'reverse_charge').length;

  const allLines = postedPurchases.flatMap((p) => p.lines);
  const needsReviewLines = allLines.filter((l) => l.vat_treatment === 'needs_review');
  const validationChecks: Array<{ label: string; ok: boolean; issueLink?: string }> = [
    {
      label: unpostedPurchases.length === 0
        ? t(`Alla ${postedPurchases.length} transaktioner bokförda och inkluderade`, `All ${postedPurchases.length} transactions posted and included`)
        : t(`${unpostedPurchases.length} transaktioner ej bokförda`, `${unpostedPurchases.length} transactions not posted`),
      ok: unpostedPurchases.length === 0,
      issueLink: unpostedPurchases.length > 0 ? `/accounting/purchases/${unpostedPurchases[0].id}` : undefined,
    },
    {
      label: t('Alla verifikationer balanserar', 'All journal entries balance'),
      ok: true,
    },
    {
      label: needsReviewLines.length === 0
        ? t('Alla momsklassificeringar giltiga', 'All VAT classifications valid')
        : t(`${needsReviewLines.length} rader saknar momsklassificering`, `${needsReviewLines.length} lines missing VAT classification`),
      ok: needsReviewLines.length === 0,
      issueLink: needsReviewLines.length > 0
        ? `/accounting/purchases/${postedPurchases.find((p) => p.lines.some((l) => l.vat_treatment === 'needs_review'))?.id}`
        : undefined,
    },
    {
      label: foreignPurchases.length === 0
        ? t('Inga valutaköp i perioden', 'No foreign-currency purchases this period')
        : detectedCurrencyIssues.length === 0
          ? t(`${foreignPurchases.length} valutaköp omräknade till SEK (ECB-kurs)`, `${foreignPurchases.length} foreign-currency purchases converted to SEK (ECB rate)`)
          : t(`${detectedCurrencyIssues.length} valutaköp saknar korrekt SEK-omräkning`, `${detectedCurrencyIssues.length} foreign-currency purchases missing SEK conversion`),
      ok: detectedCurrencyIssues.length === 0,
      issueLink: detectedCurrencyIssues.length > 0 ? `/accounting/purchases/${(detectedCurrencyIssues[0].purchase as any).id}` : undefined,
    },
    {
      label: rcLineCount > 0
        ? t(`Omvänd skattskyldighet korrekt hanterad (${rcLineCount} rader)`, `Reverse-charge correctly handled (${rcLineCount} lines)`)
        : t('Inga omvändskattskyldiga transaktioner i perioden', 'No reverse-charge transactions this period'),
      ok: true,
    },
    {
      label: needsReviewLines.length === 0 && unpostedPurchases.length === 0
        ? t('Alla transaktioner mappade till deklarationsrutor', 'All transactions mapped to VAT declaration boxes')
        : t('Ej alla transaktioner mappade till deklarationsrutor', 'Not all transactions mapped to VAT declaration boxes'),
      ok: needsReviewLines.length === 0 && unpostedPurchases.length === 0,
    },
  ];
  const reconciliationHasErrors = validationChecks.some((c) => !c.ok);

  const declarationBoxes = [
    { box: '05', label: t('Försäljning inom Sverige (exkl. moms)', 'Sales within Sweden (excl. VAT)'), amount: 0, count: 0, tooltip: t('Total försäljning i Sverige exkl. moms. Inkluderar fakturerade belopp till kunder.', 'Total sales within Sweden excluding VAT, including invoiced amounts to customers.') },
    { box: '06', label: t('Utgående moms Sverige', 'Output VAT (Sweden)'), amount: box06Amount, count: 0, tooltip: t('Utgående moms 25% på inhemsk försäljning. Beräknas som 25% av belopp i ruta 05.', 'Output VAT at 25% on domestic sales. Calculated as 25% of Box 05.') },
    { box: '10', label: t('Avdragsgill ingående moms', 'Deductible input VAT'), amount: inputVat2641, count: allLines.filter((l) => l.vat_treatment === 'domestic_deductible').length, tooltip: t('All moms du har rätt att dra av på affärsrelaterade inköp.', 'All VAT you are allowed to deduct on business-related purchases.') },
    { box: '20', label: t('Omvänd skattskyldighet, beskattningsunderlag', 'Reverse-charge taxable base'), amount: rcBase > 0 ? rcBase : 0, count: allLines.filter((l) => l.vat_treatment === 'reverse_charge').length, highlight: rcBase > 0, tooltip: t('Skatteunderlag (ej moms) för utländska inköp med omvänd skattskyldighet. Ruta 20 ingår inte i nettoberäkningen.', 'Taxable amount (not VAT) for foreign purchases under reverse charge. Box 20 is not included in the net VAT calculation.') },
    { box: '21', label: t('Omvänd skattskyldighet, moms', 'Reverse-charge VAT'), amount: rcOutputVat2614, count: allLines.filter((l) => l.vat_treatment === 'reverse_charge').length, highlight: rcOutputVat2614 > 0, tooltip: t('Moms beräknad i Sverige på de utländska inköpen (25% av ruta 20). Samma belopp ingår i ruta 10 — ingen nettokontant effekt.', 'VAT calculated in Sweden on those purchases (25% of Box 20). The same amount is included in Box 10 — no net cash impact.') },
  ];

  const createSnapshot = useMutation({
    mutationFn: async () => {
      if (hasBlockers) throw new Error(t('Alla inköp måste vara bokförda', 'All purchases must be posted'));
      const snapshotData = {
        quarter: `Q${quarter} ${year}`, period: `${startDate} – ${endDate}`, created_at: new Date().toISOString(),
        created_by: user?.email || 'unknown', total_verifications: postedPurchases.length,
        declaration_boxes: declarationBoxes.map(b => ({ box: b.box, label: b.label, amount: b.amount })),
        net_vat: netVatPosition, rules_version: '2025.4',
      };
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshotData)));
      const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      const { error } = await supabase.from('acc_vat_periods').update({
        status: 'approved', snapshot_data: snapshotData, snapshot_created_at: new Date().toISOString(),
        snapshot_created_by: user?.id, snapshot_hash: hashHex,
      }).eq('year', year).eq('quarter', quarter);
      if (error) throw error;
      return { hash: hashHex };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['acc-vat-period'] });
      toast.success(t('Ögonblicksbild skapad', 'Snapshot created'));
      setCurrentStep(4);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const steps: StepProps[] = [
    { number: 1, label: t('Datakontroll', 'Data checks'), description: t('Säkerställ bokförda SEK-värden', 'Confirm posted SEK values'), status: currentStep > 1 ? 'done' : currentStep === 1 ? 'active' : 'pending' },
    { number: 2, label: t('Avstämning', 'Reconciliation'), description: t('Kontrollera att allt stämmer', 'Verify everything matches'), status: currentStep > 2 ? 'done' : currentStep === 2 ? 'active' : 'pending' },
    { number: 3, label: t('Ögonblicksbild', 'Snapshot'), description: t('Skapa låst ögonblicksbild', 'Create locked snapshot'), status: currentStep > 3 ? 'done' : currentStep === 3 ? 'active' : 'pending' },
    { number: 4, label: t('Export & inlämning', 'Export & filing'), description: t('Exportera och lämna in', 'Export and submit'), status: currentStep === 4 ? 'active' : 'pending' },
  ];

  const downloadExport = () => {
    if (!vatPeriod?.snapshot_data) return;
    const blob = new Blob([JSON.stringify(vatPeriod.snapshot_data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `vat-declaration-q${quarter}-${year}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const qMonthsSv = ['', 'Januari', 'April', 'Juli', 'Oktober'];
  const qMonthsEn = ['', 'January', 'April', 'July', 'October'];
  const qEndSv = ['', 'Mars', 'Juni', 'September', 'December'];
  const qEndEn = ['', 'March', 'June', 'September', 'December'];
  const startMonth = language === 'sv' ? qMonthsSv[quarter] : qMonthsEn[quarter];
  const endMonthName = language === 'sv' ? qEndSv[quarter] : qEndEn[quarter];

  return (
    <AccountingLayout>
      <div className="space-y-6">
        <Link to="/accounting/vat-periods" className="text-primary text-sm hover:underline flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> {t('Tillbaka till momsperioder', 'Back to VAT periods')}
        </Link>

        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            {t('Momsdeklaration', 'VAT declaration')} Q{quarter} {year}
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="w-5 h-5 text-primary cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                {t(
                  'Momsdeklarationen sammanfattar ingående och utgående moms för kvartalet. Rapporten baseras på bokförda verifikationer i perioden.',
                  'The VAT declaration summarises input and output VAT for the quarter. It is based on posted verifications within the period.'
                )}
              </TooltipContent>
            </Tooltip>
          </h1>
          <p className="text-muted-foreground mt-1">
            {startMonth} – {endMonthName} {year}
            {vatPeriod?.deadline && ` · ${t('Deadline', 'Deadline')}: ${new Date(vatPeriod.deadline).toLocaleDateString(language === 'sv' ? 'sv-SE' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`}
          </p>
        </div>

        <StepIndicator steps={steps} currentStep={currentStep} />

        {currentStep === 1 && (
          <div className="space-y-4">
            {hasBlockers ? (
              <>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold text-amber-800">{t(`${blockerCount} problem kvarstår`, `${blockerCount} issues remaining`)}</p>
                    <p className="text-sm text-amber-700">{t('Åtgärda alla problem innan du kan fortsätta till nästa steg.', 'Resolve all issues before proceeding to the next step.')}</p>
                  </div>
                </div>
                {detectedCurrencyIssues.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="font-medium text-red-800">{t('FX-backfill krävs innan momsperioden kan godkännas', 'FX backfill is required before this VAT period can be approved')}</p>
                    <p className="text-sm text-red-700 mt-1">
                      {t('Kör backfill-skriptet så att SEK-värden sparas korrekt innan momsperioden godkänns.', 'Run the FX backfill script so the SEK values are persisted correctly before approving this VAT period.')}
                    </p>
                  </div>
                )}
                <Card className="border border-border">
                  <CardHeader><CardTitle>{t('Problem att åtgärda', 'Issues to resolve')}</CardTitle></CardHeader>
                  <CardContent className="divide-y divide-border">
                    {unpostedPurchases.map(p => (
                      <div key={p.id} className="flex items-center justify-between py-3">
                        <div>
                          <p className="text-sm font-medium">{p.description || (p.supplier as any)?.name || t('Ej klassificerat inköp', 'Unclassified purchase')}</p>
                          <p className="text-xs text-muted-foreground">{statusLabels[p.status as keyof typeof statusLabels]} · {formatSEK(Number(p.gross_amount))}</p>
                        </div>
                        <Link to={`/accounting/purchases/${p.id}`}><Button size="sm">{t('Åtgärda', 'Resolve')}</Button></Link>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </>
            ) : (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <p className="text-sm text-green-800">{t('Alla inköp är bokförda. Inga problem kvarstår.', 'All purchases are posted. No issues remaining.')}</p>
              </div>
            )}
            <Button onClick={() => setCurrentStep(2)} disabled={hasBlockers}>{t('Fortsätt till avstämning', 'Continue to reconciliation')}</Button>
          </div>
        )}

        {currentStep === 2 && (
          <div className="space-y-4">

            {/* VAT validation summary — collapsible */}
            <Card className="border border-border">
              <button
                type="button"
                className="w-full flex items-center justify-between px-6 py-4 text-left"
                onClick={() => setValidationExpanded(!validationExpanded)}
              >
                <div className="flex items-center gap-2.5">
                  <CardTitle className="text-base">{t('Momskontroll', 'VAT validation')}</CardTitle>
                  {reconciliationHasErrors ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {validationChecks.filter(c => !c.ok).length} {t('problem', 'issues')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-md bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                      <CheckCircle className="w-3.5 h-3.5" />
                      {t('Allt OK', 'All OK')}
                    </span>
                  )}
                </div>
                {validationExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
              </button>
              {validationExpanded && (
                <CardContent className="pt-0 pb-4">
                  <div className="divide-y divide-border">
                    {validationChecks.map((check, i) => (
                      <div key={i} className="flex items-center justify-between py-2.5 gap-4">
                        <div className={`flex items-center gap-2.5 text-sm ${check.ok ? 'text-green-700' : 'text-red-700'}`}>
                          {check.ok
                            ? <CheckCircle className="w-4 h-4 shrink-0" />
                            : <AlertTriangle className="w-4 h-4 shrink-0" />}
                          <span>{check.label}</span>
                        </div>
                        {!check.ok && check.issueLink && (
                          <Link to={check.issueLink} className="shrink-0">
                            <Button size="sm" variant="outline" className="h-7 text-xs">
                              {t('Visa problem →', 'View issue →')}
                            </Button>
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>

            {/* Net VAT position */}
            <Card className="border border-border">
              <CardHeader>
                <CardTitle>{t('Nettomomsposition', 'Net VAT position')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground font-medium tracking-wide mb-2">{t('Utgående moms', 'Output VAT')}</p>
                    <div className="space-y-1.5 text-sm pl-2">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Ruta 06 – Utgående moms Sverige', 'Box 06 – Output VAT (Sweden)')}</span>
                        <span>{formatSEK(box06Amount)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Ruta 21 – Omvänd skattskyldighet, moms', 'Box 21 – Reverse-charge VAT')}</span>
                        <span>{formatSEK(rcOutputVat2614)}</span>
                      </div>
                      <div className="flex justify-between font-medium border-t border-border pt-1.5">
                        <span>{t('Summa utgående moms', 'Total output VAT')}</span>
                        <span>{formatSEK(box06Amount + rcOutputVat2614)}</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground font-medium tracking-wide mb-2">{t('Ingående moms', 'Input VAT')}</p>
                    <div className="space-y-1.5 text-sm pl-2">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Ruta 10 – Avdragsgill ingående moms', 'Box 10 – Deductible input VAT')}</span>
                        <span>{formatSEK(inputVat2641)}</span>
                      </div>
                    </div>
                  </div>
                  <div className={`flex justify-between items-center px-4 py-3 rounded-lg font-semibold text-sm border ${
                    netVatPosition < 0
                      ? 'bg-green-50 border-green-200 text-green-800'
                      : netVatPosition > 0
                        ? 'bg-red-50 border-red-200 text-red-800'
                        : 'bg-muted border-border text-foreground'
                  }`}>
                    <span>{netVatPosition < 0
                      ? t('Moms att återfå', 'VAT to receive')
                      : netVatPosition > 0
                        ? t('Moms att betala', 'VAT to pay')
                        : t('Momsneutral', 'VAT position: neutral')}</span>
                    <span className="text-base">{formatSEK(Math.abs(netVatPosition))}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Declaration boxes — at the bottom */}
            <Card className="border border-border">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {t('Deklarationsrutor', 'Declaration boxes')}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="w-4 h-4 text-primary cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs">
                      {t(
                        'Rutorna motsvarar fälten i Skatteverkets momsdeklarationsformulär. Beloppen beräknas automatiskt från bokförda verifikationer.',
                        'The boxes correspond to fields on the Skatteverket VAT return form. Amounts are calculated automatically from posted verifications.'
                      )}
                    </TooltipContent>
                  </Tooltip>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Ruta', 'Box')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Beskrivning', 'Description')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Belopp', 'Amount')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Transaktioner', 'Transactions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {declarationBoxes.map(box => (
                      <TableRow key={box.box} className={box.highlight ? 'bg-amber-50/50' : box.amount === 0 && box.count === 0 ? 'opacity-50' : ''}>
                        <TableCell className="font-medium text-sm">
                          {box.box}
                          {box.tooltip && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Info className="w-3.5 h-3.5 text-primary inline ml-1 cursor-help" />
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-xs">{box.tooltip}</TooltipContent>
                            </Tooltip>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{box.label}</TableCell>
                        <TableCell className="text-right text-sm font-medium">{formatSEK(box.amount)}</TableCell>
                        <TableCell className="text-right text-sm text-primary">{box.count || ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Action row */}
            <div className="space-y-3">
              {reconciliationHasErrors && (
                <div className="flex items-center gap-2 text-sm text-red-700">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{t('Åtgärda problemen ovan innan du fortsätter.', 'Fix the issues above before proceeding.')}</span>
                </div>
              )}
              <div className="flex gap-3">
                <Button onClick={() => setCurrentStep(3)} disabled={reconciliationHasErrors}>
                  {t('Ser bra ut — fortsätt till ögonblicksbild', 'Looks good — continue to snapshot')}
                </Button>
                <Button variant="outline" onClick={() => setCurrentStep(1)}>{t('Tillbaka', 'Back')}</Button>
              </div>
            </div>

          </div>
        )}

        {currentStep === 3 && (
          <div className="space-y-4">
            {vatPeriod?.snapshot_data ? (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <div>
                  <p className="font-medium text-green-800">{t('Ögonblicksbild skapad', 'Snapshot created')}</p>
                  <p className="text-sm text-green-700">{t('Momsdeklarationen är nu låst och klar för export.', 'The VAT declaration is now locked and ready for export.')}</p>
                </div>
              </div>
            ) : (
              <Card className="border border-border">
                <CardContent className="p-6">
                  <div className="flex items-start gap-3 mb-6">
                    <Lock className="w-6 h-6 text-primary mt-0.5" />
                    <div>
                      <h3 className="font-semibold text-lg">{t('Skapa ögonblicksbild', 'Create snapshot')}</h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        {t(
                          'En ögonblicksbild är en låst version av momsdeklarationen som inte kan ändras. Detta säkerställer att rapporten är samma som det som lämnades in till Skatteverket.',
                          'A snapshot is a locked version of the VAT declaration that cannot be changed. This ensures the report matches what was submitted to the Tax Agency.'
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-4 space-y-2 text-sm mb-6">
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Period', 'Period')}</span><span>Q{quarter} {year}</span></div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{netVatPosition < 0 ? t('Moms att återfå', 'VAT to receive') : t('Moms att betala', 'VAT to pay')}</span>
                      <span className={netVatPosition < 0 ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>{formatSEK(Math.abs(netVatPosition))}</span>
                    </div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Transaktioner inkluderade', 'Transactions included')}</span><span>{postedPurchases.length} {t('st', 'pcs')}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Granskare', 'Reviewer')}</span><span>{user?.email || '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Regelversion', 'Rules version')}</span><span>2025.4</span></div>
                  </div>
                  <div className="flex gap-3">
                    <Button onClick={() => createSnapshot.mutate()} disabled={createSnapshot.isPending}>
                      <Lock className="w-4 h-4 mr-2" />{createSnapshot.isPending ? t('Skapar...', 'Creating...') : t('Skapa ögonblicksbild', 'Create snapshot')}
                    </Button>
                    <Button variant="outline" onClick={() => setCurrentStep(2)}>{t('Tillbaka', 'Back')}</Button>
                  </div>
                </CardContent>
              </Card>
            )}
            {vatPeriod?.snapshot_data && <Button onClick={() => setCurrentStep(4)}>{t('Fortsätt till export', 'Continue to export')}</Button>}
          </div>
        )}

        {currentStep === 4 && (
          <div className="space-y-4">
            {vatPeriod?.snapshot_data && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <div>
                  <p className="font-medium text-green-800">{t('Ögonblicksbild skapad', 'Snapshot created')}</p>
                  <p className="text-sm text-green-700">{t('Momsdeklarationen är nu låst och klar för export.', 'The VAT declaration is now locked and ready for export.')}</p>
                </div>
              </div>
            )}
            <Card className="border border-border">
              <CardContent className="p-6 space-y-6">
                <h3 className="font-semibold text-lg">{t('Export och inlämning', 'Export and filing')}</h3>
                <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-3">
                    <FileText className="w-8 h-8 text-primary" />
                    <div>
                      <p className="font-medium">{t('Momsdeklaration', 'VAT declaration')} Q{quarter} {year}</p>
                      <p className="text-xs text-muted-foreground">{t('Underlag för inlämning till Skatteverket', 'Supporting documents for Tax Agency submission')}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    {vatPeriod?.snapshot_hash && <span className="text-xs text-muted-foreground font-mono">Hash: {vatPeriod.snapshot_hash.slice(0, 10)}...</span>}
                    <Button onClick={downloadExport}><Download className="w-4 h-4 mr-2" /> {t('Ladda ner', 'Download')}</Button>
                  </div>
                </div>
                <div>
                  <h4 className="font-medium mb-3">{t('Inlämning till Skatteverket', 'Submission to the Tax Agency')}</h4>
                  <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1.5">
                    <li>{t('Ladda ner deklarationsunderlaget ovan', 'Download the declaration document above')}</li>
                    <li>{t('Logga in på Skatteverkets webbplats', 'Log in to the Tax Agency website')}</li>
                    <li>{t('Navigera till "Lämna momsdeklaration"', 'Navigate to "Submit VAT declaration"')}</li>
                    <li>{t('Fyll i uppgifterna manuellt baserat på underlaget', 'Fill in the details manually based on the document')}</li>
                    <li>{t('Kontrollera uppgifterna och skicka in', 'Verify the details and submit')}</li>
                    <li>{t('Ladda ner bekräftelsen från Skatteverket', 'Download the confirmation from the Tax Agency')}</li>
                    <li>{t('Ladda upp bekräftelsen här för arkivering', 'Upload the confirmation here for archiving')}</li>
                  </ol>
                </div>
                <div>
                  <h4 className="font-medium mb-3">{t('Ladda upp bekräftelse från Skatteverket', 'Upload confirmation from the Tax Agency')}</h4>
                  <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-xl p-8 cursor-pointer hover:border-primary/40 hover:bg-muted/30 transition-colors">
                    <Upload className="w-8 h-8 text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">{t('Klicka för att ladda upp eller dra och släpp', 'Click to upload or drag and drop')}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t('PDF eller skärmdump', 'PDF or screenshot')}</p>
                    <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg" />
                  </label>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </AccountingLayout>
  );
};

export default VatDeclarationFlow;
