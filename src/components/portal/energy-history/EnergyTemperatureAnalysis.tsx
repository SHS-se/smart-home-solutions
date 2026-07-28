import React, { useMemo } from 'react';
import {
  CloudSun,
  ExternalLink,
  Loader2,
  RefreshCw,
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
  isRefreshingWeather: boolean;
  onUploadClick: () => void;
  onRefreshWeather: () => Promise<void>;
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

function regressionValue(
  temperatureC: number,
  regression: NonNullable<EnergyTemperatureAnalysis['overall']['regression']>,
): number {
  if (regression.startTemperatureC === regression.endTemperatureC) return regression.startKwh;
  const ratio = (temperatureC - regression.startTemperatureC)
    / (regression.endTemperatureC - regression.startTemperatureC);
  return regression.startKwh + (ratio * (regression.endKwh - regression.startKwh));
}

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
        ? regressionValue(temperatureC, regression)
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
  isRefreshingWeather,
  onUploadClick,
  onRefreshWeather,
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
      ? regressionValue(point.temperatureC, analysis.overall.regression)
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
              <p className="text-sm font-medium">{t('Gemensam temperaturkälla', 'Shared temperature source')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {weatherDataset?.source_name ?? t('SMHI-data saknas ännu', 'SMHI data is not available yet')}
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
          <div className="flex flex-wrap items-center gap-2">
            {weatherDataset?.source_url && (
              <Button type="button" size="sm" variant="outline" asChild>
                <a href={weatherDataset.source_url} target="_blank" rel="noreferrer">
                  {t('Öppna SMHI-källa', 'Open SMHI source')}
                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
            )}
            {isStaff && (
              <Button type="button" size="sm" onClick={() => void onRefreshWeather()} disabled={isRefreshingWeather}>
                {isRefreshingWeather ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                {t('Uppdatera väderdata', 'Refresh weather data')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {weatherDataset?.sync_error && (
        <Alert className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
          <AlertTitle>{t('Temperaturdata kunde inte uppdateras', 'Temperature data could not be refreshed')}</AlertTitle>
          <AlertDescription>{weatherDataset.sync_error}</AlertDescription>
        </Alert>
      )}
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
                      {t('Årsserier med trendlinje. Punkterna är dygnsmedel grupperade per hel grad.', 'Year series with trend lines. Points are daily readings grouped by whole degree.')}
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
                      const rSquared = series.regression?.rSquared;
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
                          <Line
                            type="linear"
                            dataKey={`trend_${series.year}`}
                            name={`${series.year} ${t('trend', 'trend')} R²=${rSquared === undefined || rSquared === null ? '-' : rSquared.toFixed(3)}`}
                            stroke={color}
                            strokeWidth={2}
                            strokeDasharray="7 5"
                            dot={false}
                            connectNulls
                          />
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
                  {analysis.overall.regression?.rSquared !== null && analysis.overall.regression?.rSquared !== undefined && (
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
                    <Line
                      type="linear"
                      dataKey="trendKwh"
                      name={t('Trendlinje', 'Trendline')}
                      stroke="#f97373"
                      strokeWidth={2.5}
                      strokeDasharray="7 5"
                      dot={false}
                    />
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
        onCreate={onCreateNote}
        onUpdate={onUpdateNote}
        onDelete={onDeleteNote}
      />
    </div>
  );
};

export default EnergyTemperatureAnalysis;
