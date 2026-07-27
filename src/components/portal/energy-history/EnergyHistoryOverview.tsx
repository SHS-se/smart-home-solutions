import React, { useMemo } from 'react';
import {
  Activity,
  CalendarDays,
  CheckCircle2,
  Coins,
  Gauge,
  TriangleAlert,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import type { EnergyBillingMonth } from '@/lib/energy-billing-series';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface EnergyHistoryOverviewProps {
  series: EnergyBillingMonth[];
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
  otherCostSek: '#94a3b8',
};

const EnergyHistoryOverview: React.FC<EnergyHistoryOverviewProps> = ({ series }) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
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
  const monthOnlyFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'short',
    timeZone: 'UTC',
  }), [locale]);

  const years = useMemo(
    () => Array.from(new Set(series.map((month) => month.year))).sort((a, b) => a - b),
    [series],
  );
  const consumptionByCalendarMonth = useMemo(() => Array.from({ length: 12 }, (_, index) => {
    const row: Record<string, string | number | boolean | null> = {
      month: monthOnlyFormatter.format(new Date(Date.UTC(2024, index, 1))),
    };
    for (const year of years) {
      const value = series.find((month) => month.year === year && month.month === index + 1);
      row[String(year)] = value?.consumptionKwh ?? null;
      const chosenCoverage = value?.consumptionSource === 'grid'
        ? value.gridCoverage
        : value?.consumptionSource === 'electricity'
          ? value.electricityCoverage
          : 'missing';
      row[`${year}Complete`] = chosenCoverage === 'complete';
    }
    return row;
  }), [monthOnlyFormatter, series, years]);

  const recordedConsumption = series.reduce(
    (sum, month) => sum + (month.consumptionKwh ?? 0),
    0,
  );
  const recordedExport = series.reduce(
    (sum, month) => sum + (month.exportedKwh ?? 0),
    0,
  );
  const recordedCost = series.reduce(
    (sum, month) => sum + (month.totalCostSek ?? 0),
    0,
  );
  const recordedGridCost = series.reduce(
    (sum, month) => sum + (month.gridCostSek ?? 0),
    0,
  );
  const recordedElectricityCost = series.reduce(
    (sum, month) => sum + (month.electricityCostSek ?? 0),
    0,
  );
  const averageCost = recordedConsumption > 0 ? recordedCost / recordedConsumption : null;
  const incompleteMonths = series.filter(
    (month) => month.gridCoverage !== 'complete' || month.electricityCoverage !== 'complete',
  );

  const formatMonthKey = (monthKey: string) => monthFormatter.format(
    new Date(`${monthKey}-01T00:00:00Z`),
  );
  const coverageLabel = (status: EnergyBillingMonth['gridCoverage']) => {
    if (status === 'complete') return t('komplett', 'complete');
    if (status === 'partial') return t('delvis', 'partial');
    return t('saknas', 'missing');
  };
  const tooltipMoney = (value: number | string | undefined) => {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? moneyFormatter.format(numeric) : '-';
  };

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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="flex items-start justify-between gap-4 pt-6">
            <div>
              <p className="text-sm text-muted-foreground">{t('Registrerad förbrukning', 'Recorded consumption')}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {numberFormatter.format(recordedConsumption)} kWh
              </p>
            </div>
            <Gauge className="h-5 w-5 text-primary" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-start justify-between gap-4 pt-6">
            <div>
              <p className="text-sm text-muted-foreground">{t('Registrerad export', 'Recorded export')}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {numberFormatter.format(recordedExport)} kWh
              </p>
            </div>
            <Activity className="h-5 w-5 text-violet-600" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-start justify-between gap-4 pt-6">
            <div>
              <p className="text-sm text-muted-foreground">{t('Registrerad totalkostnad', 'Recorded total cost')}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {moneyFormatter.format(recordedCost)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('Elnät', 'Grid')} {moneyFormatter.format(recordedGridCost)} · {t('Elhandel', 'Electricity')} {moneyFormatter.format(recordedElectricityCost)}
              </p>
            </div>
            <Coins className="h-5 w-5 text-amber-600" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-start justify-between gap-4 pt-6">
            <div>
              <p className="text-sm text-muted-foreground">{t('Kostnad per registrerad kWh', 'Cost per recorded kWh')}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {averageCost === null
                  ? '-'
                  : `${numberFormatter.format(averageCost)} ${t('kr/kWh', 'SEK/kWh')}`}
              </p>
            </div>
            <CalendarDays className="h-5 w-5 text-emerald-600" />
          </CardContent>
        </Card>
      </div>

      {incompleteMonths.length > 0 ? (
        <Alert className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
          <TriangleAlert className="h-4 w-4 text-amber-700 dark:text-amber-400" />
          <AlertTitle>{t('Luckor eller delperioder upptäckta', 'Gaps or partial periods detected')}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {t(
                'Saknade månader interpoleras inte. En månad med bara en av de två fakturatyperna visas, men kostnaden är då markerad som ofullständig.',
                'Missing months are not interpolated. A month with only one invoice type remains visible, but its cost is treated as incomplete.',
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
              'Alla månader i intervallet har både elnäts- och elhandelsunderlag.',
              'Every month in the range has both grid and electricity provider coverage.',
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('Förbrukning och total kostnad per månad', 'Monthly consumption and total cost')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={380}>
            <ComposedChart data={series} margin={{ top: 12, right: 8, bottom: 28, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                dataKey="monthKey"
                minTickGap={24}
                tickFormatter={formatMonthKey}
                angle={series.length <= 18 ? -25 : 0}
                textAnchor={series.length <= 18 ? 'end' : 'middle'}
                height={series.length <= 18 ? 62 : 32}
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
                label={{ value: t('SEK', 'SEK'), angle: 90, position: 'insideRight' }}
                className="text-xs"
              />
              <Tooltip
                labelFormatter={(label) => formatMonthKey(String(label))}
                formatter={(value: number, name: string) => (
                  name === 'consumptionKwh'
                    ? [`${numberFormatter.format(value)} kWh`, t('Förbrukning', 'Consumption')]
                    : [tooltipMoney(value), t('Totalkostnad', 'Total cost')]
                )}
              />
              <Legend
                formatter={(value) => (
                  value === 'consumptionKwh'
                    ? t('Förbrukning', 'Consumption')
                    : t('Totalkostnad', 'Total cost')
                )}
              />
              <Bar yAxisId="energy" dataKey="consumptionKwh" name="consumptionKwh" radius={[3, 3, 0, 0]}>
                {series.map((month) => {
                  const coverage = month.consumptionSource === 'grid'
                    ? month.gridCoverage
                    : month.electricityCoverage;
                  return (
                    <Cell
                      key={month.monthKey}
                      fill={coverage === 'complete' ? '#2563eb' : '#f59e0b'}
                      fillOpacity={coverage === 'partial' ? 0.65 : 0.9}
                    />
                  );
                })}
              </Bar>
              <Line
                yAxisId="cost"
                dataKey="totalCostSek"
                name="totalCostSek"
                type="monotone"
                connectNulls={false}
                stroke="#dc2626"
                strokeWidth={2.5}
                dot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('Kostnadsfördelning per månad', 'Monthly cost breakdown')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={series} margin={{ top: 12, right: 8, bottom: 28, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                dataKey="monthKey"
                minTickGap={24}
                tickFormatter={formatMonthKey}
                angle={series.length <= 18 ? -25 : 0}
                textAnchor={series.length <= 18 ? 'end' : 'middle'}
                height={series.length <= 18 ? 62 : 32}
                className="text-xs"
              />
              <YAxis
                tickFormatter={(value) => numberFormatter.format(value)}
                className="text-xs"
              />
              <Tooltip
                labelFormatter={(label) => formatMonthKey(String(label))}
                formatter={(value: number, name: string) => [tooltipMoney(value), name]}
              />
              <Legend />
              <Bar dataKey="electricityEnergySek" stackId="cost" name={t('Elenergi', 'Electricity energy')} fill={COST_COLORS.electricityEnergySek} />
              <Bar dataKey="electricityFeesSek" stackId="cost" name={t('Elhandelsavgifter', 'Electricity fees')} fill={COST_COLORS.electricityFeesSek} />
              <Bar dataKey="gridFixedSek" stackId="cost" name={t('Fast nätavgift', 'Grid fixed fee')} fill={COST_COLORS.gridFixedSek} />
              <Bar dataKey="gridTransferSek" stackId="cost" name={t('Överföringsavgift', 'Transfer fee')} fill={COST_COLORS.gridTransferSek} />
              <Bar dataKey="gridPeakSek" stackId="cost" name={t('Effektavgift', 'Peak-demand fee')} fill={COST_COLORS.gridPeakSek} />
              <Bar dataKey="energyTaxSek" stackId="cost" name={t('Energiskatt', 'Energy tax')} fill={COST_COLORS.energyTaxSek} />
              <Bar dataKey="exportNetSek" stackId="cost" name={t('Export netto', 'Net export')} fill={COST_COLORS.exportNetSek} />
              <Bar dataKey="otherCostSek" stackId="cost" name={t('Övrigt/avrundning', 'Other/rounding')} fill={COST_COLORS.otherCostSek} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('Förbrukning per månad och år', 'Consumption by month and year')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={consumptionByCalendarMonth} margin={{ top: 12, right: 8, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
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
              />
              <Legend />
              {years.map((year, yearIndex) => (
                <Bar
                  key={year}
                  dataKey={String(year)}
                  name={String(year)}
                  fill={YEAR_COLORS[yearIndex % YEAR_COLORS.length]}
                  radius={[2, 2, 0, 0]}
                >
                  {consumptionByCalendarMonth.map((month) => (
                    <Cell
                      key={`${year}-${month.month}`}
                      fill={YEAR_COLORS[yearIndex % YEAR_COLORS.length]}
                      fillOpacity={month[`${year}Complete`] ? 0.9 : 0.45}
                    />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
};

export default EnergyHistoryOverview;
