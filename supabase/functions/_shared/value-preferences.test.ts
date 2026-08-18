import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  curveFromPreference,
  DEFAULT_POOL_PREFERENCE,
  DEFAULT_REFERENCE_SEK_PER_KWH,
  preferenceFromCurve,
  validatePreference,
  vehiclePreference,
} from "./value-preferences.ts";
import { marginalValue, validateCurve } from "./store-value.ts";
import { DEFAULT_EV_CURVE, DEFAULT_POOL_CURVE } from "./value-curves.ts";
import { WATER_KWH_PER_M3_K } from "./store-models.ts";

/** Phil's pool: 55 m³ at a measured COP near 4.6, so ~14 kWh per degree. */
const POOL_SCALE = {
  units_per_kwh: 4.6 / (55 * WATER_KWH_PER_M3_K),
  reference_sek_per_kwh: DEFAULT_REFERENCE_SEK_PER_KWH,
};

/** A battery vehicle at 0.16 kWh/km and 90% charging efficiency. */
const EV_SCALE = {
  units_per_kwh: 0.9 / 0.16,
  reference_sek_per_kwh: DEFAULT_REFERENCE_SEK_PER_KWH,
};

Deno.test("a generated curve is always one the planner will accept", () => {
  const curve = curveFromPreference(
    { urgent_below: 25, comfortable: 28, indifferent_above: 31 },
    "celsius",
    POOL_SCALE,
  );
  assertEquals(validateCurve(curve), null);
});

Deno.test("the thresholds land exactly where the household put them", () => {
  const curve = curveFromPreference(
    { urgent_below: 24, comfortable: 27.5, indifferent_above: 30 },
    "celsius",
    POOL_SCALE,
  );
  assertEquals(curve.points.map((point) => point.at), [24, 27.5, 30]);
  // Nothing above the indifference threshold, which is what stops a store
  // being filled without limit.
  assertEquals(marginalValue(curve, 31), 0);
});

Deno.test("the comfortable level is exactly what the energy costs", () => {
  // The anchor that makes the whole parameterisation legible: at the
  // comfortable point the store takes surplus and cheap grid and declines an
  // expensive hour, with no threshold anywhere expressing that.
  const curve = curveFromPreference(
    { urgent_below: 25, comfortable: 28, indifferent_above: 31 },
    "celsius",
    POOL_SCALE,
  );
  const valuePerKwh = marginalValue(curve, 28) * POOL_SCALE.units_per_kwh;
  assert(
    Math.abs(valuePerKwh - DEFAULT_REFERENCE_SEK_PER_KWH) < 1e-4,
    `a comfortable store should bid the reference price, bid ${valuePerKwh}`,
  );
});

Deno.test("an urgent store outbids any price it will realistically meet", () => {
  const curve = curveFromPreference(
    { urgent_below: 25, comfortable: 28, indifferent_above: 31 },
    "celsius",
    POOL_SCALE,
  );
  const valuePerKwh = marginalValue(curve, 22) * POOL_SCALE.units_per_kwh;
  assert(
    valuePerKwh > 3 * DEFAULT_REFERENCE_SEK_PER_KWH - 1e-6,
    `a cold pool must clear a dear hour, bid ${valuePerKwh}`,
  );
});

Deno.test("the same three numbers mean different money on different physics", () => {
  // The point of taking `units_per_kwh` rather than a level: a bigger pool is
  // worth more per degree because a degree costs more energy, and the customer
  // states neither figure.
  const small = curveFromPreference(
    { urgent_below: 25, comfortable: 28, indifferent_above: 31 },
    "celsius",
    { ...POOL_SCALE, units_per_kwh: POOL_SCALE.units_per_kwh * 2 },
  );
  const large = curveFromPreference(
    { urgent_below: 25, comfortable: 28, indifferent_above: 31 },
    "celsius",
    POOL_SCALE,
  );
  assert(
    marginalValue(large, 26) > marginalValue(small, 26),
    "a pool that takes twice the energy per degree must value a degree more",
  );
  // And in the unit that actually gets compared to a price, they agree.
  assertEquals(
    (marginalValue(large, 28) * POOL_SCALE.units_per_kwh).toFixed(4),
    (marginalValue(small, 28) * POOL_SCALE.units_per_kwh * 2).toFixed(4),
  );
});

Deno.test("opening and saving without an edit cannot drift", () => {
  // Round-tripping is exact because the thresholds *are* the breakpoints. An
  // editor that quietly nudged the curve every time it was opened would be a
  // worse failure than not having one.
  const preference = {
    urgent_below: 26,
    comfortable: 29,
    indifferent_above: 30.5,
  };
  const curve = curveFromPreference(preference, "celsius", POOL_SCALE);
  assertEquals(preferenceFromCurve(curve), preference);
});

Deno.test("the shipped pool default is expressible as three thresholds", () => {
  // The defaults were written by hand long before this module existed, so
  // agreeing with them is evidence the parameterisation is the right one
  // rather than a convenient one.
  const regenerated = curveFromPreference(
    DEFAULT_POOL_PREFERENCE,
    "celsius",
    POOL_SCALE,
  );
  assertEquals(
    regenerated.points.map((point) => point.at),
    [25, 28, 31],
    "the thresholds should be the shipped curve's own breakpoints",
  );
  const handWritten = marginalValue(DEFAULT_POOL_CURVE, 28);
  const generated = marginalValue(regenerated, 28);
  assert(
    Math.abs(generated - handWritten) / handWritten < 0.2,
    `hand-written ${handWritten} vs generated ${generated}`,
  );
});

Deno.test("a hand-written curve is not guessed at", () => {
  // The vehicle default's second breakpoint ends the range-anxiety ramp; it is
  // not the band anyone asked for. Reading it as one made the editor claim a
  // customer wanted 120 km when the curve means 400, so any shape this module
  // did not generate returns nothing and the caller states a default instead.
  assertEquals(preferenceFromCurve(DEFAULT_EV_CURVE), null);
  assertEquals(preferenceFromCurve(DEFAULT_POOL_CURVE), null);
});

Deno.test("vehicle thresholds are scaled to the range the customer asked for", () => {
  const preference = vehiclePreference(384);
  assertEquals(preference.comfortable, 384);
  assert(preference.urgent_below < preference.comfortable);
  assert(preference.indifferent_above > preference.comfortable);
  assertEquals(validatePreference(preference), null);
  // A tiny target must still produce a usable, ordered curve rather than a
  // degenerate one.
  assertEquals(validatePreference(vehiclePreference(1)), null);
});

Deno.test("a vehicle states the same three numbers in kilometres", () => {
  const curve = curveFromPreference(
    { urgent_below: 60, comfortable: 300, indifferent_above: 480 },
    "km",
    EV_SCALE,
  );
  assertEquals(validateCurve(curve), null);
  // Range anxiety outbids the pool's urgent band by construction, because a
  // kilometre costs less energy than a pool degree does.
  assert(marginalValue(curve, 40) > 0);
  assertEquals(marginalValue(curve, 500), 0);
});

Deno.test("thresholds out of order are refused with the offending pair named", () => {
  assertEquals(
    validatePreference({
      urgent_below: 28,
      comfortable: 26,
      indifferent_above: 31,
    }),
    "the urgent threshold must be below the comfortable one",
  );
  assertEquals(
    validatePreference({
      urgent_below: 25,
      comfortable: 31,
      indifferent_above: 30,
    }),
    "the comfortable threshold must be below the indifference one",
  );
  assertEquals(
    validatePreference({
      urgent_below: 25,
      comfortable: 28,
      indifferent_above: 31,
    }),
    null,
  );
});

Deno.test("a curve too short to carry three thresholds is not guessed at", () => {
  assertEquals(
    preferenceFromCurve({ unit: "kwh", points: [{ at: 5, sek_per_unit: 1 }] }),
    null,
  );
});
