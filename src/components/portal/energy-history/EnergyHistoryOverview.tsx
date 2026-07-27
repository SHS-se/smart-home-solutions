import React, { useMemo, useState } from 'react';
import {
  Activity,
  BadgeDollarSign,
  CalendarDays,
  CheckCircle2,
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
import type { EnergyBillingChange } from '@/lib/energy-billing-changes';
import type { EnergyBillingMonth } from '@/lib/energy-billing-series';
import {
  estimateAnnualEnergyHistory,
  type AnnualizedMetric,
} from '@/lib/energy-estimation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface EnergyHistoryOverviewProps {
  series: EnergyBillingMonth[];
  changes: EnergyBillingChange[];
}

type PeriodPreset = '12' | '24' | '36' | 'all';

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
  formatMonth: (monthKey: string) => string;
  formatValue: (item: TooltipPayloadItem) => string;
  language: string;
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
  energyTaxSek: '#60a5fa',
  exportNetSek: '#8b5cf6',
};

const PERIOD_OPTIONS: Array<{ value: PeriodPreset; sv: string; en: string }> = [
  { value: '12', sv: '12 mån', en: '12 mo' },
  { value: '24', sv: '24 mån', en: '24 mo' },
  { value: '36', sv: '36 mån', en: '36 mo' },
  { value: 'all', sv: 'Allt', en: 'All' },
];

function HistoryTooltip({
  active,
  label,
  payload,
  changes,
  formatMonth,
  formatValue,
  language,
}: HistoryTooltipProps) {
  if (!active || !label || !payload?.length) return null;
  const monthChanges = changes.filter((change) => change.monthKey === label);

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
}) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const [period, setPeriod] = useState<PeriodPreset>('12');
  const [focusedYear, setFocusedYear] = useState<number | null>(null);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }), [locale]);
  const moneyFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }), [locale]);
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
  const filteredSeries = useMemo(() => {
    if (period === 'all') return series;
    return series.slice(-Number(period));
  }, [period, series]);
  const firstVisibleMonth = filteredSeries.at(0)?.monthKey ?? null;
  const lastVisibleMonth = filteredSeries.at(-1)?.monthKey ?? null;
  const visibleChanges = useMemo(() => changes.filter((change) => (
    (!firstVisibleMonth || change.monthKey >= firstVisibleMonth)
    && (!lastVisibleMonth || change.monthKey <= lastVisibleMonth)
  )), [changes, firstVisibleMonth, lastVisibleMonth]);
  const annotationMonths = useMemo(
    () => Array.from(new Set(visibleChanges.map((change) => change.monthKey))),
    [visibleChanges],
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
  const incompleteMonths = filteredSeries.filter(
    (month) => month.gridCoverage !== 'complete' || month.electricityCoverage !== 'complete',
  );

  const formatMonthKey = (monthKey: string) => monthFormatter.format(
    new Date(`${monthKey}-01T00:00:00Z`),
  );
  const formatFullMonthKey = (monthKey: string) => fullMonthFormatter.format(
    new Date(`${monthKey}-01T00:00:00Z`),
  );
  const coverageLabel = (status: EnergyBillingMonth['gridCoverage']) => {
    if (status === 'complete') return t('komplett', 'complete');
    if (status === 'partial') return t('delvis', 'partial');
    return t('saknas', 'missing');
  };
  const metricEvidence = (metric: AnnualizedMetric) => (
    metric.estimated
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
  const renderChangeLines = (yAxisId?: string | number) => annotationMonths.map((monthKey) => (
    <ReferenceLine
      key={monthKey}
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

  if (series.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex min-h-80 flex-col items-center justify-center px-6 text-center">
          <Activity className="mb-4 h-10 w-10 text-muted-foreground" />
          <h2 className="text-lg font-medium">{t('Ingen energihistorik ännu', 'No energy history yet')}</h2>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            {t(
              'Ladda upp elnäts- och elhandelsfakturor i fliken Ladda upp. Diagrammen byggs automatiskt när det finns importerad data.',
              'Upload grid and electricity provider invoices in the Upload tab. Charts are built automatically once data has been imported.',
            )}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-gradient-to-r from-primary/5 via-background to-violet-500/5 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">{t('Visad period', 'Displayed period')}</p>
          <p className="mt-0.5 text-xs capitalize text-muted-foreground">{periodLabel}</p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1" aria-label={t('Välj period', 'Select period')}>
          {PERIOD_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={period === option.value ? 'default' : 'ghost'}
              className="h-8 px-3"
              onClick={() => setPeriod(option.value)}
            >
              {language === 'sv' ? option.sv : option.en}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AnnualMetricCard
          label={t('Årlig förbrukning', 'Annual consumption')}
          metric={annual.consumptionKwh}
          value={formatMetric(annual.consumptionKwh, numberFormatter, ' kWh')}
          icon={<Gauge className="h-5 w-5" />}
          accentClass="bg-gradient-to-r from-blue-600 to-cyan-500"
          estimatedLabel={t('Estimerad', 'Estimated')}
          actualLabel={t('Faktisk', 'Actual')}
          evidenceLabel={metricEvidence(annual.consumptionKwh)}
        />
        <AnnualMetricCard
          label={t('Årlig export', 'Annual export')}
          metric={annual.exportedKwh}
          value={formatMetric(annual.exportedKwh, numberFormatter, ' kWh')}
          icon={<Activity className="h-5 w-5" />}
          accentClass="bg-gradient-to-r from-violet-600 to-fuchsia-500"
          estimatedLabel={t('Estimerad', 'Estimated')}
          actualLabel={t('Faktisk', 'Actual')}
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
          actualLabel={t('Faktisk', 'Actual')}
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
          actualLabel={t('Faktisk', 'Actual')}
          evidenceLabel={metricEvidence(annual.costPerKwh)}
        />
      </div>

      {incompleteMonths.length > 0 ? (
        <Alert className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
          <TriangleAlert className="h-4 w-4 text-amber-700 dark:text-amber-400" />
          <AlertTitle>{t('Luckor eller delperioder upptäckta', 'Gaps or partial periods detected')}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {t(
                'Månadsdiagrammen fyller inte i luckor. Årskorten ovan är tydligt markerade som estimerade och normaliserar delperioder samt svenska säsongsvariationer.',
                'Monthly charts do not fill gaps. The annual cards above are explicitly marked as estimated and normalize partial periods and Swedish seasonality.',
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {incompleteMonths.slice(0, 8).map((month) => (
                <Badge key={month.monthKey} variant="outline" className="bg-background font-normal">
                  {formatMonthKey(month.monthKey)} · {t('elnät', 'grid')} {coverageLabel(month.gridCoverage)} · {t('elhandel', 'electricity')} {coverageLabel(month.electricityCoverage)}
                </Badge>
              ))}
              {incompleteMonths.length > 8 && (
                <Badge variant="secondary">
                  +{incompleteMonths.length - 8} {t('månader', 'months')}
                </Badge>
              )}
            </div>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert className="border-emerald-300 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20">
          <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
          <AlertTitle>{t('Komplett fakturatäckning', 'Complete invoice coverage')}</AlertTitle>
          <AlertDescription>
            {t(
              'Alla synliga månader har både elnäts- och elhandelsunderlag.',
              'Every visible month has both grid and electricity provider coverage.',
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-blue-500/5 to-violet-500/5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">
              {t('Förbrukning och total kostnad per månad', 'Monthly consumption and total cost')}
            </CardTitle>
            {visibleChanges.length > 0 && (
              <Badge variant="outline" className="border-violet-300 text-violet-700 dark:border-violet-800 dark:text-violet-300">
                ◆ {visibleChanges.length} {t('villkorsändringar', 'term changes')}
              </Badge>
            )}
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
                    formatMonth={formatMonthKey}
                    formatValue={formatTooltipValue}
                    language={language}
                  />
                )}
              />
              <Legend />
              {renderChangeLines('energy')}
              <Area
                yAxisId="energy"
                dataKey="consumptionKwh"
                name={t('Förbrukning', 'Consumption')}
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
                dot={{ r: 3, fill: '#fff', strokeWidth: 2 }}
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
        </CardContent>
      </Card>

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
                    formatMonth={formatMonthKey}
                    formatValue={formatTooltipValue}
                    language={language}
                  />
                )}
              />
              <Legend />
              <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeOpacity={0.65} />
              {renderChangeLines()}
              <Bar dataKey="electricityEnergySek" stackId="cost" name={t('Elenergi', 'Electricity energy')} fill={COST_COLORS.electricityEnergySek} animationDuration={750} />
              <Bar dataKey="electricityFeesSek" stackId="cost" name={t('Elhandelsavgifter', 'Electricity fees')} fill={COST_COLORS.electricityFeesSek} animationDuration={825} />
              <Bar dataKey="gridFixedSek" stackId="cost" name={t('Fast nätavgift', 'Grid fixed fee')} fill={COST_COLORS.gridFixedSek} animationDuration={900} />
              <Bar dataKey="gridTransferSek" stackId="cost" name={t('Överföringsavgift', 'Transfer fee')} fill={COST_COLORS.gridTransferSek} animationDuration={975} />
              <Bar dataKey="gridPeakSek" stackId="cost" name={t('Effektavgift', 'Peak-demand fee')} fill={COST_COLORS.gridPeakSek} animationDuration={1050} />
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

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-emerald-500/5 to-blue-500/5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">
                {t('Förbrukning per månad och år', 'Consumption by month and year')}
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
    </div>
  );
};

export default EnergyHistoryOverview;
