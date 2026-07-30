import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Gauge, HousePlug, Info, Loader2 } from 'lucide-react';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  computeEnergiprestanda,
  ENERGY_CLASS_BANDS,
  EP_EXCLUDED_CATEGORIES,
  NEW_BUILD_REQUIREMENT_KWH_M2,
  type DailyCategoryReading,
  type DailyTemperature,
} from '@/lib/energiprestanda';

const CLASS_COLORS: Record<string, string> = {
  A: '#1e9e3e',
  B: '#62b432',
  C: '#b3d334',
  D: '#f2e30c',
  E: '#f0a01e',
  F: '#e26b23',
  G: '#d62839',
};

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

interface EnergiprestandaSectionProps {
  readings: DailyCategoryReading[];
  weatherObservations: DailyTemperature[];
  atempM2: number | null;
  isLoading: boolean;
  error: unknown;
}

const round = (value: number, decimals = 0): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

function categoryLabel(category: string, t: (sv: string, en: string) => string): string {
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

const EnergiprestandaSection: React.FC<EnergiprestandaSectionProps> = ({
  readings,
  weatherObservations,
  atempM2,
  isLoading,
  error,
}) => {
  const { t } = useLanguage();

  const result = useMemo(
    () => computeEnergiprestanda(readings, atempM2, weatherObservations),
    [readings, atempM2, weatherObservations],
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
    return [
      'heating', 'hot_water', 'cooling', 'property_energy',
      'household', 'ev_charging', 'pool_heating',
    ].filter((c) => present.has(c));
  }, [readings]);

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

  if (readings.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex min-h-64 flex-col items-center justify-center text-center">
          <HousePlug className="mb-4 h-10 w-10 text-muted-foreground" />
          <h2 className="text-lg font-medium">
            {t('Ingen Home Assistant-data ännu', 'No Home Assistant data yet')}
          </h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            {t(
              'Koppla din Home Assistant på kontosidan så skickas daglig energianvändning per kategori hit automatiskt.',
              'Connect your Home Assistant on the Account page and daily energy use per category will be pushed here automatically.',
            )}
          </p>
          <Button asChild className="mt-4" size="sm">
            <Link to="/portal/account">{t('Till kontosidan', 'Go to Account')}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-5 w-5" />
            {t('Energiprestanda (primärenergital)', 'Energy performance (primary energy number)')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {result.reason === 'insufficient_coverage' ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                {t(
                  `För få dagar med data ännu (${result.coverageDays} av minst 30). Beräkningen visas när mer data har samlats in.`,
                  `Too few days of data so far (${result.coverageDays} of at least 30). The calculation appears once more data has been collected.`,
                )}
              </AlertDescription>
            </Alert>
          ) : result.reason === 'missing_atemp' ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                {t(
                  'Uppvärmd boarea/biarea saknas i din hemprofil, så primärenergitalet kan inte beräknas per kvadratmeter. Fyll i areorna i hemprofilen.',
                  'Heated boarea/biarea is missing from your home profile, so the primary energy number per square metre cannot be calculated. Fill in the areas in your home profile.',
                )}
              </AlertDescription>
            </Alert>
          ) : result.ep !== null ? (
            <>
              <div className="flex flex-wrap items-end gap-6">
                <div>
                  <div className="flex items-end gap-2">
                    <span className="text-5xl font-semibold leading-none">
                      {round(result.ep)}
                    </span>
                    <span className="pb-1 text-sm text-muted-foreground">
                      kWh/m²·{t('år', 'yr')}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('Rullande 12 månader t.o.m.', 'Rolling 12 months up to')}{' '}
                    {result.windowEnd}
                    {' · '}
                    {t(`${result.coverageDays} dagar med data`, `${result.coverageDays} days of data`)}
                  </p>
                </div>
                <div
                  className="flex h-14 w-14 items-center justify-center rounded-md text-2xl font-bold text-white"
                  style={{ backgroundColor: CLASS_COLORS[result.energyClass ?? 'G'] }}
                  data-testid="energy-class-badge"
                >
                  {result.energyClass}
                </div>
              </div>

              <div>
                <div className="flex h-6 w-full overflow-hidden rounded-md">
                  {ENERGY_CLASS_BANDS.map((band) => (
                    <div
                      key={band.label}
                      className="relative flex-1 text-center text-xs font-semibold leading-6 text-white"
                      style={{ backgroundColor: CLASS_COLORS[band.label] }}
                    >
                      {band.label}
                      {band.label === result.energyClass && (
                        <div className="absolute inset-x-0 -bottom-0.5 mx-auto h-1 w-8 rounded bg-foreground" />
                      )}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(
                    `Klassgränser utifrån nybyggnadskravet ${NEW_BUILD_REQUIREMENT_KWH_M2} kWh/m²·år för småhus: A ≤ ${round(NEW_BUILD_REQUIREMENT_KWH_M2 * 0.5)}, B ≤ ${round(NEW_BUILD_REQUIREMENT_KWH_M2 * 0.75)}, C ≤ ${NEW_BUILD_REQUIREMENT_KWH_M2}.`,
                    `Class limits relative to the ${NEW_BUILD_REQUIREMENT_KWH_M2} kWh/m²·yr new-build requirement for houses: A ≤ ${round(NEW_BUILD_REQUIREMENT_KWH_M2 * 0.5)}, B ≤ ${round(NEW_BUILD_REQUIREMENT_KWH_M2 * 0.75)}, C ≤ ${NEW_BUILD_REQUIREMENT_KWH_M2}.`,
                  )}
                </p>
              </div>

              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <div className="rounded-md border border-border p-3">
                  <div className="font-medium">{t('Ingår i beräkningen', 'Included in the calculation')}</div>
                  <table className="mt-2 w-full text-xs">
                    <tbody>
                      <tr>
                        <td>{t('Uppvärmning (graddagskorrigerad)', 'Heating (degree-day corrected)')}</td>
                        <td className="text-right font-mono">
                          {round(result.correctedHeatingKwh ?? 0)} kWh
                        </td>
                      </tr>
                      <tr>
                        <td>{t('Tappvarmvatten (schablon 20 × Atemp)', 'Hot water (standard 20 × Atemp)')}</td>
                        <td className="text-right font-mono">
                          {round(result.standardHotWaterKwh ?? 0)} kWh
                        </td>
                      </tr>
                      <tr>
                        <td>{t('Komfortkyla', 'Comfort cooling')}</td>
                        <td className="text-right font-mono">
                          {round(result.annualizedIncludedKwh?.cooling ?? 0)} kWh
                        </td>
                      </tr>
                      <tr>
                        <td>{t('Fastighetsenergi', 'Property energy')}</td>
                        <td className="text-right font-mono">
                          {round(result.annualizedIncludedKwh?.property_energy ?? 0)} kWh
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(
                      `Uppmätt tappvarmvatten (${round(result.measuredKwh.hot_water ?? 0)} kWh) ersätts med schablonen enligt BEN. Viktningsfaktor el 1,8.`,
                      `Measured hot water (${round(result.measuredKwh.hot_water ?? 0)} kWh) is replaced by the BEN standard value. Electricity weighting factor 1.8.`,
                    )}
                    {result.degreeDayFactor !== null
                      ? ` ${t('Graddagsfaktor', 'Degree-day factor')}: ${round(result.degreeDayFactor, 2)}.`
                      : ` ${t('Graddagskorrigering ej tillämpad (otillräcklig väderdata).', 'Degree-day correction not applied (insufficient weather data).')}`}
                  </p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="font-medium">{t('Ingår inte', 'Not included')}</div>
                  <table className="mt-2 w-full text-xs">
                    <tbody>
                      {EP_EXCLUDED_CATEGORIES.map((category) => (
                        <tr key={category}>
                          <td>{categoryLabel(category, t)}</td>
                          <td className="text-right font-mono">
                            {round(result.measuredKwh[category] ?? 0)} kWh
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

              <p className="text-xs text-muted-foreground">
                {t(
                  'Indikativ beräkning enligt BEN (BFS 2016:12), antar helelektriskt hus. En officiell energiklass kräver en certifierad energiexpert.',
                  'Indicative calculation per BEN (BFS 2016:12), assumes an all-electric home. An official energy class requires a certified energy expert.',
                )}
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>

      {monthlyByCategory.length > 0 && (
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
      )}
    </div>
  );
};

export default EnergiprestandaSection;
