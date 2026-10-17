import type { createWasmPlanner, NativeQuarter } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import type { NativeCommand, ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import { addElectricity, emptyElectricityLedger, type ElectricityLedger } from './ledger.ts';
import { withdrawTrip } from './trip-ledger.ts';
import { chargerLevels } from '../../../supabase/functions/_shared/planner/device-models.ts';
import { projectLoadBalancedEv } from '../../../supabase/functions/_shared/planner-wasm/load-balanced-ev.ts';
export type { ElectricityLedger } from './ledger.ts';

export interface DefaultSettings { poolStartC: number; poolStopC: number; idlePumpW: number; batterySuppliesEv: boolean }
export const DEFAULT_SETTINGS: DefaultSettings = { poolStartC: 30, poolStopC: 30.5, idlePumpW: 60, batterySuppliesEv: true };
/** How far the plain thermostat lets the pool fall below its target before it heats again. */
export const POOL_THERMOSTAT_BAND_C = .5;
/** Both models hold the same pool temperature: the thermostat stops where the scheduler aims.
 * A home with no stated target keeps the stock thermostat. */
export function defaultSettings(poolTargetC: number | null | undefined): DefaultSettings {
  return poolTargetC == null ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, poolStartC: poolTargetC - POOL_THERMOSTAT_BAND_C, poolStopC: poolTargetC };
}
export type ProjectionEngine = Pick<ReturnType<typeof createWasmPlanner>, 'project'>;

/** Fixed reactive decisions; native project owns every physical state transition. */
export function projectDefaultProblem(source: ReadyProblem, start: string, timeZone: string, settings: DefaultSettings, engine: ProjectionEngine, evDemandKwh: readonly number[]) {
  if (evDemandKwh.length !== source.slots.length || evDemandKwh.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid recorded EV demand');
  const problem: ReadyProblem = { ...source, ev_battery_supply_allowed: settings.batterySuppliesEv,
    pool_stop_c: source.pool_store ? settings.poolStopC : null,
    targets: { ...source.targets, ev_limit_kwh: source.car ? .8 * source.car.capacity_kwh : null } };
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let initial = problem.initial;
  let heating = ['running', 'steady'].includes(initial.heater_state?.kind ?? ''), charging = false;
  const commands: NativeCommand[] = [], quarters: NativeQuarter[] = [];
  const chargingLevels = problem.charger ? [...chargerLevels(problem.charger)].reverse().map(level => level.setting) : [0];
  for (let i = 0; i < problem.slots.length; i++) {
    if (problem.car) {
      initial = { ...initial, ev_kwh: withdrawTrip(initial.ev_kwh!, evDemandKwh[i], 'Baseline model', new Date(Date.parse(start) + i * 900_000).toISOString()) };
    }
    if (problem.pool_store) {
      if (initial.pool_c! <= settings.poolStartC) heating = true;
      else if (initial.pool_c! >= settings.poolStopC) heating = false;
    }
    if (clock.format(new Date(Date.parse(start) + problem.slots[i].start_seconds * 1000)) === '00:00') charging = true;
    if (!problem.car || initial.ev_kwh! >= problem.targets.ev_limit_kwh! - 1e-9) charging = false;
    const command: NativeCommand = { pool_on: heating, ev_amps: 0,
      battery: problem.battery ? 'self_consumption' : 'idle',
      charge_limit_w: problem.battery?.charge_max_w ?? 0, discharge_limit_w: problem.battery?.discharge_max_w ?? 0 };
    const quarter = { ...problem, initial, slots: [{ ...problem.slots[i], start_seconds: 0 }] };
    // Reactive charger load balancing: highest supported current that fits the
    // home's supply. Prices and forecasts never select this default command.
    const levels = charging && problem.slots[i].ev_available ? chargingLevels : [0];
    command.ev_amps = levels[0];
    const balanced = projectLoadBalancedEv(engine, quarter, command);
    Object.assign(command, balanced.command);
    let out = balanced.outcome;
    // With the car paused and still no room, what is left is the house and its pool
    // thermostat, and a thermostat does not know the main fuse: it runs, as it would
    // in the real house. The quarter is recorded above the limit rather than
    // invented otherwise. A house over its own limit with nothing running is a data
    // fault and still stops the month.
    if (out.kind === 'failed' && out.issue === 'shared_grid_limit' && command.pool_on && problem.slots[i].base_w <= problem.limits.import_w) {
      out = engine.project({ ...quarter, limits: { ...quarter.limits, import_w: Number.MAX_SAFE_INTEGER } }, [command]).outcome;
    }
    if (out.kind === 'failed') throw new Error(`Default operation at quarter ${i}: ${out.issue}`);
    const q = out.quarters[0];
    commands.push(command); quarters.push(q);
    if (heating && q.heater_state?.kind === 'off') heating = false;
    initial = { battery_kwh: q.battery_kwh, ev_kwh: q.ev_kwh, pool_c: q.pool_c, pool_pending_heat_kwh: q.pool_pending_heat_kwh,
      heater_state: q.heater_state as ReadyProblem['initial']['heater_state'] };
  }
  return { problem, commands, quarters };
}

export function electricityLedger(quarters: readonly NativeQuarter[], p: ReadyProblem): ElectricityLedger {
  const ledger = emptyElectricityLedger();
  quarters.forEach((q, i) => {
    const bought = Math.max(0, q.net_w) * p.slots[i].hours / 1000, sold = Math.max(0, -q.net_w) * p.slots[i].hours / 1000;
    addElectricity(ledger, bought, sold, p.slots[i].import_price, p.slots[i].export_price);
  });
  return ledger;
}

