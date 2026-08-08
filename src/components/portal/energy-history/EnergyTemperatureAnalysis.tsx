import React, { useMemo, useState } from 'react';
import {
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
  buildWeatherNormalizedEventImpacts,
  buildWeatherNormalizedHistory,
  predictTemperatureRegression,
  type EnergyTemperatureAnalysis,
  type WeatherNormalizedEventImpact,
} from '@/lib/energy-temperature-analysis';
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

interface EnergyTemperatureAnalysisProps {
  readings: ResolvedUsageReading[];
  weatherDataset: EnergyWeatherDatasetRecord | null;
  weatherObservations: EnergyWeatherObservationRecord[];
  notes: EnergyHistoryNoteRecord[];
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

function EventImpactTooltip({
  active,
  payload,
  formatDate,
  formatNumber,
  formatSignedNumber,
  beforeLabel,
  afterLabel,
  changeLabel,
  annualizedLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload?: WeatherNormalizedEventImpact }>;
  formatDate: (date: string) => string;
  formatNumber: (value: number) => string;
  formatSignedNumber: (value: number) => string;
  beforeLabel: string;
  afterLabel: string;
  changeLabel: string;
  annualizedLabel: string;
}) {
  const impact = payload?.[0]?.payload;
  if (!active || !impact) return null;

  return (
    <div className="max-w-sm rounded-xl border border-border/80 bg-background/95 p-3 text-xs shadow-xl backdrop-blur">
      <p className="text-muted-foreground">{formatDate(impact.eventDate)}</p>
      <p className="mt-1 whitespace-pre-wrap font-medium">{impact.eventText}</p>
      <div className="mt-3 space-y-1.5 border-t border-border pt-2">
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">{beforeLabel}</span>
          <span className="font-medium tabular-nums">{formatNumber(impact.beforeAverageKwh)} kWh</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">{afterLabel}</span>
          <span className="font-medium tabular-nums">{formatNumber(impact.afterAverageKwh)} kWh</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">{changeLabel}</span>
          <span className="font-medium tabular-nums">{formatSignedNumber(impact.changePercent)}%</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">{annualizedLabel}</span>
          <span className="font-medium tabular-nums">{formatSignedNumber(impact.annualizedChangeKwh)} kWh</span>
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
  isLoading,
  error,
  onUploadClick,
}) => {
  const { t, language } = useLanguage();
  const [hiddenYearSeries, setHiddenYearSeries] = useState<Set<number>>(() => new Set());
  const [showYearTrendlines, setShowYearTrendlines] = useState(true);
  const [showOverallEnergy, setShowOverallEnergy] = useState(true);
  const [showOverallTrendline, setShowOverallTrendline] = useState(true);
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const signedNumberFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
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
  const efficiencyReadings = useMemo(() => selectEfficiencyReadings(
    readings.map<DailyEnergyReading>((reading) => ({
      readingDate: reading.reading_date,
      consumptionKwh: reading.consumption_kwh,
      readingKind: reading.reading_kind as EnergyReadingKind,
    })),
  ), [readings]);
  const analysis = useMemo(() => buildEnergyTemperatureAnalysis(
    efficiencyReadings.map((reading) => ({
      readingDate: reading.readingDate,
      consumptionKwh: reading.consumptionKwh,
    })),
    weatherObservations.map((observation) => ({
      observedOn: observation.observed_on,
      temperatureC: observation.temperature_c,
    })),
  ), [efficiencyReadings, weatherObservations]);
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
  const analysisEvents = useMemo(() => notes.map((note) => ({
    id: note.id,
    eventDate: note.note_date,
    eventText: note.event_text,
  })), [notes]);
  const eventImpacts = useMemo(
    () => normalizedHistory
      ? buildWeatherNormalizedEventImpacts(normalizedHistory, analysisEvents)
      : [],
    [analysisEvents, normalizedHistory],
  );
  const normalizedEventMonths = useMemo(() => {
    const firstMonth = normalizedHistory?.months.at(0)?.monthKey;
    const lastMonth = normalizedHistory?.months.at(-1)?.monthKey;
    if (!firstMonth || !lastMonth) return [];
    return Array.from(new Set(
      notes
        .map((note) => note.note_date.slice(0, 7))
        .filter((monthKey) => monthKey >= firstMonth && monthKey <= lastMonth),
    ));
  }, [normalizedHistory, notes]);
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
                'Ladda upp daglig energidata i fliken Ladda upp. När datumen matchar den gemensamma SMHI-serien byggs temperaturdiagrammen automatiskt.',
                'Upload daily energy data in the Upload tab. Once the dates match the shared SMHI series, the temperature charts are built automatically.',
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
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {t('Så läser du diagrammen', 'How to read the charts')}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 pt-0 text-sm text-muted-foreground md:grid-cols-2">
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

          {normalizedHistory && normalizedHistory.months.length > 0 && (
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
          )}

          {normalizedHistory && notes.length > 0 && (
            <Card className="overflow-hidden border-border/70 shadow-sm" data-testid="event-impact-chart">
              <CardHeader className="border-b border-border/60 bg-gradient-to-r from-amber-500/5 to-teal-500/5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">
                      {t('Förbrukning före och efter händelser', 'Consumption before and after events')}
                    </CardTitle>
                    <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                      {t(
                        'Jämför vädernormaliserad genomsnittlig dygnsförbrukning under 90 dagar före och efter varje händelse. Minst 30 matchande dagar krävs på vardera sidan. Resultatet är en indikation, inte ett bevis på orsak.',
                        'Compares weather-normalized average daily consumption during the 90 days before and after each event. At least 30 matched days are required on each side. The result is an indication, not proof of causation.',
                      )}
                    </p>
                  </div>
                  <Badge variant="outline">{t('90 dagar före/efter', '90 days before/after')}</Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-5">
                {eventImpacts.length === 0 ? (
                  <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-border px-6 text-center">
                    <p className="max-w-xl text-sm text-muted-foreground">
                      {t(
                        'Det finns ännu inte minst 30 matchande förbruknings- och temperaturdagar både före och efter någon registrerad händelse.',
                        'There are not yet at least 30 matched consumption and temperature days both before and after a recorded event.',
                      )}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="mb-2 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-sm bg-slate-500" aria-hidden="true" />
                        {t('90 dagar före', '90 days before')}
                      </span>
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-sm bg-teal-700" aria-hidden="true" />
                        {t('90 dagar efter', '90 days after')}
                      </span>
                    </div>
                    <ResponsiveContainer width="100%" height={350}>
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
                              beforeLabel={t('Före', 'Before')}
                              afterLabel={t('Efter', 'After')}
                              changeLabel={t('Förändring', 'Change')}
                              annualizedLabel={t('Årsberäknad förändring', 'Annualized change')}
                            />
                          )}
                        />
                        <Bar
                          dataKey="beforeAverageKwh"
                          name={t('90 dagar före', '90 days before')}
                          fill="#64748b"
                          radius={[4, 4, 0, 0]}
                        />
                        <Bar
                          dataKey="afterAverageKwh"
                          name={t('90 dagar efter', '90 days after')}
                          fill="#0f766e"
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {analysis.years.length > 0 && (
            <Card className="overflow-hidden border-border/70 shadow-sm">
              <CardHeader className="border-b border-border/60 bg-gradient-to-r from-blue-500/5 to-amber-500/5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">
                      {t('Genomsnittlig energianvändning baserat på utomhustemperatur', 'Average energy usage based on outside temperature')}
                    </CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('Årsserier med kvadratiska trendlinjer. Punkterna är dygnsmedel grupperade per hel grad.', 'Year series with quadratic trend lines. Points are daily readings grouped by whole degree.')}
                    </p>
                  </div>
                  <Badge variant="outline">{analysis.joinedPoints.length} {t('matchningar', 'matches')}</Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-5">
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
                    <XAxis
                      type="number"
                      dataKey="temperatureC"
                      domain={['dataMin - 1', 'dataMax + 1']}
                      tickFormatter={(value) => `${value}°`}
                      label={{ value: t('Genomsnittlig dygnstemperatur (°C)', 'Average daily temperature (°C)'), position: 'insideBottom', offset: -12 }}
                      className="text-xs"
                    />
                    <YAxis
                      tickFormatter={(value) => numberFormatter.format(value)}
                      label={{ value: t('Energi (kWh/dygn)', 'Energy (kWh/day)'), angle: -90, position: 'insideLeft' }}
                      className="text-xs"
                    />
                    <Tooltip
                      formatter={(value: number, name: string) => [
                        `${numberFormatter.format(value)} kWh`,
                        name,
                      ]}
                      labelFormatter={(label: number) => `${label} °C`}
                    />
                    {analysis.years.map((series, index) => {
                      const color = YEAR_COLORS[index % YEAR_COLORS.length];
                      const visible = !hiddenYearSeries.has(series.year);
                      if (!visible) return null;
                      return (
                        <React.Fragment key={series.year}>
                          <Line
                            type="monotone"
                            dataKey={`energy_${series.year}`}
                            name={`${series.year}`}
                            stroke={color}
                            strokeWidth={2.5}
                            dot={{ r: 4, fill: color, strokeWidth: 1 }}
                            activeDot={{ r: 6 }}
                            connectNulls
                          />
                          {showYearTrendlines && series.regression && (
                            <Line
                              type="monotone"
                              dataKey={`trend_${series.year}`}
                              name={`${series.year} ${t('trend', 'trend')} R²=${series.regression.rSquared.toFixed(3)}`}
                              stroke={color}
                              strokeWidth={2}
                              strokeDasharray="7 5"
                              dot={false}
                              connectNulls
                            />
                          )}
                        </React.Fragment>
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {analysis.overall.points.length > 0 && (
            <Card className="overflow-hidden border-border/70 shadow-sm">
              <CardHeader className="border-b border-border/60 bg-gradient-to-r from-blue-500/5 to-violet-500/5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">
                      {t('Genomsnittlig energianvändning vid olika temperaturer', 'Average energy usage at different temperatures')}
                    </CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('Alla matchande år samlade i samma temperaturprofil.', 'All matched years combined into one temperature profile.')}
                    </p>
                  </div>
                  {analysis.overall.regression && (
                    <Badge variant="outline">
                      R² = {analysis.overall.regression.rSquared.toFixed(3)}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-5">
                <ChartSeriesControls
                  label={t('Visa serier', 'Show series')}
                  controls={[
                    {
                      id: 'overall-energy',
                      label: t('Genomsnittlig energianvändning', 'Average energy use'),
                      color: '#2563eb',
                      visible: showOverallEnergy,
                      onToggle: () => setShowOverallEnergy((visible) => !visible),
                    },
                    ...(analysis.overall.regression ? [{
                      id: 'overall-trend',
                      label: t('Trendlinje', 'Trendline'),
                      color: '#f97373',
                      dashed: true,
                      visible: showOverallTrendline,
                      onToggle: () => setShowOverallTrendline((visible) => !visible),
                    }] : []),
                  ]}
                />
                <ResponsiveContainer width="100%" height={430}>
                  <LineChart data={overallChartData} margin={{ top: 16, right: 16, bottom: 34, left: 8 }} data-testid="temperature-overall-chart">
                    <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
                    <XAxis
                      type="number"
                      dataKey="temperatureC"
                      domain={['dataMin - 1', 'dataMax + 1']}
                      tickFormatter={(value) => `${value}°`}
                      label={{ value: t('Genomsnittlig dygnstemperatur (°C)', 'Average daily temperature (°C)'), position: 'insideBottom', offset: -12 }}
                      className="text-xs"
                    />
                    <YAxis
                      tickFormatter={(value) => numberFormatter.format(value)}
                      label={{ value: t('Energi (kWh/dygn)', 'Energy (kWh/day)'), angle: -90, position: 'insideLeft' }}
                      className="text-xs"
                    />
                    <Tooltip
                      formatter={(value: number, name: string) => [
                        `${numberFormatter.format(value)} kWh`,
                        name,
                      ]}
                      labelFormatter={(label: number) => `${label} °C`}
                    />
                    {showOverallEnergy && <Line
                      type="monotone"
                      dataKey="averageKwh"
                      name={t('Genomsnittlig energianvändning', 'Average energy use')}
                      stroke="#2563eb"
                      strokeWidth={2.5}
                      dot={{ r: 5, fill: '#2563eb', strokeWidth: 1 }}
                      activeDot={{ r: 6 }}
                      connectNulls
                    />}
                    {showOverallTrendline && analysis.overall.regression && (
                      <Line
                        type="monotone"
                        dataKey="trendKwh"
                        name={t('Kvadratisk trendlinje', 'Quadratic trendline')}
                        stroke="#f97373"
                        strokeWidth={2.5}
                        strokeDasharray="7 5"
                        dot={false}
                        connectNulls
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </>
      )}

    </div>
  );
};

export default EnergyTemperatureAnalysis;
