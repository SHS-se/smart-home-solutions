import recipe from '../../../planner-core/recipe.json' with { type: 'json' };
import { builderRecipe, type ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import { localDay, localMonths } from '../../../supabase/functions/_shared/planner-wasm/calendar.ts';
import { POOL_START_COST_SEK } from '../../../supabase/functions/_shared/planner-wasm/cost-policy.ts';
import type { BenchSeries } from '../planner-bench/types.ts';
import { homePhysics, type HomeModelCapture } from './home-physics.ts';
import { DEFAULT_SETTINGS, electricityLedger, projectDefaultProblem, type ProjectionEngine } from './controller.ts';

export const QUARTER_MS = 900_000, FRAME_MS = 72 * 3_600_000;
export interface ActualRow { start_ts: string; total_load_kwh: number | null; solar_production_kwh: number | null; battery_soc: number | null; ev_soc: number | null }
export interface PriceRow { start_ts: string; import_price_sek_per_kwh: number | null; export_price_sek_per_kwh: number | null }
export interface DeviceRow { id: string; device_key: string }
export interface DeviceSlot { start_ts: string; device_energy_kwh: Record<string, number | null> }
export interface PoolRow { start_ts: string; water_temperature_c: number }
export interface OutdoorRow { start_ts: string; temperature_c: number }
export interface EvInitialRow { start_ts: string; ev_soc: number | null }
export interface HistoricalRows { snapshot: HomeModelCapture; start: string; end: string; evInitial: EvInitialRow | null; actual: ActualRow[]; prices: PriceRow[];
  devices: DeviceRow[]; deviceSlots: DeviceSlot[]; pool: PoolRow[]; outdoor: OutdoorRow[] }
export interface BaselineInput { start: string; end: string; timeZone: string; modelCapturedAt: string; initialObservedAt: string;
  problem: ReadyProblem; idlePumpW: number; carName: string; evInitialObservedAt: string | null;
  evDemandKwh: number[]; evDailyDemand: { day: string; kwh: number }[]; evMissingSocQuarters: number }

function time(value: string) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms % QUARTER_MS !== 0) throw new Error('Historical frame must end on a quarter-hour boundary');
  return ms;
}
export const frameStart = (end: string) => new Date(time(end) - FRAME_MS).toISOString();
export const shiftFrame = (end: string, direction: -1 | 1) => new Date(time(end) + direction * FRAME_MS).toISOString();

function index<T extends { start_ts: string }>(rows: T[]): Map<number, T> {
  const result = new Map<number, T>();
  rows.forEach(row => { const ms = time(row.start_ts); if (result.has(ms)) throw new Error(`Duplicate historical input at ${row.start_ts}`); result.set(ms, row); });
  return result;
}
function number(value: unknown, label: string, at: string, nonnegative = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonnegative && value < 0)) throw new Error(`Missing or invalid ${label} at ${at}`);
  return value;
}
function soc(value: unknown, label: string, at: string) {
  const result = number(value, label, at, true);
  if (result > 1) throw new Error(`Invalid ${label} at ${at}`);
  return result;
}

/** Only recorded data becomes a dense input. Nullable unknowns never become zero. */
export function prepareHomeBaseline(rows: HistoricalRows): BaselineInput {
  const facts = homePhysics(rows.snapshot), startMs = time(rows.start), start = new Date(startMs).toISOString();
  const count = (time(rows.end) - startMs) / QUARTER_MS;
  if (count <= 0) throw new Error('Historical period must contain completed quarters');
  const actual = index(rows.actual), prices = index(rows.prices), meters = index(rows.deviceSlots), pool = index(rows.pool), outdoor = index(rows.outdoor);
  const ids = new Map(rows.devices.map(d => [d.device_key, d.id]));
  const memberIds = facts.memberKeys.map(key => { const id = ids.get(key); if (!id) throw new Error(`Historical device identity is missing: ${key}`); return { id, key }; });
  if (new Set(memberIds.map(m => m.id)).size !== memberIds.length) throw new Error('Duplicate modeled device identity');
  const initialObservedAt = new Date(startMs - QUARTER_MS).toISOString(), prior = actual.get(startMs - QUARTER_MS);
  const batterySoc = facts.battery ? soc(prior?.battery_soc, 'initial battery SOC', initialObservedAt) : null;
  const evSoc = facts.car ? soc(rows.evInitial?.ev_soc, 'initial EV SOC', rows.evInitial?.start_ts ?? initialObservedAt) : null;
  if (facts.car && (!rows.evInitial || time(rows.evInitial.start_ts) >= startMs)) throw new Error('Initial EV SOC must be a historical reading before the frame');
  let lastEvSoc = evSoc, evMissingSocQuarters = 0;
  const daily = new Map<string, number>();
  const evDemandKwh = Array.from({ length: count }, (_, i) => {
    if (!facts.car) return 0;
    const at = new Date(startMs + i * QUARTER_MS).toISOString();
    const observed = actual.get(Date.parse(at))?.ev_soc;
    if (observed === null || observed === undefined) { evMissingSocQuarters++; return 0; }
    const current = soc(observed, 'EV SOC', at);
    const demand = Math.max(0, lastEvSoc! - current) * facts.car.capacity_kwh;
    lastEvSoc = current;
    const day = localDay(at, rows.snapshot.timezone);
    daily.set(day, (daily.get(day) ?? 0) + demand);
    return demand;
  });
  const poolC = facts.poolStore ? number(pool.get(startMs - QUARTER_MS)?.water_temperature_c, 'initial pool temperature', initialObservedAt) : null;
  const idlePumpW = facts.poolStore ? DEFAULT_SETTINGS.idlePumpW : 0;
  if (facts.heater && facts.heater.auxiliary_w < idlePumpW) throw new Error('Full-power pool auxiliary model is below the stated 60 W circulation draw');
  const starts = Array.from({ length: count }, (_, i) => new Date(startMs + i * QUARTER_MS).toISOString());
  const months = localMonths(starts, rows.snapshot.timezone);
  const needsOutdoor = facts.poolStore?.loss.kind === 'linear' && facts.poolStore.loss.surroundings_c === null;
  const problem: ReadyProblem = {
    abi: 8, work_grant: recipe.work_grant, recipe: builderRecipe(recipe), ev_battery_supply_allowed: DEFAULT_SETTINGS.batterySuppliesEv,
    battery: facts.battery, car: facts.car, charger: facts.charger, pool_store: facts.poolStore,
    heater: facts.heater ? { ...facts.heater, auxiliary_w: facts.heater.auxiliary_w - idlePumpW } : null,
    pool_stop_c: facts.poolStore ? DEFAULT_SETTINGS.poolStopC : null,
    initial: { battery_kwh: batterySoc === null ? null : batterySoc * facts.battery!.capacity_kwh,
      ev_kwh: evSoc === null ? null : evSoc * facts.car!.capacity_kwh, pool_c: poolC,
      heater_state: facts.poolStore ? { kind: 'off_unobserved' } : null },
    slots: starts.map((at, i) => {
      const ms = Date.parse(at), observed = actual.get(ms), price = prices.get(ms), meter = meters.get(ms);
      const load = number(observed?.total_load_kwh, 'household load', at, true);
      const removed = memberIds.reduce((sum, m) => sum + number(meter?.device_energy_kwh?.[m.id], `device meter ${m.key}`, at, true), 0);
      const base = load - removed;
      // Floating point cancellation only; no metering tolerance or invented load.
      if (base < -1e-9) throw new Error(`Modeled device energy exceeds household load at ${at}`);
      return { local_month: months[i], start_seconds: i * 900, hours: .25,
        base_w: Math.max(0, base) * 4000 + idlePumpW, base_ev_w: 0,
        solar_w: number(observed?.solar_production_kwh, 'solar generation', at, true) * 4000,
        outdoor_c: needsOutdoor ? number(outdoor.get(ms)?.temperature_c, 'outdoor temperature', at) : 0,
        import_price: number(price?.import_price_sek_per_kwh, 'import price', at),
        export_price: number(price?.export_price_sek_per_kwh, 'export price', at), published: true, ev_available: !!facts.car };
    }),
    targets: { pool_c: facts.poolStore ? DEFAULT_SETTINGS.poolStopC : null,
      ev_km: facts.car ? .8 * facts.car.capacity_kwh / facts.car.kwh_per_km : null,
      ev_limit_kwh: facts.car ? .8 * facts.car.capacity_kwh : null },
    limits: { import_w: rows.snapshot.grid.import_limit_w, export_w: rows.snapshot.grid.export_limit_w,
      battery_export_enabled: false, battery_export_reserve_kwh: 0, battery_export_min_price: 0,
      wear_per_kwh: facts.wear, pool_start_cost_sek: POOL_START_COST_SEK },
    rules: [], service_guard: { pool: [0, 0], ev: [0, 0] }, accepted: null, locked_through_seconds: 0,
    end_credit: { reference_sek_per_kwh: 0, battery: null, pool: null, ev: null },
  };
  return { start, end: new Date(time(rows.end)).toISOString(), timeZone: rows.snapshot.timezone,
    modelCapturedAt: rows.snapshot.captured_at, initialObservedAt, problem, idlePumpW, carName: facts.carName,
    evInitialObservedAt: facts.car ? rows.evInitial!.start_ts : null, evDemandKwh,
    evDailyDemand: [...daily].map(([day, kwh]) => ({ day, kwh })), evMissingSocQuarters };
}

export function projectBaseline(input: BaselineInput, engine: ProjectionEngine) {
  const began = performance.now();
  const { problem, commands, quarters } = projectDefaultProblem(input.problem, input.start, input.timeZone, DEFAULT_SETTINGS, engine, input.evDemandKwh);
  const field = (get: (q: typeof quarters[number], i: number) => number) => quarters.map(get);
  const devices = [
    ...(problem.pool_store ? [{ key: '$default_pool_heat', name: 'Pool heat pump', schedulable: true }, { key: '$default_pool_pump', name: 'Pool circulation', schedulable: true }] : []),
    ...(problem.car ? [{ key: '$default_ev', name: input.carName, schedulable: true }] : []),
  ];
  const series: BenchSeries = {
    devices, deviceW: Object.fromEntries(devices.map(d => [d.key, d.key === '$default_pool_heat' ? field(q => q.pool_compressor_w)
      : d.key === '$default_pool_pump' ? field(q => q.pool_auxiliary_w + input.idlePumpW) : field(q => q.ev_w)])),
    start: problem.slots.map(s => new Date(Date.parse(input.start) + s.start_seconds * 1000).toISOString()), hours: problem.slots.map(s => s.hours),
    published: problem.slots.map(() => 1), importPrice: problem.slots.map(s => s.import_price), exportPrice: problem.slots.map(s => s.export_price),
    solarW: problem.slots.map(s => s.solar_w), loadW: field((q, i) => problem.slots[i].base_w + q.pool_w + q.ev_w),
    poolW: field(q => q.pool_w + input.idlePumpW), hotWaterW: field(() => 0), carW: field(q => q.ev_w),
    gridImportW: field(q => Math.max(0, q.net_w)), gridExportW: field(q => Math.max(0, -q.net_w)),
    batteryChargeW: field(q => q.charge_w), batteryDischargeW: field(q => q.discharge_w),
    homeStartSoc: problem.battery ? problem.initial.battery_kwh! / problem.battery.capacity_kwh * 100 : null,
    homeSoc: quarters.map(q => problem.battery ? q.battery_kwh! / problem.battery.capacity_kwh * 100 : null),
    carSoc: quarters.map(q => problem.car ? q.ev_kwh! / problem.car.capacity_kwh * 100 : null),
    carKm: field(q => problem.car ? q.ev_kwh! / problem.car.kwh_per_km : 0), carConnected: field(() => problem.car ? 1 : 0),
    poolC: quarters.map(q => q.pool_c), poolStart: quarters.map(q => q.pool_start) as BenchSeries['poolStart'],
    costSek: field(q => q.cost), wearSek: field(q => q.wear),
  };
  return { series, commands, ledger: electricityLedger(quarters, problem), projectionMs: performance.now() - began };
}
export type BaselineResult = ReturnType<typeof projectBaseline>;
