import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { prepareRulesPlanningInput, generateRulesPlan, type PublishedCommandReference } from "../../supabase/functions/_shared/rules-planner.ts";
import { resolveRulePolicy } from "../../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import { nativePlanner } from "../../supabase/functions/_shared/planner-wasm/runtime.ts";
import { fitRoom } from "../../supabase/functions/_shared/device-learning/room/fit.ts";
import type { OptimisationSnapshot, OptimisationPlan } from "../../supabase/functions/_shared/planner/planning-contracts.ts";
import { roomHome, roomObservations, syntheticHome, withPool, withHotWater } from "./synthetic.ts";

function prepare(snapshot: OptimisationSnapshot, reference: PublishedCommandReference | null = null, policy = resolveRulePolicy()) {
  return prepareRulesPlanningInput({ snapshot, now: snapshot.captured_at, price_archive: [], resolved_price_outlook: {
    shaped: true, observed_days: 1, effective_days: 1, level_sek_per_kwh: .2,
    shadow_import_sek_per_kwh: snapshot.slots.map(s => s.import_price_sek_per_kwh!),
  } }, reference, policy);
}
const plan = (s: OptimisationSnapshot) => generateRulesPlan(prepare(s)).plan;

Deno.test("CONTRACT EV-1: cable telemetry cannot remove or postpone future charging", () => {
  const connected = syntheticHome(), unplugged = structuredClone(connected);
  unplugged.ev_battery!.connected = false;
  assertEquals(prepare(unplugged).problem, prepare(connected).problem);
  const a = plan(connected), b = plan(unplugged);
  assertEquals(b.plans.priority.slots.map(s => s.ev_target_current_a), a.plans.priority.slots.map(s => s.ev_target_current_a));
  assertEquals(b.ev_battery!.connected, false);
  const check = (p: OptimisationPlan) => assert(p.plans.priority.slots[0].ev_target_current_a > 0, "ongoing low-range charging must start now");
  check(a); check(b);
  const mutant = structuredClone(b); mutant.plans.priority.slots.forEach(s => s.ev_target_current_a = 0);
  assertThrows(() => check(mutant));
  // A later capture does not renew a free shortfall period.
  for (const hours of [1, 8, 24]) {
    const s = structuredClone(unplugged);
    s.slots = s.slots.map(slot => ({ ...slot, start: new Date(Date.parse(slot.start) + hours * 3600000).toISOString() }));
    s.captured_at = s.slots[0].start;
    s.ev_battery!.available_from = s.slots[0].start;
    const p = plan(s); check(p);
    assert((p.plans.priority.slots[0].rule_points?.ev_short ?? 0) < 0, "shortfall is counted in the opening quarter");
  }
});

for (const amps of [12, 15]) Deno.test(`CONTRACT EV-2: ${amps} A fits beside full pool power and is selected`, () => {
  const s = withPool(); s.grid.import_limit_w = 500 + 3600 + 3 * 230 * amps;
  const check = (p: OptimisationPlan) => {
    const q = p.plans.priority.slots[0];
    assertEquals(q.pool_w, 3600);
    assertEquals(q.ev_target_current_a, amps);
    assertAlmostEquals(q.ev_w, 3 * 230 * amps, 1e-8);
    assert(q.grid_import_w <= s.grid.import_limit_w + 1e-8);
  };
  const p = plan(s); check(p);
  for (const wrong of [5, 16]) {
    const mutant = structuredClone(p); mutant.plans.priority.slots[0].ev_target_current_a = wrong;
    assertThrows(() => check(mutant));
  }
});

Deno.test("CONTRACT POOL-1: equal electricity cannot gain heat from a pause in a constant-COP pool", () => {
  const s = withPool(syntheticHome(16)); s.capabilities.ev = false; s.ev_battery = null; s.services = [];
  const input = prepare(s), core = nativePlanner();
  const project = (on: boolean[]) => {
    const result = core.project(input.problem, on.map(pool_on => ({ pool_on, ev_amps: 0, battery: "idle" as const, charge_limit_w: 0, discharge_limit_w: 0 }))).outcome;
    assert(result.kind === "projected"); return result.quarters;
  };
  const continuous = project(s.slots.map((_, i) => i < 8));
  const interrupted = project(s.slots.map((_, i) => i % 2 === 0));
  const check = (rows: typeof continuous) => {
    // Eight quarters × 3.6 kW, COP 4, 40 m³ × 1.163 kWh/(m³ K).
    const kwh = rows.reduce((sum, q) => sum + q.pool_w * .25 / 1000, 0);
    assertAlmostEquals(kwh, 7.2, 1e-9);
    assertAlmostEquals(rows.at(-1)!.pool_c!, 26 + 7.2 * 4 / (40 * 1.163), 1e-9);
  };
  check(continuous); check(interrupted);
  const phantom = structuredClone(interrupted); phantom.at(-1)!.pool_c! += .1;
  assertThrows(() => check(phantom));
  // The selected full plan must not manufacture brief interruptions here.
  const selected = plan(s).plans.priority.slots;
  assert(selected.every(q => q.pool_w === 3600), "flat prices and an unmet target have no reason to pause this synthetic heater");
});

Deno.test("CONTRACT ROOM-1: independently learned relay heat reaches comfort and matches the published graph", () => {
  const fit = fitRoom(roomObservations(), 1000); assert(fit.ok);
  assertAlmostEquals(fit.model.gain_c_per_wh, .001, .00002, "recover the known actuator effect, not just background temperature");
  const p = plan(roomHome(fit.model));
  const check = (result: OptimisationPlan) => {
    const zone = result.thermal_projection!.zones[0];
    assertEquals(zone.control_type, "switch_schedule");
    assertEquals(zone.load_type, "fixed_full_load");
    let temperature = 18, energyWh = 0;
    const slots = result.plans.priority.slots;
    for (let i = 0; i < slots.length; i++) {
      const q = slots[i], c = q.device_commands.synthetic_relay;
      assert(c.type === "switch_schedule");
      const watts = c.on_seconds ? 1000 : 0, hours = q.duration_hours!;
      assertEquals(q.device_loads_w.synthetic_relay, watts);
      assertEquals(zone.planned_power_w[i], watts);
      // Independent analytic solution to the specified plant, not the fitted coefficients.
      const equilibrium = 10 + .001 * watts / .03;
      temperature = equilibrium + (temperature - equilibrium) * Math.exp(-.03 * hours);
      assertAlmostEquals(zone.planned_temperature_c[i], temperature, .03);
      energyWh += watts * hours;
    }
    assert(zone.planned_temperature_c.at(-1)! >= 20);
    assert(energyWh <= (20.5 - 18 + .03 * (20.5 - 10) * 12) / .001, "known effective heater must stop after recovering; continuous heating wastes energy here");
    assert(slots.slice(12).some(q => q.device_loads_w.synthetic_relay === 0));
  };
  check(p);
  const flat = structuredClone(p); flat.thermal_projection!.zones[0].planned_temperature_c.fill(18);
  assertThrows(() => check(flat));
  const halfPower = structuredClone(p); halfPower.thermal_projection!.zones[0].planned_power_w[0] /= 2;
  assertThrows(() => check(halfPower));
  const wrongControl = structuredClone(p); wrongControl.thermal_projection!.zones[0].control_type = "setpoint";
  assertThrows(() => check(wrongControl));
});

Deno.test("CONTRACT BASIS-1: generation does not mutate the captured basis", () => {
  const s = syntheticHome(); s.ev_battery!.connected = false;
  const fit = fitRoom(roomObservations(), 1000); assert(fit.ok);
  const freeze = (v: unknown): void => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } };
  for (const snapshot of [s, withPool(), roomHome(fit.model), withHotWater()]) {
    const basis = prepare(snapshot), before = JSON.stringify(basis);
    freeze(basis);
    const first = generateRulesPlan(basis), second = generateRulesPlan(basis);
    assertEquals(first, second); assertEquals(JSON.stringify(basis), before);
  }
});

Deno.test("CONTRACT BASIS-2: capture detaches models, policy and accepted commands from caller mutations", () => {
  const s = withPool(), policy = resolveRulePolicy();
  const reference = { plan_id: "synthetic_accepted", slots: plan(s).plans.priority.slots };
  const basis = prepare(s, reference, policy), before = structuredClone(basis), expected = generateRulesPlan(basis);
  s.pool_model!.rated_cop = 1;
  s.device_models[0].active_power_w = 1;
  s.slots[0].import_price_sek_per_kwh = 100;
  policy.rules[0].points = -2;
  policy.service_guard.pool[0] = 500;
  reference.slots[0].ev_target_current_a = 0;
  reference.slots[0].device_commands.synthetic_pool = { type: "switch_schedule", on_seconds: 0 };
  reference.slots.splice(1);
  assertEquals(basis, before);
  assertEquals(generateRulesPlan(basis), expected);
});

Deno.test("CONTRACT EV-4: the charge cap limits charging without invalidating a higher measured SOC", () => {
  const s = syntheticHome(48);
  // Exactly one quarter at 12 A below the cap: achievable with the native
  // discrete-current control, without assuming a fractional final interval.
  const initialKwh = .2 * 75 - 12 * 3 * 230 * .25 / 1000 * .92;
  s.ev_battery!.soc = initialKwh / 75; s.ev_battery!.charge_limit_soc = .2;
  // Negative prices make additional energy useful even when another quarter
  // cannot cross a comfort-rule threshold. The cap must still stop charging.
  s.slots.forEach((q, i) => q.import_price_sek_per_kwh = i < 4 ? -1 : 1);
  const check = (result: OptimisationPlan) => {
    const slots = result.plans.priority.slots;
    assert(slots.some(q => q.ev_target_current_a > 0));
    assertEquals(slots.at(-1)!.ev_target_current_a, 0);
    let storedKwh = initialKwh;
    for (const q of slots) {
      // Integrate commanded amps independently; published watts/SOC may be clipped.
      storedKwh += q.ev_target_current_a * 690 * .25 / 1000 * .92;
      assert(storedKwh <= .2 * 75 + 1e-8);
    }
    assert(.2 * 75 - storedKwh < 5 * 690 * .25 / 1000 * .92, "less than one minimum-current quarter remains");
  };
  const p = plan(s); check(p);
  const overcharge = structuredClone(p); overcharge.plans.priority.slots[0].ev_target_current_a = 16;
  assertThrows(() => check(overcharge));
  s.ev_battery!.soc = .3;
  const above = plan(s);
  assert(above.plans.priority.slots.every(q => q.ev_target_current_a === 0));
});

Deno.test("CONTRACT POOL-2: losing thermal evidence cannot turn full ON permission into average electrical draw", () => {
  const s = withPool(); s.grid.import_limit_w = 500 + 3600 + 12 * 690;
  s.pool_model!.heater_response = undefined;
  const p = plan(s);
  assertEquals(p.pool!.planning_basis, "empirical");
  for (const q of p.plans.priority.slots) {
    assertEquals(q.pool_permitted, true);
    assertEquals(q.pool_command_w, 3600);
    assertEquals(q.device_loads_w.synthetic_pool, 3600);
    assert(q.ev_target_current_a <= 12, "thermal uncertainty must not grant additional electrical headroom");
  }
});

Deno.test("CONTRACT EV-3: excluded departure concepts are absent from executable contracts", () => {
  const scan = (directory: string): void => {
    for (const e of Deno.readDirSync(directory)) {
      const path = `${directory}/${e.name}`;
      if (e.isDirectory) scan(path);
      else if (/\.(ts|rs)$/.test(path) && !/\.test\.ts$|solver-bytes\.ts$/.test(path)) {
        assert(!/\b\w*(?:departure|depart_at)\w*\b/i.test(Deno.readTextFileSync(path)), `Excluded EV concept in ${path}`);
      }
    }
  };
  for (const path of ["supabase/functions/_shared/planner", "supabase/functions/_shared/planner-wasm", "planner-core/models/src", "planner-core/solver/src"]) scan(`${Deno.cwd()}/${path}`);
});

Deno.test("CONTRACT POOL-3: a pause carries thermal and source memory instead of resetting it", () => {
  const s = withPool(syntheticHome(16)); s.capabilities.ev = false; s.ev_battery = null; s.services = [];
  const p = prepare(s).problem;
  p.heater!.source = { recovery_rate_per_h: .2, heat_loss_per_kwh: .02 };
  p.pool_store!.response_time_constant_h = .7;
  p.initial.pool_pending_heat_kwh = 2; p.initial.pool_source_depletion_kwh = 3;
  const on = s.slots.map((_, i) => i < 4 || i >= 5 && i < 9);
  const result = nativePlanner().project(p, on.map(pool_on => ({ pool_on, ev_amps: 0, battery: "idle" as const, charge_limit_w: 0, discharge_limit_w: 0 }))).outcome;
  assert(result.kind === "projected");
  // Independent integration of the specified three-state plant. A half step
  // checks convergence; no production matrix, transition or fitted output is used.
  const integrate = (seconds: number, reset = false) => {
    let water = 26, pending = 2, depletion = 3;
    return on.map((running, i) => {
      if (reset && running && i && !on[i - 1]) depletion = 0;
      for (let t = 0; t < 900; t += seconds) {
        const power = running ? 3.6 : 0;
        const thermal = power * 4 * (1 - .02 * depletion);
        const delivered = pending / .7;
        water += delivered / (40 * 1.163) * seconds / 3600;
        pending += (thermal - delivered) * seconds / 3600;
        depletion += (power - .2 * depletion) * seconds / 3600;
      }
      return { water, pending, depletion };
    });
  };
  const reference = integrate(.5), coarse = integrate(1);
  const check = (rows: typeof result.quarters) => rows.forEach((row, i) => {
    assertAlmostEquals(row.pool_c!, reference[i].water, .0001);
    assertAlmostEquals(row.pool_pending_heat_kwh!, reference[i].pending, .001);
    assertAlmostEquals(row.pool_source_depletion_kwh!, reference[i].depletion, .0002);
  });
  reference.forEach((r, i) => assertAlmostEquals(r.water, coarse[i].water, .0001));
  check(result.quarters);
  const reset = integrate(.5, true);
  const mutant = result.quarters.map((row, i) => ({ ...row, pool_c: reset[i].water,
    pool_pending_heat_kwh: reset[i].pending, pool_source_depletion_kwh: reset[i].depletion }));
  assertThrows(() => check(mutant));
});
