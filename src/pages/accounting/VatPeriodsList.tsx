import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { QUARTER_LABELS, QUARTER_MONTHS } from '@/lib/accounting-utils';
import { Calendar, AlertCircle, CheckCircle, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const VAT_STATUS_LABELS: Record<string, Record<string, string>> = {
  sv: { open: 'Öppen', in_review: 'Granskning', approved: 'Godkänd', filed: 'Inlämnad', locked: 'Låst' },
  en: { open: 'Open', in_review: 'In review', approved: 'Approved', filed: 'Filed', locked: 'Locked' },
};

const VAT_STATUS_COLORS: Record<string, string> = {
  open: 'bg-green-100 text-green-800',
  in_review: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  filed: 'bg-green-100 text-green-800',
  locked: 'bg-primary/10 text-primary',
};

const ARCHIVED_STATUSES = new Set(['filed', 'locked']);

const VatPeriodsList: React.FC = () => {
  const { t, language } = useLanguage();
  const statusLabels = VAT_STATUS_LABELS[language] || VAT_STATUS_LABELS.sv;

  const { data: vatPeriods } = useQuery({
    queryKey: ['acc-vat-periods'],
    queryFn: async () => {
      // Ensure quarters Q1..current exist for the current year before fetching.
      await supabase.rpc('acc_ensure_current_vat_periods');
      const { data } = await supabase
        .from('acc_vat_periods')
        .select('*')
        .order('year', { ascending: false })
        .order('quarter', { ascending: false });
      return data || [];
    },
  });

  // Per-quarter purchase stats (posted vs unposted), keyed "YYYY-Q".
  const { data: purchaseStatsByQuarter } = useQuery({
    queryKey: ['acc-purchase-stats-by-quarter'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_purchases').select('document_date, status');
      const stats: Record<string, { posted: number; unposted: number }> = {};
      (data || []).forEach((p) => {
        const d = new Date(p.document_date as string);
        const key = `${d.getFullYear()}-${Math.floor(d.getMonth() / 3) + 1}`;
        if (!stats[key]) stats[key] = { posted: 0, unposted: 0 };
        if (p.status === 'posted') stats[key].posted++;
        else stats[key].unposted++;
      });
      return stats;
    },
  });

  // Number of still-open monthly accounting periods per quarter, keyed "YYYY-Q".
  const { data: openPeriodsByQuarter } = useQuery({
    queryKey: ['acc-open-periods-by-quarter'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_periods').select('year, month, status').eq('status', 'open');
      const stats: Record<string, number> = {};
      (data || []).forEach((p) => {
        const key = `${p.year}-${Math.floor(((p.month as number) - 1) / 3) + 1}`;
        stats[key] = (stats[key] || 0) + 1;
      });
      return stats;
    },
  });

  // Year selector: default to current year once data has loaded.
  const availableYears = useMemo(() => {
    const ys = new Set((vatPeriods || []).map((vp) => vp.year as number));
    return Array.from(ys).sort((a, b) => b - a);
  }, [vatPeriods]);

  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  useEffect(() => {
    if (selectedYear !== null || availableYears.length === 0) return;
    const currentYear = new Date().getFullYear();
    setSelectedYear(availableYears.includes(currentYear) ? currentYear : availableYears[0]);
  }, [availableYears, selectedYear]);

  const filteredPeriods = useMemo(
    () => (vatPeriods || []).filter((vp) => vp.year === selectedYear),
    [vatPeriods, selectedYear],
  );

  // Compute readiness + issues for a given VAT period.
  const getPeriodStats = (vp: { year: number; quarter: number; status: string }) => {
    const key = `${vp.year}-${vp.quarter}`;
    const purchases = purchaseStatsByQuarter?.[key] || { posted: 0, unposted: 0 };
    const total = purchases.posted + purchases.unposted;
    const openPeriods = openPeriodsByQuarter?.[key] || 0;

    // Filed/locked quarters are considered fully ready by definition.
    const isArchived = ARCHIVED_STATUSES.has(vp.status);
    const readiness = isArchived
      ? 100
      : total > 0
        ? Math.round((purchases.posted / total) * 100)
        : 0;

    const issues = isArchived ? 0 : purchases.unposted + (openPeriods > 0 ? 1 : 0);
    return { readiness, issues, unpostedCount: purchases.unposted, openPeriods };
  };

  // The "active" quarter drives the warning banner — earliest chronological
  // quarter that is not yet filed or locked.
  const activePeriod = useMemo(() => {
    return (vatPeriods || [])
      .filter((vp) => !ARCHIVED_STATUSES.has(vp.status))
      .sort((a, b) => (a.year as number) - (b.year as number) || (a.quarter as number) - (b.quarter as number))[0];
  }, [vatPeriods]);

  const activeStats = activePeriod ? getPeriodStats(activePeriod) : null;
  const showActiveBanner = activePeriod && activeStats && activeStats.issues > 0;

  return (
    <AccountingLayout>
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              {t('Momsperioder', 'VAT periods')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-5 h-5 text-primary cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs text-xs">
                  {t(
                    'Moms (mervärdesskatt) är en konsumtionsskatt som företag samlar in åt staten. Varje kvartal rapporterar du hur mycket moms du fått in (utgående moms) och hur mycket du betalat på inköp (ingående moms). Skillnaden redovisas till Skatteverket.',
                    'VAT (Value Added Tax) is a consumption tax that businesses collect on behalf of the government. Each quarter you report how much VAT you charged customers (output VAT) and how much you paid on purchases (input VAT). The difference is reported to the Tax Agency.'
                  )}
                </TooltipContent>
              </Tooltip>
            </h1>
            <p className="text-muted-foreground mt-1">{t('Kvartalsvis momsrapportering och inlämning', 'Quarterly VAT reporting and submission')}</p>
          </div>

          {availableYears.length > 0 && selectedYear !== null && (
            <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {showActiveBanner && activePeriod && activeStats && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-amber-800">
                {t(
                  `${QUARTER_LABELS[activePeriod.quarter]} ${activePeriod.year} kräver granskning`,
                  `${QUARTER_LABELS[activePeriod.quarter]} ${activePeriod.year} needs review`,
                )}
              </p>
              <p className="text-sm text-amber-700 mt-0.5">
                {[
                  activeStats.openPeriods > 0
                    ? t(
                        `${activeStats.openPeriods} bokföringsperiod${activeStats.openPeriods > 1 ? 'er' : ''} ej stängd${activeStats.openPeriods > 1 ? 'a' : ''}`,
                        `${activeStats.openPeriods} accounting period${activeStats.openPeriods > 1 ? 's' : ''} not closed`,
                      )
                    : null,
                  activeStats.unpostedCount > 0
                    ? t(`${activeStats.unpostedCount} inköp ej bokförda`, `${activeStats.unpostedCount} purchases not posted`)
                    : null,
                ]
                  .filter(Boolean)
                  .join('. ')}
                .{' '}
                {activePeriod.deadline && (
                  <>
                    {t('Deadline', 'Deadline')}{' '}
                    {new Date(activePeriod.deadline).toLocaleDateString(language === 'sv' ? 'sv-SE' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.
                  </>
                )}
              </p>
              {activeStats.openPeriods > 0 ? (
                <Link to="/accounting/periods">
                  <Button size="sm" variant="destructive" className="mt-2">{t('Stäng perioder', 'Close periods')}</Button>
                </Link>
              ) : (
                <Link to={`/accounting/vat-periods/q${activePeriod.quarter}-${activePeriod.year}`}>
                  <Button size="sm" variant="destructive" className="mt-2">{t('Granska nu', 'Review now')}</Button>
                </Link>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredPeriods.map((vp) => {
            const { readiness, issues } = getPeriodStats(vp);
            const periodSlug = `q${vp.quarter}-${vp.year}`;
            const isArchived = ARCHIVED_STATUSES.has(vp.status);

            return (
              <Card key={vp.id} className="border border-border">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="text-xl font-bold">{QUARTER_LABELS[vp.quarter]} {vp.year}</h3>
                      <p className="text-sm text-muted-foreground">{QUARTER_MONTHS[vp.quarter]}</p>
                    </div>
                    <Badge className={`${VAT_STATUS_COLORS[vp.status] || ''} border-0 text-xs`}>
                      {statusLabels[vp.status] || vp.status}
                    </Badge>
                  </div>

                  <div className="space-y-3">
                    {!isArchived && (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{t('Beredskap', 'Readiness')}</span>
                          <span className="font-medium">{readiness}%</span>
                        </div>
                        <Progress value={readiness} className="h-2" />

                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{t('Problem', 'Issues')}</span>
                          {issues > 0 ? (
                            <span className="text-destructive font-medium">{issues} {t('problem', 'issues')}</span>
                          ) : (
                            <span className="text-green-600 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> {t('Inga problem', 'No issues')}</span>
                          )}
                        </div>
                      </>
                    )}

                    {vp.deadline && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">{t('Deadline', 'Deadline')}</span>
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {new Date(vp.deadline).toLocaleDateString(language === 'sv' ? 'sv-SE' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="mt-5">
                    <Link to={`/accounting/vat-periods/${periodSlug}`}>
                      <Button className="w-full" variant={isArchived ? 'outline' : 'default'}>
                        {isArchived
                          ? t('Visa arkiverad deklaration', 'View archived return')
                          : t('Granska och godkänn', 'Review and approve')}
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
          <Info className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium text-primary">{t('Momsrapportering steg för steg', 'VAT reporting step by step')}</p>
            <ol className="list-decimal list-inside text-muted-foreground mt-2 space-y-1">
              <li>{t('Ladda upp och bokför alla inköp i kvartalet — valideringar sker automatiskt vid bokföring', 'Upload and post all purchases for the quarter — validations run automatically on posting')}</li>
              <li>{t('Öppna kvartalsperioden och kör datakontroll — åtgärda eventuella blockerare', 'Open the quarter period and run data checks — resolve any blockers')}</li>
              <li>{t('Granska nettomomspositionen och verifiera deklarationsrutorna', 'Review the net VAT position and verify the declaration boxes')}</li>
              <li>{t('Skapa en låst ögonblicksbild av deklarationen', 'Create a locked snapshot of the declaration')}</li>
              <li>{t('Ladda ner underlaget och fyll i Skatteverkets e-tjänst manuellt', 'Download the report and manually enter the figures in the Tax Agency e-service')}</li>
              <li>{t('Ladda upp bekräftelsen från Skatteverket för arkivering', 'Upload the Tax Agency confirmation for archiving')}</li>
            </ol>
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default VatPeriodsList;
