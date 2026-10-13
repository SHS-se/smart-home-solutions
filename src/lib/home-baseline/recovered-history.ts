import type { ActualRow, HistoricalRows } from './model.ts';
import { homePhysics } from './home-physics.ts';
import { allocateReportedEnergy, type ReportedEnergyInterval } from './reported-energy-intervals.ts';

const HOUR = 3_600_000, QUARTER = HOUR / 4;
type EnergyField = Exclude<keyof ActualRow, 'start_ts' | 'battery_soc' | 'ev_soc'>;
type StateField = 'battery_soc' | 'ev_soc' | 'pool_c' | 'outdoor_c';
export interface StatisticSeries { statistic_id: string; unit: string; statistics: { start: number; sum?: number | null; mean?: number | null }[] }
export interface RecoverySpec { start: string; end: string; actual: Partial<Record<EnergyField, string[]>>;
  devices: { id: string; sources: string[] }[]; members: string[]; states: Partial<Record<StateField, string>> }
export interface RecoveredHour { start_ts: string; actual: Partial<Omit<ActualRow, 'start_ts'>> & { reported_intervals?: ReportedEnergyInterval[] }; device_energy_kwh: Record<string, number>;
  pool_c: number | null; outdoor_c: number | null; baseline_load_kwh: number | null; sources: Record<string, string>; invalid_readings: number }
export interface RecoverySummary { hours: number; balanceHours: number; deviceSumHours: number; invalidReadings: number; sources: string[] }
export const emptyRecovery = (): RecoverySummary => ({ hours: 0, balanceHours: 0, deviceSumHours: 0, invalidReadings: 0, sources: [] });

/** HA sum is reset-adjusted. A missing predecessor or negative correction is an individual gap. */
export function energyDeltas(series: StatisticSeries) {
  const scale = ({ kWh: 1, MWh: 1000, Wh: .001 } as Record<string, number>)[series.unit];
  if (scale === undefined) throw new Error(`Unsupported energy unit for ${series.statistic_id}: ${series.unit}`);
  const byTime = new Map(series.statistics.map(row => [row.start, row]));
  const energy = new Map<number, number>(), invalid = new Set<number>();
  for (const row of series.statistics) {
    if (!Number.isFinite(row.start) || row.start % HOUR) throw new Error('Recovered statistics must be hourly');
    const previous = byTime.get(row.start - HOUR);
    if (row.sum == null || previous?.sum == null) continue;
    const delta = (row.sum - previous.sum) * scale;
    if (!Number.isFinite(delta) || delta < -1e-9) { invalid.add(row.start); continue; }
    energy.set(row.start, Math.max(0, delta)); // Floating-point cancellation only.
  }
  return { energy, invalid };
}

/** Normalize source observations once; never write allocated quarters into measured/planner tables. */
export function prepareHourlyRecovery(series: StatisticSeries[], spec: RecoverySpec): RecoveredHour[] {
  const start = Date.parse(spec.start), end = Date.parse(spec.end);
  if (![start, end].every(t => Number.isFinite(t) && t % HOUR === 0) || start >= end) throw new Error('Choose a completed hourly recovery window');
  const byId = new Map(series.map(s => [s.statistic_id, s]));
  if (byId.size !== series.length || new Set(spec.devices.map(d => d.id)).size !== spec.devices.length) throw new Error('Duplicate recovery source or device identity');
  const usedEnergy = new Set([...Object.values(spec.actual).flat(), ...spec.devices.flatMap(d => d.sources)]);
  const changes = new Map([...usedEnergy].flatMap(id => byId.has(id) ? [[id, energyDeltas(byId.get(id)!)] as const] : []));
  const states = new Map(Object.entries(spec.states).map(([field, id]) => {
    const source = byId.get(id!);
    if (source && source.unit !== (field.endsWith('soc') ? '%' : '°C')) throw new Error(`Unexpected measurement unit: ${id}`);
    return [field, new Map(source?.statistics.flatMap(row => row.mean == null || !Number.isFinite(row.mean) ? []
      : [[row.start, field.endsWith('soc') ? row.mean / 100 : row.mean] as const]) ?? [])] as const;
  }));
  const members = new Set(spec.members), result: RecoveredHour[] = [];
  // The preceding completed hour supplies initial state and the first energy delta.
  for (let t = start - HOUR; t < end; t += HOUR) {
    const row: RecoveredHour = { start_ts: new Date(t).toISOString(), actual: {}, device_energy_kwh: {}, pool_c: null,
      outdoor_c: null, baseline_load_kwh: null, sources: {}, invalid_readings: 0 };
    const pick = (field: string, ids: string[]) => {
      for (const id of ids) {
        const value = changes.get(id)?.energy.get(t);
        if (value !== undefined) { row.sources[field] = id; return value; }
      }
      return undefined;
    };
    for (const [field, ids] of Object.entries(spec.actual)) {
      const value = pick(field, ids!); if (value !== undefined) row.actual[field as EnergyField] = value;
    }
    for (const device of spec.devices) {
      const value = pick(`device:${device.id}`, device.sources); if (value !== undefined) row.device_energy_kwh[device.id] = value;
    }
    for (const [field, id] of Object.entries(spec.states)) {
      const value = states.get(field)?.get(t);
      if (value === undefined) continue;
      row.sources[field] = id!;
      if (field === 'pool_c' || field === 'outdoor_c') row[field] = value;
      else if (value >= 0 && value <= 1) row.actual[field as 'battery_soc' | 'ev_soc'] = value;
    }
    row.invalid_readings = [...changes.values()].filter(change => change.invalid.has(t)).length;
    const removed = Object.entries(row.device_energy_kwh).reduce((n, [id, value]) => n + (members.has(id) ? value : 0), 0);
    const other = Object.entries(row.device_energy_kwh).reduce((n, [id, value]) => n + (members.has(id) ? 0 : value), 0);
    if (row.actual.total_load_kwh == null && row.actual.grid_import_kwh != null) {
      // Recover household demand from the same hour's electricity balance.
      // Missing channels follow the explicitly selected missing-energy = 0 policy.
      const a = row.actual, load = a.grid_import_kwh! + (a.solar_production_kwh ?? 0) + (a.battery_discharge_kwh ?? 0)
        - (a.grid_export_kwh ?? 0) - (a.battery_charge_kwh ?? 0);
      if (load >= 0) { row.actual.total_load_kwh = load; row.sources.household_estimate = 'grid_balance'; }
    }
    if (row.actual.total_load_kwh == null) {
      if (Object.keys(row.device_energy_kwh).length) { row.actual.total_load_kwh = removed + other; row.baseline_load_kwh = other; }
    } else if (row.actual.total_load_kwh - removed < -1e-9) row.baseline_load_kwh = other;
    if (Object.keys(row.sources).length || row.invalid_readings) result.push(row);
  }
  return result;
}

/** Below this much impossible energy in the hours on hand there is nothing to correct. */
export const LATE_METER_MIN_KWH = 1;
/** Read an hour earlier, at most this share of the impossible energy may remain. */
export const LATE_METER_MAX_REMAINING = .05;

/**
 * Move a late-reporting counter's energy back to the hour it was drawn.
 *
 * A device cannot use more than the whole house did. A counter that breaks that
 * rule in its own hour, and no longer does when read one hour earlier, is
 * reporting an hour late. Left alone, the hour the device really ran keeps its
 * energy in the household's base load (it is never removed there), and the hour
 * after loses energy the house did use.
 *
 * Decided per device and source statistic over the hours on hand, so a counter
 * that was later replaced by a prompt one is corrected only where it was used.
 */
export function alignLateMeters(hours: readonly RecoveredHour[], members: ReadonlySet<string>): RecoveredHour[] {
  const byTime = new Map(hours.map(hour => [Date.parse(hour.start_ts), hour]));
  const sourceOf = (hour: RecoveredHour | undefined, id: string) => hour?.sources[`device:${id}`];
  // A total summed from the device meters themselves can never contradict them.
  const measuredTotal = (hour: RecoveredHour | undefined) => hour !== undefined && (hour.sources.total_load_kwh !== undefined || hour.sources.household_estimate !== undefined);
  const measuredLoad = (hour: RecoveredHour | undefined) => measuredTotal(hour) ? hour!.actual.total_load_kwh ?? null : null;
  const impossible = new Map<string, { id: string; source: string; asRead: number; earlier: number }>();
  for (const hour of hours) for (const [id, kwh] of Object.entries(hour.device_energy_kwh)) {
    const source = sourceOf(hour, id);
    if (!source) continue;
    const key = `${id}|${source}`, tally = impossible.get(key) ?? { id, source, asRead: 0, earlier: 0 };
    const load = measuredLoad(hour), before = measuredLoad(byTime.get(Date.parse(hour.start_ts) - HOUR));
    if (load !== null) tally.asRead += Math.max(0, kwh - load);
    if (before !== null) tally.earlier += Math.max(0, kwh - before);
    impossible.set(key, tally);
  }
  const late = [...impossible.values()].filter(tally => tally.asRead > LATE_METER_MIN_KWH && tally.earlier <= tally.asRead * LATE_METER_MAX_REMAINING);
  if (!late.length) return [...hours];
  return hours.map(hour => {
    const next = byTime.get(Date.parse(hour.start_ts) + HOUR);
    const moved = late.filter(({ id, source }) => sourceOf(hour, id) === source || sourceOf(next, id) === source);
    if (!moved.length) return hour;
    const device_energy_kwh = { ...hour.device_energy_kwh }, sources = { ...hour.sources };
    for (const { id, source } of moved) {
      // The reading that arrived in the next hour describes this one. The counter's
      // last hour before it was replaced has no later reading and keeps none.
      device_energy_kwh[id] = sourceOf(next, id) === source ? next!.device_energy_kwh[id] ?? 0 : 0;
      sources[`device:${id}`] = source;
    }
    const removed = Object.entries(device_energy_kwh).reduce((n, [id, kwh]) => n + (members.has(id) ? kwh : 0), 0);
    const other = Object.entries(device_energy_kwh).reduce((n, [id, kwh]) => n + (members.has(id) ? 0 : kwh), 0);
    // Same rule as the first normalisation: the independent other meters stand in
    // only where the removed devices still exceed the measured total.
    const actual = measuredTotal(hour) ? hour.actual : { ...hour.actual, total_load_kwh: removed + other };
    const baseline_load_kwh = !measuredTotal(hour) ? other : (actual.total_load_kwh ?? 0) - removed < -1e-9 ? other : null;
    return { ...hour, actual, device_energy_kwh, sources, baseline_load_kwh };
  });
}

/** Field-level precedence preserves every non-null measured value, including zero. */
export function mergeHourlyHistory(rows: HistoricalRows, recoveredHours: readonly RecoveredHour[]): HistoricalRows & { baselineLoads: { start_ts: string; kwh: number }[]; recovery: RecoverySummary } {
  const start = Date.parse(rows.start), end = Date.parse(rows.end), prior = start - QUARTER;
  const stamp = (value: string) => new Date(value).toISOString();
  const actual = new Map(rows.actual.map(r => [stamp(r.start_ts), { ...r, start_ts: stamp(r.start_ts) }]));
  const meters = new Map(rows.deviceSlots.map(r => [stamp(r.start_ts), { ...r, start_ts: stamp(r.start_ts), device_energy_kwh: { ...r.device_energy_kwh } }]));
  const pool = new Map(rows.pool.map(r => [stamp(r.start_ts), { ...r, start_ts: stamp(r.start_ts) }])), outdoor = new Map(rows.outdoor.map(r => [stamp(r.start_ts), { ...r, start_ts: stamp(r.start_ts) }]));
  const baselineLoads: { start_ts: string; kwh: number }[] = [], recovery = emptyRecovery();
  const memberKeys = new Set(homePhysics(rows.snapshot).memberKeys);
  const memberIds = new Set(rows.devices.filter(d => memberKeys.has(d.device_key)).map(d => d.id));
  const excluded = new Set(rows.devices.filter(d => memberKeys.has(d.device_key) || d.category === 'ev_charging').map(d => d.id));
  const hours = alignLateMeters(recoveredHours, memberIds);
  const sources = new Set<string>();
  const hourlyFields = new Map<string, Set<string>>();
  const recovered = (at: string, field: string) => {
    if (!hourlyFields.has(at)) hourlyFields.set(at, new Set());
    hourlyFields.get(at)!.add(field);
  };
  let evInitial = rows.evInitial?.ev_soc == null ? null : rows.evInitial;
  for (const hour of hours) {
    const from = Date.parse(hour.start_ts);
    if (!Number.isFinite(from) || from % HOUR) throw new Error('Recovered history must contain hourly timestamps');
    let used = false, summed = false, balanced = false;
    for (let i = 0; i < 4; i++) {
      const t = from + i * QUARTER;
      if (t < prior || t >= end) continue;
      const stamp = new Date(t).toISOString(), measured = actual.get(stamp), hasMeasuredTotal = measured?.total_load_kwh != null;
      const target: ActualRow = measured ?? { start_ts: stamp, total_load_kwh: null, solar_production_kwh: null,
        grid_import_kwh: null, grid_export_kwh: null, battery_charge_kwh: null, battery_discharge_kwh: null, battery_soc: null, ev_soc: null };
      for (const [key, value] of Object.entries(hour.actual)) {
        if (key === 'reported_intervals') continue;
        if (typeof value !== 'number') {
          if (value == null) continue;
          throw new Error('Invalid recovered energy value');
        }
        const field = key as Exclude<keyof ActualRow, 'start_ts'>;
        if (target[field] == null && value != null) {
          target[field] = field.endsWith('soc') ? value : value / 4; used = true;
          recovered(stamp, field);
          if (field === 'total_load_kwh' && hour.sources.household_estimate === 'grid_balance') balanced = true;
        }
      }
      if (hour.baseline_load_kwh !== null && !hasMeasuredTotal && t >= start) {
        baselineLoads.push({ start_ts: stamp, kwh: hour.baseline_load_kwh / 4 }); summed = true;
      }
      actual.set(stamp, target);
      if (t < start && target.ev_soc != null && (!evInitial || Date.parse(evInitial.start_ts) < t)) evInitial = { start_ts: stamp, ev_soc: target.ev_soc };
      if (t >= start) {
        const meter = meters.get(stamp) ?? { start_ts: stamp, device_energy_kwh: {} };
        let recoveredMember = false;
        for (const [id, energy] of Object.entries(hour.device_energy_kwh)) if (meter.device_energy_kwh[id] == null) {
          meter.device_energy_kwh[id] = energy / 4; used = true;
          recovered(stamp, `device:${id}`);
          if (memberIds.has(id)) recoveredMember = true;
        }
        const removed = [...memberIds].reduce((n, id) => n + (meter.device_energy_kwh[id] ?? 0), 0);
        if (hasMeasuredTotal && recoveredMember && target.total_load_kwh! - removed < -1e-9) {
          // Hourly allocation can disagree with a measured quarter total. Use
          // independent other meters; preserve the actual total and all meters.
          baselineLoads.push({ start_ts: stamp, kwh: Object.entries(meter.device_energy_kwh)
            .reduce((n, [id, energy]) => n + (excluded.has(id) ? 0 : energy ?? 0), 0) });
          summed = true;
        }
        meters.set(stamp, meter);
        if (!outdoor.has(stamp) && hour.outdoor_c !== null) { outdoor.set(stamp, { start_ts: stamp, temperature_c: hour.outdoor_c }); used = true; recovered(stamp, 'outdoor_c'); }
      }
      if (pool.get(stamp)?.water_temperature_c == null && hour.pool_c !== null) { pool.set(stamp, { start_ts: stamp, water_temperature_c: hour.pool_c }); used = true; recovered(stamp, 'pool_c'); }
    }
    if ((used || summed) && from + HOUR > start && from < end) {
      recovery.hours++; if (summed) recovery.deviceSumHours++;
      if (balanced) recovery.balanceHours++;
      recovery.invalidReadings += hour.invalid_readings;
      Object.values(hour.sources).forEach(id => sources.add(id));
    }
  }
  const intervalFields = allocateReportedEnergy(actual, hours.flatMap(h => h.actual.reported_intervals ?? []), prior, end);
  // An interval average can conflict with a fine-grained device reading. Use
  // the existing independent other-meter baseline only for that estimated total.
  for (const [at, fields] of intervalFields) {
    fields.forEach(field => recovered(at, field));
    if (!fields.has('total_load_kwh') || Date.parse(at) < start) continue;
    const previous = baselineLoads.findIndex(row => row.start_ts === at);
    if (previous >= 0) baselineLoads.splice(previous, 1);
    const deviceEnergy = meters.get(at)?.device_energy_kwh ?? {};
    const removed = [...memberIds].reduce((n, id) => n + (deviceEnergy[id] ?? 0), 0);
    if (actual.get(at)!.total_load_kwh! - removed < -1e-9) baselineLoads.push({ start_ts: at,
      kwh: Object.entries(deviceEnergy).reduce((n, [id, energy]) => n + (excluded.has(id) ? 0 : energy ?? 0), 0) });
  }
  recovery.sources = [...sources].sort();
  return { ...rows, actual: [...actual.values()], deviceSlots: [...meters.values()], pool: [...pool.values()], outdoor: [...outdoor.values()], evInitial,
    baselineLoads, recovery, intervalFields: [...intervalFields].map(([start_ts, fields]) => ({ start_ts, fields: [...fields] })), hourlyFields: [...hourlyFields].map(([start_ts, fields]) => ({ start_ts, fields: [...fields] })) };
}
