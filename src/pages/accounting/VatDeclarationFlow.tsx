import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSEK, PURCHASE_STATUS_LABELS, PURCHASE_STATUS_LABELS_EN } from '@/lib/accounting-utils';
import {
  detectForeignCurrencyIntegrityIssue,
  formatCurrencyAmount,
  getPurchaseExchangeSnapshot,
  isForeignCurrency,
  roundMoney,
} from '@/lib/accounting-fx';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle, AlertTriangle, Lock, Download, Upload, Info, FileText } from 'lucide-react';

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
  const declarationBoxes = [
    { box: '05', label: t('Försäljning inom Sverige (exkl. moms)', 'Sales within Sweden (excl. VAT)'), amount: 0, count: 0, tooltip: t('Total försäljning i Sverige exkl. moms. Inkluderar fakturerade belopp till kunder.', 'Total sales within Sweden excluding VAT, including invoiced amounts to customers.') },
    { box: '06', label: t('Inhemsk utgående moms 25%', 'Domestic output VAT 25%'), amount: box06Amount, count: 0, tooltip: t('Utgående moms 25% på inhemsk försäljning. Beräknas som 25% av belopp i ruta 05.', 'Output VAT at 25% on domestic sales. Calculated as 25% of the amount in Box 05.') },
    { box: '10', label: t('Avdragsgill ingående moms', 'Deductible input VAT'), amount: inputVat2641, count: allLines.filter((l) => l.vat_treatment === 'domestic_deductible').length, tooltip: t('All moms du har rätt att dra av på affärsrelaterade inköp. Inkluderar ingående moms från inhemska köp samt omvänd skattskyldighet.', 'All VAT you are allowed to deduct on business-related purchases. Includes input VAT from domestic purchases and reverse charge.') },
    { box: '20', label: t('Omvänd skattskyldighet, beskattningsunderlag', 'Reverse-charge taxable base'), amount: rcBase > 0 ? rcBase : 0, count: allLines.filter((l) => l.vat_treatment === 'reverse_charge').length, highlight: rcBase > 0, tooltip: t('Nettobeloppet (exkl. moms) för inköp från EU-leverantörer med omvänd skattskyldighet. Detta är ett underlag, inte ett momsbelopp — ruta 20 ingår inte i nettoberäkningen.', 'The net amount (excl. VAT) for purchases from EU suppliers under reverse charge. This is a taxable base, not a VAT amount — Box 20 is not included in the net VAT calculation.') },
    { box: '21', label: t('Utgående moms på omvänd skattskyldighet', 'Reverse-charge output VAT'), amount: rcOutputVat2614, count: allLines.filter((l) => l.vat_treatment === 'reverse_charge').length, highlight: rcOutputVat2614 > 0, tooltip: t('25% moms beräknad på beskattningsunderlaget i ruta 20 (konto 2614). Eftersom denna moms är avdragsgill ingår samma belopp även i ruta 10 — ingen nettokontant effekt.', '25% VAT calculated on the taxable base in Box 20 (account 2614). Since this VAT is also deductible, the same amount is included in Box 10 — no net cash impact.') },
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

            {/* Validation summary */}
            <Card className="border border-border">
              <CardContent className="p-5">
                <h3 className="font-semibold mb-3">{t('Kontrollsammanfattning', 'VAT check summary')}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  <div className="flex items-center gap-2 text-green-700">
                    <CheckCircle className="w-4 h-4 shrink-0" />
                    <span>{t(`${postedPurchases.length} verifikationer granskade och inkluderade`, `${postedPurchases.length} verifications reviewed and included`)}</span>
                  </div>
                  {foreignPurchases.length > 0 ? (
                    <div className="flex items-center gap-2 text-green-700">
                      <CheckCircle className="w-4 h-4 shrink-0" />
                      <span>{t(`${foreignPurchases.length} valutaköp kontrollerade (ECB-kurs)`, `${foreignPurchases.length} foreign-currency purchases validated (ECB rate)`)}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <CheckCircle className="w-4 h-4 shrink-0" />
                      <span>{t('Inga valutaköp i perioden', 'No foreign-currency purchases this period')}</span>
                    </div>
                  )}
                  {rcLineCount > 0 ? (
                    <div className="flex items-center gap-2 text-green-700">
                      <CheckCircle className="w-4 h-4 shrink-0" />
                      <span>{t(`${rcLineCount} omvändskattskyldiga rader inkluderade (rutor 20 & 21)`, `${rcLineCount} reverse-charge lines included (boxes 20 & 21)`)}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <CheckCircle className="w-4 h-4 shrink-0" />
                      <span>{t('Inga omvändskattskyldiga transaktioner', 'No reverse-charge transactions')}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-green-700">
                    <CheckCircle className="w-4 h-4 shrink-0" />
                    <span>
                      {netVatPosition < 0
                        ? t(`Momsåterbäring beräknad: ${formatSEK(Math.abs(netVatPosition))}`, `Refund calculated: ${formatSEK(Math.abs(netVatPosition))}`)
                        : t(`Moms att betala beräknad: ${formatSEK(netVatPosition)}`, `VAT to pay calculated: ${formatSEK(netVatPosition)}`)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Declaration boxes */}
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
                {rcLineCount > 0 && (
                  <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                    <p className="font-medium mb-1">{t('Vad är omvänd skattskyldighet?', 'What is reverse charge?')}</p>
                    <p>{t(
                      'Omvänd skattskyldighet innebär att du som köpare beräknar svensk moms på vissa utländska inköp. Beskattningsunderlaget visas i ruta 20 och momsen i ruta 21. Eftersom denna moms även är avdragsgill ingår samma belopp i ruta 10 — omvänd skattskyldighet har alltså ingen nettokontant effekt.',
                      'Reverse charge means you as the buyer calculate Swedish VAT on certain foreign purchases. The taxable base appears in Box 20 and the VAT in Box 21. Since this VAT is also deductible, the same amount is included in Box 10 — meaning reverse charge has no net cash impact.'
                    )}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Net VAT position */}
            <Card className="border border-border">
              <CardHeader>
                <CardTitle>{t('Nettomomsposition', 'Net VAT position')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground font-medium tracking-wide mb-2">{t('Utgående moms (att betala)', 'Output VAT (owed)')}</p>
                    <div className="space-y-1.5 text-sm pl-2">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Inhemsk utgående moms (ruta 06)', 'Domestic output VAT (Box 06)')}</span>
                        <span>{formatSEK(box06Amount)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Omvänd skattskyldighet (ruta 21)', 'Reverse-charge output VAT (Box 21)')}</span>
                        <span>{formatSEK(rcOutputVat2614)}</span>
                      </div>
                      <div className="flex justify-between font-medium border-t border-border pt-1.5">
                        <span>{t('Summa utgående moms', 'Total output VAT')}</span>
                        <span>{formatSEK(box06Amount + rcOutputVat2614)}</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground font-medium tracking-wide mb-2">{t('Avdragsgill ingående moms', 'Deductible input VAT')}</p>
                    <div className="space-y-1.5 text-sm pl-2">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Ingående moms (ruta 10)', 'Deductible input VAT (Box 10)')}</span>
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

            {/* Foreign-currency check */}
            {foreignPurchases.length > 0 && (
              <Card className="border border-border">
                <CardHeader>
                  <CardTitle>{t('Valutakontroll', 'Foreign-currency check')}</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t(
                      'Dessa inköp visas här så att SEK-omräkningen och rapporteringen av omvänd skattskyldighet kan kontrolleras innan momsögonblicksbilden låses.',
                      'These purchases are shown here so the SEK conversion and reverse-charge reporting can be checked before locking the VAT snapshot.'
                    )}
                  </p>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs uppercase text-muted-foreground">{t('Datum', 'Date')}</TableHead>
                        <TableHead className="text-xs uppercase text-muted-foreground">{t('Leverantör', 'Supplier')}</TableHead>
                        <TableHead className="text-xs uppercase text-muted-foreground">{t('Originalt belopp', 'Original amount')}</TableHead>
                        <TableHead className="text-xs uppercase text-muted-foreground">{t('Kurs', 'Rate')}</TableHead>
                        <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('SEK-belopp', 'SEK amount')}</TableHead>
                        <TableHead className="text-xs uppercase text-muted-foreground">{t('Ingår i rutor', 'Included in boxes')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {foreignPurchases.map((purchase) => {
                        const snapshot = getPurchaseExchangeSnapshot(purchase);
                        const purchaseLines = ((purchase as any).lines || []) as Array<any>;
                        const includedBoxes = Array.from(new Set(purchaseLines.flatMap((line) => {
                          if (line.vat_treatment === 'domestic_deductible') return ['10'];
                          if (line.vat_treatment === 'reverse_charge') return ['20', '21'];
                          return [] as string[];
                        }))).sort();
                        return (
                          <TableRow key={purchase.id}>
                            <TableCell className="text-sm">{purchase.document_date}</TableCell>
                            <TableCell className="text-sm">{(purchase.supplier as any)?.name || '—'}</TableCell>
                            <TableCell className="text-sm">{formatCurrencyAmount(snapshot.originalNet, snapshot.originalCurrency)}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{snapshot.exchangeRateSource} · {snapshot.exchangeRateDate || '—'}</TableCell>
                            <TableCell className="text-right text-sm font-medium">{formatSEK(snapshot.convertedNetSek)}</TableCell>
                            <TableCell className="text-sm">
                              {includedBoxes.length > 0
                                ? includedBoxes.map((b) => (
                                    <Badge key={b} variant="outline" className="text-xs mr-1">{b}</Badge>
                                  ))
                                : <span className="text-muted-foreground">—</span>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            <div className="flex gap-3">
              <Button onClick={() => setCurrentStep(3)}>{t('Godkänn och fortsätt', 'Approve and continue')}</Button>
              <Button variant="outline" onClick={() => setCurrentStep(1)}>{t('Tillbaka', 'Back')}</Button>
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
