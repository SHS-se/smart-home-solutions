import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Gauge, HousePlug, Info, Loader2 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import type { ResolvedUsageReading } from '@/lib/energy-usage-resolution';
import { toDailyEnergyReadings } from '@/lib/energy-usage-series';
import {
  EP_EXCLUDED_CATEGORIES,
  type DailyCategoryReading,
  type DailyTemperature,
} from '@/lib/energiprestanda';
import {
  resolveEnergyPerformance,
  type EnergyPerformanceConfidence,
  type EnergyPerformanceMethod,
  type ResolvedEnergyPerformance,
} from '@/lib/energy-performance';
import type { IndicativeEnergyGrade } from '@/lib/indicative-energy-performance';

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

const CATEGORY_COLORS: Record<string, string> = {
  heating: '#e26b23',
  hot_water: '#2a9d8f',
  cooling: '#4cc9f0',
  property_energy: '#7b6ff0',
  household: '#9aa0a6',
  ev_charging: '#5b8def',
  pool_heating: '#48b5a3',
  solar_production: '#f2c94c',
  grid_import: '#6b7280',
  grid_export: '#c5ce38',
  total_consumption: '#374151',
};

const CHART_CATEGORY_ORDER = [
  'heating',
  'hot_water',
  'cooling',
  'property_energy',
  'household',
  'ev_charging',
  'pool_heating',
];

const CONFIDENCE_STYLES: Record<EnergyPerformanceConfidence, string> = {
  high: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  medium: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200',
  low: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
};

type Translate = (sv: string, en: string) => string;

interface EnergiprestandaSectionProps {
  /** Daily per-category readings pushed from Home Assistant, when connected. */
  readings: DailyCategoryReading[];
  /** Daily grid-import / whole-home readings from invoices and file imports. */
  usageReadings: ResolvedUsageReading[];
  weatherObservations: DailyTemperature[];
  atempM2: number | null;
  heatedBoareaM2?: number | null;
  heatedBiareaM2?: number | null;
  hasSolar?: boolean | null;
  isLoading: boolean;
  error: unknown;
  onUploadClick?: () => void;
}

const round = (value: number, decimals = 0): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

function categoryLabel(category: string, t: Translate): string {
  switch (category) {
    case 'heating': return t('Uppvärmning', 'Heating');
    case 'hot_water': return t('Tappvarmvatten', 'Hot water');
    case 'cooling': return t('Komfortkyla', 'Comfort cooling');
    case 'property_energy': return t('Fastighetsenergi', 'Property energy');
    case 'household': return t('Hushållsel', 'Household');
    case 'ev_charging': return t('Elbilsladdning', 'EV charging');
    case 'pool_heating': return t('Pooluppvärmning', 'Pool heating');
    case 'solar_production': return t('Solproduktion', 'Solar production');
    case 'grid_import': return t('Nätuttag', 'Grid import');
    case 'grid_export': return t('Export', 'Grid export');
    case 'total_consumption': return t('Total', 'Total');
    default: return category;
  }
}

function methodLabel(method: EnergyPerformanceMethod, t: Translate): string {
  return method === 'measured_categories'
    ? t('Uppmätt per kategori', 'Measured per category')
    : t('Uppskattad från nätuttag', 'Estimated from grid import');
}

function confidenceLabel(confidence: EnergyPerformanceConfidence, t: Translate): string {
  switch (confidence) {
    case 'high': return t('Hög tillförlitlighet', 'High confidence');
    case 'medium': return t('Medelhög tillförlitlighet', 'Medium confidence');
    default: return t('Låg tillförlitlighet', 'Low confidence');
  }
}

function blockerMessage(
  performance: ResolvedEnergyPerformance,
  t: Translate,
): string {
  const { profile } = performance.estimated;
  switch (performance.blocker) {
    case 'missing_heated_area':
      return t(
        'Fyll i både uppvärmd boarea och uppvärmd biarea i Hemprofilen för att beräkna en energiklass. Ange 0 om uppvärmd biarea saknas.',
        'Complete both heated boarea and heated biarea in the Home profile to calculate an energy class. Enter 0 if there is no heated biarea.',
      );
    case 'area_not_supported':
      return t(
        'BBR 31 anger inget primärenergital för småhus med högst 50 m² Atemp, så någon A–G-indikation visas inte.',
        'BBR 31 does not specify a primary-energy requirement for small houses of at most 50 m² Atemp, so no A–G indication is shown.',
      );
    case 'solar_requires_total_consumption':
      return t(
        `Hemprofilen anger att huset har solceller. Nätuttag efter solinstallationen underskattar husets energibehov, så minst 30 dagar med verklig totalförbrukning behövs. Just nu finns ${profile.actualTotalConsumptionDays} sådana dagar. Koppla Home Assistant för att slippa kravet.`,
        `The Home profile says this home has solar panels. Grid import after the solar installation understates the home’s energy demand, so at least 30 days of actual whole-home consumption are needed. There are currently ${profile.actualTotalConsumptionDays} such days. Connecting Home Assistant removes this requirement.`,
      );
    case 'no_data':
      return t(
        'Det finns ännu ingen daglig energidata. Ladda upp ditt dagliga nätuttag från elnätsbolaget, så räknas en uppskattad energiklass fram.',
        'There is no daily energy data yet. Upload your daily grid import from the grid operator and an estimated energy class will be calculated.',
      );
    default:
      return t(
        `Minst 300 dagar med dagligt nätuttag behövs för en uppskattning, eller 30 dagar med kategoridata från Home Assistant för en uppmätt beräkning. Just nu finns ${profile.gridImportDays} nät-dagar och ${performance.measured.coverageDays} kategoridagar.`,
        `At least 300 days of daily grid import are needed for an estimate, or 30 days of category data from Home Assistant for a measured calculation. There are currently ${profile.gridImportDays} grid days and ${performance.measured.coverageDays} category days.`,
      );
  }
}

const EnergiprestandaSection: React.FC<EnergiprestandaSectionProps> = ({
  readings,
  usageReadings,
  weatherObservations,
  atempM2,
  heatedBoareaM2 = null,
  heatedBiareaM2 = null,
  hasSolar = null,
  isLoading,
  error,
  onUploadClick,
}) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }), [locale]);

  const dailyReadings = useMemo(() => toDailyEnergyReadings(usageReadings), [usageReadings]);
  const performance = useMemo(
    () => resolveEnergyPerformance(
      readings,
      dailyReadings,
      atempM2,
      weatherObservations,
      hasSolar,
    ),
    [atempM2, dailyReadings, hasSolar, readings, weatherObservations],
  );

  const monthlyByCategory = useMemo(() => {
    const months = new Map<string, Record<string, number | string>>();
    for (const reading of readings) {
      const month = reading.reading_date.slice(0, 7);
      const row = months.get(month) ?? { month };
      row[reading.category] = round(
        Number(row[reading.category] ?? 0) + reading.kwh,
        1,
      );
      months.set(month, row);
    }
    return Array.from(months.values())
      .sort((a, b) => String(a.month).localeCompare(String(b.month)))
      .slice(-13);
  }, [readings]);

  const chartCategories = useMemo(() => {
    const present = new Set(readings.map((r) => r.category));
    return CHART_CATEGORY_ORDER.filter((category) => present.has(category));
  }, [readings]);

  const formatKwh = (value: number | null) => (
    value === null ? '–' : `${numberFormatter.format(value)} kWh`
  );

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex min-h-48 items-center justify-center">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t('Data kunde inte läsas', 'Data could not be loaded')}</AlertTitle>
        <AlertDescription>
          {error instanceof Error ? error.message : String(error)}
        </AlertDescription>
      </Alert>
    );
  }

  const { measured, estimated } = performance;

  return (
    <div className="space-y-5">
      <Card
        className="overflow-hidden border-border/70 shadow-sm"
        data-testid="energy-performance"
      >
        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-emerald-500/5 via-background to-amber-500/5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Gauge className="h-4 w-4 text-emerald-700" />
                {t('Energiprestanda (primärenergital)', 'Energy performance (primary energy number)')}
              </CardTitle>
              <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                {t(
                  'En A–G-indikation inspirerad av Boverkets energideklaration. Beräkningen använder det bästa underlag ditt hem har. Detta är inte en officiell energideklaration eller ett myndighetsbeslut.',
                  'An A–G indication inspired by Boverket’s energy performance certificate. The calculation uses the best evidence your home has. This is not an official certificate or authority decision.',
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {performance.method && performance.confidence && (
                <>
                  <Badge variant="outline" className="bg-background" data-testid="energy-performance-method">
                    {methodLabel(performance.method, t)}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={CONFIDENCE_STYLES[performance.confidence]}
                    data-testid="energy-performance-confidence"
                  >
                    {confidenceLabel(performance.confidence, t)}
                  </Badge>
                </>
              )}
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {t('Ej officiell', 'Not official')}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          {performance.grade ? (
            <>
              <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
                <div className="flex flex-col items-center justify-center rounded-2xl border border-border/70 bg-muted/20 p-5 text-center">
                  <div
                    className={`flex h-24 w-24 items-center justify-center rounded-2xl text-5xl font-bold text-white shadow-lg ${
                      GRADE_BANDS.find((band) => band.grade === performance.grade)?.className
                    }`}
                    data-testid="energy-class-badge"
                  >
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
                    <p className="mt-1 font-medium tabular-nums">
                      {numberFormatter.format(performance.heatedAreaM2!)} m²
                    </p>
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
                    <p className="mt-1 font-medium tabular-nums">
                      {numberFormatter.format(performance.newBuildRequirementKwhM2!)} kWh/m², {t('år', 'year')}
                    </p>
                  </div>
                  {performance.method === 'measured_categories' ? (
                    <>
                      <div className="rounded-xl border p-3">
                        <p className="text-xs text-muted-foreground">
                          {t('Normaliserad byggnadsenergi', 'Normalized building energy')}
                        </p>
                        <p className="mt-1 font-medium tabular-nums">
                          {formatKwh(measured.normalizedAnnualKwh)}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {t('Rullande 12 månader t.o.m.', 'Rolling 12 months up to')}{' '}
                          {measured.windowEnd}
                        </p>
                      </div>
                      <div className="rounded-xl border p-3">
                        <p className="text-xs text-muted-foreground">
                          {t('Underlag', 'Evidence')}
                        </p>
                        <p className="mt-1 font-medium tabular-nums">
                          {t(
                            `${measured.coverageDays} dagar med kategoridata`,
                            `${measured.coverageDays} days of category data`,
                          )}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {measured.degreeDayFactor !== null
                            ? `${t('Graddagsfaktor', 'Degree-day factor')} ${numberFormatter.format(round(measured.degreeDayFactor, 2))}`
                            : t('Ingen graddagskorrigering', 'No degree-day correction')}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="rounded-xl border p-3">
                        <p className="text-xs text-muted-foreground">{t('Uppskattad byggnadsenergi från nätet', 'Estimated building energy from grid')}</p>
                        <p className="mt-1 font-medium tabular-nums">
                          {formatKwh(estimated.estimatedDeliveredBuildingElectricityKwh)}
                        </p>
                      </div>
                      <div className="rounded-xl border p-3">
                        <p className="text-xs text-muted-foreground">{t('Avdragen normal hushållsel', 'Deducted normal household electricity')}</p>
                        <p className="mt-1 font-medium tabular-nums">
                          {formatKwh(estimated.estimatedHouseholdElectricityKwh)}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {t(
                            `Schablon 30 kWh/m² · ${estimated.profile.gridImportDays} nät-dagar`,
                            `Standard 30 kWh/m² · ${estimated.profile.gridImportDays} grid days`,
                          )}
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {performance.method === 'measured_categories' && (
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-xl border border-border/70 p-3">
                    <div className="font-medium">{t('Ingår i beräkningen', 'Included in the calculation')}</div>
                    <table className="mt-2 w-full text-xs">
                      <tbody>
                        <tr>
                          <td>{t('Uppvärmning (graddagskorrigerad)', 'Heating (degree-day corrected)')}</td>
                          <td className="text-right font-mono">
                            {round(measured.correctedHeatingKwh ?? 0)} kWh
                          </td>
                        </tr>
                        <tr>
                          <td>{t('Tappvarmvatten (schablon 20 × Atemp)', 'Hot water (standard 20 × Atemp)')}</td>
                          <td className="text-right font-mono">
                            {round(measured.standardHotWaterKwh ?? 0)} kWh
                          </td>
                        </tr>
                        <tr>
                          <td>{t('Komfortkyla', 'Comfort cooling')}</td>
                          <td className="text-right font-mono">
                            {round(measured.annualizedIncludedKwh?.cooling ?? 0)} kWh
                          </td>
                        </tr>
                        <tr>
                          <td>{t('Fastighetsenergi', 'Property energy')}</td>
                          <td className="text-right font-mono">
                            {round(measured.annualizedIncludedKwh?.property_energy ?? 0)} kWh
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t(
                        `Uppmätt tappvarmvatten (${round(measured.measuredKwh.hot_water ?? 0)} kWh) ersätts med schablonen enligt BEN. Viktningsfaktor el 1,8.`,
                        `Measured hot water (${round(measured.measuredKwh.hot_water ?? 0)} kWh) is replaced by the BEN standard value. Electricity weighting factor 1.8.`,
                      )}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/70 p-3">
                    <div className="font-medium">{t('Ingår inte', 'Not included')}</div>
                    <table className="mt-2 w-full text-xs">
                      <tbody>
                        {EP_EXCLUDED_CATEGORIES.map((category) => (
                          <tr key={category}>
                            <td>{categoryLabel(category, t)}</td>
                            <td className="text-right font-mono">
                              {round(measured.measuredKwh[category] ?? 0)} kWh
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t(
                        'Uppmätta värden i fönstret, utan uppräkning. Pooluppvärmning särredovisas — energiexperten avgör klassningen i en formell deklaration.',
                        'Measured values in the window, not annualized. Pool heating is tracked separately — the certified expert decides its classification in a formal declaration.',
                      )}
                    </p>
                  </div>
                </div>
              )}

              {performance.method === 'estimated_from_grid' && (
                <Alert className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
                  <Info className="h-4 w-4 text-amber-700 dark:text-amber-400" />
                  <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      {t(
                        'Klassen bygger på ditt nätuttag plus schabloner, eftersom uppvärmning, varmvatten och hushållsel inte mäts var för sig. Koppla Home Assistant på kontosidan för en uppmätt beräkning per kategori.',
                        'The class is based on your grid import plus standard values, because heating, hot water, and household electricity are not metered separately. Connect Home Assistant on the Account page for a measured per-category calculation.',
                      )}
                    </span>
                    <Button asChild size="sm" variant="outline" className="shrink-0 bg-background">
                      <Link to="/portal/account">{t('Koppla Home Assistant', 'Connect Home Assistant')}</Link>
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : (
            <Alert className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
              <Info className="h-4 w-4 text-amber-700 dark:text-amber-400" />
              <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{blockerMessage(performance, t)}</span>
                {onUploadClick && performance.blocker !== 'missing_heated_area' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0 bg-background"
                    onClick={onUploadClick}
                  >
                    {t('Ladda upp energidata', 'Upload energy data')}
                  </Button>
                )}
              </AlertDescription>
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
                  'Uppmätt per kategori: dagliga mätvärden från Home Assistant summeras över en rullande tolvmånadersperiod enligt BEN (BFS 2016:12). Tappvarmvatten ersätts med schablonen 20 kWh/m², uppvärmningen graddagskorrigeras mot normalår, och hushållsel, elbilsladdning och pooluppvärmning räknas bort eftersom de mäts separat.',
                  'Measured per category: daily values from Home Assistant are summed over a rolling twelve-month window per BEN (BFS 2016:12). Hot water is replaced by the 20 kWh/m² standard value, heating is degree-day corrected against a normal year, and household electricity, EV charging, and pool heating are excluded because they are metered separately.',
                )}
              </p>
              <p>
                {t(
                  'Uppskattad från nätuttag: när kategoridata saknas används det dagliga nätuttaget från elnätsbolaget. Atemp uppskattas som uppvärmd boarea plus uppvärmd biarea, huset antas elvärmt i Stockholms län, elfaktorn 1,8 och geografifaktorn 1,0 används, BEN:s normalvärde 30 kWh/m² och år dras av för hushållsel, och nätelen fördelas proportionellt mellan hushållsel och byggnadsenergi.',
                  'Estimated from grid import: when category data is missing, the daily grid import from the grid operator is used. Atemp is estimated as heated boarea plus heated biarea, the house is assumed electrically heated in Stockholm County, the electricity factor 1.8 and geographic factor 1.0 are used, BEN’s normal household-electricity value of 30 kWh/m²/year is deducted, and grid electricity is allocated proportionally between household and building energy.',
                )}
              </p>
              <p>
                {t(
                  'Boarea plus biarea kan avvika från en uppmätt Atemp. Båda beräkningarna saknar certifierad normalårskorrigering av inomhustemperatur och verifierad fördelning av sol och batteri; uppskattningen saknar dessutom separata mätare för hushållsel och byggnadsenergi. Därför kan bokstaven avvika väsentligt från en riktig energideklaration. Den nya A0-klassen uppskattas inte.',
                  'Boarea plus biarea can differ from a measured Atemp. Both calculations lack certified normal-year correction of indoor temperature and verified allocation of solar and battery energy; the estimate additionally lacks separate meters for household and building energy. The letter may therefore differ materially from a real certificate. The new A0 class is not estimated.',
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

      {monthlyByCategory.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t('Månadsvis per kategori (från Home Assistant)', 'Monthly by category (from Home Assistant)')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={monthlyByCategory}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.35} />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  label={{ value: 'kWh', angle: -90, position: 'insideLeft' }}
                />
                <Tooltip cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
                <Legend />
                {chartCategories.map((category) => (
                  <Bar
                    key={category}
                    dataKey={category}
                    stackId="energy"
                    name={categoryLabel(category, t)}
                    fill={CATEGORY_COLORS[category]}
                    animationDuration={750}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex min-h-48 flex-col items-center justify-center text-center">
            <HousePlug className="mb-3 h-9 w-9 text-muted-foreground" />
            <h2 className="text-base font-medium">
              {t('Mer precision med Home Assistant', 'More precision with Home Assistant')}
            </h2>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              {t(
                'Koppla din Home Assistant på kontosidan så skickas daglig energianvändning per kategori hit automatiskt, och energiklassen räknas på uppmätta värden i stället för schabloner.',
                'Connect your Home Assistant on the Account page and daily energy use per category is pushed here automatically, so the energy class is calculated from measured values instead of standard assumptions.',
              )}
            </p>
            <Button asChild className="mt-4" size="sm">
              <Link to="/portal/account">{t('Till kontosidan', 'Go to Account')}</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default EnergiprestandaSection;
