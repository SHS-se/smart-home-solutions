/** As-issued accuracy evaluation. These diagnostics never authorize control. */
export type AccuracyGrade = 'green' | 'lime' | 'yellow' | 'orange' | 'red';
export interface AccuracyScore { percentage: number | null; grade: AccuracyGrade | null }
export interface AccuracyDevice extends AccuracyScore { key: string; name: string }
export interface EnergyAccuracy extends AccuracyScore {
  quarters: number; predicted_kwh: number; actual_kwh: number; absolute_error_kwh: number;
  bias_kwh: number; bias_percent: number | null;
}
export interface AccuracyBreakdown extends EnergyAccuracy { key: string }
export interface HistoricalAccuracyDevice extends AccuracyDevice, EnergyAccuracy {
  gaps: number;
  battery?: {charge: EnergyAccuracy; discharge: EnergyAccuracy};
  daily: AccuracyBreakdown[]; models: AccuracyBreakdown[]; leads: AccuracyBreakdown[];
}
export interface AccuracySide extends AccuracyScore { devices: HistoricalAccuracyDevice[] }
/** How close the planner's last estimate came to each price once it was published. */
export interface PriceAccuracy extends AccuracyScore { quarters: number }
/**
 * A driven room's planned temperature against its reading at the same
 * instant. The percentage is the share of quarters within ROOM_TOLERANCE_C,
 * kept apart from the energy figures: a degree is not a kilowatt-hour.
 */
export interface RoomTemperatureAccuracy extends AccuracyDevice {
  quarters: number; mean_absolute_error_c: number | null; bias_c: number | null;
}
export interface AccuracyReport {
  version: 3; scheduled_at: string; calculated_at: string; timezone: string; historical_from: string;
  historical: AccuracySide; prices: PriceAccuracy;
  /** Present when the archived plans drive rooms. */
  room_temperature?: { tolerance_c: number; rooms: RoomTemperatureAccuracy[] };
  calculations?: unknown[];
}
export interface AccuracySlot {
  start: string; duration_hours: number; load_w: number | null; pv_w: number | null;
  device_loads_w: Record<string, number> | null;
  battery_charge_w: number | null; battery_discharge_w: number | null; battery_soc: number | null;
  /** The planner's own import price where none was published yet; null once published. */
  estimated_import_sek_per_kwh?: number | null;
  /** Driven rooms (controlled-rooms.ts), °C at the end of the quarter, by room key. */
  room_temperature_c?: Record<string, number> | null;
}
/** Compact reporting evidence, selected in the database; never a planning input. */
export interface AccuracyEvidence {
  energy: {at: number; plan_id: string; published_at: number; model_version: string | null;
    keys: string[]; slot: AccuracySlot}[];
  rooms: {at: number; key: string; plan_id: string; value: number}[];
  estimates: {at: number; plan_id: string; value: number}[];
  catalog: {names: [string, string][]; room_names: [string, string][];
    latest_keys: string[]; latest_rooms: {key: string; name: string}[]};
  actuals: AccuracyActual[]; device_actuals: DeviceActual[]; prices: PublishedPrice[];
  room_actuals: RoomActual[];
}
export interface AccuracyInput extends AccuracyEvidence {
  scheduled_at: string; calculated_at: string; timezone: string;
}
/** A room reading: the temperature at the start of the quarter. */
export interface RoomActual { start_ts: string; room_key: string; room_temperature_c: number }
export const ROOM_TOLERANCE_C = 0.5;
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
  soc_comparison?: {state: 'unavailable'; reason: 'endpoint_vs_interval_mean'};
}
/** The same sums in SEK/kWh: estimated against published import prices. */
interface RoomCalculation {
  key: string; name: string; quarters: number; within: number; absolute_error_c: number; bias_c: number; plan_ids: string[];
}
interface PriceCalculation {
  key: 'prices'; pairs: number; estimated_sek_per_kwh: number; published_sek_per_kwh: number;
  absolute_error_sek_per_kwh: number; bias_sek_per_kwh: number; matched: number; larger: number; plan_ids: string[];
}
const DAY = 86_400_000;
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

/** Bias and volume describe direction separately from the unchanged overlap score. */
function energyAccuracy(s: ErrorSums): EnergyAccuracy {
  return {...scoreSums(s), quarters: s.pairs, predicted_kwh: s.predicted_kwh,
    actual_kwh: s.actual_kwh, absolute_error_kwh: s.absolute_error_kwh, bias_kwh: s.bias_kwh,
    bias_percent: s.actual_kwh > 0 ? 100 * s.bias_kwh / s.actual_kwh : null};
}
function breakdown(pairs: Pair[], key: (pair: Pair) => string): AccuracyBreakdown[] {
  const groups = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const name = key(pair), group = groups.get(name);
    if (group) group.push(pair); else groups.set(name, [pair]);
  }
  return [...groups].map(([key, pairs]) => ({key, ...energyAccuracy(sums(pairs))}));
}

export function calculateAccuracy(input: AccuracyInput) {
  const at = Date.parse(input.scheduled_at), from = at - 7 * DAY;
  const actuals = new Map(input.actuals.map(a => [Date.parse(a.start_ts), a]));
  const deviceActuals = new Map(input.device_actuals.map(a => [`${Date.parse(a.start_ts)}:${a.device_key}`, a.energy_kwh]));
  const history = new Map(input.energy.map(row => [row.at, row]));
  const estimates = new Map(input.estimates.map(row => [row.at, row]));
  const names = new Map(input.catalog.names), roomNames = new Map(input.catalog.room_names);
  const roomPlans = new Map(input.rooms.map(row => [`${row.at}:${row.key}`, row]));
  const allKeys = new Set(input.catalog.latest_keys);
  for (const row of history.values()) row.keys.forEach(k => allKeys.add(k));
  const historicalPairs = new Map<string, Pair[]>(), gaps = new Map<string, number>();
  for (const {plan_id, slot, keys} of history.values()) for (const key of keys) {
    const start = Date.parse(slot.start), prediction = predicted(slot, key);
    const actual = measured(slot, key, actuals.get(start), deviceActuals, start);
    if (!prediction || !actual) { gaps.set(key, (gaps.get(key) ?? 0) + 1); continue; }
    const pair = {at: start, predicted: prediction, actual, plan_id};
    const group = historicalPairs.get(key);
    if (group) group.push(pair); else historicalPairs.set(key, [pair]);
  }
  const historyRows: HistoricalAccuracyDevice[] = [], diagnostics: (AccuracyCalculation | PriceCalculation | RoomCalculation)[] = [];
  const historicTotals: Pair[] = [];
  const localDay = new Intl.DateTimeFormat('en-CA', {timeZone: input.timezone, year: 'numeric', month: '2-digit', day: '2-digit'});
  const dayKeys = new Map(input.energy.map(row => [row.at, localDay.format(row.at)]));
  for (const key of allKeys) {
    const pairs = historicalPairs.get(key) ?? [], historical = sums(pairs);
    const name = names.get(key) ?? key.slice(7);
    const direction = (index: number) => energyAccuracy(sums(pairs.map(p => ({...p, predicted: [p.predicted[index]], actual: [p.actual[index]]}))));
    historyRows.push({key, name, ...energyAccuracy(historical), gaps: gaps.get(key) ?? 0,
      ...(key === 'battery' ? {battery: {charge: direction(0), discharge: direction(1)}} : {}),
      daily: breakdown(pairs, p => dayKeys.get(p.at)!),
      models: breakdown(pairs, p => history.get(p.at)!.model_version ?? 'unrecorded'),
      leads: breakdown(pairs, p => {
        const hours = (p.at - history.get(p.at)!.published_at) / 3_600_000;
        return hours < 1 ? '0–1 h' : hours < 6 ? '1–6 h' : hours < 24 ? '6–24 h' : '24+ h';
      })});
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
    diagnostics.push({key, name, historical, gaps: gaps.get(key) ?? 0,
      plan_ids: [...new Set(pairs.map(p => p.plan_id))], ...(lag ? {lag} : {}),
      // HA reports quarter means; endpoint differences cannot calibrate physics.
      ...(key === 'battery' ? {soc_comparison: {state: 'unavailable' as const, reason: 'endpoint_vs_interval_mean' as const}} : {})});
  }
  const pricePairs: Pair[] = input.prices.flatMap(p => {
    const start = Date.parse(p.start_ts), estimate = estimates.get(start);
    return estimate && valid(p.import_price_sek_per_kwh)
      ? [{at: start, plan_id: estimate.plan_id, predicted: [estimate.value], actual: [p.import_price_sek_per_kwh]}] : [];
  });
  const price = sums(pricePairs);
  const roomReadings = new Map((input.room_actuals ?? []).map(a => [`${Date.parse(a.start_ts)}:${a.room_key}`, Number(a.room_temperature_c)]));
  const rooms = new Map<string, RoomCalculation>();
  for (const [id, planned] of roomPlans) {
    const reading = roomReadings.get(id);
    if (!valid(reading)) continue;
    const key = id.slice(id.indexOf(':') + 1), error = planned.value - reading;
    const room = rooms.get(key) ?? {key, name: roomNames.get(key) ?? key, quarters: 0, within: 0, absolute_error_c: 0, bias_c: 0, plan_ids: []};
    room.quarters++; room.absolute_error_c += Math.abs(error); room.bias_c += error;
    if (Math.abs(error) <= ROOM_TOLERANCE_C + 1e-9) room.within++;
    if (!room.plan_ids.includes(planned.plan_id)) room.plan_ids.push(planned.plan_id);
    rooms.set(key, room);
  }
  // Every room the latest plan drives is listed, compared or not, as devices are.
  for (const room of input.catalog.latest_rooms) if (!rooms.has(room.key))
    rooms.set(room.key, {key: room.key, name: room.name, quarters: 0, within: 0, absolute_error_c: 0, bias_c: 0, plan_ids: []});
  const roomRows: RoomTemperatureAccuracy[] = [...rooms.values()].sort((a, b) => a.name.localeCompare(b.name)).map(room => ({
    key: room.key, name: room.name, ...accuracyScore(room.within, room.quarters), quarters: room.quarters,
    mean_absolute_error_c: room.quarters ? Math.round(100 * room.absolute_error_c / room.quarters) / 100 : null,
    bias_c: room.quarters ? Math.round(100 * room.bias_c / room.quarters) / 100 : null,
  }));
  diagnostics.push(...[...rooms.values()].map(room => ({...room, key: 'room:' + room.key})));
  diagnostics.push({key: 'prices', pairs: price.pairs, estimated_sek_per_kwh: price.predicted_kwh,
    published_sek_per_kwh: price.actual_kwh, absolute_error_sek_per_kwh: price.absolute_error_kwh, bias_sek_per_kwh: price.bias_kwh,
    matched: price.matched_kwh, larger: price.larger_kwh, plan_ids: [...new Set(pricePairs.map(p => p.plan_id))]});
  const report: AccuracyReport = {version: 3, scheduled_at: input.scheduled_at, calculated_at: input.calculated_at,
    timezone: input.timezone, historical_from: new Date(from).toISOString(),
    historical: {...scoreSums(sums(historicTotals)), devices: historyRows},
    prices: {...scoreSums(price), quarters: price.pairs},
    ...(roomRows.length ? {room_temperature: {tolerance_c: ROOM_TOLERANCE_C, rooms: roomRows}} : {})};
  return {report, diagnostics};
}
