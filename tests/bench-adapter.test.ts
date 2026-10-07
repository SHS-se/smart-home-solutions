import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { loadTypeScriptPlanner, snapshotFor } from "../bench/adapter.ts";
import { loadCase, QUARTERS, type BenchRecorded, type BenchScenarioData } from "../src/lib/planner-bench/case.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { poolLevels } from "../src/lib/planner-bench/referee.ts";

const root = new URL("..", import.meta.url).pathname;
const START = Date.parse("2026-09-24T07:15:00Z");
const quarters = <T>(make: (i: number) => T): T[] => Array.from({ length: QUARTERS }, (_, i) => make(i));
const hourOf = (i: number) => new Date(START + i * 900_000).getUTCHours();

/** Sunny days, dear evenings, a day and a half of published prices, a cool pool and a car wanting range. */
const dataset = (): BenchScenarioData => ({
  format: "shs-bench-case", version: 1, origin: { kind: "manual", detail: "test", created_at: "2026-09-24T07:15:00Z" },
  start: new Date(START).toISOString(), timezone: "Europe/Stockholm", location: { latitude: 59.4, longitude: 18 },
  known_prices: {
    import_sek_per_kwh: quarters(i => i < 132 ? (hourOf(i) >= 16 && hourOf(i) < 20 ? 3 : 1) : null),
    export_sek_per_kwh: quarters(i => i < 132 ? 0.4 : null),
  },
  solar_forecast_w: quarters(i => hourOf(i) >= 8 && hourOf(i) < 14 ? 5000 : 0),
  base_load_forecast_w: quarters(() => 600),
  other_devices_w: {},
  start_state: { battery_soc: 0.3, pool_water_c: 27.5, ev: { soc: 0.3, target_soc: 0.8 } },
  comfort: { pool_c: 30, ev_km: 300 },
});
const recorded = (): BenchRecorded => ({
  prices: { import_sek_per_kwh: quarters(i => hourOf(i) >= 16 && hourOf(i) < 20 ? 3 : 1), export_sek_per_kwh: quarters(() => 0.4) },
  outdoor_temperature_c: quarters(() => 12),
  solar_irradiance_w_per_m2: quarters(() => null),
  history: {
    prices: { start: new Date(START - 96 * 900_000).toISOString(), import_sek_per_kwh: new Array(96).fill(1.2), export_sek_per_kwh: new Array(96).fill(0.4) },
    grid_import_kwh: { start: "2026-08-31T22:00:00.000Z", kwh: [] },
  },
  recorded_at: "2026-09-28T00:00:00Z",
});

Deno.test("the production TypeScript planner derives its curves from the targets, and the scale turns them up", async () => {
  const planner = await loadTypeScriptPlanner(root);
  assertEquals(planner.generation, "snapshot+comfort");
  const c = loadCase(dataset(), recorded());
  const { record } = planner.plan(c, HOUSEHOLD);
  assertEquals(record.status, "ready");
  assertEquals(record.valuation, { scale: 1, pool: "scale", ev: "scale", battery: "scale" });
  // Battery from the forecast; pool and car from target service willingness.
  const curve = (store: string, from = record) => from.curves.find(candidate => candidate.store === store)!;
  assertEquals(record.curves.map(candidate => candidate.store).sort(), ["battery", "ev", "pool"]);
  assertEquals([curve("battery").mode, curve("pool").mode, curve("ev").mode], ["balanced", "comfort target", "comfort target"]);
  assertEquals(curve("pool").derivation!.target, 30);
  // The planner believes what the referee carries out: a kWh drawn by the pool, pump included, warms it
  // by the heat pump's heat at its setting over the pool's heat capacity.
  const poolOn = poolLevels(HOUSEHOLD).at(-1)!;
  assertAlmostEquals(curve("pool").units_per_kwh!, poolOn.heat_w / poolOn.draw_w / HOUSEHOLD.pool.store.capacity_kwh_per_c, 1e-9);
  // And it estimates the unpublished prices itself.
  assert(record.beliefs.import_sek_per_kwh.every(price => typeof price === "number" && price > 0));

  const { outcome, stats, series } = evaluate(c, record, {});
  assert(stats.pool_kwh > 1 && stats.battery_charge_kwh > 1, JSON.stringify(stats));
  // The plan heads for the pool's target: it ends within a degree of 30 °C.
  assert(Math.abs(series.poolC[287]! - 30) < 1, `pool ends at ${series.poolC[287]}`);
  assert(stats.ev_kwh > 1 && series.carKm![287]! >= 300,
    `car failed to reach its affordable target: ${series.carKm![287]}`);
  // Warmth counts through the whole horizon: once the pool has reached its
  // target it does not drift more than about a degree below it to wait for cheaper energy.
  const reached = series.poolC.findIndex(temperature => temperature! >= 29.5);
  assert(reached >= 0 && Math.min(...series.poolC.slice(reached) as number[]) > 28.8,
    `pool fell to ${Math.min(...series.poolC.slice(Math.max(0, reached)) as number[])} after reaching 29.5 at quarter ${reached}`);
  // The referee's physics and the planner's agree on what the household can do.
  assert(outcome.violations.length <= 2, JSON.stringify(outcome.violations.slice(0, 5)));

  // A higher valuation multiplies every curve and buys at least as much comfort.
  const high = planner.plan(c, HOUSEHOLD, Math.SQRT2).record;
  for (const store of ["pool", "ev", "battery"]) {
    const ratio = curve(store, high).points[0].sek_per_unit / curve(store).points[0].sek_per_unit;
    assert(Math.abs(ratio - Math.SQRT2) < 0.01, `${store} scaled by ${ratio}`);
  }
});

Deno.test("the planner is told the pool cools whatever the weather, and keeps it warm through a heat wave", async () => {
  const planner = await loadTypeScriptPlanner(root);
  // A pool at its target in 28 °C air: by the outdoor air alone it would hardly cool at all.
  const hot = loadCase({ ...dataset(), start_state: { ...dataset().start_state, pool_water_c: 30 } },
    { ...recorded(), outdoor_temperature_c: quarters(() => 28) });
  const { record } = planner.plan(hot, HOUSEHOLD);
  const { stats, series } = evaluate(hot, record, {});
  // Left alone it would lose 2 °C in three days; the plan buys the heat to stay within a degree of 30 °C.
  assert(stats.pool_kwh > 15, `the pool was given ${stats.pool_kwh} kWh`);
  assert(Math.min(...series.poolC as number[]) > 29, `pool fell to ${Math.min(...series.poolC as number[])}`);
});

Deno.test("the planner plans every device from its device model, whatever the older fields say", async () => {
  const M = await import(`${root}supabase/functions/_shared/planner/energy-optimisation.ts`);
  assert(M.PLANNER_INPUTS.includes("device_physics"));
  const c = loadCase(dataset(), recorded());
  const decided = (snapshot: unknown) => {
    const plan = M.generateOptimisationPlan(snapshot, new Date(c.start), []);
    assertEquals(plan.status, "ready");
    return plan.plans.priority.slots.map((slot: Record<string, number>) => [slot.pool_w, slot.ev_w, slot.battery_charge_w, slot.battery_discharge_w]);
  };
  const snapshot = snapshotFor(c, HOUSEHOLD, 1, true, false, false, true) as unknown as {
    [field: string]: unknown;
    pool: Record<string, unknown>; battery: Record<string, unknown>; ev_battery: Record<string, unknown>;
    device_models: { pool_role?: string }[]; services: { device: string; control: Record<string, unknown> }[];
  };
  const plan = decided(snapshot);
  // The heat pump is on at its 12 kW setting, pump included, or off; the car charges at whole amps.
  assertEquals([...new Set(plan.map((slot: number[]) => slot[0]))].sort(), [0, 3764]);
  assert(plan.every((slot: number[]) => slot[1] === 0 || (slot[1] >= 3450 && slot[1] % 690 === 0)), "the car is planned between two amp steps");

  // The same case with every older field saying something else about the devices: a small pool that
  // leaks into the weather behind a weak heater, a small battery, a thirsty car on a slow charger.
  const misleading = {
    ...snapshot,
    pool: { ...snapshot.pool, volume_m3: 20 },
    pool_model: { loss_kw_per_k: 0.5, rated_cop: 2, cop_per_air_c: 0.05, cutout_air_c: null, response: null },
    battery: { ...snapshot.battery, capacity_kwh: 6, charge_max_w: 2_000 },
    ev_battery: { ...snapshot.ev_battery, capacity_kwh: 40, kwh_per_km: 0.3 },
    device_models: snapshot.device_models.map(device =>
      device.pool_role ? { ...device, active_power_w: device.pool_role === "heater" ? 1_000 : 500 } : device),
    services: snapshot.services.map(service =>
      service.device === "ev" ? { ...service, control: { ...service.control, max_current_a: 8 } }
        : { ...service, control: { type: "fixed_power", power_w: 1_500 } }),
  };
  assertEquals(decided(misleading), plan);
  // Without its models the planner believes those fields, and plans another household.
  const other = decided({ ...misleading, device_physics: null });
  assert(JSON.stringify(other) !== JSON.stringify(plan));
  assert(other.some((slot: number[]) => slot[0] === 1500) && other.every((slot: number[]) => slot[0] === 0 || slot[0] === 1500), "the pool is not planned at the power the older fields give");
});

Deno.test("a plan's battery discharge is read once: what it sells is part of it, not on top of it", async () => {
  const planner = await loadTypeScriptPlanner(root);
  // Evenings at 3 kr to sell: the battery is planned to export, the house drawing 600 W of what it gives.
  const evening = (i: number) => hourOf(i) >= 16 && hourOf(i) < 20;
  const told = { ...dataset(), comfort: { pool_c: 20, ev_km: 100 }, start_state: { ...dataset().start_state, battery_soc: 0.95 }, known_prices: { import_sek_per_kwh: quarters(i => i < 132 ? (evening(i) ? 4 : 1) : null), export_sek_per_kwh: quarters(i => i < 132 ? (evening(i) ? 3 : 0.4) : null) } };
  const c = loadCase(told, { ...recorded(), prices: { import_sek_per_kwh: quarters(i => evening(i) ? 4 : 1), export_sek_per_kwh: quarters(i => evening(i) ? 3 : 0.4) } });
  const { record } = planner.plan(c, HOUSEHOLD);
  const { outcome, series } = evaluate(c, record, {});
  const sold = series.gridExportW.filter((w, i) => evening(i) && w > 1_000).length;
  assert(sold > 0, "the battery was not planned to export, so this case tests nothing");
  assert(Math.max(...record.decisions.battery_discharge_w) <= HOUSEHOLD.battery.discharge_max_w + 1, `discharge of ${Math.max(...record.decisions.battery_discharge_w)} W asked of a ${HOUSEHOLD.battery.discharge_max_w} W battery`);
  assertEquals(outcome.violations.filter(v => v.kind.startsWith("battery")), []);
});
