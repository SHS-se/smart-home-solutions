// Independently generated synthetic clock and equipment observations.
import { assert, assertEquals } from "@std/assert";
import { carReadinessPolicy } from "./planner-wasm/car-policy.ts";
import { prepareRulesPlanningInput, generateRulesPlan } from "./rules-planner.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { syntheticHome } from "../../../tests/planner-contracts/synthetic.ts";

const origin = Date.parse("2026-01-01T00:00:00Z");
const battery = {capacity_kwh: 60, charge_efficiency: .9, kwh_per_km: .2};
const slots = Array.from({length: 288}, (_, i) => ({start_seconds: i * 900, hours: .25, ev_available: true}));
const clock = (running: boolean, elapsed_seconds: number) => ({running, elapsed_seconds, observed_at: new Date(origin).toISOString()});
const policy = (running: boolean, elapsed_seconds: number, connected = false) => carReadinessPolicy({
  battery, limitSoc: .8, connection: connected ? {kind: "plugged", sinceMs: origin - 100 * 3600000} : {kind: "unplugged"},
  readinessClock: clock(running, elapsed_seconds),
}, slots, origin);

Deno.test("location clock advances at home, freezes away, and ignores cable state", () => {
  const home = policy(true, 0).breach_permille;
  assertEquals([home[0], home[39], home[239]], [201, 299, 799]);
  const away = policy(false, 12 * 3600).breach_permille;
  assert(away.every(value => value === 319));
  assertEquals(policy(false, 12 * 3600, true), policy(false, 12 * 3600, false));
  assertEquals(policy(true, 0, true), policy(true, 0, false));
  assertEquals(policy(true, 0).breach_permille[0], 201, "a new home arrival restarts the ramp");
});

Deno.test("location clock observation time survives later capture and delayed planning", () => {
  const home = carReadinessPolicy({battery, limitSoc: .8, connection: {kind: "unplugged"},
    readinessClock: clock(true, 12 * 3600)}, slots, origin + 6 * 3600000);
  assertEquals(home.breach_permille[0], 381);
  const away = carReadinessPolicy({battery, limitSoc: .8, connection: {kind: "unplugged"},
    readinessClock: clock(false, 12 * 3600)}, slots, origin + 100 * 3600000);
  assert(away.breach_permille.every(value => value === 319));
});

function prepare(connected: boolean, running: boolean, missing = false) {
  const snapshot = syntheticHome();
  const ev = snapshot.ev_battery!;
  ev.connected = connected;
  ev.source_entity_ids.location = "device_tracker.synthetic_vehicle";
  if (!missing) ev.readiness_clock = {running, elapsed_seconds: 60 * 3600, observed_at: snapshot.captured_at};
  return prepareRulesPlanningInput({snapshot, now: snapshot.captured_at, price_archive: [], resolved_price_outlook: {
    shaped: false, observed_days: 1, effective_days: 1, level_sek_per_kwh: .2,
    shadow_import_sek_per_kwh: snapshot.slots.map(() => .2),
  }}, null, resolveRulePolicy());
}

Deno.test("an away unplugged EV keeps future charging and truthful cable telemetry", () => {
  const plugged = prepare(true, false), unplugged = prepare(false, false);
  assertEquals(unplugged.problem, plugged.problem);
  assert(unplugged.problem.slots.every(s => s.ev_available));
  const a = generateRulesPlan(plugged).plan, b = generateRulesPlan(unplugged).plan;
  assertEquals(b.validation_errors, []);
  assertEquals(b.ev_battery!.connected, false);
  assertEquals(b.plans.priority.slots.map(s => s.ev_target_current_a), a.plans.priority.slots.map(s => s.ev_target_current_a));
  assert(b.plans.priority.slots.some(s => s.ev_w > 0 && s.ev_charging_conditional));
});

Deno.test("a configured location with no clock keeps the EV and estimates mature readiness", () => {
  const prepared = prepare(false, false, true);
  assert(prepared.snapshot.planning_warnings!.some(w => w.code === "ev_readiness_estimated"));
  assert(prepared.problem.car_policy!.breach_permille.every(value => value === 799));
  const result = generateRulesPlan(prepared).plan;
  assertEquals(result.capabilities.ev, true);
  assertEquals(result.validation_errors, []);
});
