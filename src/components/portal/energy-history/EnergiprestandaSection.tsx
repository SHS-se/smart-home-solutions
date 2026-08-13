import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ExternalLink, Gauge, HousePlug, Info, Loader2 } from 'lucide-react';
import {
  Bar,
  BarChart,
  Brush,
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
  type EnergyPerformanceHomeFacts,
  type EnergyPerformanceMethod,
  type ResolvedEnergyPerformance,
} from '@/lib/energy-performance';
import type { IndicativeEnergyGrade } from '@/lib/indicative-energy-performance';
import type { EnergyEvent } from '@/lib/energy-events';
import {
  restatedPrimaryEnergy,
  wasRestated,
  type StoredEnergyDeclaration,
} from '@/lib/energy-declaration-storage';

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
  /** Build year, dwelling form and heating system, for the cold-start prior. */
  homeFacts?: EnergyPerformanceHomeFacts;
  /** Recorded events. Holidays and faults are excluded; renovations shift the prior. */
  events?: EnergyEvent[];
  onManageEventsClick?: () => void;
  /** Official Boverket certificate, when the customer has uploaded one. */
  declaration?: StoredEnergyDeclaration | null;
  onUploadDeclarationClick?: () => void;
  periodStartMonth: string | null;
  periodEndMonth: string | null;
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
  switch (method) {
    case 'measured_categories':
      return t('Uppmätt per kategori', 'Measured per category');
    case 'estimated_from_grid':
      return t('Uppskattad från nätuttag', 'Estimated from grid import');
    default:
      return t('Modellerad för hustypen', 'Modelled for this house type');
  }
}

/**
 * Why the figure is what it is. The old card asserted "degree-day corrected"
 * next to "no degree-day correction"; a class is now only ever stated on a
 * basis the card can name.
 */
function basisMessage(
  performance: ResolvedEnergyPerformance,
  t: Translate,
): string | null {
  const coverage = performance.measured.heatingCoverage;
  const seasonPercent = coverage ? Math.round(coverage.fraction * 100) : 0;

  if (performance.method === 'modelled_archetype') {
    return t(
      `Ingen mätning täcker ännu tillräckligt av en uppvärmningssäsong, så siffran är modellerad utifrån byggår, hustyp och uppvärmningssätt — inte uppmätt i just detta hus. Uppmätt hittills: ${seasonPercent} % av ett normalårs graddagar.`,
      `No measurement yet covers enough of a heating season, so this figure is modelled from build year, dwelling type and heating system — it is not measured in this house. Measured so far: ${seasonPercent}% of a normal year’s degree days.`,
    );
  }
  if (performance.method === 'measured_categories' && performance.isModelled) {
    return t(
      `Uppmätt data täcker ${seasonPercent} % av ett normalårs graddagar, så siffran är en blandning av mätning och modell. Andelen mätning ökar under vintern.`,
      `Measured data covers ${seasonPercent}% of a normal year’s degree days, so this figure blends measurement with the model. The measured share grows through the winter.`,
    );
  }
  if (performance.method === 'estimated_from_grid') {
    return t(
      'Beräknad från husets totala elförbrukning, fördelad på kategorier med en modell för hustypen. Hushållsel dras av med BEN:s schablon.',
      'Derived from the home’s total electricity use, split into categories by a model for this house type. Household electricity is deducted using BEN’s standard value.',
    );
  }
  return null;
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
        `Fyll i byggår, hustyp och uppvärmningssätt i Hemprofilen så visas åtminstone ett modellerat värde. Just nu finns ${profile.gridImportDays} nät-dagar och ${performance.measured.coverageDays} kategoridagar.`,
        `Complete build year, dwelling type and heating system in the Home profile and at least a modelled figure can be shown. There are currently ${profile.gridImportDays} grid days and ${performance.measured.coverageDays} category days.`,
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
  homeFacts = {},
  events = [],
  onManageEventsClick,
  declaration = null,
  onUploadDeclarationClick,
  periodStartMonth,
  periodEndMonth,
  isLoading,
  error,
  onUploadClick,
}) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }), [locale]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }), [locale]);

  const dailyReadings = useMemo(() => toDailyEnergyReadings(usageReadings), [usageReadings]);
  const performance = useMemo(
    () => resolveEnergyPerformance(
      readings,
      dailyReadings,
      atempM2,
      weatherObservations,
      hasSolar,
      homeFacts,
      events,
    ),
    [atempM2, dailyReadings, events, hasSolar, homeFacts, readings, weatherObservations],
  );

  const visibleCategoryReadings = useMemo(() => readings.filter((reading) => {
    const monthKey = reading.reading_date.slice(0, 7);
    return (!periodStartMonth || monthKey >= periodStartMonth)
      && (!periodEndMonth || monthKey <= periodEndMonth);
  }), [periodEndMonth, periodStartMonth, readings]);

  const monthlyByCategory = useMemo(() => {
    const months = new Map<string, Record<string, number | string>>();
    for (const reading of visibleCategoryReadings) {
      const month = reading.reading_date.slice(0, 7);
      const row = months.get(month) ?? { month };
      row[reading.category] = round(
        Number(row[reading.category] ?? 0) + reading.kwh,
        1,
      );
      months.set(month, row);
    }
    return Array.from(months.values())
      .sort((a, b) => String(a.month).localeCompare(String(b.month)));
  }, [visibleCategoryReadings]);

  const categoryCoverage = useMemo(() => {
    const dates = [...new Set(readings.map((reading) => reading.reading_date))].sort();
    const months = new Set(dates.map((date) => date.slice(0, 7)));
    return {
      days: dates.length,
      months: months.size,
      firstDate: dates.at(0) ?? null,
      lastDate: dates.at(-1) ?? null,
    };
  }, [readings]);

  const chartCategories = useMemo(() => {
    const present = new Set(visibleCategoryReadings.map((r) => r.category));
    return CHART_CATEGORY_ORDER.filter((category) => present.has(category));
  }, [visibleCategoryReadings]);

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
              {basisMessage(performance, t) && (
                <p
                  className="mt-2 max-w-3xl text-xs text-muted-foreground"
                  data-testid="energy-performance-basis"
                >
                  {basisMessage(performance, t)}
                </p>
              )}
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
              {performance.isModelled && (
                <Badge
                  variant="outline"
                  className="border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200"
                  data-testid="energy-performance-modelled"
                >
                  {t('Modellerad, ej uppmätt', 'Modelled, not measured')}
                </Badge>
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
                            `${Math.round((measured.heatingCoverage?.fraction ?? 0) * 100)} % av uppvärmningssäsongen`,
                            `${Math.round((measured.heatingCoverage?.fraction ?? 0) * 100)}% of the heating season`,
                          )}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {t(
                            `${measured.coverageDays} dagar med kategoridata`,
                            `${measured.coverageDays} days of category data`,
                          )}
                          {measured.degreeDayFactor !== null
                            ? ` · ${t('graddagsfaktor', 'degree-day factor')} ${numberFormatter.format(round(measured.degreeDayFactor, 2))}`
                            : ''}
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

          {/*
            Events are inputs here, so the card has to say when they changed the
            answer. A silently excluded fortnight is exactly the kind of hidden
            adjustment this page has been cleaned of.
          */}
          {(performance.eventWarnings.length > 0
            || performance.renovationHeatingFactor < 1) && (
            <div className="rounded-xl border border-teal-200 bg-teal-50/40 p-4 dark:border-teal-900 dark:bg-teal-950/20">
              <p className="text-sm font-medium">
                {t('Dina händelser påverkar den här siffran', 'Your events affect this figure')}
              </p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {performance.renovationHeatingFactor < 1 && (
                  <li>
                    {t(
                      `En registrerad renovering${performance.renovationYear ? ` (${performance.renovationYear})` : ''} sänker modellens uppvärmningsbehov med ${Math.round((1 - performance.renovationHeatingFactor) * 100)} %. Det är ett försiktigt antagande — uppmätt data ersätter det efterhand.`,
                      `A recorded renovation${performance.renovationYear ? ` (${performance.renovationYear})` : ''} lowers the model’s heat demand by ${Math.round((1 - performance.renovationHeatingFactor) * 100)}%. That is a conservative assumption — measured data replaces it over time.`,
                    )}
                  </li>
                )}
                {performance.eventWarnings.map((warning) => (
                  <li key={warning.kind}>
                    {warning.kind === 'period_days_excluded'
                      ? t(
                        `${warning.days} dagar är borträknade som ej representativa (bortrest, gäster eller utrustningsfel).`,
                        `${warning.days} days are excluded as unrepresentative (away, guests or an equipment fault).`,
                      )
                      : t(
                        `Perioden innehåller ${warning.steps?.length} varaktig förändring av huset eller hushållet, så data före och efter beskriver inte samma förutsättningar.`,
                        `The window contains ${warning.steps?.length} lasting change to the house or household, so data before and after does not describe the same conditions.`,
                      )}
                  </li>
                ))}
              </ul>
              {onManageEventsClick && (
                <Button size="sm" variant="outline" className="mt-3" onClick={onManageEventsClick}>
                  {t('Hantera händelser', 'Manage events')}
                </Button>
              )}
            </div>
          )}

          {declaration ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">
                  {t('Officiell energideklaration', 'Official energy declaration')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[
                    declaration.issuedOn
                      ? dateFormatter.format(new Date(`${declaration.issuedOn}T00:00:00Z`))
                      : null,
                    declaration.declarationId ? `ID ${declaration.declarationId}` : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('Som utfärdad', 'As issued')}
                  </p>
                  <p className="font-medium tabular-nums">
                    {t('Klass', 'Class')} {declaration.energyClass} ·{' '}
                    {numberFormatter.format(declaration.primaryEnergyKwhM2)} kWh/m²
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('Omräknad till dagens elfaktor', 'Restated on today’s factor')}
                  </p>
                  <p className="font-medium tabular-nums">
                    {numberFormatter.format(round(restatedPrimaryEnergy(declaration), 1))} kWh/m²
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('Uppmätt Atemp', 'Surveyed Atemp')}
                  </p>
                  <p className="font-medium tabular-nums">
                    {declaration.atempM2 !== null
                      ? `${numberFormatter.format(declaration.atempM2)} m²`
                      : '–'}
                  </p>
                </div>
              </div>
              {wasRestated(declaration) && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t(
                    `Deklarationen använde viktningsfaktorn ${numberFormatter.format(declaration.weightingFactor ?? 1.6)} för el. Sedan 1 september 2020 gäller 1,8, så samma byggnad med samma energianvändning får ett högre tal idag utan att något har förändrats.`,
                    `The declaration used an electricity weighting factor of ${numberFormatter.format(declaration.weightingFactor ?? 1.6)}. Since 1 September 2020 the factor is 1.8, so the same building with the same energy use scores higher today without anything having changed.`,
                  )}
                </p>
              )}
              {declaration.similarBuildingsKwhM2 !== null && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(
                    `Boverkets referensvärde för liknande byggnader är ${numberFormatter.format(declaration.similarBuildingsKwhM2)} kWh/m². Detta hus låg på ${Math.round((restatedPrimaryEnergy(declaration) / declaration.similarBuildingsKwhM2) * 100)} % av det.`,
                    `Boverket’s reference value for similar buildings is ${numberFormatter.format(declaration.similarBuildingsKwhM2)} kWh/m². This house was at ${Math.round((restatedPrimaryEnergy(declaration) / declaration.similarBuildingsKwhM2) * 100)}% of that.`,
                  )}
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/70 p-4">
              <p className="text-sm font-medium">
                {t('Har du en energideklaration?', 'Do you have an energy declaration?')}
              </p>
              <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                {t(
                  'Ladda upp den under Data så läses husets uppmätta Atemp, certifierade energiklass och Boverkets referensvärde för liknande byggnader in automatiskt. Det ersätter flera av uppskattningarna ovan och gör det möjligt att jämföra före och efter era förbättringar.',
                  'Upload it under Data and the home’s surveyed Atemp, certified energy class and Boverket’s reference value for similar buildings are read automatically. That replaces several of the estimates above and makes it possible to compare before and after your improvements.',
                )}
              </p>
              {onUploadDeclarationClick && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={onUploadDeclarationClick}
                >
                  {t('Gå till uppladdning', 'Go to upload')}
                </Button>
              )}
            </div>
          )}

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
              <p className="font-medium text-foreground">
                {t('Varför siffran kan se konstig ut', 'Why the number can look strange')}
              </p>
              <p>
                {t(
                  'Uppvärmning räknas om med graddagar, inte med antal dagar. Ett mätfönster i juli innehåller nästan inga graddagar och säger därför nästan ingenting om årets uppvärmning – att multiplicera det med 365/antal dagar ger ett kraftigt underskattat värde. Därför visas ingen uppmätt klass förrän mätningen täcker minst 60 % av ett normalårs graddagar.',
                  'Heating is scaled by degree days, not by day count. A window in July contains almost no degree days and therefore says almost nothing about the year’s heating — multiplying it by 365/days produces a badly understated figure. No measured class is shown until the measurement covers at least 60% of a normal year’s degree days.',
                )}
              </p>
              <p>
                {t(
                  'Tappvarmvatten ersätts alltid med BEN:s schablon 20 kWh per m² Atemp, oavsett hur mycket varmvatten hushållet faktiskt använder. Det gör byggnader jämförbara, men för ett stort hus blir schablonen en stor del av hela talet och kan ligga klart över den faktiska användningen. I en certifierad energideklaration för ett hus på 435 m² noterades 15,4 kWh/m².',
                  'Hot water is always replaced by BEN’s standard value of 20 kWh per m² Atemp, regardless of how much the household actually uses. That makes buildings comparable, but for a large house the standard value becomes a large share of the whole number and can sit well above actual use. A certified declaration for a 435 m² house recorded 15.4 kWh/m².',
                )}
              </p>
              <p>
                {t(
                  'Modellerade värden beskriver ett typiskt hus av samma ålder, typ och uppvärmningssätt – inte just ditt hus. Ett hus som är bättre än genomsnittet för sin årgång får därför en sämre modellerad klass än sin verkliga. Modellen känner inte till renoveringar.',
                  'Modelled figures describe a typical house of the same age, type and heating system — not your house. A home that is better than average for its vintage will therefore get a worse modelled class than its real one. The model cannot see renovations.',
                )}
              </p>
              <p>
                {t(
                  'Jämför du med en äldre energideklaration: viktningsfaktorn för el höjdes från 1,6 till 1,8 den 1 september 2020 (BBR 29). Samma hus med samma energianvändning får därför ett 12,5 % högre primärenergital idag, utan att något har förändrats i byggnaden.',
                  'If you are comparing with an older energy declaration: the weighting factor for electricity rose from 1.6 to 1.8 on 1 September 2020 (BBR 29). The same house with the same energy use therefore gets a 12.5% higher primary-energy number today, without anything about the building having changed.',
                )}
              </p>
              <p>
                {t(
                  'Fastighetsenergi är gemensam el för byggnadens drift. Ett friliggande småhus har normalt ingen alls, och den posten sätts därför till noll i modellen även om Home Assistant har en egen kategori med liknande namn.',
                  'Property energy is shared electricity for operating the building. A detached house normally has none, so the model sets it to zero — even though Home Assistant has a category with a similar name, which is a different thing.',
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
        <Card data-testid="energy-performance-source-data">
          <CardContent className="p-0">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-3 p-5">
                <div className="rounded-lg bg-blue-500/10 p-2 text-blue-700 dark:text-blue-300">
                  <HousePlug className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-medium">
                    {t('Kategoridata från Home Assistant', 'Category data from Home Assistant')}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {categoryCoverage.firstDate && categoryCoverage.lastDate
                      ? t(
                          `${categoryCoverage.days} dagar från ${dateFormatter.format(new Date(`${categoryCoverage.firstDate}T00:00:00Z`))} till ${dateFormatter.format(new Date(`${categoryCoverage.lastDate}T00:00:00Z`))}. Första månaden är ofta delvis återfylld och den pågående månaden är inte färdig ännu.`,
                          `${categoryCoverage.days} days from ${dateFormatter.format(new Date(`${categoryCoverage.firstDate}T00:00:00Z`))} to ${dateFormatter.format(new Date(`${categoryCoverage.lastDate}T00:00:00Z`))}. The first month is often a partial backfill and the current month is not complete yet.`,
                        )
                      : null}
                  </p>
                </div>
                <Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
                  {categoryCoverage.months} {t('månader', 'months')}
                </Badge>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-border/60 p-5">
                <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
                  {t(
                    'När integrationen ansluts skickar den upp till 30 tidigare dagar som finns kvar i Home Assistants recorder. Därefter läggs den senast avslutade dagen till varje natt. Därför blir den första och den pågående månaden normalt ofullständiga, medan månaderna däremellan blir kompletta.',
                    'When the integration is connected, it sends up to 30 previous days still retained by the Home Assistant recorder. It then adds the latest completed day every night. That normally leaves the first and current months incomplete, while the months between them become complete.',
                  )}
                </p>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={monthlyByCategory}>
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.35} />
                    <XAxis dataKey="month" minTickGap={24} tick={{ fontSize: 12 }} />
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
                    {monthlyByCategory.length > 18 && (
                      <Brush dataKey="month" height={26} travellerWidth={8} />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </details>
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
