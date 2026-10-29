import { finalSimulationState, simulationProblem, type SimulationStart } from './simulation-state.ts';
import { parseDeviceColours } from '../energy-shift/device-colours.ts';
import { deviceMembers, allocateDevicePower, type DeviceMember } from '../../../supabase/functions/_shared/planner/device-power-allocation.ts';
import { poolHeaters } from '../../../supabase/functions/_shared/planner/pool-devices.ts';
import recipe from '../../../planner-core/recipe.json' with { type: 'json' };
import { builderRecipe, type ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import { localDay, localMonths } from '../../../supabase/functions/_shared/planner-wasm/calendar.ts';
import { POOL_START_COST_SEK, EV_START_PREFERENCE_SEK, BATTERY_START_PREFERENCE_SEK } from '../../../supabase/functions/_shared/planner-wasm/cost-policy.ts';
import type { BenchSeries } from '../planner-bench/types.ts';
import { homePhysics, type HomeModelCapture } from './home-physics.ts';
import { defaultSettings, electricityLedger, projectDefaultProblem, type ProjectionEngine } from './controller.ts';
import { addElectricity, emptyElectricityLedger, type ElectricityLedger } from './ledger.ts';
import { buildEnergyTimeline, type TimelineRow } from '../energy-shift/energy-timeline.ts';
import type { ActualEnergySlot } from '../energy-shift/contracts.ts';
import type { ChartDevice } from '../energy-shift/plan-chart-data.ts';
import { emptyRecovery, type RecoverySummary } from './recovered-history.ts';
import { assessAssumptions, type InputEvidence } from './evidence.ts';
import { modeledSolar, type SolarHour, type SolarProfile } from './solar.ts';
import { quarterPool, type PoolStart } from './pool-carry.ts';
import type { ActualPrice } from '../../../supabase/functions/_shared/actual-contract-prices.ts';
import { inferredEvAvailability } from './trip-ledger.ts';

export const QUARTER_MS = 900_000, FRAME_MS = 72 * 3_600_000;
export type ActualRow = ActualEnergySlot;
export type PriceRow = import('../../../supabase/functions/_shared/historical-electricity-prices.ts').HistoricalPrice;
export interface DeviceRow { colour: string; id: string; device_key: string; name?: string; category: string }
export interface DeviceSlot { start_ts: string; device_energy_kwh: Record<string, number | null> }
export interface PoolRow { start_ts: string; water_temperature_c: number | null }
export interface OutdoorRow { start_ts: string; temperature_c: number }
export interface EvInitialRow { start_ts: string; ev_soc: number | null }
export interface HistoricalRows { snapshot: HomeModelCapture; solar?: { profile: SolarProfile; hours: SolarHour[] }; start: string; end: string; priceArea: string; evInitial: EvInitialRow | null; actual: ActualRow[]; prices: PriceRow[]; actualPrices: ActualPrice[];
    devices: DeviceRow[]; deviceSlots: DeviceSlot[]; pool: PoolRow[]; outdoor: OutdoorRow[]; baselineLoads?: { start_ts: string; kwh: number }[]; recovery?: RecoverySummary; hourlyFields?: { start_ts: string; fields: string[] }[]; intervalFields?: { start_ts: string; fields: string[] }[]; tariff?: import('../../../supabase/functions/_shared/energy-grid-pricing.ts').GridTariffCatalogue }
export interface BaselineInput { equipment?: import('./equipment.ts').EquipmentTrial; members: { heater: DeviceMember[]; auxiliary: DeviceMember[]; ev: DeviceMember[] }; tariff?: import('../../../supabase/functions/_shared/energy-grid-pricing.ts').GridTariffCatalogue; settings: Pick<HomeModelCapture, 'comfort' | 'policy' | 'criteria' | 'ev_battery' | 'pool_model'>; start: string; end: string; timeZone: string; modelCapturedAt: string; initialObservedAt: string; batteryInitialAssumed: boolean; evInitialAssumed: boolean; poolInitialAssumed: boolean;
  pool: PoolStart | null;
  continuation: SimulationStart | null;
  planningTail: { slots: ReadyProblem['slots']; evDemandKwh: number[] };
  evidence: InputEvidence;
  solar: { profileHash: string | null; reconstructedKwh: number; reconstructedQuarters: number };
  recovery: RecoverySummary;
  priceArea: string; reconstructedPriceQuarters: number; assumedPriceQuarters: number; problem: ReadyProblem; idlePumpW: number; carName: string; evInitialObservedAt: string | null;
  evDemandKwh: number[]; evDailyDemand: { day: string; kwh: number }[]; evMissingSocQuarters: number;
  energyGaps: { householdQuarters: number; solarQuarters: number; deviceReadings: number };
  recorded: { rows: TimelineRow[]; devices: ChartDevice[]; ledger: ElectricityLedger; missingImportQuarters: number; missingExportQuarters: number; gridImportCostSek: number } }

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

/** Missing energy contributes zero; missing household totals use the other device meters. */
export function prepareHomeBaseline(rows: HistoricalRows): BaselineInput {
  parseDeviceColours(rows.devices);
  const facts = homePhysics(rows.snapshot), startMs = time(rows.start), start = new Date(startMs).toISOString();
  const count = (time(rows.end) - startMs) / QUARTER_MS;
  if (count <= 0) throw new Error('Historical period must contain completed quarters');
  const actual = index(rows.actual), prices = index(rows.prices), meters = index(rows.deviceSlots), pool = index(rows.pool), outdoor = index(rows.outdoor), baselineLoads = index(rows.baselineLoads ?? []);
  if ((rows.solar?.profile.profile_hash ?? null) !== rows.snapshot.roi_solar_profile) throw new Error('ROI solar profile changed; reload the report');
  const reconstructedSolar = modeledSolar(rows.solar?.profile ?? null, rows.solar?.hours ?? []);
  const solar = { profileHash: rows.snapshot.roi_solar_profile, reconstructedKwh: 0, reconstructedQuarters: 0 };
  const ids = new Map(rows.devices.map(d => [d.device_key, d.id]));
  const memberIds = facts.memberKeys.map(key => { const id = ids.get(key); if (!id) throw new Error(`Historical device identity is missing: ${key}`); return { id, key }; });
  if (new Set(memberIds.map(m => m.id)).size !== memberIds.length) throw new Error('Duplicate modeled device identity');
  const replaced = new Set(memberIds.map(m => m.id));
  const missingDevices = memberIds.map(m => ({ key: m.key, name: rows.devices.find(d => d.id === m.id)?.name ?? m.key, quarters: 0 }));
  const hourlyByTime = new Map((rows.hourlyFields ?? []).map(r => [Date.parse(r.start_ts), new Set(r.fields)]));
  const fieldCounts = new Map<string, number>();
  for (const [at, fields] of hourlyByTime) if (at >= startMs && at < time(rows.end)) fields.forEach(field => fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1));
  const evidence: InputEvidence = { hourlyModel: [], hourlyImport: [], hourlyExport: [], assumedMarkup: [], missingDevices,
    hourlyFields: [...fieldCounts].map(([field, quarters]) => ({ field: field.startsWith('device:')
      ? `device:${rows.devices.find(d => d.id === field.slice(7))?.name ?? rows.devices.find(d => d.id === field.slice(7))?.device_key ?? field.slice(7)}` : field, quarters })) };
  const intervalQuarters = new Set((rows.intervalFields ?? []).map(r => Date.parse(r.start_ts)));
  const energyGaps = { householdQuarters: 0, solarQuarters: 0, deviceReadings: 0 };
  const recorded = { ledger: emptyElectricityLedger(), missingImportQuarters: 0, missingExportQuarters: 0, gridImportCostSek: 0 };
  const energy = (value: unknown, label: string, at: string, gap: keyof typeof energyGaps) => {
    if (value === null || value === undefined) { energyGaps[gap]++; return 0; }
    return number(value, label, at, true);
  };
  const initialObservedAt = new Date(startMs - QUARTER_MS).toISOString(), prior = actual.get(startMs - QUARTER_MS);
  const batteryInitialAssumed = facts.battery !== null && prior?.battery_soc == null;
  const batterySoc = facts.battery ? batteryInitialAssumed ? 0 : soc(prior?.battery_soc, 'initial battery SOC', initialObservedAt) : null;
  const evInitialAssumed = facts.car !== null && rows.evInitial?.ev_soc == null;
  const evSoc = facts.car ? evInitialAssumed ? .8 : soc(rows.evInitial?.ev_soc, 'initial EV SOC', rows.evInitial!.start_ts) : null;
  if (facts.car && !evInitialAssumed && time(rows.evInitial!.start_ts) >= startMs) throw new Error('Initial EV SOC must be a historical reading before the frame');
  // Assumed starting energy is not an observed driving-demand reference.
  let lastEvSoc = evInitialAssumed ? null : evSoc, evMissingSocQuarters = 0;
  const independentEvSoc = Array<boolean>(count).fill(false);
  const daily = new Map<string, number>();
  const evDemandKwh = Array.from({ length: count }, (_, i) => {
    if (!facts.car) return 0;
    const at = new Date(startMs + i * QUARTER_MS).toISOString();
    const observed = actual.get(Date.parse(at))?.ev_soc;
    if (observed === null || observed === undefined) { evMissingSocQuarters++; return 0; }
    const current = soc(observed, 'EV SOC', at);
    // Recovery copies one hourly mean into four quarters. Only its original
    // hour boundary is an observation; measured quarters retain their resolution.
    independentEvSoc[i] = !hourlyByTime.get(Date.parse(at))?.has('ev_soc') || Date.parse(at) % 3_600_000 === 0;
    const demand = lastEvSoc === null ? 0 : Math.max(0, lastEvSoc - current) * facts.car.capacity_kwh;
    lastEvSoc = current;
    const day = localDay(at, rows.snapshot.timezone);
    daily.set(day, (daily.get(day) ?? 0) + demand);
    return demand;
  });
  const evAvailable = inferredEvAvailability(evDemandKwh, independentEvSoc);
  const poolInitialAssumed = facts.poolStore !== null && pool.get(startMs - QUARTER_MS)?.water_temperature_c == null;
  const settings = defaultSettings(rows.snapshot.comfort?.pool?.target_c);
  const poolC = facts.poolStore ? poolInitialAssumed ? settings.poolStartC : number(pool.get(startMs - QUARTER_MS)?.water_temperature_c, 'initial pool temperature', initialObservedAt) : null;
  const idlePumpW = facts.poolStore ? settings.idlePumpW : 0;
  if (facts.heater && facts.heater.auxiliary_w < idlePumpW) throw new Error('Full-power pool auxiliary model is below the stated 60 W circulation draw');
  const starts = Array.from({ length: count }, (_, i) => new Date(startMs + i * QUARTER_MS).toISOString());
  const months = localMonths(starts, rows.snapshot.timezone);
  const needsOutdoor = facts.poolStore?.loss.kind === 'linear' && facts.poolStore.loss.surroundings_c === null;
  const problem: ReadyProblem = {
    abi: 13, work_grant: recipe.work_grant, recipe: builderRecipe(recipe), ev_battery_supply_allowed: settings.batterySuppliesEv,
    battery: facts.battery, car: facts.car, charger: facts.charger, pool_store: facts.poolStore,
    heater: facts.heater ? { ...facts.heater, auxiliary_w: facts.heater.auxiliary_w - idlePumpW } : null,
    pool_stop_c: facts.poolStore ? settings.poolStopC : null,
    initial: { battery_kwh: batterySoc === null ? null : batterySoc * facts.battery!.capacity_kwh,
      ev_kwh: evSoc === null ? null : evSoc * facts.car!.capacity_kwh, pool_c: poolC, pool_pending_heat_kwh: facts.poolStore ? 0 : null, pool_source_depletion_kwh: null,
      heater_state: facts.poolStore ? { kind: 'off_unobserved' } : null },
    slots: starts.map((at, i) => {
      const ms = Date.parse(at), observed = actual.get(ms), price = prices.get(ms), meter = meters.get(ms);
      const removed = memberIds.reduce((sum, m, member) => {
        const value = meter?.device_energy_kwh?.[m.id]; if (value == null) missingDevices[member].quarters++;
        return sum + energy(value, `device meter ${m.key}`, at, 'deviceReadings');
      }, 0);
      evidence.hourlyModel.push(['total_load_kwh', 'solar_production_kwh', ...rows.devices.filter(d => replaced.has(d.id) || baselineLoads.has(ms) || observed?.total_load_kwh == null).map(d => `device:${d.id}`)].some(field => hourlyByTime.get(ms)?.has(field)));
      evidence.hourlyImport.push(hourlyByTime.get(ms)?.has('grid_import_kwh') ?? false);
      evidence.hourlyExport.push(hourlyByTime.get(ms)?.has('grid_export_kwh') ?? false);
      evidence.assumedMarkup.push(price?.supplier_revision.includes('assumed') ?? false);
      let base: number;
      if (baselineLoads.has(ms)) {
        base = number(baselineLoads.get(ms)!.kwh, 'device-summed baseline load', at, true);
      } else if (observed?.total_load_kwh === null || observed?.total_load_kwh === undefined) {
        energyGaps.householdQuarters++;
        base = Object.entries(meter?.device_energy_kwh ?? {}).reduce((sum, [id, value]) => replaced.has(id) ? sum
          : sum + energy(value, `device meter ${id}`, at, 'deviceReadings'), 0);
      } else {
        base = number(observed.total_load_kwh, 'household load', at, true) - removed;
      }
      // Floating point cancellation only; no metering tolerance or invented load.
      if (base < -1e-9) throw new Error(`Modeled device energy exceeds household load at ${at}`);
      const importPrice = number(price?.import_price_sek_per_kwh, 'import price', at);
      const exportPrice = number(price?.export_price_sek_per_kwh, 'export price', at);
      const gridEnergy = (value: number | null | undefined, label: 'Import' | 'Export') => {
        if (value === null || value === undefined) { recorded[`missing${label}Quarters`]++; return 0; }
        return number(value, `grid ${label.toLowerCase()}`, at, true);
      };
      const bought = gridEnergy(observed?.grid_import_kwh, 'Import');
      addElectricity(recorded.ledger, bought, gridEnergy(observed?.grid_export_kwh, 'Export'), importPrice, exportPrice);
      recorded.gridImportCostSek += bought * number(price?.grid_import_price_sek_per_kwh, 'grid tariff', at);
      const modeledKwh = reconstructedSolar(ms);
      if (modeledKwh !== null) { solar.reconstructedKwh += modeledKwh; solar.reconstructedQuarters++; }
      return { local_month: months[i], start_seconds: i * 900, hours: .25,
        base_w: Math.max(0, base) * 4000 + idlePumpW, base_ev_w: 0,
        solar_w: (modeledKwh ?? energy(observed?.solar_production_kwh, 'solar generation', at, 'solarQuarters')) * 4000,
        outdoor_c: needsOutdoor ? number(outdoor.get(ms)?.temperature_c, 'outdoor temperature', at) : 0,
        import_price: importPrice, export_price: exportPrice, published: true, ev_available: !!facts.car && evAvailable[i], pool_auxiliary_dispatch: null };
    }),
    targets: { pool_c: facts.poolStore ? settings.poolStopC : null,
      ev_km: facts.car ? .8 * facts.car.capacity_kwh / facts.car.kwh_per_km : null,
      ev_limit_kwh: facts.car ? .8 * facts.car.capacity_kwh : null },
    limits: { import_w: rows.snapshot.grid.import_limit_w, export_w: rows.snapshot.grid.export_limit_w,
      battery_export_enabled: false, battery_export_reserve_kwh: 0, battery_export_min_price: 0,
      wear_per_kwh: facts.wear, ev_start_preference_sek: EV_START_PREFERENCE_SEK, battery_start_preference_sek: BATTERY_START_PREFERENCE_SEK, pool_start_cost_sek: POOL_START_COST_SEK },
    rules: [], service_guard: { pool: [0, 0], ev: [0, 0] }, accepted: null, released: null, unavailable: null, locked_through_seconds: 0,
    end_credit: { reference_sek_per_kwh: 0, battery: null, pool: null, ev: null },
  };
  const poolMembers = rows.snapshot.device_models.filter(model => model.planning_service === 'pool');
  const heaterKeys = new Set(poolHeaters(poolMembers).map(model => model.key));
  const members = {
    heater: facts.heater ? deviceMembers(poolMembers.filter(model => heaterKeys.has(model.key)), facts.heater.compressor_w) : [],
    auxiliary: facts.heater ? deviceMembers(poolMembers.filter(model => !heaterKeys.has(model.key)), facts.heater.auxiliary_w) : [],
    ev: facts.charger ? deviceMembers(rows.snapshot.device_models.filter(model => model.category === 'ev_charging'), facts.charger.max_current_a * facts.charger.voltage_v * facts.charger.phase_count) : [],
  };
  return { members, pool: null, continuation: null, planningTail: { slots: [], evDemandKwh: [] }, tariff: rows.tariff, solar, settings: { comfort: rows.snapshot.comfort, policy: rows.snapshot.policy, criteria: rows.snapshot.criteria, ev_battery: rows.snapshot.ev_battery, pool_model: rows.snapshot.pool_model }, start, end: new Date(time(rows.end)).toISOString(), timeZone: rows.snapshot.timezone, evidence, recovery: rows.recovery ?? emptyRecovery(),
    priceArea: rows.priceArea, reconstructedPriceQuarters: rows.prices.filter(row => row.source === 'reconstructed').length,
    assumedPriceQuarters: rows.prices.filter(row => row.supplier_revision.includes('assumed')).length, modelCapturedAt: rows.snapshot.captured_at, initialObservedAt, batteryInitialAssumed, evInitialAssumed, poolInitialAssumed, problem, idlePumpW, carName: facts.carName,
    evInitialObservedAt: facts.car && !evInitialAssumed ? rows.evInitial!.start_ts : null, evDemandKwh,
    evDailyDemand: [...daily].map(([day, kwh]) => ({ day, kwh })), evMissingSocQuarters, energyGaps,
    recorded: { ...recorded,
      devices: rows.devices.map(d => ({ key: d.device_key, name: d.name ?? rows.snapshot.device_models.find(m => m.key === d.device_key)?.name ?? d.device_key,
        colour: d.colour, schedulable: facts.memberKeys.includes(d.device_key) })),
      rows: buildEnergyTimeline({ nowMs: time(rows.end), planSlots: [],
        actuals: starts.map(start_ts => {
          const observed = actual.get(Date.parse(start_ts));
          const measuredEnergy = (value: number | null | undefined, label: string) => value == null ? 0 : number(value, label, start_ts, true);
          return { start_ts, total_load_kwh: measuredEnergy(observed?.total_load_kwh, 'household load'),
            solar_production_kwh: measuredEnergy(observed?.solar_production_kwh, 'solar generation'),
            grid_import_kwh: measuredEnergy(observed?.grid_import_kwh, 'grid import'), grid_export_kwh: measuredEnergy(observed?.grid_export_kwh, 'grid export'),
            battery_charge_kwh: measuredEnergy(observed?.battery_charge_kwh, 'battery charge'), battery_discharge_kwh: measuredEnergy(observed?.battery_discharge_kwh, 'battery discharge'),
            battery_soc: observed?.battery_soc == null ? null : soc(observed.battery_soc, 'battery SOC', start_ts),
            ev_soc: observed?.ev_soc == null ? null : soc(observed.ev_soc, 'EV SOC', start_ts) };
        }), prices: rows.actualPrices,
        deviceActuals: rows.deviceSlots.map(row => ({ ...row, device_energy_kwh: Object.fromEntries(Object.entries(row.device_energy_kwh).map(([id, value]) => [id, value == null ? 0 : number(value, `device meter ${id}`, row.start_ts, true)])) })),
        estimatedEnergyStarts: intervalQuarters, deviceKeyById: new Map(rows.devices.map(d => [d.id, d.device_key])), poolActuals: rows.pool.flatMap(row => row.water_temperature_c == null ? [] : [{ ...row, water_temperature_c: row.water_temperature_c }]) }),
    } };
}

export function projectBaseline(input: BaselineInput, engine: ProjectionEngine, assess = true) {
  const began = performance.now();
  const { problem, commands, quarters } = projectDefaultProblem(simulationProblem(input, 'baseline'), input.start, input.timeZone, defaultSettings(input.settings.comfort?.pool?.target_c), engine, input.evDemandKwh);
  const series = projectionSeries(input, problem, quarters);
  const ledger = electricityLedger(quarters, problem);
  return { series, commands, ledger, states: quarters.map(finalSimulationState), poolStates: quarters.map(quarterPool), sensitivity: assess ? assessAssumptions(input, ledger.costSek, series.gridImportW, engine) : { initial: [], markup10OreDeltaSek: 0, timingSavingMinSek: 0, timingSavingMaxSek: 0 }, projectionMs: performance.now() - began };
}

export function projectionSeries(input: BaselineInput, problem: ReadyProblem, quarters: import('../../../supabase/functions/_shared/planner-wasm/core.ts').NativeQuarter[]): BenchSeries {
  const field = (get: (q: typeof quarters[number], i: number) => number) => quarters.map(get);
  const keys = new Set(Object.values(input.members).flat().map(member => member.key));
  const devices = [...keys].map(key => {
    const device = input.recorded.devices.find(device => device.key === key);
    if (!device) throw new Error(`Historical device presentation is missing: ${key}`);
    return { ...device };
  });
  const loads = quarters.map(quarter => {
    const result: Record<string, number> = {};
    allocateDevicePower(input.members.heater, quarter.pool_compressor_w, result);
    allocateDevicePower(input.members.auxiliary, quarter.pool_auxiliary_w + input.idlePumpW, result);
    allocateDevicePower(input.members.ev, quarter.ev_w, result);
    return result;
  });
  const series: BenchSeries = {
    devices, deviceW: Object.fromEntries(devices.map(device => [device.key, loads.map(slot => slot[device.key])])),
    start: problem.slots.map(s => new Date(Date.parse(input.start) + s.start_seconds * 1000).toISOString()), hours: problem.slots.map(s => s.hours),
    published: problem.slots.map(() => 1), importPrice: problem.slots.map(s => s.import_price), exportPrice: problem.slots.map(s => s.export_price),
    solarW: field((q, i) => Math.max(0, problem.slots[i].solar_w - q.curtailed_w)), loadW: field((q, i) => problem.slots[i].base_w + q.pool_w + q.ev_w),
    poolW: field(q => q.pool_w + input.idlePumpW), hotWaterW: field(() => 0), carW: field(q => q.ev_w),
    gridImportW: field(q => Math.max(0, q.net_w)), gridExportW: field(q => Math.max(0, -q.net_w)),
    batteryChargeW: field(q => q.charge_w), batteryDischargeW: field(q => q.discharge_w),
    homeStartSoc: problem.battery ? problem.initial.battery_kwh! / problem.battery.capacity_kwh * 100 : null,
    homeSoc: quarters.map(q => problem.battery ? q.battery_kwh! / problem.battery.capacity_kwh * 100 : null),
    carSoc: quarters.map(q => problem.car ? q.ev_kwh! / problem.car.capacity_kwh * 100 : null),
    carKm: field(q => problem.car ? q.ev_kwh! / problem.car.kwh_per_km : 0), carConnected: field((_, i) => problem.slots[i].ev_available ? 1 : 0),
    poolC: quarters.map(q => q.pool_c), poolPendingHeatKwh: quarters.map(q => q.pool_pending_heat_kwh), poolSourceDepletionKwh: quarters.map(q => q.pool_source_depletion_kwh), poolStart: quarters.map(q => q.pool_start) as BenchSeries['poolStart'],
    costSek: field(q => q.cost), wearSek: field(q => q.wear),
  };
  return series;
}
export type BaselineResult = ReturnType<typeof projectBaseline>;
