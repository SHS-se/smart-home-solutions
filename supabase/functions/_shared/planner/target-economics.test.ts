import { assertAlmostEquals, assertEquals } from "@std/assert";
import { targetEconomics } from "./target-economics.ts";
import { totalUtility } from "./store-value.ts";
import { marginalServiceValues, serviceValue } from "./dispatch-service-value.ts";

Deno.test("target willingness has physical units, saturates at the target and scales once", () => {
  const make = (scale: number) => targetEconomics({ unit: "km", target: 300, step: 50,
    units_per_kwh: 6, reference_sek_per_kwh: .8, scale,
    timing: { kind: "held", slot_hours: [.1, .25, .25] } });
  const base = make(1), high = make(2);
  assertAlmostEquals(base.curve.points[0].sek_per_unit, 3 * .8 / 6);
  assertAlmostEquals(totalUtility(base.curve, 350), totalUtility(base.curve, 300));
  assertAlmostEquals(totalUtility(high.curve, 150), 2 * totalUtility(base.curve, 150));
  assertEquals(base.usage_weight, [.1 / 24, .25 / 24, .25 / 24]);
  assertEquals(base.terminal_weight, 1);
  assertEquals(base.derivation.service_basis, "service_day");
});

Deno.test("declared readiness values the event once, with no closing double count", () => {
  const economics = targetEconomics({ unit: "km", target: 300, step: 50,
    units_per_kwh: 6, reference_sek_per_kwh: .8, scale: 1,
    timing: { kind: "event", slot: 2, slots: 4 } });
  assertEquals(economics.usage_weight, [0, 0, 1, 0]);
  assertEquals(economics.terminal_weight, 0);
  assertEquals(economics.derivation.service_basis, "readiness_event");
});

Deno.test("service slices add up without repricing the remaining horizon", () => {
  const model = { curve: { unit: "celsius", points: [{ at: 30, sek_per_unit: 10 }] },
    usage_weight: [.1 / 24, .25 / 24, .25 / 24], terminal_weight: 1 };
  const state = [29, 29.2, 29.6, 30.1];
  // Independently: holding improvements 0, .2, .6; terminal capped at +1.
  const expected = 10 * (.25 / 24 * .2 + .25 / 24 * .6 + 1);
  assertAlmostEquals(serviceValue(model, state), expected);
  assertAlmostEquals(serviceValue(model, state, 0, 1) + serviceValue(model, state, 1, 3), expected);
});

Deno.test("suffix marginal matches finite differences through actual thermal transitions", () => {
  const model = { curve: { unit: "celsius", points: [
    { at: 25, sek_per_unit: 20 }, { at: 35, sek_per_unit: 5 }] },
    usage_weight: [.1 / 24, .25 / 24, .25 / 24, .25 / 24], terminal_weight: 1 };
  const decay = [.99, .97, .98, .96];
  const project = (injected: number, delta: number) => {
    const state = [29];
    for (let i = 0; i < 4; i++) state.push((state[i] + (i === injected ? delta : 0)) * decay[i] + .5);
    return state;
  };
  const state = project(-1, 0);
  const adjoint = marginalServiceValues(model, state, decay, decay);
  const base = serviceValue(model, state);
  for (let i = 0; i < 4; i++) {
    assertAlmostEquals(adjoint[i], (serviceValue(model, project(i, 1e-5)) - base) / 1e-5, 2e-5);
  }
});

Deno.test("zero-weight service terms retain signed-zero accumulation", () => {
  const model = { curve: { unit: "kwh", points: [{ at: 10, sek_per_unit: 2 }] },
    usage_weight: [0], terminal_weight: -0 };
  // The terminal account is -0; the held account's +0 normalizes the sum.
  assertEquals(Object.is(serviceValue(model, [1, 1]), 0), true);
});

Deno.test("an empty nonterminal service slice reads no utility", () => {
  const model = { curve: { unit: "kwh", get points(): { at: number; sek_per_unit: number }[] {
    throw new Error("No utility belongs to this empty slice");
  } }, usage_weight: [] };
  assertEquals(serviceValue(model, [1, 2, 3], 1, 1), 0);
});
