/** As-issued accuracy evaluation. These diagnostics never authorize control. */
export type AccuracyGrade = 'green' | 'lime' | 'yellow' | 'orange' | 'red';
export interface AccuracyScore { percentage: number | null; grade: AccuracyGrade | null }
export interface AccuracyDevice extends AccuracyScore { key: string; name: string }
export interface AccuracySide extends AccuracyScore { devices: AccuracyDevice[] }
/** How close the planner's last estimate came to each price once it was published. */
export interface PriceAccuracy extends AccuracyScore { quarters: number }
export interface AccuracyReport {
  version: 2; scheduled_at: string; calculated_at: string; timezone: string; historical_from: string;
  historical: AccuracySide; prices: PriceAccuracy;
  calculations?: unknown[];
}
export interface AccuracySlot {
  start: string; duration_hours: number; load_w: number | null; pv_w: number | null;
  device_loads_w: Record<string, number> | null;
  battery_charge_w: number | null; battery_discharge_w: number | null; battery_soc: number | null;
  /** The planner's own import price where none was published yet; null once published. */
  estimated_import_sek_per_kwh?: number | null;
}
export interface ForecastRecord {
  plan_id: string; published_at: string;
  forecast: { timezone: string; battery: boolean; devices: {key: string; name: string}[]; slots: AccuracySlot[] };
}
export interface AccuracyActual {
  start_ts: string; total_load_kwh: number | null; solar_production_kwh: number | null;
  battery_charge_kwh: number | null; battery_discharge_kwh: number | null; battery_soc: number | null;
}
export interface DeviceActual { start_ts: string; device_key: string; energy_kwh: number }
export interface PublishedPrice { start_ts: string; import_price_sek_per_kwh: number }
interface Pair { at: number; plan_id: string; predicted: number[]; actual: number[] }
/** matched_kwh sums min(predicted, actual) and larger_kwh sums max(predicted, actual), per value. */
interface ErrorSums {
  pairs: number; predicted_kwh: number; actual_kwh: number; absolute_error_kwh: number; bias_kwh: number;
  matched_kwh: number; larger_kwh: number;
}
interface AccuracyCalculation {
  key: string; name: string; historical: ErrorSums; gaps: number; plan_ids: string[];
  lag?: (ErrorSums & {minutes: number})[];
  soc_percentage_points?: {samples: number; absolute_error: number; bias: number};
}
/** The same sums in SEK/kWh: estimated against published import prices. */
interface PriceCalculation {
  key: 'prices'; pairs: number; estimated_sek_per_kwh: number; published_sek_per_kwh: number;
  absolute_error_sek_per_kwh: number; bias_sek_per_kwh: number; matched: number; larger: number; plan_ids: string[];
}
const QUARTER = 900_000, DAY = 86_400_000;
const valid = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const volume = (values: number[]) => values.reduce((sum, value) => sum + Math.abs(value), 0);

/**
 * The share of energy where forecast and measurement agree:
 * sum(min(predicted, actual)) / sum(max(predicted, actual)). Every component
 * uses it. It is bounded to 0..100 without clamping, so one bad stretch cannot
 * drive the score below zero, and over- and under-delivery count alike.
 */
export function accuracyScore(matched: number, larger: number): AccuracyScore {
  const percentage = larger > 0 ? Math.round(100 * matched / larger) : null;
  return {percentage, grade: percentage === null ? null : percentage >= 90 ? 'green'
    : percentage >= 80 ? 'lime' : percentage >= 70 ? 'yellow' : percentage >= 60 ? 'orange' : 'red'};
}
// Energies, and import prices in practice, are non-negative; the floor keeps the score's bounds exact.
const energyPair = (p: Pair, i: number) => [Math.max(0, p.predicted[i]), Math.max(0, p.actual[i])];
function sums(pairs: Pair[]): ErrorSums {
  return pairs.reduce((s, p) => ({pairs: s.pairs + 1,
    predicted_kwh: s.predicted_kwh + volume(p.predicted), actual_kwh: s.actual_kwh + volume(p.actual),
    absolute_error_kwh: s.absolute_error_kwh + p.actual.reduce((n, a, i) => n + Math.abs(p.predicted[i] - a), 0),
    bias_kwh: s.bias_kwh + p.actual.reduce((n, a, i) => n + p.predicted[i] - a, 0),
    matched_kwh: s.matched_kwh + p.actual.reduce((n, _, i) => n + Math.min(...energyPair(p, i)), 0),
    larger_kwh: s.larger_kwh + p.actual.reduce((n, _, i) => n + Math.max(...energyPair(p, i)), 0)}),
  {pairs: 0, predicted_kwh: 0, actual_kwh: 0, absolute_error_kwh: 0, bias_kwh: 0, matched_kwh: 0, larger_kwh: 0});
}
const scoreSums = (s: ErrorSums) => accuracyScore(s.matched_kwh, s.larger_kwh);
const keys = (r: ForecastRecord) => ['baseline', ...r.forecast.devices.map(d => 'device:' + d.key), 'solar', ...(r.forecast.battery ? ['battery'] : [])];
function predicted(slot: AccuracySlot, key: string): number[] | null {
  const energy = (watts: unknown) => valid(watts) ? watts * slot.duration_hours / 1000 : null;
  if (key === 'battery') {
    const charge = energy(slot.battery_charge_w), discharge = energy(slot.battery_discharge_w);
    return charge !== null && discharge !== null ? [charge, discharge] : null;
  }
  if (key === 'baseline') {
    if (!valid(slot.load_w) || !slot.device_loads_w || !Object.values(slot.device_loads_w).every(valid)) return null;
    const residual = slot.load_w - Object.values(slot.device_loads_w).reduce((a, b) => a + b, 0);
    return residual >= -1e-7 ? [Math.max(0, residual) * slot.duration_hours / 1000] : null;
  }
  const value = energy(key === 'solar' ? slot.pv_w : slot.device_loads_w?.[key.slice(7)]);
  return value === null ? null : [value];
}
function measured(slot: AccuracySlot, key: string, actual: AccuracyActual | undefined,
  devices: Map<string, number>, at: number): number[] | null {
  if (key.startsWith('device:')) {
    const value = devices.get(`${at}:${key.slice(7)}`);
    return valid(value) ? [value] : null;
  }
  if (!actual) return null;
  if (key === 'battery') return valid(actual.battery_charge_kwh) && valid(actual.battery_discharge_kwh)
    ? [actual.battery_charge_kwh, actual.battery_discharge_kwh] : null;
  if (key === 'solar') return valid(actual.solar_production_kwh) ? [actual.solar_production_kwh] : null;
  if (!valid(actual.total_load_kwh) || !slot.device_loads_w) return null;
  const components = Object.keys(slot.device_loads_w).map(k => devices.get(`${at}:${k}`));
  if (!components.every(valid)) return null;
  const residual = actual.total_load_kwh - components.reduce((a, b) => a + b, 0);
  return residual >= -1e-7 ? [Math.max(0, residual)] : null;
}

export function calculateAccuracy(input: {scheduled_at: string; calculated_at: string; timezone: string;
  forecasts: ForecastRecord[]; actuals: AccuracyActual[]; device_actuals: DeviceActual[]; prices: PublishedPrice[]}) {
  const at = Date.parse(input.scheduled_at), from = at - 7 * DAY;
  const actuals = new Map(input.actuals.map(a => [Date.parse(a.start_ts), a]));
  const deviceActuals = new Map(input.device_actuals.map(a => [`${Date.parse(a.start_ts)}:${a.device_key}`, a.energy_kwh]));
  const records = input.forecasts.filter(r => Date.parse(r.published_at) <= at)
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || a.plan_id.localeCompare(b.plan_id));
  const history = new Map<number, {record: ForecastRecord; slot: AccuracySlot}>();
  // Later records overwrite earlier ones, so each quarter keeps the last estimate made before its price was published.
  const estimates = new Map<number, {plan_id: string; value: number}>();
  const names = new Map<string, string>([['baseline', 'Baseline'], ['solar', 'Solar'], ['battery', 'House battery']]);
  for (const record of records) {
    record.forecast.devices.forEach(d => names.set('device:' + d.key, d.name));
    for (const slot of record.forecast.slots) {
      const start = Date.parse(slot.start);
      if (start >= from && valid(slot.estimated_import_sek_per_kwh))
        estimates.set(start, {plan_id: record.plan_id, value: slot.estimated_import_sek_per_kwh});
      // Only complete forecasts published before the quarter can be compared
      // with a full measured quarter. Partial/current-quarter captures are not hindcasts.
      if (start < from || start + QUARTER > at || start < Date.parse(record.published_at) || slot.duration_hours !== .25) continue;
      history.set(start, {record, slot});
    }
  }
  const allKeys = new Set(records.length ? keys(records.at(-1)!) : []);
  for (const {record} of history.values()) keys(record).forEach(k => allKeys.add(k));
  const historicalPairs = new Map<string, Pair[]>(), gaps = new Map<string, number>();
  for (const {record, slot} of history.values()) for (const key of keys(record)) {
    const start = Date.parse(slot.start), prediction = predicted(slot, key);
    const actual = measured(slot, key, actuals.get(start), deviceActuals, start);
    if (!prediction || !actual) { gaps.set(key, (gaps.get(key) ?? 0) + 1); continue; }
    historicalPairs.set(key, [...historicalPairs.get(key) ?? [], {at: start, predicted: prediction, actual, plan_id: record.plan_id}]);
  }
  const historyRows: AccuracyDevice[] = [], diagnostics: (AccuracyCalculation | PriceCalculation)[] = [];
  const historicTotals: Pair[] = [];
  for (const key of allKeys) {
    const pairs = historicalPairs.get(key) ?? [], historical = sums(pairs);
    const name = names.get(key) ?? key.slice(7);
    historyRows.push({key, name, ...scoreSums(historical)});
    historicTotals.push(...pairs);
    // Positive shift means measured battery behaviour follows the forecast later.
    const lag = key === 'battery' ? [-30, -15, 0, 15, 30, 60].map(minutes => {
      const shifted = pairs.flatMap(p => {
        const a = actuals.get(p.at + minutes * 60_000);
        return valid(a?.battery_charge_kwh) && valid(a?.battery_discharge_kwh)
          ? [{...p, actual: [a.battery_charge_kwh, a.battery_discharge_kwh]}] : [];
      });
      return {minutes, ...sums(shifted)};
    }) : undefined;
    const soc = key === 'battery' ? pairs.flatMap(p => {
      const forecast = history.get(p.at)?.slot.battery_soc, measured = actuals.get(p.at)?.battery_soc;
      return valid(forecast) && valid(measured) ? [(forecast - measured) * 100] : [];
    }) : null;
    diagnostics.push({key, name, historical, gaps: gaps.get(key) ?? 0,
      plan_ids: [...new Set(pairs.map(p => p.plan_id))], ...(lag ? {lag} : {}),
      ...(soc ? {soc_percentage_points: {samples: soc.length, absolute_error: soc.reduce((a,b) => a + Math.abs(b),0), bias: soc.reduce((a,b) => a + b,0)}} : {})});
  }
  const pricePairs: Pair[] = input.prices.flatMap(p => {
    const start = Date.parse(p.start_ts), estimate = estimates.get(start);
    return estimate && valid(p.import_price_sek_per_kwh)
      ? [{at: start, plan_id: estimate.plan_id, predicted: [estimate.value], actual: [p.import_price_sek_per_kwh]}] : [];
  });
  const price = sums(pricePairs);
  diagnostics.push({key: 'prices', pairs: price.pairs, estimated_sek_per_kwh: price.predicted_kwh,
    published_sek_per_kwh: price.actual_kwh, absolute_error_sek_per_kwh: price.absolute_error_kwh, bias_sek_per_kwh: price.bias_kwh,
    matched: price.matched_kwh, larger: price.larger_kwh, plan_ids: [...new Set(pricePairs.map(p => p.plan_id))]});
  const report: AccuracyReport = {version: 2, scheduled_at: input.scheduled_at, calculated_at: input.calculated_at,
    timezone: input.timezone, historical_from: new Date(from).toISOString(),
    historical: {...scoreSums(sums(historicTotals)), devices: historyRows},
    prices: {...scoreSums(price), quarters: price.pairs}};
  return {report, diagnostics};
}
