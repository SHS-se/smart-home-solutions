import React, { useMemo, useState } from 'react';
import {
  ExternalLink,
  Gauge,
  Home,
  Info,
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
import type { EnergyUsageReadingRecord } from '@/lib/energy-temperature-storage';
import type { EnergyReadingKind } from '@/lib/energy-usage-parser';
import {
  buildMonthlyEnergyFlows,
  type DailyEnergyReading,
} from '@/lib/energy-usage-series';
import {
  buildIndicativeEnergyPerformance,
  type IndicativeEnergyGrade,
} from '@/lib/indicative-energy-performance';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface EnergySourceInsightsProps {
  readings: EnergyUsageReadingRecord[];
  heatedBoareaM2: number | null;
  heatedBiareaM2: number | null;
  heatedAreaM2: number | null;
  hasSolar: boolean | null;
  isLoading?: boolean;
  error?: unknown;
  onUploadClick?: () => void;
}

const SOURCE_COLORS = {
  grid: '#2563eb',
  total: '#0f766e',
  self: '#d97706',
};

const GRADE_BANDS: Array<{
  grade: IndicativeEnergyGrade;
  label: string;
  className: string;
}> = [
  { grade: 'A', label: '≤50%', className: 'bg-emerald-600' },
  { grade: 'B', label: '50–75%', className: 'bg-green-500' },
  { grade: 'C', label: '75–100%', className: 'bg-lime-500' },
  { grade: 'D', label: '100–135%', className: 'bg-yellow-500' },
  { grade: 'E', label: '135–180%', className: 'bg-orange-500' },
  { grade: 'F', label: '180–235%', className: 'bg-orange-700' },
  { grade: 'G', label: '>235%', className: 'bg-red-700' },
];

function toDailyReadings(readings: EnergyUsageReadingRecord[]): DailyEnergyReading[] {
  return readings.map((reading) => ({
    readingDate: reading.reading_date,
    consumptionKwh: reading.consumption_kwh,
    readingKind: reading.reading_kind as EnergyReadingKind,
  }));
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

const EnergySourceInsights: React.FC<EnergySourceInsightsProps> = ({
  readings,
  heatedBoareaM2,
  heatedBiareaM2,
  heatedAreaM2,
  hasSolar,
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
  const dailyReadings = useMemo(() => toDailyReadings(readings), [readings]);
  const monthlyFlows = useMemo(
    () => buildMonthlyEnergyFlows(dailyReadings),
    [dailyReadings],
  );
  const performance = useMemo(
    () => buildIndicativeEnergyPerformance(dailyReadings, heatedAreaM2, hasSolar),
    [dailyReadings, hasSolar, heatedAreaM2],
  );
  const annualProfile = performance.profile;
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
  const availabilityMessage = (() => {
    if (performance.unavailableReason === 'missing_heated_area') {
      return t(
        'Fyll i både uppvärmd boarea och uppvärmd biarea i Hemprofilen för att beräkna en indikativ energiklass. Ange 0 om uppvärmd biarea saknas.',
        'Complete both heated boarea and heated biarea in the Home profile to calculate an indicative energy class. Enter 0 if there is no heated biarea.',
      );
    }
    if (performance.unavailableReason === 'area_not_supported') {
      return t(
        'BBR 31 anger inget primärenergital för småhus med högst 50 m² Atemp, så någon A–G-indikation visas inte.',
        'BBR 31 does not specify a primary-energy requirement for small houses of at most 50 m² Atemp, so no A–G indication is shown.',
      );
    }
    if (performance.unavailableReason === 'insufficient_daily_data') {
      return t(
        `Minst 300 dagar med både nätunderlag och tekniskt förbrukningsunderlag behövs. Just nu finns ${annualProfile.gridImportDays} nät-dagar och ${annualProfile.efficiencyDays} tekniska dagar under den senaste årsperioden.`,
        `At least 300 days of both grid evidence and technical consumption evidence are needed. The latest annual window currently has ${annualProfile.gridImportDays} grid days and ${annualProfile.efficiencyDays} technical days.`,
      );
    }
    if (performance.unavailableReason === 'solar_requires_total_consumption') {
      return t(
        `Hemprofilen anger att huset har solceller. Lägg till minst 30 dagar med verklig totalförbrukning innan en energiklass visas; nätuttag efter solinstallationen underskattar husets energibehov. Just nu finns ${annualProfile.actualTotalConsumptionDays} sådana dagar under den senaste årsperioden.`,
        `The Home profile says this home has solar panels. Add at least 30 days of actual whole-home consumption before an energy class is shown; grid import after the solar installation understates the home’s energy demand. The latest annual window currently has ${annualProfile.actualTotalConsumptionDays} such days.`,
      );
    }
    return null;
  })();

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

      <Card className="overflow-hidden border-border/70 shadow-sm" data-testid="indicative-energy-performance">
        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-emerald-500/5 via-background to-amber-500/5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Gauge className="h-4 w-4 text-emerald-700" />
                {t('Indikativ energiprestanda', 'Indicative energy performance')}
              </CardTitle>
              <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                {t(
                  'En förenklad A–G-indikation inspirerad av Boverkets energideklaration. Detta är inte en officiell energideklaration eller ett myndighetsbeslut.',
                  'A simplified A–G indication inspired by Boverket’s energy performance certificate. This is not an official certificate or authority decision.',
                )}
              </p>
            </div>
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {t('Ej officiell', 'Not official')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          {performance.grade ? (
            <>
              <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
                <div className="flex flex-col items-center justify-center rounded-2xl border border-border/70 bg-muted/20 p-5 text-center">
                  <div className={`flex h-24 w-24 items-center justify-center rounded-2xl text-5xl font-bold text-white shadow-lg ${
                    GRADE_BANDS.find((band) => band.grade === performance.grade)?.className
                  }`}>
                    {performance.grade}
                  </div>
                  <p className="mt-3 text-sm font-medium">
                    {numberFormatter.format(performance.primaryEnergyKwhM2!)} kWh/m², {t('år', 'year')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {numberFormatter.format(performance.requirementPercent!)}% {t(
                      'av jämförbart nybyggnadskrav',
                      'of the comparable new-build requirement',
                    )}
                  </p>
                </div>
                <div className="grid content-start gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border p-3">
                    <p className="text-xs text-muted-foreground">{t('Uppskattad Atemp', 'Estimated Atemp')}</p>
                    <p className="mt-1 font-medium tabular-nums">{numberFormatter.format(performance.heatedAreaM2!)} m²</p>
                    {heatedBoareaM2 !== null && heatedBiareaM2 !== null ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {numberFormatter.format(heatedBoareaM2)} m² {t('boarea', 'boarea')}
                        {' + '}
                        {numberFormatter.format(heatedBiareaM2)} m² {t('biarea', 'biarea')}
                      </p>
                    ) : null}
                  </div>
                  <div className="rounded-xl border p-3">
                    <p className="text-xs text-muted-foreground">{t('Jämförelsekrav BBR 31', 'BBR 31 comparison requirement')}</p>
                    <p className="mt-1 font-medium tabular-nums">{numberFormatter.format(performance.newBuildRequirementKwhM2!)} kWh/m², {t('år', 'year')}</p>
                  </div>
                  <div className="rounded-xl border p-3">
                    <p className="text-xs text-muted-foreground">{t('Uppskattad byggnadsenergi från nätet', 'Estimated building energy from grid')}</p>
                    <p className="mt-1 font-medium tabular-nums">{formatAnnual(performance.estimatedDeliveredBuildingElectricityKwh)}</p>
                  </div>
                  <div className="rounded-xl border p-3">
                    <p className="text-xs text-muted-foreground">{t('Avdragen normal hushållsel', 'Deducted normal household electricity')}</p>
                    <p className="mt-1 font-medium tabular-nums">{formatAnnual(performance.estimatedHouseholdElectricityKwh)}</p>
                  </div>
                </div>
              </div>

            </>
          ) : (
            <Alert className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
              <Info className="h-4 w-4 text-amber-700 dark:text-amber-400" />
              <AlertDescription>{availabilityMessage}</AlertDescription>
            </Alert>
          )}

          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              {t(
                'Klassgräns som andel av jämförbart nybyggnadskrav',
                'Class boundary as a share of the comparable new-build requirement',
              )}
            </p>
            <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-border/70">
              {GRADE_BANDS.map((band) => (
                <div
                  key={band.grade}
                  className={`${band.className} px-1 py-2 text-center text-white ${
                    performance.grade === band.grade
                      ? 'relative z-10 ring-4 ring-foreground/25 ring-inset'
                      : 'opacity-65'
                  }`}
                >
                  <p className="font-semibold">{band.grade}</p>
                  <p className="text-[9px] sm:text-[10px]">{band.label}</p>
                </div>
              ))}
            </div>
          </div>

          <details className="rounded-xl border border-border/70 bg-muted/15 p-4">
            <summary className="cursor-pointer text-sm font-medium">
              {t('Så räknas indikationen och vad som saknas', 'How the indication is calculated and what is missing')}
            </summary>
            <div className="mt-3 space-y-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                {t(
                  'Officiell energiprestanda omfattar köpt energi för uppvärmning, tappvarmvatten, komfortkyla och fastighetsenergi – inte hushållsel. Den viktas med primärenergifaktorer och geografisk faktor och jämförs sedan med nybyggnadskravet för byggnaden.',
                  'Official energy performance covers delivered energy for heating, domestic hot water, comfort cooling, and building services—not household electricity. It is weighted using primary-energy and geographic factors, then compared with the new-build requirement for that building.',
                )}
              </p>
              <p>
                {t(
                  'Den här beräkningen uppskattar Atemp som uppvärmd boarea plus uppvärmd biarea, antar ett elvärmt småhus i Stockholms län, använder elfaktorn 1,8 och geografifaktorn 1,0, drar av BEN:s normalvärde 30 kWh/m² och år för hushållsel och fördelar nätel proportionellt mellan hushållsel och byggnadsenergi när totalförbrukning finns.',
                  'This calculation estimates Atemp as heated boarea plus heated biarea, assumes an electrically heated small house in Stockholm County, uses the electricity factor 1.8 and geographic factor 1.0, deducts BEN’s normal household-electricity value of 30 kWh/m²/year, and allocates grid electricity proportionally between household and building energy when whole-home consumption is available.',
                )}
              </p>
              <p>
                {t(
                  'Boarea plus biarea kan avvika från en uppmätt Atemp. Beräkningen saknar också certifierad normalårskorrigering, exakt normalisering av varmvatten och inomhustemperatur, separata mätare för hushållsel och byggnadsenergi samt säker fördelning av sol och batteri. Därför kan bokstaven avvika väsentligt från en riktig energideklaration. Den nya A0-klassen uppskattas inte.',
                  'Boarea plus biarea can differ from a measured Atemp. The calculation also lacks certified normal-year correction, exact normalization of hot water and indoor temperature, separate meters for household and building energy, and verified allocation of solar and battery energy. The letter may therefore differ materially from a real certificate. The new A0 class is not estimated.',
                )}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <a
                  href="https://www.boverket.se/sv/energideklaration/energideklaration/energideklarationens-innehall/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  {t('Boverket: energiklasser', 'Boverket: energy classes')}
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a
                  href="https://www.boverket.se/sv/byggande/bygg-och-renovera-energieffektivt/energihushallningskrav/primarenergital-och-byggnadens-energiprestanda"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  {t('Boverket: primärenergital', 'Boverket: primary-energy number')}
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a
                  href="https://www.boverket.se/sv/energideklaration/for-energiexperter/lokalt-producerad-solel-i-energideklarationen/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  {t('Boverket: solel i energideklarationen', 'Boverket: solar in the certificate')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </details>
        </CardContent>
      </Card>
    </div>
  );
};

export default EnergySourceInsights;
