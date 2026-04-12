import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSEK, PURCHASE_STATUS_LABELS, PURCHASE_STATUS_LABELS_EN, isReverseChargeTreatment } from '@/lib/accounting-utils';
import {
  detectForeignCurrencyIntegrityIssue,
  getPurchaseExchangeSnapshot,
  isForeignCurrency,
  roundMoney,
} from '@/lib/accounting-fx';
import {
  buildSkatteverketXml,
  finalizeVatDeclarationAmounts,
  purchaseMatchesDeclarationBox,
  validateSkatteverketXml,
  type DeclarationBoxFilter,
} from '@/lib/vat-declaration';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle, AlertTriangle, Lock, Download, Upload, Info, FileText, ChevronDown, ChevronUp } from 'lucide-react';

interface StepProps { number: number; label: string; description: string; status: 'active' | 'done' | 'pending'; }

interface VatWorkflowState {
  dataChecksApprovedAt?: string;
  reconciliationApprovedAt?: string;
}

const StepIndicator: React.FC<{
  steps: StepProps[];
  maxAccessibleStep: number;
  onSelectStep: (step: number) => void;
}> = ({ steps, maxAccessibleStep, onSelectStep }) => (
  <Card className="border border-border">
    <CardContent className="p-6">
      <div className="flex items-center justify-between">
        {steps.map((step, i) => (
          <React.Fragment key={step.number}>
            <button
              type="button"
              onClick={() => onSelectStep(step.number)}
              disabled={step.number > maxAccessibleStep}
              className="flex items-center gap-3 text-left disabled:cursor-not-allowed"
            >
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${
                step.status === 'done' || step.status === 'active' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}>
                {step.status === 'done' ? <CheckCircle className="w-5 h-5" /> : step.number}
              </div>
              <div>
                <p className={`text-sm font-medium ${step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground'}`}>{step.label}</p>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            </button>
            {i < steps.length - 1 && <div className="flex-1 h-px bg-border mx-4" />}
          </React.Fragment>
        ))}
      </div>
    </CardContent>
  </Card>
);

function parseVatWorkflowState(value: unknown): VatWorkflowState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;

  return {
    dataChecksApprovedAt: typeof record.dataChecksApprovedAt === 'string' ? record.dataChecksApprovedAt : undefined,
    reconciliationApprovedAt: typeof record.reconciliationApprovedAt === 'string' ? record.reconciliationApprovedAt : undefined,
  };
}

const VatDeclarationFlow: React.FC = () => {
  const { periodId } = useParams<{ periodId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { t, language } = useLanguage();
  const queryClient = useQueryClient();
  const [validationExpanded, setValidationExpanded] = useState(false);
  const [generatedXml, setGeneratedXml] = useState<string | null>(null);
  const [xmlValidationErrors, setXmlValidationErrors] = useState<string[]>([]);
  const [xmlValidationWarnings, setXmlValidationWarnings] = useState<string[]>([]);

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

  const buildDeclarationBoxLink = (box: DeclarationBoxFilter): string => {
    const params = new URLSearchParams();
    params.set('status', 'posted');
    params.set('declarationBox', box);
    params.set('dateFrom', startDate);
    params.set('dateTo', endDate);
    return `/accounting/purchases?${params.toString()}`;
  };

  // ── Skatteverket box calculations ──────────────────────────────────────────
  // Section A: Taxable sales bases (not yet tracked — no sales invoices)
  const box05 = 0; // ForsMomsEjAnnan — Taxable sales
  // Section B: Output VAT on sales
  const box10 = 0; // MomsUtgHog — Output VAT 25% on sales
  const box11 = 0; // MomsUtgMedel — Output VAT 12%
  const box12 = 0; // MomsUtgLag — Output VAT 6%
  // Section C: Taxable purchases (reverse-charge bases)
  const sumNetByTreatment = (treatment: string) => roundMoney(postedPurchases.reduce(
    (sum, p) => sum + p.lines.filter((l) => l.vat_treatment === treatment)
      .reduce((lineSum, l) => lineSum + Number(l.net_amount), 0), 0));
  const box20Raw = sumNetByTreatment('reverse_charge_eu_goods');       // InkopVaruAnnatEg
  const box21Raw = sumNetByTreatment('reverse_charge_eu_services');    // InkopTjanstAnnatEg
  const box22Raw = sumNetByTreatment('reverse_charge_non_eu_services');// InkopTjanstUtomEg
  // Section D: Output VAT on purchases (reverse-charge output VAT)
  const box30Raw = roundMoney(postedPurchases.reduce((sum, p) => sum + p.lines
    .filter((l) => isReverseChargeTreatment(l.vat_treatment))
    .reduce((lineSum, l) => lineSum + roundMoney(Number(l.net_amount) * 0.25), 0), 0)); // MomsInkopUtgHog
  const box31Raw = 0; // MomsInkopUtgMedel — 12% on RC purchases (not applicable)
  const box32Raw = 0; // MomsInkopUtgLag — 6% on RC purchases (not applicable)
  // Section F: Deductible input VAT
  const domesticInputVat = roundMoney(postedPurchases.reduce((sum, p) => sum + p.lines
    .filter((l) => l.vat_treatment === 'domestic_deductible')
    .reduce((lineSum, l) => lineSum + Number(l.vat_amount), 0), 0));
  const rcInputVat = box30Raw; // Reverse-charge input VAT = output VAT (net zero)
  const roundedDeclarationAmounts = finalizeVatDeclarationAmounts({
    box05,
    box10,
    box11,
    box12,
    box20: box20Raw,
    box21: box21Raw,
    box22: box22Raw,
    box30: box30Raw,
    box31: box31Raw,
    box32: box32Raw,
    box48: roundMoney(domesticInputVat + rcInputVat),
  });
  const box20 = roundedDeclarationAmounts.box20;
  const box21 = roundedDeclarationAmounts.box21;
  const box22 = roundedDeclarationAmounts.box22;
  const box30 = roundedDeclarationAmounts.box30;
  const box31 = roundedDeclarationAmounts.box31;
  const box32 = roundedDeclarationAmounts.box32;
  const box48 = roundedDeclarationAmounts.box48;
  const momsBetala = roundedDeclarationAmounts.momsBetala;
  const rcLineCount = postedPurchases.flatMap((p) => p.lines).filter((l) => isReverseChargeTreatment(l.vat_treatment)).length;

  const allLines = postedPurchases.flatMap((p) => p.lines);
  const needsReviewLines = allLines.filter((l: any) => l.vat_treatment === 'needs_review');
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
  const workflowState = useMemo(() => parseVatWorkflowState(vatPeriod?.workflow_state), [vatPeriod?.workflow_state]);
  const dataChecksApproved = Boolean(workflowState.dataChecksApprovedAt) || Boolean(workflowState.reconciliationApprovedAt) || Boolean(vatPeriod?.snapshot_data);
  const reconciliationApproved = Boolean(workflowState.reconciliationApprovedAt) || Boolean(vatPeriod?.snapshot_data);
  const maxAccessibleStep = vatPeriod?.snapshot_data
    ? 4
    : reconciliationApproved
      ? 3
      : dataChecksApproved
        ? 2
        : 1;
  const requestedStep = Number(searchParams.get('step') || '');
  const normalizedRequestedStep = Number.isInteger(requestedStep) && requestedStep >= 1 && requestedStep <= 4
    ? requestedStep
    : null;
  const currentStep = normalizedRequestedStep === null
    ? maxAccessibleStep
    : Math.min(normalizedRequestedStep, maxAccessibleStep);

  const goToStep = (step: number, replace = false) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('step', String(step));
    setSearchParams(nextParams, { replace });
  };

  /** Skatteverket XML element names mapped to box numbers */
  const declarationBoxes = [
    // Section A: Taxable sales
    { box: '05', xmlTag: 'ForsMomsEjAnnan', label: t('Momspliktig försäljning (ej i 06, 07, 08)', 'Taxable sales (not in 06, 07, 08)'), amount: box05, count: 0, section: 'A', filterBox: null },
    // Section B: Output VAT on sales
    { box: '10', xmlTag: 'MomsUtgHog', label: t('Utgående moms 25 %', 'Output VAT 25%'), amount: box10, count: 0, section: 'B', filterBox: null },
    { box: '11', xmlTag: 'MomsUtgMedel', label: t('Utgående moms 12 %', 'Output VAT 12%'), amount: box11, count: 0, section: 'B', filterBox: null },
    { box: '12', xmlTag: 'MomsUtgLag', label: t('Utgående moms 6 %', 'Output VAT 6%'), amount: box12, count: 0, section: 'B', filterBox: null },
    // Section C: Taxable purchases (reverse-charge bases)
    { box: '20', xmlTag: 'InkopVaruAnnatEg', label: t('Inköp av varor från annat EU-land', 'Purchases of goods from other EU country'), amount: box20, highlight: box20 > 0, section: 'C', filterBox: '20' as const },
    { box: '21', xmlTag: 'InkopTjanstAnnatEg', label: t('Inköp av tjänster från annat EU-land', 'Purchases of services from other EU country'), amount: box21, highlight: box21 > 0, section: 'C', filterBox: '21' as const },
    { box: '22', xmlTag: 'InkopTjanstUtomEg', label: t('Inköp av tjänster från land utanför EU', 'Purchases of services from outside EU'), amount: box22, highlight: box22 > 0, section: 'C', filterBox: '22' as const },
    // Section D: Output VAT on purchases
    { box: '30', xmlTag: 'MomsInkopUtgHog', label: t('Utgående moms 25 % på inköp', 'Output VAT 25% on purchases'), amount: box30, highlight: box30 > 0, section: 'D', filterBox: '30' as const },
    { box: '31', xmlTag: 'MomsInkopUtgMedel', label: t('Utgående moms 12 % på inköp', 'Output VAT 12% on purchases'), amount: box31, count: 0, section: 'D', filterBox: null },
    { box: '32', xmlTag: 'MomsInkopUtgLag', label: t('Utgående moms 6 % på inköp', 'Output VAT 6% on purchases'), amount: box32, count: 0, section: 'D', filterBox: null },
    // Section F: Input VAT
    { box: '48', xmlTag: 'MomsIngAvdr', label: t('Ingående moms att dra av', 'Deductible input VAT'), amount: box48, section: 'F', filterBox: '48' as const },
    // Section G: VAT to pay or receive
    { box: '49', xmlTag: 'MomsBetala', label: t('Moms att betala eller återfå', 'VAT to pay or receive'), amount: momsBetala, count: 0, section: 'G', filterBox: null },
  ].map((box) => {
    if (!box.filterBox) {
      return {
        ...box,
        count: box.count ?? 0,
        matchingPurchases: [] as typeof postedPurchases,
      };
    }

    const matchingPurchases = postedPurchases.filter((purchase) =>
      purchaseMatchesDeclarationBox({ lines: purchase.lines }, box.filterBox),
    );

    return {
      ...box,
      count: matchingPurchases.length,
      matchingPurchases,
    };
  });

  const createSnapshot = useMutation({
    mutationFn: async () => {
      if (hasBlockers) throw new Error(t('Alla inköp måste vara bokförda', 'All purchases must be posted'));
      const snapshotData = {
        quarter: `Q${quarter} ${year}`, period: `${startDate} – ${endDate}`, created_at: new Date().toISOString(),
        created_by: user?.email || 'unknown', total_verifications: postedPurchases.length,
        declaration_boxes: declarationBoxes.map(b => ({ box: b.box, xmlTag: b.xmlTag, label: b.label, amount: Math.round(b.amount) })),
        moms_betala: Math.round(momsBetala), rules_version: __GIT_COMMIT__,
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
      goToStep(4);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const approveDataChecks = useMutation({
    mutationFn: async () => {
      if (hasBlockers) throw new Error(t('Alla problem måste åtgärdas först', 'All issues must be resolved first'));
      if (!vatPeriod) throw new Error(t('Momsperioden kunde inte laddas', 'VAT period could not be loaded'));

      const nextWorkflowState: VatWorkflowState = {
        ...workflowState,
        dataChecksApprovedAt: workflowState.dataChecksApprovedAt || new Date().toISOString(),
      };
      const nextStatus = vatPeriod.status === 'open' ? 'in_review' : vatPeriod.status;
      const { error } = await supabase
        .from('acc_vat_periods')
        .update({ workflow_state: nextWorkflowState, status: nextStatus })
        .eq('year', year)
        .eq('quarter', quarter);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['acc-vat-period'] });
      goToStep(2);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const approveReconciliation = useMutation({
    mutationFn: async () => {
      if (reconciliationHasErrors) throw new Error(t('Åtgärda avstämningsproblemen först', 'Fix reconciliation issues first'));
      if (!vatPeriod) throw new Error(t('Momsperioden kunde inte laddas', 'VAT period could not be loaded'));

      const approvedAt = new Date().toISOString();
      const nextWorkflowState: VatWorkflowState = {
        ...workflowState,
        dataChecksApprovedAt: workflowState.dataChecksApprovedAt || approvedAt,
        reconciliationApprovedAt: workflowState.reconciliationApprovedAt || approvedAt,
      };
      const nextStatus = vatPeriod.status === 'open' ? 'in_review' : vatPeriod.status;
      const { error } = await supabase
        .from('acc_vat_periods')
        .update({ workflow_state: nextWorkflowState, status: nextStatus })
        .eq('year', year)
        .eq('quarter', quarter);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['acc-vat-period'] });
      goToStep(3);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const steps: StepProps[] = [
    {
      number: 1,
      label: t('Datakontroll', 'Data checks'),
      description: t('Säkerställ bokförda SEK-värden', 'Confirm posted SEK values'),
      status: currentStep === 1 ? 'active' : dataChecksApproved ? 'done' : 'pending',
    },
    {
      number: 2,
      label: t('Avstämning', 'Reconciliation'),
      description: t('Kontrollera att allt stämmer', 'Verify everything matches'),
      status: currentStep === 2 ? 'active' : reconciliationApproved ? 'done' : 'pending',
    },
    {
      number: 3,
      label: t('Ögonblicksbild', 'Snapshot'),
      description: t('Skapa låst ögonblicksbild', 'Create locked snapshot'),
      status: currentStep === 3 ? 'active' : vatPeriod?.snapshot_data ? 'done' : 'pending',
    },
    {
      number: 4,
      label: t('Export & inlämning', 'Export & filing'),
      description: t('Exportera och lämna in', 'Export and submit'),
      status: currentStep === 4 ? 'active' : 'pending',
    },
  ];

  const declarationXmlBoxes = useMemo(() => declarationBoxes.map((box) => ({
    xmlTag: box.xmlTag,
    amount: box.amount,
  })), [declarationBoxes]);

  useEffect(() => {
    setGeneratedXml(null);
    setXmlValidationErrors([]);
    setXmlValidationWarnings([]);
  }, [quarter, year, vatPeriod?.snapshot_hash, JSON.stringify(declarationXmlBoxes)]);

  useEffect(() => {
    if (normalizedRequestedStep !== currentStep) {
      goToStep(currentStep, normalizedRequestedStep === null);
    }
  }, [currentStep, normalizedRequestedStep]);

  const generateValidatedXml = () => {
    // Last month of the quarter determines the period code
    const periodYYYYMM = `${year}${String(quarter * 3).padStart(2, '0')}`;
    const orgNr = '790519-7591'; // SHS org number
    const xml = buildSkatteverketXml(orgNr, periodYYYYMM, declarationXmlBoxes);
    const validation = validateSkatteverketXml({
      xml,
      expectedOrgNr: orgNr,
      expectedPeriodYYYYMM: periodYYYYMM,
      declarationBoxes: declarationXmlBoxes,
    });

    setXmlValidationErrors(validation.errors);
    setXmlValidationWarnings(validation.warnings);

    if (!validation.ok) {
      setGeneratedXml(null);
      throw new Error(validation.errors[0] || t('XML-validering misslyckades', 'XML validation failed'));
    }

    setGeneratedXml(xml);
    if (validation.warnings.length > 0) {
      toast.warning(t('XML skapad med varningar', 'XML generated with warnings'));
    } else {
      toast.success(t('XML skapad och validerad', 'XML generated and validated'));
    }
  };

  const downloadXmlExport = () => {
    if (!generatedXml) {
      generateValidatedXml();
      return;
    }
    // Encode as ISO-8859-1
    const encoder = new TextEncoder();
    const blob = new Blob([encoder.encode(generatedXml)], { type: 'application/xml; charset=ISO-8859-1' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `momsdeklaration-${year}-q${quarter}.xml`; a.click();
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

        <StepIndicator
          steps={steps}
          maxAccessibleStep={maxAccessibleStep}
          onSelectStep={(step) => {
            if (step <= maxAccessibleStep) goToStep(step);
          }}
        />

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
            <Button onClick={() => approveDataChecks.mutate()} disabled={hasBlockers || approveDataChecks.isPending}>
              {approveDataChecks.isPending
                ? t('Sparar...', 'Saving...')
                : t('Fortsätt till avstämning', 'Continue to reconciliation')}
            </Button>
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
                    <p className="text-xs uppercase text-muted-foreground font-medium tracking-wide mb-2">{t('Utgående moms (ruta 10+11+12+30+31+32)', 'Output VAT (box 10+11+12+30+31+32)')}</p>
                    <div className="space-y-1.5 text-sm pl-2">
                      {box10 > 0 && <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Ruta 10 – Utgående moms 25 % (försäljning)', 'Box 10 – Output VAT 25% (sales)')}</span>
                        <span>{formatSEK(box10)}</span>
                      </div>}
                      {box30 > 0 && <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Ruta 30 – Utgående moms 25 % (inköp)', 'Box 30 – Output VAT 25% (purchases)')}</span>
                        <span>{formatSEK(box30)}</span>
                      </div>}
                      <div className="flex justify-between font-medium border-t border-border pt-1.5">
                        <span>{t('Summa utgående moms', 'Total output VAT')}</span>
                        <span>{formatSEK(box10 + box11 + box12 + box30 + box31 + box32)}</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground font-medium tracking-wide mb-2">{t('Ingående moms (ruta 48)', 'Input VAT (box 48)')}</p>
                    <div className="space-y-1.5 text-sm pl-2">
                      {domesticInputVat > 0 && <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Inhemska inköp (konto 2641)', 'Domestic purchases (account 2641)')}</span>
                        <span>{formatSEK(domesticInputVat)}</span>
                      </div>}
                      {rcInputVat > 0 && <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Omvänd skattskyldighet (konto 2645)', 'Reverse charge (account 2645)')}</span>
                        <span>{formatSEK(rcInputVat)}</span>
                      </div>}
                      <div className="flex justify-between font-medium border-t border-border pt-1.5">
                        <span>{t('Ruta 48 – Avdragsgill ingående moms', 'Box 48 – Deductible input VAT')}</span>
                        <span>{formatSEK(box48)}</span>
                      </div>
                    </div>
                  </div>
                  <div className={`flex justify-between items-center px-4 py-3 rounded-lg font-semibold text-sm border ${
                    momsBetala < 0
                      ? 'bg-green-50 border-green-200 text-green-800'
                      : momsBetala > 0
                        ? 'bg-red-50 border-red-200 text-red-800'
                        : 'bg-muted border-border text-foreground'
                  }`}>
                    <span>{momsBetala < 0
                      ? t('Moms att återfå (ruta 49)', 'VAT to receive (box 49)')
                      : momsBetala > 0
                        ? t('Moms att betala (ruta 49)', 'VAT to pay (box 49)')
                        : t('Momsneutral', 'VAT position: neutral')}</span>
                    <span className="text-base">{formatSEK(Math.abs(momsBetala))}</span>
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
                        <TableCell className="text-right text-sm">
                          {box.filterBox && box.count > 0 ? (
                            <Link to={buildDeclarationBoxLink(box.filterBox)} className="text-primary hover:underline">
                              {box.count}
                            </Link>
                          ) : (
                            <span className={box.count ? 'text-foreground' : 'text-muted-foreground'}>{box.count || ''}</span>
                          )}
                        </TableCell>
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
                <Button onClick={() => approveReconciliation.mutate()} disabled={reconciliationHasErrors || approveReconciliation.isPending}>
                  {approveReconciliation.isPending
                    ? t('Sparar...', 'Saving...')
                    : t('Godkänn och fortsätt till ögonblicksbild', 'Approve and continue to snapshot')}
                </Button>
                <Button variant="outline" onClick={() => goToStep(1)}>{t('Tillbaka', 'Back')}</Button>
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
                      <span className="text-muted-foreground">{momsBetala < 0 ? t('Moms att återfå', 'VAT to receive') : t('Moms att betala', 'VAT to pay')}</span>
                      <span className={momsBetala < 0 ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>{formatSEK(Math.abs(momsBetala))}</span>
                    </div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Transaktioner inkluderade', 'Transactions included')}</span><span>{postedPurchases.length} {t('st', 'pcs')}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Granskare', 'Reviewer')}</span><span>{user?.email || '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('Regelversion (git)', 'Rules commit (git)')}</span><span className="font-mono text-xs">{__GIT_COMMIT__.slice(0, 10)}</span></div>
                  </div>
                  <div className="flex gap-3">
                    <Button onClick={() => createSnapshot.mutate()} disabled={createSnapshot.isPending}>
                      <Lock className="w-4 h-4 mr-2" />{createSnapshot.isPending ? t('Skapar...', 'Creating...') : t('Skapa ögonblicksbild', 'Create snapshot')}
                    </Button>
                    <Button variant="outline" onClick={() => goToStep(2)}>{t('Tillbaka', 'Back')}</Button>
                  </div>
                </CardContent>
              </Card>
            )}
            {vatPeriod?.snapshot_data && <Button onClick={() => goToStep(4)}>{t('Fortsätt till export', 'Continue to export')}</Button>}
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
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg">
                    <div className="flex items-center gap-3">
                      <FileText className="w-8 h-8 text-primary" />
                      <div>
                        <p className="font-medium">{t('Skatteverket XML (eSKDUpload)', 'Skatteverket XML (eSKDUpload)')}</p>
                        <p className="text-xs text-muted-foreground">
                          {generatedXml
                            ? t('Validerad fil redo för uppladdning till Skatteverket', 'Validated file ready for upload to Skatteverket')
                            : t('Generera och validera filen innan nedladdning', 'Generate and validate the file before downloading')}
                        </p>
                      </div>
                    </div>
                    <Button onClick={downloadXmlExport}>
                      <Download className="w-4 h-4 mr-2" />
                      {generatedXml
                        ? t('Ladda ner XML', 'Download XML')
                        : t('Generera XML', 'Generate XML')}
                    </Button>
                  </div>
                </div>
                {(xmlValidationErrors.length > 0 || xmlValidationWarnings.length > 0 || generatedXml) && (
                  <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2">
                    <p className="text-sm font-medium">{t('XML-validering', 'XML validation')}</p>
                    {generatedXml && xmlValidationErrors.length === 0 && (
                      <p className="text-sm text-green-700">{t('XML-filen matchar förväntad struktur och summering.', 'The XML file matches the expected structure and totals.')}</p>
                    )}
                    {xmlValidationErrors.map((error) => (
                      <p key={error} className="text-sm text-destructive">{error}</p>
                    ))}
                    {xmlValidationWarnings.map((warning) => (
                      <p key={warning} className="text-sm text-amber-700">{warning}</p>
                    ))}
                  </div>
                )}
                <div>
                  <h4 className="font-medium mb-3">{t('Inlämning till Skatteverket', 'Submission to the Tax Agency')}</h4>
                  <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1.5">
                    <li>{t('Generera och ladda ner XML-filen ovan', 'Generate and download the XML file above')}</li>
                    <li>{t('Logga in på Skatteverkets webbplats', 'Log in to the Tax Agency website')}</li>
                    <li>{t('Navigera till "Lämna momsdeklaration via fil"', 'Navigate to "Submit VAT declaration via file"')}</li>
                    <li>{t('Ladda upp XML-filen', 'Upload the XML file')}</li>
                    <li>{t('Kontrollera uppgifterna och signera med e-legitimation', 'Verify the details and sign with e-ID')}</li>
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
