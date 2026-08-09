import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  CloudSun,
  ExternalLink,
  Loader2,
  Thermometer,
  Upload,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  buildEnergyTemperatureAnalysis,
  buildSeasonalEventImpacts,
  buildWeatherNormalizedHistory,
  predictTemperatureRegression,
  type EnergyAnalysisReadingKind,
  type EnergyTemperatureAnalysis,
  type SeasonalEventImpact,
  type WeatherNormalizedHistory,
} from '@/lib/energy-temperature-analysis';
import type { EnergyBillingMonth } from '@/lib/energy-billing-series';
import {
  selectEfficiencyReadings,
  type DailyEnergyReading,
} from '@/lib/energy-usage-series';
import type { EnergyReadingKind } from '@/lib/energy-usage-parser';
import type {
  EnergyHistoryNoteRecord,
  EnergyWeatherDatasetRecord,
  EnergyWeatherObservationRecord,
} from '@/lib/energy-temperature-storage';
import type { ResolvedUsageReading } from '@/lib/energy-usage-resolution';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface EnergyTemperatureAnalysisProps {
  readings: ResolvedUsageReading[];
  weatherDataset: EnergyWeatherDatasetRecord | null;
  weatherObservations: EnergyWeatherObservationRecord[];
  notes: EnergyHistoryNoteRecord[];
  billingMonths: EnergyBillingMonth[];
  periodStartMonth: string | null;
  periodEndMonth: string | null;
  costDataIsLoading: boolean;
  isLoading: boolean;
  error?: unknown;
  onUploadClick: () => void;
}

type MultiYearChartRow = Record<string, number | null> & { temperatureC: number };

interface ChartSeriesControl {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  dashed?: boolean;
  onToggle: () => void;
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

const EVENT_READING_KINDS: EnergyAnalysisReadingKind[] = [
  'total_consumption',
  'grid_import',
];

function buildMultiYearChartData(analysis: EnergyTemperatureAnalysis): MultiYearChartRow[] {
  const temperatures = Array.from(new Set(
    analysis.years.flatMap((series) => series.points.map((point) => point.temperatureC)),
  )).sort((temperatureA, temperatureB) => temperatureA - temperatureB);

  return temperatures.map((temperatureC) => {
    const row: MultiYearChartRow = { temperatureC };
    for (const series of analysis.years) {
      const point = series.points.find((candidate) => candidate.temperatureC === temperatureC);
      row[`energy_${series.year}`] = point?.averageKwh ?? null;
      const regression = series.regression;
      row[`trend_${series.year}`] = regression
        && temperatureC >= regression.startTemperatureC
        && temperatureC <= regression.endTemperatureC
        ? predictTemperatureRegression(temperatureC, regression)
        : null;
    }
    return row;
  });
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function ChartSeriesControls({
  label,
  controls,
}: {
  label: string;
  controls: ChartSeriesControl[];
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="mr-1 text-xs font-medium text-muted-foreground">{label}</span>
      {controls.map((control) => (
        <Button
          key={control.id}
          type="button"
          size="sm"
          variant={control.visible ? 'secondary' : 'outline'}
          className="h-8 gap-2 px-2.5 text-xs"
          aria-pressed={control.visible}
          data-testid={`temperature-series-toggle-${control.id}`}
          onClick={control.onToggle}
        >
          <span
            aria-hidden="true"
            className={control.dashed ? 'w-4 border-t-2 border-dashed' : 'w-4 border-t-2'}
            style={{ borderColor: control.color }}
          />
          {control.label}
        </Button>
      ))}
    </div>
  );
}

function AnalysisEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex min-h-48 flex-col items-center justify-center px-6 text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function EventImpactTooltip({
  active,
  payload,
  formatDate,
  formatNumber,
  formatSignedNumber,
  formatMoney,
  referenceLabel,
  comparisonLabel,
  sourceLabel,
  energyUnit,
  normalizedLabel,
  rawLabel,
  temperatureLabel,
  energyChangeLabel,
  costChangeLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload?: SeasonalEventImpact }>;
  formatDate: (date: string) => string;
  formatNumber: (value: number) => string;
  formatSignedNumber: (value: number) => string;
  formatMoney: (value: number) => string;
  referenceLabel: string;
  comparisonLabel: string;
  sourceLabel: (readingKind: EnergyAnalysisReadingKind) => string;
  energyUnit: string;
  normalizedLabel: string;
  rawLabel: string;
  temperatureLabel: string;
  energyChangeLabel: string;
  costChangeLabel: string;
}) {
  const impact = payload?.[0]?.payload;
  if (!active || !impact) return null;

  return (
    <div className="max-w-sm rounded-xl border border-border/80 bg-background/95 p-3 text-xs shadow-xl backdrop-blur">
      <p className="text-muted-foreground">{formatDate(impact.eventDate)}</p>
      <p className="mt-1 whitespace-pre-wrap font-medium">{impact.eventText}</p>
      <p className="mt-2 text-[11px] font-medium text-muted-foreground">
        {sourceLabel(impact.readingKind)}
      </p>
      <div className="mt-3 grid grid-cols-[minmax(5.5rem,1fr)_auto_auto] gap-x-4 gap-y-1.5 border-t border-border pt-2 tabular-nums">
        <span />
        <span className="text-right font-medium">{referenceLabel}</span>
        <span className="text-right font-medium">{comparisonLabel}</span>
        <span className="text-muted-foreground">{normalizedLabel}</span>
        <span className="text-right">{formatNumber(impact.referenceAverageKwh)} {energyUnit}</span>
        <span className="text-right">{formatNumber(impact.comparisonAverageKwh)} {energyUnit}</span>
        <span className="text-muted-foreground">{rawLabel}</span>
        <span className="text-right">{formatNumber(impact.referenceActualAverageKwh)} {energyUnit}</span>
        <span className="text-right">{formatNumber(impact.comparisonActualAverageKwh)} {energyUnit}</span>
        <span className="text-muted-foreground">{temperatureLabel}</span>
        <span className="text-right">{formatNumber(impact.referenceAverageTemperatureC)} °C</span>
        <span className="text-right">{formatNumber(impact.comparisonAverageTemperatureC)} °C</span>
      </div>
      <div className="mt-3 space-y-1.5 border-t border-border pt-2">
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">{energyChangeLabel}</span>
          <span className="font-medium tabular-nums">{formatSignedNumber(impact.changePercent)}%</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">{costChangeLabel}</span>
          <span className="font-medium tabular-nums">
            {impact.costChangeSek === null
              ? '–'
              : `${formatMoney(impact.costChangeSek)}${impact.costChangePercent === null ? '' : ` (${formatSignedNumber(impact.costChangePercent)}%)`}`}
          </span>
        </div>
      </div>
    </div>
  );
}

const EnergyTemperatureAnalysis: React.FC<EnergyTemperatureAnalysisProps> = ({
  readings,
  weatherDataset,
  weatherObservations,
  notes,
  billingMonths,
  periodStartMonth,
  periodEndMonth,
  costDataIsLoading,
  isLoading,
  error,
  onUploadClick,
}) => {
  const { t, language } = useLanguage();
  const [hiddenYearSeries, setHiddenYearSeries] = useState<Set<number>>(() => new Set());
  const [showYearTrendlines, setShowYearTrendlines] = useState(true);
  const [showOverallEnergy, setShowOverallEnergy] = useState(true);
  const [showOverallTrendline, setShowOverallTrendline] = useState(true);
  const [temperatureProfileView, setTemperatureProfileView] = useState<'years' | 'combined'>('years');
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const signedNumberFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }), [locale]);
  const moneyFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
    signDisplay: 'exceptZero',
  }), [locale]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }), [locale]);
  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }), [locale]);
  const allDailyReadings = useMemo(() => readings.map<DailyEnergyReading>((reading) => ({
    readingDate: reading.reading_date,
    consumptionKwh: reading.consumption_kwh,
    readingKind: reading.reading_kind as EnergyReadingKind,
  })), [readings]);
  const allEfficiencyReadings = useMemo(
    () => selectEfficiencyReadings(allDailyReadings),
    [allDailyReadings],
  );
  const efficiencyReadings = useMemo(() => allEfficiencyReadings.filter((reading) => {
    const monthKey = reading.readingDate.slice(0, 7);
    return (!periodStartMonth || monthKey >= periodStartMonth)
      && (!periodEndMonth || monthKey <= periodEndMonth);
  }), [allEfficiencyReadings, periodEndMonth, periodStartMonth]);
  const visibleWeatherObservations = useMemo(() => weatherObservations.filter((observation) => {
    const monthKey = observation.observed_on.slice(0, 7);
    return (!periodStartMonth || monthKey >= periodStartMonth)
      && (!periodEndMonth || monthKey <= periodEndMonth);
  }), [periodEndMonth, periodStartMonth, weatherObservations]);
  const analysis = useMemo(() => buildEnergyTemperatureAnalysis(
    efficiencyReadings.map((reading) => ({
      readingDate: reading.readingDate,
      consumptionKwh: reading.consumptionKwh,
      readingKind: reading.readingKind,
    })),
    visibleWeatherObservations.map((observation) => ({
      observedOn: observation.observed_on,
      temperatureC: observation.temperature_c,
    })),
  ), [efficiencyReadings, visibleWeatherObservations]);
  const multiYearChartData = useMemo(() => buildMultiYearChartData(analysis), [analysis]);
  const overallChartData = useMemo(() => analysis.overall.points.map((point) => ({
    temperatureC: point.temperatureC,
    averageKwh: point.averageKwh,
    trendKwh: analysis.overall.regression
      ? predictTemperatureRegression(point.temperatureC, analysis.overall.regression)
      : null,
  })), [analysis]);
  const normalizedHistory = useMemo(
    () => buildWeatherNormalizedHistory(analysis),
    [analysis],
  );
  const eventNormalizedHistories = useMemo(() => Object.fromEntries(
    EVENT_READING_KINDS.map((readingKind) => {
      const sourceAnalysis = buildEnergyTemperatureAnalysis(
        allDailyReadings
          .filter((reading) => reading.readingKind === readingKind)
          .map((reading) => ({
            readingDate: reading.readingDate,
            consumptionKwh: reading.consumptionKwh,
            readingKind,
          })),
        weatherObservations.map((observation) => ({
          observedOn: observation.observed_on,
          temperatureC: observation.temperature_c,
        })),
      );
      return [readingKind, buildWeatherNormalizedHistory(sourceAnalysis)];
    }),
  ) as Record<EnergyAnalysisReadingKind, WeatherNormalizedHistory | null>, [
    allDailyReadings,
    weatherObservations,
  ]);
  const analysisEvents = useMemo(() => notes
    .filter((note) => {
      const monthKey = note.note_date.slice(0, 7);
      return (!periodStartMonth || monthKey >= periodStartMonth)
        && (!periodEndMonth || monthKey <= periodEndMonth);
    })
    .map((note) => ({
      id: note.id,
      eventDate: note.note_date,
      eventText: note.event_text,
    })), [notes, periodEndMonth, periodStartMonth]);
  const eventImpacts = useMemo(() => {
    const impactsByReadingKind = new Map(EVENT_READING_KINDS.map((readingKind) => {
      const history = eventNormalizedHistories[readingKind];
      return [readingKind, history
        ? buildSeasonalEventImpacts(history, analysisEvents, billingMonths, readingKind)
        : []] as const;
    }));
    const impactsByEvent = new Map<string, SeasonalEventImpact>();
    for (const readingKind of EVENT_READING_KINDS) {
      for (const impact of impactsByReadingKind.get(readingKind) ?? []) {
        if (!impactsByEvent.has(impact.eventId)) impactsByEvent.set(impact.eventId, impact);
      }
    }
    return analysisEvents.flatMap((event) => {
      const impact = impactsByEvent.get(event.id);
      return impact ? [impact] : [];
    });
  }, [analysisEvents, billingMonths, eventNormalizedHistories]);
  const hasEventNormalizedHistory = EVENT_READING_KINDS.some(
    (readingKind) => eventNormalizedHistories[readingKind] !== null,
  );
  const normalizedEventMonths = useMemo(() => {
    const firstMonth = normalizedHistory?.months.at(0)?.monthKey;
    const lastMonth = normalizedHistory?.months.at(-1)?.monthKey;
    if (!firstMonth || !lastMonth) return [];
    return Array.from(new Set(
      analysisEvents
        .map((event) => event.eventDate.slice(0, 7))
        .filter((monthKey) => monthKey >= firstMonth && monthKey <= lastMonth),
    ));
  }, [analysisEvents, normalizedHistory]);
  const readingStart = efficiencyReadings[0]?.readingDate ?? null;
  const readingEnd = efficiencyReadings.at(-1)?.readingDate ?? null;
  const actualTotalDays = efficiencyReadings.filter(
    (reading) => reading.readingKind === 'total_consumption',
  ).length;
  const gridProxyDays = efficiencyReadings.length - actualTotalDays;
  const firstTotalConsumptionDate = efficiencyReadings.find(
    (reading) => reading.readingKind === 'total_consumption',
  )?.readingDate ?? null;
  const weatherStart = weatherObservations[0]?.observed_on ?? null;
  const weatherEnd = weatherObservations.at(-1)?.observed_on ?? null;
  const weatherError = errorMessage(error);
  const eventSourceLabel = (readingKind: EnergyAnalysisReadingKind) => (
    readingKind === 'total_consumption'
      ? t('Hela hemmets förbrukning', 'Whole-home consumption')
      : t('Köpt el från nätet', 'Electricity bought from the grid')
  );
  const toggleYearSeries = (year: number) => {
    setHiddenYearSeries((current) => {
      const next = new Set(current);
      if (next.has(year)) {
        next.delete(year);
      } else {
        next.add(year);
      }
      return next;
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex min-h-64 items-center justify-center">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden border-sky-200/80 bg-gradient-to-r from-sky-500/10 via-background to-amber-500/10 shadow-sm dark:border-sky-900/70">
        <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-sky-100 p-2.5 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
              <CloudSun className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium">{t('Automatisk temperaturdata från SMHI', 'Automatic temperature data from SMHI')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(
                  'Observerad dygnsmedeltemperatur från Stockholm-Observatoriekullen A hämtas automatiskt varje natt. Samma regionala temperaturserie används för alla hem i Stockholm/Täby-området – du behöver inte uppdatera den själv.',
                  'Observed daily mean temperature from Stockholm-Observatoriekullen A is collected automatically every night. The same regional temperature series is used for every home in the Stockholm/Täby area—you do not need to update it yourself.',
                )}
              </p>
              {weatherDataset && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('Station', 'Station')} {weatherDataset.station_id} · {weatherDataset.latitude.toFixed(4)}, {weatherDataset.longitude.toFixed(4)}
                  {weatherDataset.last_observation_date && (
                    <> · {t('senaste observation', 'latest observation')} {dateFormatter.format(new Date(`${weatherDataset.last_observation_date}T00:00:00Z`))}</>
                  )}
                </p>
              )}
            </div>
          </div>
          {weatherDataset?.source_url && (
            <Button type="button" size="sm" variant="outline" asChild>
              <a href={weatherDataset.source_url} target="_blank" rel="noreferrer">
                {t('Visa originaldata hos SMHI', 'View source data at SMHI')}
                <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </CardContent>
      </Card>

      {efficiencyReadings.length > 0 && (
        <Card className="border-border/70 bg-muted/20" data-testid="temperature-energy-source">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium">
                {t('Underlag för effektivitetsdiagrammen', 'Evidence used for the efficiency charts')}
              </p>
              <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                {actualTotalDays > 0
                  ? t(
                      `Husets verkliga totalförbrukning används när den finns${firstTotalConsumptionDate ? `, från ${firstTotalConsumptionDate}` : ''}. För tidigare dagar används nätuttag som proxy. Solpanelernas minskning av köpt el förväxlas därför inte med en plötslig förbättring av huset.`,
                      `Whole-home consumption is used whenever available${firstTotalConsumptionDate ? `, from ${firstTotalConsumptionDate}` : ''}. Grid import is used as a proxy for earlier days. The solar panels’ reduction in purchased electricity is therefore not mistaken for a sudden improvement in the building.`,
                    )
                  : t(
                      'Endast nätuttag finns. Det fungerar som proxy innan lokal produktion, men kan underskatta husets verkliga energibehov efter installation av sol eller batteri.',
                      'Only grid import is available. It works as a proxy before local generation, but can understate the home’s actual energy demand after solar or battery installation.',
                    )}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Badge variant="outline" className="border-teal-300 text-teal-700 dark:border-teal-800 dark:text-teal-300">
                {actualTotalDays} {t('totaldagar', 'whole-home days')}
              </Badge>
              <Badge variant="outline" className="border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300">
                {gridProxyDays} {t('proxy-dagar', 'proxy days')}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {weatherError && (
        <Alert variant="destructive">
          <AlertTitle>{t('Temperaturdata kunde inte läsas', 'Temperature data could not be loaded')}</AlertTitle>
          <AlertDescription>{weatherError}</AlertDescription>
        </Alert>
      )}

      {efficiencyReadings.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
            <Upload className="mb-4 h-10 w-10 text-muted-foreground" />
            <h2 className="text-lg font-medium">{t('Ladda upp daglig förbrukning först', 'Upload daily consumption first')}</h2>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              {t(
                'Ladda upp daglig energidata på fliken Data. När datumen matchar den gemensamma SMHI-serien byggs temperaturdiagrammen automatiskt.',
                'Upload daily energy data in the Data tab. Once the dates match the shared SMHI series, the temperature charts are built automatically.',
              )}
            </p>
            <Button type="button" className="mt-4" onClick={onUploadClick}>
              <Upload className="mr-2 h-4 w-4" />
              {t('Ladda upp energidata', 'Upload energy data')}
            </Button>
          </CardContent>
        </Card>
      ) : analysis.joinedPoints.length === 0 ? (
        <Alert className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
          <Thermometer className="h-4 w-4 text-amber-700 dark:text-amber-400" />
          <AlertTitle>{t('Inga matchande dagar ännu', 'No matching days yet')}</AlertTitle>
          <AlertDescription>
            {t(
              `Förbrukningen täcker ${readingStart && readingEnd ? `${readingStart} – ${readingEnd}` : 'en okänd period'}, medan temperaturserien täcker ${weatherStart && weatherEnd ? `${weatherStart} – ${weatherEnd}` : 'ingen period'}.`,
              `Your consumption covers ${readingStart && readingEnd ? `${readingStart} – ${readingEnd}` : 'an unknown period'}, while the temperature series covers ${weatherStart && weatherEnd ? `${weatherStart} – ${weatherEnd}` : 'no period yet'}.`,
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <Card className="border-border/70 bg-muted/20">
            <CardContent className="p-0">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4">
                  <span className="text-sm font-medium">
                    {t('Så läser du diagrammen', 'How to read the charts')}
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="grid gap-4 border-t border-border/60 p-4 text-sm text-muted-foreground md:grid-cols-2">
                  <div>
                    <p className="font-medium text-foreground">
                      {t('Jämförelse år för år', 'Year-by-year comparison')}
                    </p>
                    <p className="mt-1">
                      {t(
                        'Varje punkt visar genomsnittlig energianvändning för dagar med samma avrundade utomhustemperatur. Färgade årsserier och deras streckade trendlinjer gör det lättare att se om huset använder mer eller mindre energi vid samma väder efter exempelvis en renovering.',
                        'Each point shows average energy use for days with the same rounded outdoor temperature. Coloured yearly series and their dashed trend lines make it easier to see whether the home uses more or less energy in the same weather after changes such as a renovation.',
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-foreground">
                      {t('Samlad temperaturprofil', 'Combined temperature profile')}
                    </p>
                    <p className="mt-1">
                      {t(
                        'Det samlade diagrammet kombinerar alla matchande år och visar den typiska relationen mellan temperatur och dygnsförbrukning. R² anger hur väl trendlinjen beskriver mätpunkterna. Använd tidslinjen nedan för att markera förändringar som kan påverka jämförelsen.',
                        'The combined chart joins all matching years and shows the typical relationship between temperature and daily consumption. R² indicates how closely the trend line fits the measured points. Use the timeline below to mark changes that may affect the comparison.',
                      )}
                    </p>
                  </div>
                </div>
              </details>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent className="pt-5">
                <p className="text-sm text-muted-foreground">{t('Matchande dagar', 'Matched days')}</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{numberFormatter.format(analysis.joinedPoints.length)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('förbrukning + temperatur', 'consumption + temperature')}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <p className="text-sm text-muted-foreground">{t('Analyserade år', 'Analyzed years')}</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{analysis.years.length}</p>
                <p className="mt-1 text-xs text-muted-foreground">{analysis.years.map((series) => series.year).join(', ')}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <p className="text-sm text-muted-foreground">{t('Förbrukningsperiod', 'Consumption period')}</p>
                <p className="mt-2 text-sm font-semibold">{readingStart ? dateFormatter.format(new Date(`${readingStart}T00:00:00Z`)) : '-'}</p>
                <p className="mt-1 text-xs text-muted-foreground">{readingEnd ? dateFormatter.format(new Date(`${readingEnd}T00:00:00Z`)) : '-'}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <p className="text-sm text-muted-foreground">{t('Temperaturbinning', 'Temperature bins')}</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{analysis.overall.points.length}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('avrundat till hela °C', 'rounded to whole °C')}</p>
              </CardContent>
            </Card>
          </div>

          <Tabs defaultValue="history" className="space-y-5">
            <TabsList className="grid h-auto w-full grid-cols-3 gap-1 p-1 lg:max-w-2xl">
              <TabsTrigger value="history">{t('Utveckling', 'Trend')}</TabsTrigger>
              <TabsTrigger value="events">{t('Händelser', 'Events')}</TabsTrigger>
              <TabsTrigger value="profile">{t('Temperaturprofil', 'Temperature profile')}</TabsTrigger>
            </TabsList>

            <TabsContent value="history">
              {normalizedHistory && normalizedHistory.months.length > 0 ? (
              <Card className="overflow-hidden border-border/70 shadow-sm" data-testid="weather-normalized-history-chart">
              <CardHeader className="border-b border-border/60 bg-gradient-to-r from-teal-500/5 to-blue-500/5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">
                      {t('Vädernormaliserad förbrukning över tid', 'Weather-normalized consumption over time')}
                    </CardTitle>
                    <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                      {t(
                        'Varje månad räknas om till den förbrukning huset skulle haft vid 0 °C. Därmed speglar förändringar i linjen främst huset och användningen, inte om månaden råkade vara varm eller kall.',
                        'Each month is adjusted to the consumption the home would have had at 0 °C. Changes in the line therefore primarily reflect the home and its usage, rather than whether a month happened to be warm or cold.',
                      )}
                    </p>
                  </div>
                  <Badge variant="outline">{t('Referens', 'Reference')}: 0 °C</Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-5">
                <ResponsiveContainer width="100%" height={390}>
                  <LineChart
                    data={normalizedHistory.months}
                    margin={{ top: 16, right: 16, bottom: 20, left: 8 }}
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
                      label={{ value: t('kWh/dygn vid 0 °C', 'kWh/day at 0 °C'), angle: -90, position: 'insideLeft' }}
                      className="text-xs"
                    />
                    <Tooltip
                      formatter={(value: number) => [
                        `${numberFormatter.format(value)} kWh`,
                        t('Vädernormaliserad förbrukning', 'Weather-normalized consumption'),
                      ]}
                      labelFormatter={(monthKey: string) => monthFormatter.format(new Date(`${monthKey}-01T00:00:00Z`))}
                    />
                    {normalizedEventMonths.map((monthKey) => (
                      <ReferenceLine
                        key={monthKey}
                        x={monthKey}
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
                    ))}
                    <Line
                      type="monotone"
                      dataKey="averageNormalizedKwh"
                      name={t('Vädernormaliserad förbrukning', 'Weather-normalized consumption')}
                      stroke="#0f766e"
                      strokeWidth={3}
                      dot={{ r: 3, fill: '#fff', strokeWidth: 2 }}
                      activeDot={{ r: 5 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
              </Card>
              ) : (
                <AnalysisEmptyState
                  title={t('Mer temperaturvariation behövs', 'More temperature variation is needed')}
                  description={t(
                    'Den valda perioden har ännu inte tillräckligt många olika temperaturer för en stabil vädernormaliserad trend.',
                    'The selected period does not yet contain enough varied temperatures for a stable weather-normalized trend.',
                  )}
                />
              )}
            </TabsContent>

            <TabsContent value="events">
              {!hasEventNormalizedHistory ? (
                <AnalysisEmptyState
                  title={t('Mer historik behövs', 'More history is needed')}
                  description={t(
                    'Händelser kan jämföras när samma typ av energimätning har en stabil temperaturmodell och matchande dagar från året före.',
                    'Events can be compared once the same type of energy reading has a stable temperature model and matching days from the previous year.',
                  )}
                />
              ) : analysisEvents.length === 0 ? (
                <AnalysisEmptyState
                  title={t('Inga händelser under perioden', 'No events in this period')}
                  description={t(
                    'Lägg till en installation eller annan förändring under Jämförelser på Översikt för att följa resultatet här.',
                    'Add an installation or another change under Comparisons in Overview to track its result here.',
                  )}
                />
              ) : (
                <Card className="overflow-hidden border-border/70 shadow-sm" data-testid="event-impact-chart">
                  <CardHeader className="border-b border-border/60 bg-gradient-to-r from-amber-500/5 to-teal-500/5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-base">
                          {t('Resultat efter händelser', 'Results after events')}
                        </CardTitle>
                        <p className="mt-1 max-w-4xl text-xs text-muted-foreground">
                          {t(
                            'Staplarna jämför samma kalenderdagar året före och visar energi väderjusterad till 0 °C. Hela hemmets förbrukning används bara när den finns i båda perioderna; annars visas köpt el från nätet tydligt som ett mått på nätberoende. Rå förbrukning och medeltemperatur visas under diagrammet. Månadens fakturakostnad fördelas per kalenderdag, är inte vädernormaliserad och visas bara när kompletta nät- och elhandelskostnader täcker båda perioderna. Resultatet är en utfallsindikator, inte ett mått på enbart renoveringens effekt.',
                            'The bars compare the same calendar dates one year earlier and show energy weather-adjusted to 0 °C. Whole-home consumption is used only when both periods contain it; otherwise electricity bought from the grid is clearly labelled as a measure of grid dependence. Raw usage and average temperature appear below the chart. Monthly billed cost is allocated by calendar day, is not weather-normalized, and is shown only when complete grid and supplier costs cover both periods. The result is an outcome indicator, not a measurement of the renovation alone.',
                          )}
                        </p>
                      </div>
                      <Badge variant="outline">{t('3 månader · år mot år', '3 months · year over year')}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-5">
                    {eventImpacts.length === 0 ? (
                      <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-border px-6 text-center">
                        <p className="max-w-xl text-sm text-muted-foreground">
                          {t(
                            'Det finns ännu inte minst 30 dagpar med samma typ av energimätning efter händelsen och under samma period föregående år.',
                            'There are not yet at least 30 paired days with the same type of energy reading after an event and in the same period one year earlier.',
                          )}
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="mb-2 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-sm bg-slate-500" aria-hidden="true" />
                            {t('Samma period året före', 'Same period one year earlier')}
                          </span>
                          <span className="inline-flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-sm bg-teal-700" aria-hidden="true" />
                            {t('Efter händelsen', 'After the event')}
                          </span>
                        </div>
                        <ResponsiveContainer width="100%" height={330}>
                          <BarChart
                            data={eventImpacts}
                            margin={{ top: 16, right: 16, bottom: 28, left: 8 }}
                            barGap={6}
                          >
                            <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
                            <XAxis
                              dataKey="eventDate"
                              tickFormatter={(date) => dateFormatter.format(new Date(`${date}T00:00:00Z`))}
                              className="text-xs"
                            />
                            <YAxis
                              tickFormatter={(value) => numberFormatter.format(value)}
                              label={{ value: t('kWh/dygn vid 0 °C', 'kWh/day at 0 °C'), angle: -90, position: 'insideLeft' }}
                              className="text-xs"
                            />
                            <Tooltip
                              content={(
                                <EventImpactTooltip
                                  formatDate={(date) => dateFormatter.format(new Date(`${date}T00:00:00Z`))}
                                  formatNumber={(value) => numberFormatter.format(value)}
                                  formatSignedNumber={(value) => signedNumberFormatter.format(value)}
                                  formatMoney={(value) => moneyFormatter.format(value)}
                                  referenceLabel={t('Året före', 'Previous year')}
                                  comparisonLabel={t('Efter', 'After')}
                                  sourceLabel={eventSourceLabel}
                                  energyUnit={t('kWh/dygn', 'kWh/day')}
                                  normalizedLabel={t('Vid 0 °C', 'At 0 °C')}
                                  rawLabel={t('Rådata', 'Raw')}
                                  temperatureLabel={t('Utomhus', 'Outdoors')}
                                  energyChangeLabel={t('Väderjusterad skillnad', 'Weather-adjusted difference')}
                                  costChangeLabel={t('Beräknad fakturaskillnad (rå)', 'Estimated billed-cost difference (raw)')}
                                />
                              )}
                            />
                            <Bar
                              dataKey="referenceAverageKwh"
                              name={t('Samma period året före', 'Same period one year earlier')}
                              fill="#64748b"
                              radius={[4, 4, 0, 0]}
                            />
                            <Bar
                              dataKey="comparisonAverageKwh"
                              name={t('Efter händelsen', 'After the event')}
                              fill="#0f766e"
                              radius={[4, 4, 0, 0]}
                            />
                          </BarChart>
                        </ResponsiveContainer>
                        <div className="mt-4 grid gap-3 lg:grid-cols-2">
                          {eventImpacts.map((impact) => (
                            <div key={impact.eventId} className="rounded-xl border border-border/70 bg-muted/15 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                  <p className="text-xs text-muted-foreground">
                                    {dateFormatter.format(new Date(`${impact.eventDate}T00:00:00Z`))}
                                  </p>
                                  <p className="mt-1 text-sm font-medium">{impact.eventText}</p>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  <Badge variant="secondary">{eventSourceLabel(impact.readingKind)}</Badge>
                                  {!impact.completeWindow && (
                                    <Badge variant="outline">{t('Pågående', 'In progress')}</Badge>
                                  )}
                                </div>
                              </div>
                              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                {([
                                  {
                                    label: t('Samma period året före', 'Same period one year earlier'),
                                    startDate: impact.referenceStartDate,
                                    endDate: impact.referenceEndDate,
                                    normalizedKwh: impact.referenceAverageKwh,
                                    actualKwh: impact.referenceActualAverageKwh,
                                    temperatureC: impact.referenceAverageTemperatureC,
                                  },
                                  {
                                    label: t('Efter händelsen', 'After the event'),
                                    startDate: impact.comparisonStartDate,
                                    endDate: impact.comparisonEndDate,
                                    normalizedKwh: impact.comparisonAverageKwh,
                                    actualKwh: impact.comparisonActualAverageKwh,
                                    temperatureC: impact.comparisonAverageTemperatureC,
                                  },
                                ] as const).map((period) => (
                                  <div key={period.label} className="rounded-lg border border-border/60 bg-background/70 p-3">
                                    <p className="text-[11px] font-medium">{period.label}</p>
                                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                                      {dateFormatter.format(new Date(`${period.startDate}T00:00:00Z`))}
                                      {' – '}
                                      {dateFormatter.format(new Date(`${period.endDate}T00:00:00Z`))}
                                    </p>
                                    <p className="mt-2 text-base font-semibold tabular-nums">
                                      {numberFormatter.format(period.normalizedKwh)} {t('kWh/dygn vid 0 °C', 'kWh/day at 0 °C')}
                                    </p>
                                    <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                                      {t('Rådata', 'Raw')}: {numberFormatter.format(period.actualKwh)} {t('kWh/dygn', 'kWh/day')}
                                    </p>
                                    <p className="text-[11px] tabular-nums text-muted-foreground">
                                      {t('Medeltemperatur ute', 'Average outdoors')}: {numberFormatter.format(period.temperatureC)} °C
                                    </p>
                                  </div>
                                ))}
                              </div>
                              <div className="mt-3 grid grid-cols-2 gap-3">
                                <div>
                                  <p className="text-[11px] text-muted-foreground">
                                    {t('Väderjusterad skillnad', 'Weather-adjusted difference')}
                                  </p>
                                  <p className={`mt-1 text-lg font-semibold tabular-nums ${impact.changePercent <= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                                    {signedNumberFormatter.format(impact.changePercent)}%
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-muted-foreground">
                                    {t('Beräknad fakturaskillnad (rå)', 'Estimated billed-cost difference (raw)')}
                                  </p>
                                  <p className={`mt-1 text-lg font-semibold tabular-nums ${impact.costChangeSek === null ? 'text-foreground' : impact.costChangeSek <= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                                    {impact.costChangeSek === null
                                      ? costDataIsLoading ? t('Läser…', 'Loading…') : '–'
                                      : moneyFormatter.format(impact.costChangeSek)}
                                  </p>
                                  {impact.costChangePercent !== null && (
                                    <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                                      {signedNumberFormatter.format(impact.costChangePercent)}%
                                    </p>
                                  )}
                                </div>
                              </div>
                              <p className="mt-3 text-[11px] text-muted-foreground">
                                {impact.matchedDayCount} {t('matchade dagpar', 'matched day pairs')}
                                {impact.readingKind === 'grid_import'
                                  ? t(' · visar köpt el, inte hela hemmets energieffektivitet', ' · measures grid purchases, not whole-home efficiency')
                                  : ''}
                              </p>
                              {impact.costChangeSek === null && !costDataIsLoading && (
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  {t(
                                    'Fakturaskillnaden kräver kompletta nät- och elhandelskostnader för varje jämförd månad.',
                                    'Billed-cost difference requires complete grid and supplier costs for every compared month.',
                                  )}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>

          {analysis.overall.points.length > 0 && (
            <TabsContent value="profile">
              <Card className="overflow-hidden border-border/70 shadow-sm">
              <CardHeader className="border-b border-border/60 bg-gradient-to-r from-blue-500/5 via-background to-violet-500/5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">
                      {t('Energianvändning vid olika utomhustemperaturer', 'Energy use at different outdoor temperatures')}
                    </CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(
                        'Växla mellan årsserier för att se förändringar över tid och den samlade profilen för husets typiska temperaturrespons.',
                        'Switch between yearly series to see changes over time and the combined profile for the home’s typical temperature response.',
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex gap-1 rounded-lg bg-muted/60 p-1">
                      <Button
                        type="button"
                        size="sm"
                        variant={temperatureProfileView === 'years' ? 'default' : 'ghost'}
                        className="h-8"
                        onClick={() => setTemperatureProfileView('years')}
                      >
                        {t('År för år', 'By year')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={temperatureProfileView === 'combined' ? 'default' : 'ghost'}
                        className="h-8"
                        onClick={() => setTemperatureProfileView('combined')}
                      >
                        {t('Samlad profil', 'Combined')}
                      </Button>
                    </div>
                    <Badge variant="outline">{analysis.joinedPoints.length} {t('matchningar', 'matches')}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-5">
                {temperatureProfileView === 'years' ? (
                  <>
                    <ChartSeriesControls
                      label={t('Visa årsserier', 'Show year series')}
                      controls={[
                        ...analysis.years.map((series, index) => ({
                          id: `year-${series.year}`,
                          label: `${series.year}`,
                          color: YEAR_COLORS[index % YEAR_COLORS.length],
                          visible: !hiddenYearSeries.has(series.year),
                          onToggle: () => toggleYearSeries(series.year),
                        })),
                        {
                          id: 'year-trends',
                          label: t('Trendlinjer', 'Trend lines'),
                          color: '#64748b',
                          dashed: true,
                          visible: showYearTrendlines,
                          onToggle: () => setShowYearTrendlines((visible) => !visible),
                        },
                      ]}
                    />
                    <ResponsiveContainer width="100%" height={430}>
                      <LineChart data={multiYearChartData} margin={{ top: 16, right: 16, bottom: 34, left: 8 }} data-testid="temperature-year-chart">
                        <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
                        <XAxis type="number" dataKey="temperatureC" domain={['dataMin - 1', 'dataMax + 1']} tickFormatter={(value) => `${value}°`} label={{ value: t('Genomsnittlig dygnstemperatur (°C)', 'Average daily temperature (°C)'), position: 'insideBottom', offset: -12 }} className="text-xs" />
                        <YAxis tickFormatter={(value) => numberFormatter.format(value)} label={{ value: t('Energi (kWh/dygn)', 'Energy (kWh/day)'), angle: -90, position: 'insideLeft' }} className="text-xs" />
                        <Tooltip formatter={(value: number, name: string) => [`${numberFormatter.format(value)} kWh`, name]} labelFormatter={(label: number) => `${label} °C`} />
                        {analysis.years.map((series, index) => {
                          const color = YEAR_COLORS[index % YEAR_COLORS.length];
                          if (hiddenYearSeries.has(series.year)) return null;
                          return (
                            <React.Fragment key={series.year}>
                              <Line type="monotone" dataKey={`energy_${series.year}`} name={`${series.year}`} stroke={color} strokeWidth={2.5} dot={{ r: 4, fill: color, strokeWidth: 1 }} activeDot={{ r: 6 }} connectNulls />
                              {showYearTrendlines && series.regression && (
                                <Line type="monotone" dataKey={`trend_${series.year}`} name={`${series.year} ${t('trend', 'trend')} R²=${series.regression.rSquared.toFixed(3)}`} stroke={color} strokeWidth={2} strokeDasharray="7 5" dot={false} connectNulls />
                              )}
                            </React.Fragment>
                          );
                        })}
                      </LineChart>
                    </ResponsiveContainer>
                  </>
                ) : (
                  <>
                    <ChartSeriesControls
                      label={t('Visa serier', 'Show series')}
                      controls={[
                        { id: 'overall-energy', label: t('Genomsnittlig energianvändning', 'Average energy use'), color: '#2563eb', visible: showOverallEnergy, onToggle: () => setShowOverallEnergy((visible) => !visible) },
                        ...(analysis.overall.regression ? [{ id: 'overall-trend', label: t('Trendlinje', 'Trendline'), color: '#f97373', dashed: true, visible: showOverallTrendline, onToggle: () => setShowOverallTrendline((visible) => !visible) }] : []),
                      ]}
                    />
                    <ResponsiveContainer width="100%" height={430}>
                      <LineChart data={overallChartData} margin={{ top: 16, right: 16, bottom: 34, left: 8 }} data-testid="temperature-overall-chart">
                        <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
                        <XAxis type="number" dataKey="temperatureC" domain={['dataMin - 1', 'dataMax + 1']} tickFormatter={(value) => `${value}°`} label={{ value: t('Genomsnittlig dygnstemperatur (°C)', 'Average daily temperature (°C)'), position: 'insideBottom', offset: -12 }} className="text-xs" />
                        <YAxis tickFormatter={(value) => numberFormatter.format(value)} label={{ value: t('Energi (kWh/dygn)', 'Energy (kWh/day)'), angle: -90, position: 'insideLeft' }} className="text-xs" />
                        <Tooltip formatter={(value: number, name: string) => [`${numberFormatter.format(value)} kWh`, name]} labelFormatter={(label: number) => `${label} °C`} />
                        {showOverallEnergy && <Line type="monotone" dataKey="averageKwh" name={t('Genomsnittlig energianvändning', 'Average energy use')} stroke="#2563eb" strokeWidth={2.5} dot={{ r: 5, fill: '#2563eb', strokeWidth: 1 }} activeDot={{ r: 6 }} connectNulls />}
                        {showOverallTrendline && analysis.overall.regression && <Line type="monotone" dataKey="trendKwh" name={t('Kvadratisk trendlinje', 'Quadratic trendline')} stroke="#f97373" strokeWidth={2.5} strokeDasharray="7 5" dot={false} connectNulls />}
                      </LineChart>
                    </ResponsiveContainer>
                  </>
                )}
              </CardContent>
              </Card>
            </TabsContent>
          )}
          </Tabs>
        </>
      )}

    </div>
  );
};

export default EnergyTemperatureAnalysis;
