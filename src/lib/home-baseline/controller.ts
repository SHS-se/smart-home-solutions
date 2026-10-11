import type { createWasmPlanner, NativeQuarter } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import type { NativeCommand, ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem.ts';

export interface DefaultSettings { poolStartC: number; poolStopC: number; idlePumpW: number; batterySuppliesEv: boolean }
export const DEFAULT_SETTINGS: DefaultSettings = { poolStartC: 30, poolStopC: 30.5, idlePumpW: 60, batterySuppliesEv: true };
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
  for (let i = 0; i < problem.slots.length; i++) {
    if (problem.car) {
      const remaining = initial.ev_kwh! - evDemandKwh[i];
      if (remaining < -1e-9) throw new Error(`Recorded EV demand exceeds default battery energy at quarter ${i}`);
      initial = { ...initial, ev_kwh: Math.max(0, remaining) };
    }
    if (problem.pool_store) {
      if (initial.pool_c! <= settings.poolStartC) heating = true;
      else if (initial.pool_c! >= settings.poolStopC) heating = false;
    }
    if (clock.format(new Date(Date.parse(start) + problem.slots[i].start_seconds * 1000)) === '00:00') charging = true;
    if (!problem.car || initial.ev_kwh! >= problem.targets.ev_limit_kwh! - 1e-9) charging = false;
    const command: NativeCommand = { pool_on: heating, ev_amps: charging ? problem.charger!.max_current_a : 0,
      battery: problem.battery ? 'self_consumption' : 'idle',
      charge_limit_w: problem.battery?.charge_max_w ?? 0, discharge_limit_w: problem.battery?.discharge_max_w ?? 0 };
    const out = engine.project({ ...problem, initial, slots: [{ ...problem.slots[i], start_seconds: 0 }] }, [command]).outcome;
    if (out.kind === 'failed') throw new Error(`Default operation at quarter ${i}: ${out.issue}`);
    const q = out.quarters[0];
    commands.push(command); quarters.push(q);
    if (heating && q.heater_state?.kind === 'off') heating = false;
    initial = { battery_kwh: q.battery_kwh, ev_kwh: q.ev_kwh, pool_c: q.pool_c,
      heater_state: q.heater_state as ReadyProblem['initial']['heater_state'] };
  }
  return { problem, commands, quarters };
}

export interface ElectricityLedger { importKwh: number; exportKwh: number; importCostSek: number; exportRevenueSek: number; costSek: number }

export function electricityLedger(quarters: readonly NativeQuarter[], p: ReadyProblem): ElectricityLedger {
  const ledger: ElectricityLedger = { importKwh: 0, exportKwh: 0, importCostSek: 0, exportRevenueSek: 0, costSek: 0 };
  quarters.forEach((q, i) => {
    const bought = Math.max(0, q.net_w) * p.slots[i].hours / 1000, sold = Math.max(0, -q.net_w) * p.slots[i].hours / 1000;
    ledger.importKwh += bought; ledger.exportKwh += sold;
    ledger.importCostSek += bought * p.slots[i].import_price; ledger.exportRevenueSek += sold * p.slots[i].export_price;
  });
  ledger.costSek = ledger.importCostSek - ledger.exportRevenueSek;
  return ledger;
}

