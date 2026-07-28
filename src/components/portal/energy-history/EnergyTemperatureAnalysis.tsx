import React, { useMemo } from 'react';
import {
  CloudSun,
  ExternalLink,
  Loader2,
  Thermometer,
  Upload,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  buildEnergyTemperatureAnalysis,
  predictTemperatureRegression,
  type EnergyTemperatureAnalysis,
} from '@/lib/energy-temperature-analysis';
import type {
  EnergyHistoryNoteRecord,
  EnergyUsageReadingRecord,
  EnergyWeatherDatasetRecord,
  EnergyWeatherObservationRecord,
} from '@/lib/energy-temperature-storage';
import EnergyHistoryTimeline from '@/components/portal/energy-history/EnergyHistoryTimeline';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface EnergyTemperatureAnalysisProps {
  readings: EnergyUsageReadingRecord[];
  weatherDataset: EnergyWeatherDatasetRecord | null;
  weatherObservations: EnergyWeatherObservationRecord[];
  notes: EnergyHistoryNoteRecord[];
  isLoading: boolean;
  error?: unknown;
  notesError?: unknown;
  isStaff: boolean;
  currentUserId: string | null;
  onUploadClick: () => void;
  onCreateNote: EnergyHistoryTimelineProps['onCreate'];
  onUpdateNote: EnergyHistoryTimelineProps['onUpdate'];
  onDeleteNote: EnergyHistoryTimelineProps['onDelete'];
}

type EnergyHistoryTimelineProps = React.ComponentProps<typeof EnergyHistoryTimeline>;
type MultiYearChartRow = Record<string, number | null> & { temperatureC: number };

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

const EnergyTemperatureAnalysis: React.FC<EnergyTemperatureAnalysisProps> = ({
  readings,
  weatherDataset,
  weatherObservations,
  notes,
  isLoading,
  error,
  notesError,
  isStaff,
  currentUserId,
  onUploadClick,
  onCreateNote,
  onUpdateNote,
  onDeleteNote,
}) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }), [locale]);
  const analysis = useMemo(() => buildEnergyTemperatureAnalysis(
    readings.map((reading) => ({
      readingDate: reading.reading_date,
      consumptionKwh: reading.consumption_kwh,
    })),
    weatherObservations.map((observation) => ({
      observedOn: observation.observed_on,
      temperatureC: observation.temperature_c,
    })),
  ), [readings, weatherObservations]);
  const multiYearChartData = useMemo(() => buildMultiYearChartData(analysis), [analysis]);
  const overallChartData = useMemo(() => analysis.overall.points.map((point) => ({
    temperatureC: point.temperatureC,
    averageKwh: point.averageKwh,
    trendKwh: analysis.overall.regression
      ? predictTemperatureRegression(point.temperatureC, analysis.overall.regression)
      : null,
  })), [analysis]);
  const readingStart = readings[0]?.reading_date ?? null;
  const readingEnd = readings.at(-1)?.reading_date ?? null;
  const weatherStart = weatherObservations[0]?.observed_on ?? null;
  const weatherEnd = weatherObservations.at(-1)?.observed_on ?? null;
  const weatherError = errorMessage(error);
  const timelineError = errorMessage(notesError);

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

      {weatherError && (
        <Alert variant="destructive">
          <AlertTitle>{t('Temperaturdata kunde inte läsas', 'Temperature data could not be loaded')}</AlertTitle>
          <AlertDescription>{weatherError}</AlertDescription>
        </Alert>
      )}

      {readings.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
            <Upload className="mb-4 h-10 w-10 text-muted-foreground" />
            <h2 className="text-lg font-medium">{t('Ladda upp daglig förbrukning först', 'Upload daily consumption first')}</h2>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              {t(
                'Ladda upp CSV-filer i fliken Ladda upp. När datumen matchar den gemensamma SMHI-serien byggs temperaturdiagrammen automatiskt.',
                'Upload CSV files in the Upload tab. Once the dates match the shared SMHI series, the temperature charts are built automatically.',
              )}
            </p>
            <Button type="button" className="mt-4" onClick={onUploadClick}>
              <Upload className="mr-2 h-4 w-4" />
              {t('Ladda upp CSV', 'Upload CSV')}
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
                <ResponsiveContainer width="100%" height={430}>
                  <LineChart data={multiYearChartData} margin={{ top: 16, right: 16, bottom: 24, left: 8 }}>
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
                    <Legend />
                    {analysis.years.map((series, index) => {
                      const color = YEAR_COLORS[index % YEAR_COLORS.length];
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
                            connectNulls={false}
                          />
                          {series.regression && (
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
                <ResponsiveContainer width="100%" height={430}>
                  <LineChart data={overallChartData} margin={{ top: 16, right: 16, bottom: 24, left: 8 }}>
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
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="averageKwh"
                      name={t('Genomsnittlig energianvändning', 'Average energy use')}
                      stroke="#2563eb"
                      strokeWidth={2.5}
                      dot={{ r: 5, fill: '#2563eb', strokeWidth: 1 }}
                      activeDot={{ r: 6 }}
                    />
                    {analysis.overall.regression && (
                      <Line
                        type="monotone"
                        dataKey="trendKwh"
                        name={t('Kvadratisk trendlinje', 'Quadratic trendline')}
                        stroke="#f97373"
                        strokeWidth={2.5}
                        strokeDasharray="7 5"
                        dot={false}
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {timelineError && (
        <Alert variant="destructive">
          <AlertTitle>{t('Tidslinjeanteckningar kunde inte läsas', 'Timeline notes could not be loaded')}</AlertTitle>
          <AlertDescription>{timelineError}</AlertDescription>
        </Alert>
      )}
      <EnergyHistoryTimeline
        notes={notes}
        currentUserId={currentUserId}
        isStaff={isStaff}
        onCreate={onCreateNote}
        onUpdate={onUpdateNote}
        onDelete={onDeleteNote}
      />
    </div>
  );
};

export default EnergyTemperatureAnalysis;
