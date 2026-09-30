import { assert, assertEquals } from "@std/assert";
import { horizon } from "../supabase/functions/_shared/planner/energy-optimisation.fixture.ts";
import { validateOperatingScope } from "../supabase/functions/_shared/planner/operating-scope.ts";
import type { OptimisationSnapshot } from "../supabase/functions/_shared/planner/energy-optimisation.ts";
import { applyHousehold, type BenchWeather } from "../bench/household.ts";
import { loadPlanner } from "../bench/planner-adapter.ts";
import type { BenchInput } from "../src/lib/planner-bench/types.ts";

const root = new URL("..", import.meta.url).pathname;

/** A capture with neither car nor pool, as the oldest replays are. */
function bare(overrides: Partial<OptimisationSnapshot> = {}): BenchInput {
  const snapshot = horizon({ capabilities: { pv: true, battery: true, ev: false, pool: false, boiler: false }, ...overrides });
  return { snapshot: snapshot as unknown as BenchInput["snapshot"], now: snapshot.captured_at, price_archive: [] };
}

const snap = (input: BenchInput) => input.snapshot as unknown as OptimisationSnapshot;

Deno.test("a replay without car or pool is planned with both, and the battery", async () => {
  const input = applyHousehold(bare(), null);
  validateOperatingScope(snap(input));
  const planner = await loadPlanner(root);
  const { stats } = planner.run(input, [input]);
  assert(stats.ev_kwh > 1, `EV charged ${stats.ev_kwh} kWh`);
  assert(stats.pool_kwh > 1, `pool heated ${stats.pool_kwh} kWh`);
  assert(stats.battery_charge_kwh > 1, `battery charged ${stats.battery_charge_kwh} kWh`);
});

Deno.test("the household controls its devices and leaves the replay's others as demand", () => {
  const hotWater = {
    ...horizon().device_models[0],
    key: "sensor.hot_water_energy", category: "hot_water", forecast_w_by_slot: new Array(288).fill(100),
  };
  const s = snap(applyHousehold(bare({ device_models: [hotWater] as OptimisationSnapshot["device_models"] }), null));
  assertEquals(s.schema_version, 9);
  assertEquals(s.operating_scope!.modes, { $battery: "controlling", $ev: "controlling", $pool: "controlling", "sensor.hot_water_energy": "monitoring" });
  assertEquals(Object.keys(s.operating_scope!.external_demands), ["sensor.hot_water_energy"]);
  assertEquals(s.services.filter(service => service.device === "ev" || service.device === "pool").length, 2);
});

Deno.test("the replay's car is kept only while it is plugged in and wants charge", () => {
  const car = (soc: number, connected: boolean) => ({
    name: "Car", connected, capacity_kwh: 70, soc, departure_target_soc: 0.9, charge_efficiency: 0.9,
    available_from: "2026-08-10T08:00:00.000Z", departure: null, priority: 3,
    source_entity_ids: { connected: "a", soc: "b", target_soc: "c", energy_remaining: null, charge_current: null },
  });
  const wanting = snap(applyHousehold(bare({ ev_battery: car(0.5, true) }), null)).ev_battery!;
  assertEquals([wanting.soc, wanting.departure_target_soc, wanting.departure], [0.5, 0.9, null]);
  for (const other of [car(0.9, true), car(0.5, false)]) {
    const fallback = snap(applyHousehold(bare({ ev_battery: other }), null)).ev_battery!;
    assertEquals([fallback.soc, fallback.departure_target_soc, fallback.connected], [0.4, 0.8, true]);
    // 07:00 in Stockholm the morning after the 10:00 start.
    assertEquals(fallback.departure, "2026-08-11T05:00:00.000Z");
  }
});

Deno.test("archived weather fills in only for a replay that has none", () => {
  const weather: BenchWeather = {
    source: "test", fetched_at: "2026-08-10T08:00:00Z",
    outdoor_temperature_c: new Array(288).fill(5), solar_irradiance_w_per_m2: new Array(288).fill(100),
  };
  assertEquals(snap(applyHousehold(bare(), weather)).outdoor_temperature_c![0], 22);
  const withoutOwn = bare();
  delete (withoutOwn.snapshot as Record<string, unknown>).outdoor_temperature_c;
  assertEquals(snap(applyHousehold(withoutOwn, weather)).outdoor_temperature_c![0], 5);
});
