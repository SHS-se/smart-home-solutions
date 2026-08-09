import React, { useMemo, useState } from 'react';
import {
  Activity,
  BadgeDollarSign,
  CalendarDays,
  Coins,
  Gauge,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import {
  Area,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import EnergyHistoryEventForm from '@/components/portal/energy-history/EnergyHistoryEventForm';
import EnergyPriceInflationCard from '@/components/portal/energy-history/EnergyPriceInflationCard';
import EnergySavingsCard from '@/components/portal/energy-history/EnergySavingsCard';
import EnergySourceInsights from '@/components/portal/energy-history/EnergySourceInsights';
import type { EnergyBillingChange } from '@/lib/energy-billing-changes';
import type { EnergyBillingMonth } from '@/lib/energy-billing-series';
import {
  divergentTariffComparisons,
  type EnergyTariffInvoiceComparison,
} from '@/lib/energy-tariff-series';
import type {
  EnergyHistoryNoteRecord,
  TimelineNoteValues,
} from '@/lib/energy-temperature-storage';
import type { ResolvedUsageReading } from '@/lib/energy-usage-resolution';
import {
  MAX_UPLOAD_SUGGESTIONS,
  estimatedMonthKeys,
  suggestedEnergyUploads,
} from '@/lib/energy-upload-suggestions';
import {
  estimateAnnualEnergyHistory,
  type AnnualizedMetric,
} from '@/lib/energy-estimation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface EnergyHistoryOverviewProps {
  series: EnergyBillingMonth[];
  changes: EnergyBillingChange[];
  notes: EnergyHistoryNoteRecord[];
  usageReadings: ResolvedUsageReading[];
  notesError?: unknown;
  usageError?: unknown;
  usageIsLoading?: boolean;
  moveInDate?: string | null;
  isSample?: boolean;
  periodStartMonth: string | null;
  periodEndMonth: string | null;
  onUploadClick?: () => void;
  onCreateNote: (values: TimelineNoteValues) => Promise<void>;
  tariffInvoiceComparisons?: EnergyTariffInvoiceComparison[];
}

interface TooltipPayloadItem {
  color?: string;
  dataKey?: string | number;
  fill?: string;
  name?: string | number;
  value?: number | string;
}

interface HistoryTooltipProps {
  active?: boolean;
  label?: string;
  payload?: TooltipPayloadItem[];
  changes: EnergyBillingChange[];
  notes: EnergyHistoryNoteRecord[];
  formatMonth: (monthKey: string) => string;
  formatDate: (date: string) => string;
  formatValue: (item: TooltipPayloadItem) => string;
  language: string;
  estimatedMonths: Set<string>;
}

const YEAR_COLORS = [
  '#2563eb',
  '#dc2626',
  '#d97706',
  '#16a34a',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4f46e5',
];

const COST_COLORS = {
  electricityEnergySek: '#f59e0b',
  electricityFeesSek: '#f97316',
  gridFixedSek: '#14b8a6',
  gridTransferSek: '#22c55e',
  gridPeakSek: '#ef4444',
  gridVatSek: '#f43f5e',
  energyTaxSek: '#60a5fa',
  exportNetSek: '#8b5cf6',
};

/**
 * A month carried by an estimate reads as a hollow marker rather than a filled
 * one. It is the difference between "we know" and "we worked it out", visible
 * at a glance and impossible to nag with.
 */
function CostDot({
  cx,
  cy,
  monthKey,
  estimatedMonths,
}: {
  cx?: number;
  cy?: number;
  monthKey?: string;
  estimatedMonths: Set<string>;
}) {
  if (cx === undefined || cy === undefined) return null;
  const estimated = monthKey !== undefined && estimatedMonths.has(monthKey);
  return (
    <circle
      cx={cx}
      cy={cy}
      r={estimated ? 3.5 : 3}
      fill={estimated ? 'transparent' : '#fff'}
      stroke="#e11d48"
      strokeWidth={2}
      strokeDasharray={estimated ? '2 1.5' : undefined}
    />
  );
}

function HistoryTooltip({
  active,
  label,
  payload,
  changes,
  notes,
  formatMonth,
  formatDate,
  formatValue,
  language,
  estimatedMonths,
}: HistoryTooltipProps) {
  if (!active || !label || !payload?.length) return null;
  const monthChanges = changes.filter((change) => change.monthKey === label);
  const monthNotes = notes.filter((note) => note.note_date.slice(0, 7) === label);

  return (
    <div className="max-w-sm rounded-xl border border-border/80 bg-background/95 p-3 shadow-xl backdrop-blur">
      <p className="mb-2 font-medium capitalize">{formatMonth(label)}</p>
      <div className="space-y-1.5">
        {payload
          .filter((item) => item.value !== null && item.value !== undefined)
          .map((item) => (
            <div
              key={String(item.dataKey ?? item.name)}
              className="flex items-center justify-between gap-5 text-xs"
            >
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color ?? item.fill }}
                />
                <span className="truncate">{item.name}</span>
              </span>
              <span className="font-medium tabular-nums">{formatValue(item)}</span>
            </div>
          ))}
      </div>
      {estimatedMonths.has(label) && (
        <p className="mt-2 text-xs text-muted-foreground">
          {language === 'sv'
            ? 'Delvis beräknad från Home Assistant — ingen kvittofil täcker hela månaden.'
            : 'Partly calculated from Home Assistant — no receipt covers the whole month.'}
        </p>
      )}
      {monthChanges.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border pt-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-violet-700 dark:text-violet-300">
            <Sparkles className="h-3.5 w-3.5" />
            {language === 'sv' ? 'Ändrade villkor' : 'Changed terms'}
          </p>
          {monthChanges.map((change) => (
            <div key={change.id} className="text-xs">
              <p className="font-medium">
                {language === 'sv' ? change.titleSv : change.titleEn}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {language === 'sv' ? change.detailSv : change.detailEn}
              </p>
            </div>
          ))}
        </div>
      )}
      {monthNotes.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border pt-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-teal-700 dark:text-teal-300">
            <span aria-hidden="true" className="text-[10px]">◆</span>
            {language === 'sv' ? 'Registrerade händelser' : 'Recorded events'}
          </p>
          {monthNotes.map((note) => (
            <div key={note.id} className="text-xs">
              <p className="text-muted-foreground">{formatDate(note.note_date)}</p>
              <p className="mt-0.5 whitespace-pre-wrap font-medium">{note.event_text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface AnnualMetricCardProps {
  label: string;
  metric: AnnualizedMetric;
  value: string;
  detail?: React.ReactNode;
  icon: React.ReactNode;
  accentClass: string;
  estimatedLabel: string;
  actualLabel: string;
  evidenceLabel: string;
}

function AnnualMetricCard({
  label,
  metric,
  value,
  detail,
  icon,
  accentClass,
  estimatedLabel,
  actualLabel,
  evidenceLabel,
}: AnnualMetricCardProps) {
  return (
    <Card className="group relative overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-muted/25 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg">
      <div className={`absolute inset-x-0 top-0 h-1 ${accentClass}`} />
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-muted-foreground">{label}</p>
              <Badge
                variant={metric.estimated ? 'secondary' : 'outline'}
                className={metric.estimated
                  ? 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200'
                  : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'}
              >
                {metric.estimated ? estimatedLabel : actualLabel}
              </Badge>
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
            {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
            <p className="mt-2 text-[11px] text-muted-foreground">
              {evidenceLabel}
            </p>
          </div>
          <div className={`rounded-xl p-2.5 text-white shadow-sm ${accentClass}`}>
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const EnergyHistoryOverview: React.FC<EnergyHistoryOverviewProps> = ({
  series,
  changes,
  notes,
  usageReadings,
  notesError,
  usageError,
  usageIsLoading = false,
  moveInDate = null,
  isSample = false,
  periodStartMonth,
  periodEndMonth,
  onUploadClick,
  onCreateNote,
  tariffInvoiceComparisons = [],
}) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const [focusedYear, setFocusedYear] = useState<number | null>(null);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }), [locale]);
  const moneyFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }), [locale]);
  const percentFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }), [locale]);
  const visibleTariffInvoiceComparisons = useMemo(
    () => tariffInvoiceComparisons.filter((comparison) => (
      (!periodStartMonth || comparison.monthKey >= periodStartMonth)
      && (!periodEndMonth || comparison.monthKey <= periodEndMonth)
    )),
    [periodEndMonth, periodStartMonth, tariffInvoiceComparisons],
  );
  const divergentComparisons = useMemo(
    () => divergentTariffComparisons(visibleTariffInvoiceComparisons),
    [visibleTariffInvoiceComparisons],
  );
  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  }), [locale]);
  const fullMonthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }), [locale]);
  const monthOnlyFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'short',
    timeZone: 'UTC',
  }), [locale]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }), [locale]);

  const annual = useMemo(() => estimateAnnualEnergyHistory(series), [series]);
  const filteredSeries = useMemo(() => series.filter((month) => (
    (!periodStartMonth || month.monthKey >= periodStartMonth)
    && (!periodEndMonth || month.monthKey <= periodEndMonth)
  )), [periodEndMonth, periodStartMonth, series]);
  const filteredUsageReadings = useMemo(() => usageReadings.filter((reading) => {
    const monthKey = reading.reading_date.slice(0, 7);
    return (!periodStartMonth || monthKey >= periodStartMonth)
      && (!periodEndMonth || monthKey <= periodEndMonth);
  }), [periodEndMonth, periodStartMonth, usageReadings]);
  const firstVisibleMonth = filteredSeries.at(0)?.monthKey ?? null;
  const lastVisibleMonth = filteredSeries.at(-1)?.monthKey ?? null;
  const visibleChanges = useMemo(() => changes.filter((change) => (
    (!periodStartMonth || change.monthKey >= periodStartMonth)
    && (!periodEndMonth || change.monthKey <= periodEndMonth)
  )), [changes, periodEndMonth, periodStartMonth]);
  const visibleNotes = useMemo(() => notes.filter((note) => {
    const monthKey = note.note_date.slice(0, 7);
    return (!periodStartMonth || monthKey >= periodStartMonth)
      && (!periodEndMonth || monthKey <= periodEndMonth);
  }), [notes, periodEndMonth, periodStartMonth]);
  const changeAnnotationMonths = useMemo(
    () => Array.from(new Set(visibleChanges.map((change) => change.monthKey))),
    [visibleChanges],
  );
  const eventAnnotationMonths = useMemo(
    () => Array.from(new Set(visibleNotes.map((note) => note.note_date.slice(0, 7)))),
    [visibleNotes],
  );
  const years = useMemo(
    () => Array.from(new Set(filteredSeries.map((month) => month.year))).sort((a, b) => a - b),
    [filteredSeries],
  );
  const activeYear = focusedYear !== null && years.includes(focusedYear)
    ? focusedYear
    : years.at(-1) ?? null;
  const consumptionByCalendarMonth = useMemo(() => Array.from({ length: 12 }, (_, index) => {
    const row: Record<string, string | number | boolean | null> = {
      month: monthOnlyFormatter.format(new Date(Date.UTC(2024, index, 1))),
    };
    for (const year of years) {
      const value = filteredSeries.find(
        (month) => month.year === year && month.month === index + 1,
      );
      row[String(year)] = value?.consumptionKwh ?? null;
      const chosenCoverage = value?.consumptionSource === 'grid'
        ? value.gridCoverage
        : value?.consumptionSource === 'electricity'
          ? value.electricityCoverage
          : 'missing';
      row[`${year}Complete`] = chosenCoverage === 'complete';
    }
    return row;
  }), [filteredSeries, monthOnlyFormatter, years]);
  // Sample data is a placeholder for a customer with nothing uploaded yet.
  // Marking its months as estimated, or asking for receipts to fill them,
  // would be advice about numbers that are not theirs.
  const estimatedMonths = useMemo(
    () => (isSample ? new Set<string>() : estimatedMonthKeys(series, moveInDate)),
    [series, moveInDate, isSample],
  );
  const uploadSuggestions = useMemo(
    () => (isSample ? [] : suggestedEnergyUploads(series, moveInDate))
      .filter((suggestion) => (
        (!periodStartMonth || suggestion.monthKey >= periodStartMonth)
        && (!periodEndMonth || suggestion.monthKey <= periodEndMonth)
      ))
      .slice(0, MAX_UPLOAD_SUGGESTIONS),
    [series, moveInDate, periodStartMonth, periodEndMonth, isSample],
  );

  const formatMonthKey = (monthKey: string) => monthFormatter.format(
    new Date(`${monthKey}-01T00:00:00Z`),
  );
  const formatFullMonthKey = (monthKey: string) => fullMonthFormatter.format(
    new Date(`${monthKey}-01T00:00:00Z`),
  );
  const formatDate = (date: string) => dateFormatter.format(
    new Date(`${date}T00:00:00Z`),
  );
  const metricEvidence = (metric: AnnualizedMetric) => (
    isSample
      ? t('Exempeldata – ersätts med dina fakturor efter import', 'Sample data – replaced by your invoices after import')
      : metric.estimated
      ? t(
          `Baserad på ${metric.observedMonths} månaders underlag`,
          `Based on ${metric.observedMonths} months of source data`,
        )
      : t('Senaste 12 kompletta månaderna', 'Latest 12 complete months')
  );
  const formatMetric = (
    metric: AnnualizedMetric,
    formatter: Intl.NumberFormat,
    suffix = '',
  ) => (
    metric.value === null ? '-' : `${formatter.format(metric.value)}${suffix}`
  );
  const costSeriesKeys = new Set(Object.keys(COST_COLORS));
  const formatTooltipValue = (item: TooltipPayloadItem) => {
    const numeric = typeof item.value === 'number' ? item.value : Number(item.value);
    if (!Number.isFinite(numeric)) return '-';
    return costSeriesKeys.has(String(item.dataKey)) || item.dataKey === 'totalCostSek'
      ? moneyFormatter.format(numeric)
      : `${numberFormatter.format(numeric)} kWh`;
  };
  const periodLabel = firstVisibleMonth && lastVisibleMonth
    ? `${formatFullMonthKey(firstVisibleMonth)} – ${formatFullMonthKey(lastVisibleMonth)}`
    : '';
  const renderChangeLines = (yAxisId?: string | number) => changeAnnotationMonths.map((monthKey) => (
    <ReferenceLine
      key={`change-${monthKey}`}
      x={monthKey}
      yAxisId={yAxisId}
      stroke="#7c3aed"
      strokeDasharray="4 4"
      strokeOpacity={0.75}
      label={{
        value: '◆',
        position: 'top',
        fill: '#7c3aed',
        fontSize: 10,
      }}
    />
  ));
  const renderEventLines = (yAxisId?: string | number) => eventAnnotationMonths.map((monthKey) => (
    <ReferenceLine
      key={`event-${monthKey}`}
      x={monthKey}
      yAxisId={yAxisId}
      stroke="#0f766e"
      strokeDasharray="4 4"
      strokeOpacity={0.75}
      label={{
        value: '◆',
        position: 'top',
        fill: '#0f766e',
        fontSize: 10,
      }}
    />
  ));

  if (series.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex min-h-80 flex-col items-center justify-center px-6 text-center">
          <Activity className="mb-4 h-10 w-10 text-muted-foreground" />
          <h2 className="text-lg font-medium">{t('Ingen energihistorik ännu', 'No energy history yet')}</h2>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            {t(
              'Ladda upp elnäts- och elhandelsfakturor under Data i sidomenyn. Diagrammen byggs automatiskt när det finns importerad data.',
              'Upload grid and electricity provider invoices under Data in the sidebar. Charts are built automatically once data has been imported.',
            )}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Tabs defaultValue="summary" className="space-y-6">
      <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 lg:max-w-2xl lg:grid-cols-4">
        <TabsTrigger value="summary">{t('Sammanfattning', 'Summary')}</TabsTrigger>
        <TabsTrigger value="flows">{t('Energiflöden', 'Energy flow')}</TabsTrigger>
        <TabsTrigger value="costs">{t('Kostnader', 'Costs')}</TabsTrigger>
        <TabsTrigger value="comparisons">{t('Jämförelser', 'Comparisons')}</TabsTrigger>
      </TabsList>

      {isSample && (
        <Alert className="border-primary/30 bg-gradient-to-r from-primary/10 via-background to-violet-500/10 shadow-sm">
          <Sparkles className="h-4 w-4 text-primary" />
          <AlertTitle>{t('Så här kan din energihistorik se ut', 'This is what your energy history can look like')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {t(
                'Fakturadiagrammen visar exempeldata. Ladda upp dina energifiler i den gemensamma rutan; fakturor ersätter exemplen med egna kostnader, nätuttag och villkorsändringar.',
                'The invoice charts show sample data. Upload your energy files in the shared box; invoices replace the samples with your own costs, grid import, and term changes.',
              )}
            </span>
            {onUploadClick && (
              <Button type="button" size="sm" onClick={onUploadClick} className="shrink-0">
                {t('Ladda upp energidata', 'Upload energy data')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <section className="space-y-3" aria-labelledby="energy-history-overview-heading">
        <div className="flex flex-wrap items-end justify-between gap-2 px-1">
          <div>
            <h2 id="energy-history-overview-heading" className="text-sm font-medium">
              {t('Överblick för den visade perioden', 'At a glance for the displayed period')}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(
                'Samma nyckeltal ligger kvar när du växlar vy nedan.',
                'These headline figures stay visible when you switch views below.',
              )}
            </p>
          </div>
          {periodLabel && <Badge variant="outline" className="capitalize">{periodLabel}</Badge>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AnnualMetricCard
          label={t('Årligt nätuttag', 'Annual grid import')}
          metric={annual.consumptionKwh}
          value={formatMetric(annual.consumptionKwh, numberFormatter, ' kWh')}
          icon={<Gauge className="h-5 w-5" />}
          accentClass="bg-gradient-to-r from-blue-600 to-cyan-500"
          estimatedLabel={t('Estimerad', 'Estimated')}
          actualLabel={isSample ? t('Exempel', 'Sample') : t('Faktisk', 'Actual')}
          evidenceLabel={metricEvidence(annual.consumptionKwh)}
        />
        <AnnualMetricCard
          label={t('Årlig export', 'Annual export')}
          metric={annual.exportedKwh}
          value={formatMetric(annual.exportedKwh, numberFormatter, ' kWh')}
          icon={<Activity className="h-5 w-5" />}
          accentClass="bg-gradient-to-r from-violet-600 to-fuchsia-500"
          estimatedLabel={t('Estimerad', 'Estimated')}
          actualLabel={isSample ? t('Exempel', 'Sample') : t('Faktisk', 'Actual')}
          evidenceLabel={metricEvidence(annual.exportedKwh)}
        />
        <AnnualMetricCard
          label={t('Årlig totalkostnad', 'Annual total cost')}
          metric={annual.totalCostSek}
          value={formatMetric(annual.totalCostSek, moneyFormatter)}
          detail={(
            <>
              {t('Elnät', 'Grid')} {formatMetric(annual.gridCostSek, moneyFormatter)}
              {' · '}
              {t('Elhandel', 'Electricity')} {formatMetric(annual.electricityCostSek, moneyFormatter)}
            </>
          )}
          icon={<Coins className="h-5 w-5" />}
          accentClass="bg-gradient-to-r from-amber-500 to-orange-500"
          estimatedLabel={t('Estimerad', 'Estimated')}
          actualLabel={isSample ? t('Exempel', 'Sample') : t('Faktisk', 'Actual')}
          evidenceLabel={metricEvidence(annual.totalCostSek)}
        />
        <AnnualMetricCard
          label={t('Årlig kostnad per kWh', 'Annual cost per kWh')}
          metric={annual.costPerKwh}
          value={formatMetric(
            annual.costPerKwh,
            numberFormatter,
            ` ${t('kr/kWh', 'SEK/kWh')}`,
          )}
          icon={<CalendarDays className="h-5 w-5" />}
          accentClass="bg-gradient-to-r from-emerald-600 to-teal-500"
          estimatedLabel={t('Estimerad', 'Estimated')}
          actualLabel={isSample ? t('Exempel', 'Sample') : t('Faktisk', 'Actual')}
          evidenceLabel={metricEvidence(annual.costPerKwh)}
        />
        </div>
      </section>

        <TabsContent value="summary" className="space-y-5">
          <EnergySavingsCard
            months={filteredSeries}
            readings={filteredUsageReadings}
            periodLabel={periodLabel}
            isSample={isSample}
            onUploadClick={onUploadClick}
          />
          <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-blue-500/5 to-violet-500/5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">
              {t('Nätuttag och total kostnad per månad', 'Monthly grid import and total cost')}
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              {visibleChanges.length > 0 && (
                <Badge variant="outline" className="border-violet-300 text-violet-700 dark:border-violet-800 dark:text-violet-300">
                  ◆ {visibleChanges.length} {t('villkorsändringar', 'term changes')}
                </Badge>
              )}
              {visibleNotes.length > 0 && (
                <Badge variant="outline" className="border-teal-300 text-teal-700 dark:border-teal-800 dark:text-teal-300">
                  ◆ {visibleNotes.length} {t('händelser', 'events')}
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <ResponsiveContainer width="100%" height={390}>
            <ComposedChart data={filteredSeries} margin={{ top: 16, right: 8, bottom: 24, left: 8 }}>
              <defs>
                <linearGradient id="energyHistoryConsumption" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2563eb" stopOpacity={0.72} />
                  <stop offset="95%" stopColor="#2563eb" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
              <XAxis
                dataKey="monthKey"
                minTickGap={24}
                tickFormatter={formatMonthKey}
                angle={filteredSeries.length <= 18 ? -25 : 0}
                textAnchor={filteredSeries.length <= 18 ? 'end' : 'middle'}
                height={filteredSeries.length <= 18 ? 62 : 32}
                className="text-xs"
              />
              <YAxis
                yAxisId="energy"
                tickFormatter={(value) => numberFormatter.format(value)}
                label={{ value: 'kWh', angle: -90, position: 'insideLeft' }}
                className="text-xs"
              />
              <YAxis
                yAxisId="cost"
                orientation="right"
                tickFormatter={(value) => numberFormatter.format(value)}
                label={{ value: 'SEK', angle: 90, position: 'insideRight' }}
                className="text-xs"
              />
              <Tooltip
                content={(
                  <HistoryTooltip
                    changes={visibleChanges}
                    notes={visibleNotes}
                    formatMonth={formatMonthKey}
                    formatDate={formatDate}
                    formatValue={formatTooltipValue}
                    language={language}
                    estimatedMonths={estimatedMonths}
                  />
                )}
              />
              <Legend />
              {renderChangeLines('energy')}
              {renderEventLines('energy')}
              <Area
                yAxisId="energy"
                dataKey="consumptionKwh"
                name={t('Nätuttag', 'Grid import')}
                type="monotone"
                connectNulls={false}
                stroke="#2563eb"
                strokeWidth={2.5}
                fill="url(#energyHistoryConsumption)"
                activeDot={{ r: 5, strokeWidth: 2 }}
                animationDuration={900}
              />
              <Line
                yAxisId="cost"
                dataKey="totalCostSek"
                name={t('Totalkostnad', 'Total cost')}
                type="monotone"
                connectNulls={false}
                stroke="#e11d48"
                strokeWidth={3}
                dot={(props) => (
                  <CostDot
                    key={`cost-dot-${props.payload?.monthKey ?? props.index}`}
                    cx={props.cx}
                    cy={props.cy}
                    monthKey={props.payload?.monthKey}
                    estimatedMonths={estimatedMonths}
                  />
                )}
                activeDot={{ r: 5 }}
                animationDuration={1050}
              />
              {filteredSeries.length > 18 && (
                <Brush
                  dataKey="monthKey"
                  height={26}
                  stroke="#7c3aed"
                  tickFormatter={formatMonthKey}
                  travellerWidth={8}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
          {uploadSuggestions.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {t(
                'Ihåliga punkter är månader utan komplett kvitto.',
                'Hollow markers are months without a complete receipt.',
              )}
              {' '}
              {uploadSuggestions.length === 1
                ? t('Ett kvitto skulle skärpa bilden:', 'One receipt would sharpen this:')
                : t('Kvitton som skulle skärpa bilden:', 'Receipts that would sharpen this:')}
              {' '}
              {uploadSuggestions.map((suggestion, index) => (
                <React.Fragment key={`${suggestion.monthKey}-${suggestion.kind}`}>
                  {index > 0 && ', '}
                  <span className="text-foreground">
                    {suggestion.kind === 'grid' ? t('elnät', 'grid') : t('elhandel', 'electricity')}
                    {' '}
                    {formatMonthKey(suggestion.monthKey)}
                  </span>
                </React.Fragment>
              ))}
              {'. '}
              <button
                type="button"
                onClick={onUploadClick}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t('Ladda upp', 'Upload')}
              </button>
            </p>
          )}
        </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="flows" className="space-y-5">
          <EnergySourceInsights
            readings={filteredUsageReadings}
            isLoading={usageIsLoading}
            error={usageError}
            onUploadClick={onUploadClick}
          />
        </TabsContent>

        <TabsContent value="costs" className="space-y-5">
          <EnergyPriceInflationCard months={filteredSeries} />

          {visibleTariffInvoiceComparisons.length > 0 && (
          <Card className="overflow-hidden border-border/70 shadow-sm">
          <CardHeader className="border-b border-border/60 bg-gradient-to-r from-emerald-500/5 to-blue-500/5">
            <CardTitle className="text-base">
              {t('Ellevio-faktura jämfört med Home Assistant', 'Ellevio invoice compared with Home Assistant')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-5">
            <p className="text-sm text-muted-foreground">
              {t(
                'Fakturan är det auktoritativa beloppet i kostnadsdiagrammen. Home Assistant-beräkningen sparas separat som en indikativ jämförelse och skrivs inte över.',
                'The invoice is the authoritative amount in cost charts. The Home Assistant calculation is retained separately as an indicative comparison and is not overwritten.',
              )}
            </p>
            {divergentComparisons.length > 0 && (
              <Alert variant="destructive">
                <TriangleAlert className="h-4 w-4" />
                <AlertTitle>
                  {t(
                    'Home Assistant-beräkningen avviker från fakturan',
                    'The Home Assistant calculation diverges from the invoice',
                  )}
                </AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    {t(
                      'Avvikelsen överstiger 5 % och 100 kr under följande månader. Den vanligaste orsaken är att mätdata kommer från växelriktaren i stället för elmätaren.',
                      'The difference exceeds both 5% and 100 kr in the months below. The most common cause is meter data coming from the inverter rather than the electricity meter.',
                    )}
                  </p>
                  <ul className="list-inside list-disc">
                    {divergentComparisons.slice(-6).map((comparison) => (
                      <li key={comparison.monthKey}>
                        {formatMonthKey(comparison.monthKey)}
                        {': '}
                        {moneyFormatter.format(comparison.differenceSek)}
                        {' ('}
                        {percentFormatter.format(comparison.differenceRatio)}
                        {')'}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={visibleTariffInvoiceComparisons} margin={{ top: 12, right: 8, bottom: 20, left: 8 }}>
                <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
                <XAxis dataKey="monthKey" tickFormatter={formatMonthKey} minTickGap={20} className="text-xs" />
                <YAxis tickFormatter={(value) => numberFormatter.format(value)} className="text-xs" />
                <Tooltip formatter={(value: number) => moneyFormatter.format(value)} labelFormatter={formatMonthKey} />
                <Legend />
                <Bar dataKey="invoiceAmountSek" name={t('Ellevio-faktura (auktoritativ)', 'Ellevio invoice (authoritative)')} fill="#059669" />
                <Bar dataKey="haEstimateAmountSek" name={t('Home Assistant (indikativ)', 'Home Assistant (indicative)')} fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
          </Card>
          )}

          <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-amber-500/5 to-violet-500/5">
          <CardTitle className="text-base">
            {t('Kostnadsfördelning per månad', 'Monthly cost breakdown')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-5">
          <ResponsiveContainer width="100%" height={420}>
            <BarChart
              data={filteredSeries}
              stackOffset="sign"
              margin={{ top: 16, right: 8, bottom: 28, left: 8 }}
            >
              <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
              <XAxis
                dataKey="monthKey"
                minTickGap={24}
                tickFormatter={formatMonthKey}
                angle={filteredSeries.length <= 18 ? -25 : 0}
                textAnchor={filteredSeries.length <= 18 ? 'end' : 'middle'}
                height={filteredSeries.length <= 18 ? 62 : 32}
                className="text-xs"
              />
              <YAxis
                tickFormatter={(value) => numberFormatter.format(value)}
                className="text-xs"
              />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                content={(
                  <HistoryTooltip
                    changes={visibleChanges}
                    notes={visibleNotes}
                    formatMonth={formatMonthKey}
                    formatDate={formatDate}
                    formatValue={formatTooltipValue}
                    language={language}
                    estimatedMonths={estimatedMonths}
                  />
                )}
              />
              <Legend />
              <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeOpacity={0.65} />
              {renderChangeLines()}
              {renderEventLines()}
              <Bar dataKey="electricityEnergySek" stackId="cost" name={t('Elenergi', 'Electricity energy')} fill={COST_COLORS.electricityEnergySek} animationDuration={750} />
              <Bar dataKey="electricityFeesSek" stackId="cost" name={t('Elhandelsavgifter', 'Electricity fees')} fill={COST_COLORS.electricityFeesSek} animationDuration={825} />
              <Bar dataKey="gridFixedSek" stackId="cost" name={t('Fast nätavgift', 'Grid fixed fee')} fill={COST_COLORS.gridFixedSek} animationDuration={900} />
              <Bar dataKey="gridTransferSek" stackId="cost" name={t('Överföringsavgift', 'Transfer fee')} fill={COST_COLORS.gridTransferSek} animationDuration={975} />
              <Bar dataKey="gridPeakSek" stackId="cost" name={t('Effektavgift', 'Peak-demand fee')} fill={COST_COLORS.gridPeakSek} animationDuration={1050} />
              <Bar dataKey="gridVatSek" stackId="cost" name={t('Moms på nätavgifter', 'VAT on grid charges')} fill={COST_COLORS.gridVatSek} animationDuration={1085} />
              <Bar dataKey="energyTaxSek" stackId="cost" name={t('Energiskatt', 'Energy tax')} fill={COST_COLORS.energyTaxSek} animationDuration={1125} />
              <Bar dataKey="exportNetSek" stackId="cost" name={t('Export netto', 'Net export')} fill={COST_COLORS.exportNetSek} animationDuration={1200} />
              {filteredSeries.length > 18 && (
                <Brush
                  dataKey="monthKey"
                  height={26}
                  stroke="#7c3aed"
                  tickFormatter={formatMonthKey}
                  travellerWidth={8}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              'Exportersättning visas med sitt verkliga tecken under nollinjen. Den minskar alltså stapelns nettokostnad.',
              'Export credits retain their true sign below the zero line, reducing the bar’s net cost.',
            )}
          </p>
        </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="comparisons" className="space-y-5">
          <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-emerald-500/5 to-blue-500/5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">
                {t('Nätuttag per månad och år', 'Grid import by month and year')}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  'Alltid 12 månadsgrupper. Välj ett år för att lyfta fram det och tona ned resten.',
                  'Always 12 month groups. Select a year to highlight it and dim the rest.',
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-1">
              {years.map((year) => (
                <Button
                  key={year}
                  type="button"
                  size="sm"
                  variant={activeYear === year ? 'default' : 'outline'}
                  className="h-8"
                  onClick={() => setFocusedYear(year)}
                >
                  {year}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <ResponsiveContainer width="100%" height={410}>
            <BarChart data={consumptionByCalendarMonth} margin={{ top: 12, right: 8, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
              <XAxis dataKey="month" className="text-xs" />
              <YAxis
                tickFormatter={(value) => numberFormatter.format(value)}
                label={{ value: 'kWh', angle: -90, position: 'insideLeft' }}
                className="text-xs"
              />
              <Tooltip
                formatter={(value: number, name: string) => [
                  `${numberFormatter.format(value)} kWh`,
                  name,
                ]}
                cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
              />
              <Legend />
              {years.map((year, yearIndex) => (
                <Bar
                  key={year}
                  dataKey={String(year)}
                  name={String(year)}
                  fill={YEAR_COLORS[yearIndex % YEAR_COLORS.length]}
                  radius={[3, 3, 0, 0]}
                  animationDuration={800 + yearIndex * 90}
                >
                  {consumptionByCalendarMonth.map((month) => {
                    const isComplete = Boolean(month[`${year}Complete`]);
                    const isFocused = activeYear === year;
                    return (
                      <Cell
                        key={`${year}-${month.month}`}
                        fill={YEAR_COLORS[yearIndex % YEAR_COLORS.length]}
                        fillOpacity={(isFocused ? 0.95 : 0.18) * (isComplete ? 1 : 0.5)}
                      />
                    );
                  })}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
          </Card>
          <EnergyHistoryEventForm
            loadError={notesError}
            onCreate={onCreateNote}
          />
          <Card className="overflow-hidden border-violet-200/80 bg-gradient-to-br from-background to-violet-500/5 shadow-sm dark:border-violet-900/70">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="h-4 w-4 text-violet-600" />
              {t('Förändrade villkor', 'Changed terms')}
            </CardTitle>
            <Badge variant="secondary">
              {visibleChanges.length} {t('under perioden', 'in this period')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {visibleChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(
                'Inga byten eller bestående pris- och modelländringar upptäcktes i den valda perioden.',
                'No provider switches or lasting price and model changes were detected in the selected period.',
              )}
            </p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {visibleChanges.map((change) => {
                const Icon = change.type === 'provider'
                  ? RefreshCw
                  : change.type === 'price'
                    ? BadgeDollarSign
                    : Sparkles;
                return (
                  <div
                    key={change.id}
                    className="group flex gap-3 rounded-xl border border-border/70 bg-background/80 p-4 transition-colors hover:border-violet-300 hover:bg-violet-50/40 dark:hover:border-violet-800 dark:hover:bg-violet-950/20"
                  >
                    <div className="mt-0.5 rounded-lg bg-violet-100 p-2 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs capitalize text-muted-foreground">
                        {dateFormatter.format(new Date(`${change.date}T00:00:00Z`))}
                      </p>
                      <p className="mt-0.5 text-sm font-medium">
                        {language === 'sv' ? change.titleSv : change.titleEn}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {language === 'sv' ? change.detailSv : change.detailEn}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
          </Card>
        </TabsContent>
    </Tabs>
  );
};

export default EnergyHistoryOverview;
