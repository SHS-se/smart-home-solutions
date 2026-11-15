// Independently generated synthetic equipment; no captured household inputs.
import { assertEquals } from "@std/assert";
import { poolElectricalCeilingW, poolElectricalDemand, poolElectricalReservation, resolvePoolOperatingDraw } from "./models/pool/electrical.ts";

const point = (settings: Record<string, number>, heater: number, pump: number, last: string, steady = 40) => ({
  settings, running_hours: steady + 4, steady_hours: steady, electric_w: { heater, pump },
  heat_sessions: 0, electric_kwh: 0, heat_kwh: null, cop: null, first_observed_at: "2026-10-01T00:00:00.000Z", last_observed_at: last });
const learned = (...points: unknown[]) => ({ method: "operating_points_v1", points });
const BOTH = learned(
  point({ heater: 12, pump: 100 }, 3000, 760, "2026-11-02T00:00:00.000Z"),
  point({ heater: 12, pump: 80 }, 3050, 410, "2026-11-10T00:00:00.000Z"),
  point({ heater: 8, pump: 100 }, 1650, 760, "2026-09-23T00:00:00.000Z"));
const members = (heater: unknown, pump: unknown) => [
  { key: "heater", ...(heater === undefined ? {} : { power_setting: heater }) },
  { key: "pump", ...(pump === undefined ? {} : { power_setting: pump }) },
] as { key: string; power_setting?: { value: number | null } | null }[];
const resolve = (heater: unknown, pump: unknown, from: unknown = BOTH) => resolvePoolOperatingDraw(from, members(heater, pump), ["heater"]);

Deno.test("the point for the settings the home reports is the expected draw", () => {
  assertEquals(resolve({ value: 12 }, { value: 80 }), { member_w: { heater: 3050, pump: 410 }, settings: { heater: 12, pump: 80 },
    steady_hours: 40, last_observed_at: "2026-11-10T00:00:00.000Z", basis: "reported_settings" });
  assertEquals(resolve({ value: 12 }, { value: 100 })!.member_w, { heater: 3000, pump: 760 });
  assertEquals(resolve({ value: 8 }, { value: 100 })!.member_w.heater, 1650);
});

Deno.test("settings never observed running, or evidence keyed by other devices, give no point", () => {
  // 10 kW has not run; a point for another setting is not its draw.
  assertEquals(resolve({ value: 10 }, { value: 100 }), null);
  // Quarters learned before settings were recorded mix every setting the equipment ran at.
  const unkeyed = learned(point({}, 2460, 704, "2026-11-15T00:00:00.000Z", 430));
  assertEquals(resolve({ value: 12 }, { value: 100 }, unkeyed), null);
  // A pump with no setting of its own cannot use points keyed by one, and the reverse.
  assertEquals(resolve({ value: 12 }, null), null);
  const heaterOnly = learned(point({ heater: 12 }, 3000, 760, "2026-11-10T00:00:00.000Z"));
  assertEquals(resolve({ value: 12 }, null, heaterOnly)!.member_w, { heater: 3000, pump: 760 });
  assertEquals(resolve({ value: 12 }, { value: 100 }, heaterOnly), null);
  // Fixed equipment with no settings at all is one unkeyed point.
  assertEquals(resolve(null, null, unkeyed)!.member_w, { heater: 2460, pump: 704 });
});

Deno.test("a home that does not report settings keeps planning on its bound", () => {
  assertEquals(resolve(undefined, undefined), null);
  assertEquals(resolve({ value: 12 }, undefined), null);
  assertEquals(resolve(undefined, undefined, learned(point({}, 2460, 704, "2026-11-15T00:00:00.000Z"))), null);
});

Deno.test("a setting that cannot be read takes the point most recently observed for the rest", () => {
  const draw = resolve({ value: 12 }, { value: null })!;
  assertEquals([draw.member_w, draw.basis], [{ heater: 3050, pump: 410 }, "last_observed"]);
  assertEquals(resolve({ value: null }, { value: 100 })!.settings, { heater: 12, pump: 100 });
});

Deno.test("malformed or evidence-free learner output is no point, never a failure", () => {
  assertEquals(resolvePoolOperatingDraw(undefined, members({ value: 12 }, { value: 100 }), ["heater"]), null);
  for (const bad of [null, "points", [], {}, { method: "other", points: [] }, { method: "operating_points_v1", points: "x" },
    learned(null, 3, { settings: { heater: 12, pump: 100 } }, point({ heater: 12, pump: 100 }, 3000, 760, "not a time")),
    learned(point({ heater: 12, pump: 100 }, 3000, 760, "2026-11-02T00:00:00.000Z", 0)),
    learned(point({ heater: 12, pump: 100 }, 0, 760, "2026-11-02T00:00:00.000Z")),
    learned({ ...point({ heater: 12, pump: 100 }, 3000, 760, "2026-11-02T00:00:00.000Z"), settings: { heater: "12", pump: 100 } })]) {
    assertEquals(resolve({ value: 12 }, { value: 100 }, bad), null);
  }
  // A pump whose draw was not measured keeps its own bound; the heater's is used.
  const noPump = learned({ ...point({ heater: 12, pump: 100 }, 3000, 760, "2026-11-02T00:00:00.000Z"), electric_w: { heater: 3000 } });
  assertEquals(resolve({ value: 12 }, { value: 100 }, noPump)!.member_w, { heater: 3000 });
});

const model = (key: string, role: "heater" | "circulation", watts: number | null) => ({ key, name: key, statistic_id: "sensor." + key,
  category: "pool_heating", planning_service: "pool" as const, pool_role: role, planning_role: "controllable" as const,
  suggested_load_type: "fixed_full_load" as const, load_type: "fixed_full_load" as const, control_type: "switch_schedule" as const,
  active_power_w: watts, profile_sample_count: 100, forecast_w_by_slot: [0] });
const snapshot = (draw: Record<string, number> | null, heater: number | null = 3450, pump: number | null = 780) => ({
  device_models: [model("heater", "heater", heater), model("pump", "circulation", pump)],
  pool_model: draw ? { operating_draw: { member_w: draw, settings: {}, steady_hours: 40,
    last_observed_at: "2026-11-10T00:00:00.000Z", basis: "reported_settings" as const } } : null });

Deno.test("expected draw is the measured point; the reservation stays the home's bound", () => {
  const measured = snapshot({ heater: 3050, pump: 410 });
  assertEquals(poolElectricalDemand(measured), { compressor_w: 3050, auxiliary_w: 410, member_w: { heater: 3050, pump: 410 } });
  assertEquals(poolElectricalReservation(measured), { compressor_w: 3450, auxiliary_w: 780 });
  // Unmetered time is bounded by what ON may draw, not by what it usually draws.
  assertEquals(poolElectricalCeilingW(measured), 3450);
  // Without a point the bound stands in for the expected draw, as before.
  const unmeasured = snapshot(null);
  assertEquals(poolElectricalDemand(unmeasured), { compressor_w: 3450, auxiliary_w: 780, member_w: { heater: 3450, pump: 780 } });
  assertEquals(poolElectricalReservation(unmeasured), { compressor_w: 3450, auxiliary_w: 780 });
});

Deno.test("a measured draw above a stale bound raises the reservation with it", () => {
  const stale = snapshot({ heater: 3050, pump: 410 }, 2800, null);
  assertEquals(poolElectricalDemand(stale).compressor_w, 3050);
  assertEquals(poolElectricalReservation(stale), { compressor_w: 3050, auxiliary_w: 410 });
  // Only the heater was measured: the pump is expected at its own bound.
  const partial = snapshot({ heater: 3050 });
  assertEquals(poolElectricalDemand(partial), { compressor_w: 3050, auxiliary_w: 780, member_w: { heater: 3050, pump: 780 } });
});
