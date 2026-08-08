import React, { useMemo, useState } from 'react';
import {
  Home,
  Leaf,
  Loader2,
  Sun,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import {
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import type { ResolvedUsageReading } from '@/lib/energy-usage-resolution';
import {
  buildMonthlyEnergyFlows,
  buildRollingAnnualEnergyProfile,
  toDailyEnergyReadings,
} from '@/lib/energy-usage-series';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface EnergySourceInsightsProps {
  readings: ResolvedUsageReading[];
  isLoading?: boolean;
  error?: unknown;
  onUploadClick?: () => void;
}

const SOURCE_COLORS = {
  grid: '#2563eb',
  total: '#0f766e',
  self: '#d97706',
};

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

const EnergySourceInsights: React.FC<EnergySourceInsightsProps> = ({
  readings,
  isLoading = false,
  error,
  onUploadClick,
}) => {
  const { t, language } = useLanguage();
  const [showGrid, setShowGrid] = useState(true);
  const [showTotal, setShowTotal] = useState(true);
  const [showSelfSupplied, setShowSelfSupplied] = useState(true);
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }), [locale]);
  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  }), [locale]);
  const dailyReadings = useMemo(() => toDailyEnergyReadings(readings), [readings]);
  const monthlyFlows = useMemo(
    () => buildMonthlyEnergyFlows(dailyReadings),
    [dailyReadings],
  );
  const annualProfile = useMemo(
    () => buildRollingAnnualEnergyProfile(dailyReadings),
    [dailyReadings],
  );
  const gridReadingCount = readings.filter(
    (reading) => reading.reading_kind === 'grid_import',
  ).length;
  const totalReadingCount = readings.filter(
    (reading) => reading.reading_kind === 'total_consumption',
  ).length;
  const sourceError = errorMessage(error);
  const formatAnnual = (value: number | null) => (
    value === null ? '–' : `${numberFormatter.format(value)} kWh`
  );
  const formatDaily = (value: number | null) => (
    value === null ? '–' : `${numberFormatter.format(value)} kWh/${t('dygn', 'day')}`
  );
  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex min-h-56 items-center justify-center">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (sourceError) {
    return (
      <Alert variant="destructive">
        <TriangleAlert className="h-4 w-4" />
        <AlertDescription>{sourceError}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden border-border/70 shadow-sm" data-testid="energy-source-comparison">
        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-blue-500/5 via-background to-teal-500/5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">
                {t('Nätuttag och husets verkliga energibehov', 'Grid import and the home’s actual energy demand')}
              </CardTitle>
              <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                {t(
                  'Nätuttag visar köpt el och därmed solens kostnadsbesparing. Totalförbrukning visar all energi som huset använde, oavsett om den kom från nät, sol eller batteri, och används därför i effektivitetsanalysen.',
                  'Grid import shows purchased electricity and therefore the cost saving from solar. Whole-home consumption shows all energy used by the home, whether supplied by the grid, solar, or battery, and is therefore used for efficiency analysis.',
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300">
                {gridReadingCount} {t('nät-dagar', 'grid days')}
              </Badge>
              <Badge variant="outline" className="border-teal-300 text-teal-700 dark:border-teal-800 dark:text-teal-300">
                {totalReadingCount} {t('totaldagar', 'whole-home days')}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-blue-200/80 bg-blue-500/5 p-4 dark:border-blue-900/70">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Leaf className="h-4 w-4 text-blue-600" />
                {t('Årsberäknat nätuttag', 'Annualized grid import')}
              </p>
              <p className="mt-2 text-xl font-semibold tabular-nums">
                {formatAnnual(annualProfile.annualGridImportKwh)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {annualProfile.gridImportDays} {t('mätta dagar', 'measured days')}
              </p>
            </div>
            <div className="rounded-xl border border-teal-200/80 bg-teal-500/5 p-4 dark:border-teal-900/70">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Home className="h-4 w-4 text-teal-700" />
                {t('Tekniskt årsbehov', 'Annualized technical demand')}
              </p>
              <p className="mt-2 text-xl font-semibold tabular-nums">
                {formatAnnual(annualProfile.annualWholeHomeKwh)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {annualProfile.actualTotalConsumptionDays} {t(
                  'dagar med verklig totalförbrukning; tidigare dagar använder nätuttag som proxy',
                  'days of actual whole-home load; earlier days use grid import as a proxy',
                )}
              </p>
            </div>
            <div className="rounded-xl border border-amber-200/80 bg-amber-500/5 p-4 dark:border-amber-900/70">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Sun className="h-4 w-4 text-amber-600" />
                {t('Genomsnitt bakom mätaren', 'Average behind the meter')}
              </p>
              <p className="mt-2 text-xl font-semibold tabular-nums">
                {formatDaily(annualProfile.averageSelfSuppliedKwhPerDay)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {annualProfile.pairedDays} {t(
                  'dagar där båda serierna finns',
                  'days where both series are available',
                )}
              </p>
            </div>
          </div>

          {monthlyFlows.length === 0 ? (
            <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center">
              <Upload className="mb-3 h-9 w-9 text-muted-foreground" />
              <p className="text-sm font-medium">
                {t('Ingen daglig energidata ännu', 'No daily energy data yet')}
              </p>
              <p className="mt-1 max-w-lg text-xs text-muted-foreground">
                {t(
                  'Ladda upp dagligt nätuttag och, om det finns, Sigenergy-exporten från Home Assistant.',
                  'Upload daily grid import and, when available, the Sigenergy export from Home Assistant.',
                )}
              </p>
              {onUploadClick && (
                <Button type="button" size="sm" className="mt-4" onClick={onUploadClick}>
                  {t('Ladda upp energidata', 'Upload energy data')}
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('Visa energiserier', 'Show energy series')}>
                {[
                  {
                    label: t('Nätuttag', 'Grid import'),
                    color: SOURCE_COLORS.grid,
                    visible: showGrid,
                    toggle: () => setShowGrid((visible) => !visible),
                  },
                  {
                    label: t('Totalförbrukning', 'Whole-home consumption'),
                    color: SOURCE_COLORS.total,
                    visible: showTotal,
                    toggle: () => setShowTotal((visible) => !visible),
                  },
                  {
                    label: t('Sol/batteri bakom mätaren', 'Solar/battery behind meter'),
                    color: SOURCE_COLORS.self,
                    visible: showSelfSupplied,
                    toggle: () => setShowSelfSupplied((visible) => !visible),
                  },
                ].map((control) => (
                  <Button
                    key={control.label}
                    type="button"
                    size="sm"
                    variant={control.visible ? 'secondary' : 'outline'}
                    className="h-8 gap-2 px-2.5 text-xs"
                    aria-pressed={control.visible}
                    onClick={control.toggle}
                  >
                    <span
                      aria-hidden="true"
                      className="w-4 border-t-2"
                      style={{ borderColor: control.color }}
                    />
                    {control.label}
                  </Button>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={390}>
                <LineChart
                  data={monthlyFlows}
                  margin={{ top: 12, right: 16, bottom: 24, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
                  <XAxis
                    dataKey="monthKey"
                    minTickGap={28}
                    tickFormatter={(monthKey) => monthFormatter.format(new Date(`${monthKey}-01T00:00:00Z`))}
                    className="text-xs"
                  />
                  <YAxis
                    tickFormatter={(value) => numberFormatter.format(value)}
                    label={{ value: t('kWh/dygn', 'kWh/day'), angle: -90, position: 'insideLeft' }}
                    className="text-xs"
                  />
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      `${numberFormatter.format(value)} kWh/${t('dygn', 'day')}`,
                      name,
                    ]}
                    labelFormatter={(monthKey: string) => monthFormatter.format(new Date(`${monthKey}-01T00:00:00Z`))}
                  />
                  {showGrid && (
                    <Line
                      type="monotone"
                      dataKey="gridImportAverageKwh"
                      name={t('Nätuttag', 'Grid import')}
                      stroke={SOURCE_COLORS.grid}
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: '#fff', strokeWidth: 2 }}
                      connectNulls
                    />
                  )}
                  {showTotal && (
                    <Line
                      type="monotone"
                      dataKey="totalConsumptionAverageKwh"
                      name={t('Totalförbrukning', 'Whole-home consumption')}
                      stroke={SOURCE_COLORS.total}
                      strokeWidth={3}
                      dot={{ r: 3, fill: '#fff', strokeWidth: 2 }}
                      connectNulls
                    />
                  )}
                  {showSelfSupplied && (
                    <Line
                      type="monotone"
                      dataKey="selfSuppliedAverageKwh"
                      name={t('Sol/batteri bakom mätaren', 'Solar/battery behind meter')}
                      stroke={SOURCE_COLORS.self}
                      strokeWidth={2.5}
                      strokeDasharray="7 5"
                      dot={{ r: 3, fill: '#fff', strokeWidth: 2 }}
                      connectNulls
                    />
                  )}
                  {monthlyFlows.length > 24 && (
                    <Brush
                      dataKey="monthKey"
                      height={25}
                      startIndex={Math.max(0, monthlyFlows.length - 24)}
                      stroke="#64748b"
                      tickFormatter={(monthKey) => monthFormatter.format(new Date(`${monthKey}-01T00:00:00Z`))}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
              <p className="text-xs text-muted-foreground">
                {t(
                  'Diagrammet visar genomsnitt per tillgängligt dygn i varje månad, så en pågående delmånad kan jämföras utan att se konstgjort låg ut. Linjer kopplas över saknade månader men inga värden fylls i.',
                  'The chart shows the average per available day in each month, so an incomplete current month does not look artificially low. Lines connect across missing months, but no values are invented.',
                )}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default EnergySourceInsights;
