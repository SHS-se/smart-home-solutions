// A separate experiment: forecast planning, measured execution, native defaults.
// Imports the working planner's public models/API without changing its sources.
import recipe from '../../../planner-core/recipe.json' with { type: 'json' };
import { createWasmPlanner, type NativeQuarter } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import { builderRecipe, RULE_KEYS, type NativeCommand, type PlannerRuleKey, type ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import { endCredit, problemEndCredit, type EndCredit } from '../../../supabase/functions/_shared/planner-wasm/end-credit.ts';
import { localDay, localMonths } from '../../../supabase/functions/_shared/planner-wasm/calendar.ts';
import { POOL_START_COST_SEK } from '../../../supabase/functions/_shared/planner-wasm/cost-policy.ts';
import { publishHeater } from '../../../supabase/functions/_shared/planner/device-models.ts';
import { demandLevel } from '../../../supabase/functions/_shared/planner/demand-outlook.ts';
import { buildPriceOutlook } from '../../../supabase/functions/_shared/planner/energy-price-shape.ts';
import { canonicalJson, caseTargets, quarterStarts, sha256, type BenchCase } from '../planner-bench/case.ts';
import { resolveRules, serviceGuard } from '../planner-bench/score.ts';
import { BENCH_DEVICES, BENCH_DEVICE_KEYS } from '../planner-bench/devices.ts';
import type { Household } from '../planner-bench/household.ts';
import type { BenchSeries, CriteriaOverrides } from '../planner-bench/types.ts';
import { hoursInDay } from '../contract-roi.ts';

export const COMPARISON_VERSION = 1;
export interface DefaultSettings { poolStartC: number; poolStopC: number; idlePumpW: number; batterySuppliesEv: boolean }
export const DEFAULT_SETTINGS: DefaultSettings = { poolStartC: 30, poolStopC: 30.5, idlePumpW: 60, batterySuppliesEv: true };
export type ComparisonEngine = Pick<ReturnType<typeof createWasmPlanner>, 'solve' | 'project'>;
export interface ElectricityLedger { importKwh: number; exportKwh: number; importCostSek: number; exportRevenueSek: number; costSek: number }
export interface ComparisonSide {
  commands: NativeCommand[]; quarters: NativeQuarter[]; series: BenchSeries; ledger: ElectricityLedger; credit: EndCredit;
  wearSek: number; poolMinimumC: number; poolBelowStartHours: number; evEndSoc: number; batteryEndSoc: number;
}
export interface SchedulerComparison {
  version: number; inputHash: string; settings: DefaultSettings; baseline: ComparisonSide; shs: ComparisonSide;
  cashSavingSek: number; adjustedSavingSek: number; forecastCostSek: number; forecastImportPrices: number[];
  forecastSolarW: number[]; poolTargetC: number; evTargetKm: number; evChargeLimitSoc: number;
}

function validateSettings(settings: DefaultSettings, h: Household) {
  if (![settings.poolStartC, settings.poolStopC, settings.idlePumpW].every(Number.isFinite)
    || settings.poolStartC >= settings.poolStopC || settings.idlePumpW < 0 || settings.idlePumpW > h.pool.heater.auxiliary_w
    || typeof settings.batterySuppliesEv !== 'boolean') throw new Error('Invalid default thermostat or circulation settings');
}

/** Comparison-specific adapter. Forecast algorithms and SHS rule inputs are reused unchanged. */
export function forecastProblem(c: BenchCase, h: Household, settings: DefaultSettings, criteria: CriteriaOverrides): ReadyProblem {
  validateSettings(settings, h);
  const starts = quarterStarts(c.start), months = localMonths(starts, c.timezone);
  const correction = demandLevel(c.recorded.history.demand_days, localDay(c.start, c.timezone));
  const history = c.recorded.history.prices.import_sek_per_kwh.flatMap((price, i) => price === null ? [] : [{
    start_ts: new Date(Date.parse(c.recorded.history.prices.start) + i * 900_000).toISOString(), import_price_sek_per_kwh: price,
  }]);
  const outlook = buildPriceOutlook(starts.map((start, i) => ({ start, import_price_sek_per_kwh: c.known_prices.import_sek_per_kwh[i] })),
    history, { timeZone: c.timezone, asOf: Date.parse(c.start), wind: c.recorded.wind?.days });
  const spreads = c.known_prices.import_sek_per_kwh.flatMap((v, i) => v === null || c.known_prices.export_sek_per_kwh[i] === null
    ? [] : [v - c.known_prices.export_sek_per_kwh[i]!]).sort((a, b) => a - b);
  if (!spreads.length) throw new Error('Price modelling requires a published import/export pair');
  const spread = spreads[Math.floor(spreads.length / 2)], target = caseTargets(c), heater = publishHeater(h.pool.heater);
  const p: ReadyProblem = {
    abi: 8, work_grant: recipe.work_grant, recipe: builderRecipe(recipe), ev_battery_supply_allowed: h.site.ev_battery_supply_allowed,
    slots: starts.map((_, i) => ({ local_month: months[i], start_seconds: i * 900, hours: .25,
      base_w: c.base_load_forecast_w[i] * (correction?.factor ?? 1) + settings.idlePumpW, base_ev_w: 0,
      solar_w: c.solar_forecast_w[i], outdoor_c: c.recorded.outdoor_temperature_c[i],
      import_price: outlook.shadowImportSekPerKwh[i], export_price: c.known_prices.export_sek_per_kwh[i] ?? outlook.shadowImportSekPerKwh[i] - spread,
      ev_available: true, published: c.known_prices.import_sek_per_kwh[i] !== null && c.known_prices.export_sek_per_kwh[i] !== null })),
    battery: h.battery, car: h.car.battery, charger: h.car.charger, pool_store: h.pool.store,
    // A common circulation floor is already in base_w. Heating adds only the difference.
    heater: { ...heater, auxiliary_w: heater.auxiliary_w - settings.idlePumpW }, pool_stop_c: settings.poolStopC,
    initial: { battery_kwh: c.start_state.battery_soc * h.battery.capacity_kwh, ev_kwh: c.start_state.ev.soc * h.car.battery.capacity_kwh,
      pool_c: c.start_state.pool_water_c, heater_state: c.start_state.pool_heater },
    targets: { pool_c: target.pool_c, ev_km: target.ev_km, ev_limit_kwh: c.start_state.ev.target_soc * h.car.battery.capacity_kwh },
    limits: { import_w: h.site.import_limit_w, export_w: h.site.export_limit_w, battery_export_enabled: h.site.battery_export_enabled,
      battery_export_reserve_kwh: h.site.battery_export_reserve_soc * h.battery.capacity_kwh,
      battery_export_min_price: h.site.battery_export_min_price_sek_per_kwh, wear_per_kwh: h.site.battery_degradation_sek_per_kwh, pool_start_cost_sek: POOL_START_COST_SEK },
    rules: resolveRules(criteria).flatMap(r => {
      if (!RULE_KEYS.some(key => key === r.key)) throw new Error(`Unsupported comparison rule: ${r.key}`);
      return r.enabled ? [{ key: r.key as PlannerRuleKey, threshold: r.threshold, points: r.points, required: r.required ?? false }] : [];
    }),
    service_guard: serviceGuard(criteria), accepted: null, locked_through_seconds: 0,
    end_credit: { reference_sek_per_kwh: 0, battery: null, pool: null, ev: null },
  };
  p.end_credit = problemEndCredit(p);
  return p;
}

function recordedProblem(c: BenchCase, p: ReadyProblem, settings: DefaultSettings): ReadyProblem {
  const actual = c.recorded.actual;
  if (!actual) throw new Error('Recorded household load and solar are required for the comparison');
  return { ...p, slots: p.slots.map((s, i) => ({ ...s, base_w: actual.base_load_w[i] + settings.idlePumpW,
    solar_w: actual.solar_w[i], import_price: c.recorded.prices.import_sek_per_kwh[i], export_price: c.recorded.prices.export_sek_per_kwh[i] })) };
}

/** Reactive policy only. All clipping, startup, heat losses and energy balance belong to native project(). */
export function projectDefaults(c: BenchCase, h: Household, forecast: ReadyProblem, settings: DefaultSettings, engine: ComparisonEngine) {
  const problem = { ...recordedProblem(c, forecast, settings), ev_battery_supply_allowed: settings.batterySuppliesEv,
    targets: { ...forecast.targets, ev_limit_kwh: .8 * h.car.battery.capacity_kwh } };
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: c.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let initial = problem.initial, heating = ['running', 'steady'].includes(c.start_state.pool_heater.kind), charging = false;
  const commands: NativeCommand[] = [], quarters: NativeQuarter[] = [];
  for (let i = 0; i < problem.slots.length; i++) {
    if (initial.pool_c! <= settings.poolStartC) heating = true;
    else if (initial.pool_c! >= settings.poolStopC) heating = false;
    if (clock.format(new Date(Date.parse(c.start) + i * 900_000)) === '00:00') charging = true;
    if (initial.ev_kwh! >= problem.targets.ev_limit_kwh! - 1e-9) charging = false;
    const command: NativeCommand = { pool_on: heating, ev_amps: charging ? h.car.charger.max_current_a : 0,
      battery: 'self_consumption', charge_limit_w: h.battery.charge_max_w, discharge_limit_w: h.battery.discharge_max_w };
    const out = engine.project({ ...problem, initial, slots: [{ ...problem.slots[i], start_seconds: 0 }] }, [command]).outcome;
    if (out.kind === 'failed') throw new Error(`Default operation at quarter ${i}: ${out.issue}`);
    const q = out.quarters[0];
    commands.push(command); quarters.push(q);
    // Native projection can reach stop temperature and cool again within this quarter.
    // The physical stop resets the thermostat latch even when its final reading is in the deadband.
    if (heating && q.heater_state?.kind === 'off') heating = false;
    initial = { battery_kwh: q.battery_kwh, ev_kwh: q.ev_kwh, pool_c: q.pool_c, heater_state: q.heater_state as ReadyProblem['initial']['heater_state'] };
  }
  return { problem, commands, quarters };
}

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

function side(c: BenchCase, h: Household, p: ReadyProblem, commands: NativeCommand[], quarters: NativeQuarter[], settings: DefaultSettings,
  terms: ReturnType<typeof problemEndCredit>, forecasts: ReadyProblem): ComparisonSide {
  const field = (get: (q: NativeQuarter, i: number) => number) => quarters.map(get);
  const pump = field(q => settings.idlePumpW + q.pool_auxiliary_w), compressor = field(q => q.pool_compressor_w);
  const series: BenchSeries = {
    devices: BENCH_DEVICES.map(d => ({ ...d })), deviceW: { [BENCH_DEVICE_KEYS.poolPump]: pump, [BENCH_DEVICE_KEYS.poolHeater]: compressor, [BENCH_DEVICE_KEYS.ev]: field(q => q.ev_w) },
    start: quarterStarts(c.start), hours: p.slots.map(s => s.hours), published: forecasts.slots.map(s => s.published ? 1 : 0),
    importPrice: p.slots.map(s => s.import_price), exportPrice: p.slots.map(s => s.export_price), believedImportPrice: forecasts.slots.map(s => s.import_price),
    solarW: p.slots.map(s => s.solar_w), loadW: field((q, i) => p.slots[i].base_w + q.pool_w + q.ev_w),
    poolW: field(q => q.pool_w + settings.idlePumpW), hotWaterW: field(() => 0), carW: field(q => q.ev_w), poolStart: quarters.map(q => q.pool_start ? { off_seconds: q.pool_start.off_seconds } : null),
    gridImportW: field(q => Math.max(0, q.net_w)), gridExportW: field(q => Math.max(0, -q.net_w)),
    batteryChargeW: field(q => q.charge_w), batteryDischargeW: field(q => q.discharge_w),
    homeStartSoc: c.start_state.battery_soc * 100, homeSoc: field(q => q.battery_kwh! / h.battery.capacity_kwh * 100),
    carSoc: field(q => q.ev_kwh! / h.car.battery.capacity_kwh * 100), carKm: field(q => q.ev_kwh! / h.car.battery.kwh_per_km),
    carConnected: field(() => 1), poolC: field(q => q.pool_c!), costSek: field(q => q.cost), wearSek: field(q => q.wear),
  };
  const last = quarters.at(-1)!;
  const credit = endCredit(terms, p.initial, { battery_kwh: last.battery_kwh, ev_kwh: last.ev_kwh, pool_c: last.pool_c });
  return { commands, quarters, series, ledger: electricityLedger(quarters, p), credit, wearSek: quarters.reduce((sum, q) => sum + q.wear, 0),
    poolMinimumC: Math.min(c.start_state.pool_water_c, ...field(q => q.pool_c!)),
    poolBelowStartHours: quarters.reduce((sum, q, i) => sum + (q.pool_c! < settings.poolStartC ? p.slots[i].hours : 0), 0),
    evEndSoc: last.ev_kwh! / h.car.battery.capacity_kwh * 100, batteryEndSoc: last.battery_kwh! / h.battery.capacity_kwh * 100 };
}

export async function compareScheduler(c: BenchCase, h: Household, settings: DefaultSettings, criteria: CriteriaOverrides, engine: ComparisonEngine): Promise<SchedulerComparison> {
  const forecast = forecastProblem(c, h, settings, criteria), recorded = recordedProblem(c, forecast, settings);
  const solved = engine.solve(forecast).outcome;
  if (solved.kind === 'failed') throw new Error(`SHS modelling: ${solved.issue}`);
  // The native API validates these with Zod; the frontend's non-strict TS configuration infers optional properties.
  const shsCommands = solved.selection.commands as NativeCommand[];
  const projected = engine.project(recorded, shsCommands).outcome;
  if (projected.kind === 'failed') throw new Error(`SHS measured execution: ${projected.issue}`);
  const defaults = projectDefaults(c, h, forecast, settings, engine);
  // One explicitly declared accounting cap/price for both participants, independent of forecast errors.
  const terms = problemEndCredit({ ...recorded, targets: { ...recorded.targets, pool_c: settings.poolStopC,
    ev_limit_kwh: .8 * h.car.battery.capacity_kwh, ev_km: .8 * h.car.battery.capacity_kwh / h.car.battery.kwh_per_km } });
  const baseline = side(c, h, defaults.problem, defaults.commands, defaults.quarters, settings, terms, forecast);
  const shs = side(c, h, recorded, shsCommands, projected.quarters, settings, terms, forecast);
  const cashSavingSek = baseline.ledger.costSek - shs.ledger.costSek;
  return { version: COMPARISON_VERSION, inputHash: await sha256(canonicalJson({ forecast, recorded, settings, terms })), settings: { ...settings }, baseline, shs,
    cashSavingSek, adjustedSavingSek: cashSavingSek + shs.credit.credit_sek - baseline.credit.credit_sek,
    forecastCostSek: solved.selection.account.cash_sek, forecastImportPrices: forecast.slots.map(s => s.import_price),
    forecastSolarW: forecast.slots.map(s => s.solar_w), poolTargetC: c.comfort!.pool_c!, evTargetKm: c.comfort!.ev_km!, evChargeLimitSoc: c.start_state.ev.target_soc };
}

/** Subscription over this case only, allocating covered hours in each local month (including DST). */
export function subscriptionForCase(start: string, timeZone: string, hours: number, monthlySek: number): number {
  if (!Number.isFinite(monthlySek) || monthlySek < 0) throw new Error('Invalid subscription');
  const months = new Map<string, number>();
  for (let offset = 0; offset < hours; offset += .25) {
    const month = localDay(new Date(Date.parse(start) + offset * 3_600_000).toISOString(), timeZone).slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + Math.min(.25, hours - offset));
  }
  let amount = 0;
  for (const [month, covered] of months) {
    const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    let monthHours = 0;
    for (let day = 1; day <= days; day++) monthHours += hoursInDay(`${month}-${String(day).padStart(2, '0')}`, timeZone);
    amount += monthlySek * covered / monthHours;
  }
  return amount;
}
