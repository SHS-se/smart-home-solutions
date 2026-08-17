import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  DEFAULT_VALUE_CURVES,
  DEFAULT_VALUE_SETTINGS,
  parseStoredCurve,
  resolveValueCurves,
  resolveValueSettings,
  type ValueStoreKey,
} from "./value-curves.ts";
import { marginalValue, validateCurve } from "./store-value.ts";

Deno.test("every shipped default is a valid concave curve", () => {
  for (const [key, curve] of Object.entries(DEFAULT_VALUE_CURVES)) {
    assertEquals(validateCurve(curve), null, `${key} default is invalid`);
  }
});

Deno.test("the pool default orders a cold pool above a warm one", () => {
  const pool = DEFAULT_VALUE_CURVES.pool;

  assert(marginalValue(pool, 23) > marginalValue(pool, 28));
  assertEquals(
    marginalValue(pool, 32),
    0,
    "past the top of the band more heat is worth nothing",
  );
});

Deno.test("the EV default makes the last fifth nearly worthless", () => {
  const ev = DEFAULT_VALUE_CURVES.ev;
  // Roughly a Model Y: 75 kWh at 0.16 kWh/km is about 470 km full.
  const nearlyEmpty = marginalValue(ev, 40);
  const nearlyFull = marginalValue(ev, 400);

  assert(nearlyEmpty > nearlyFull * 20, "range anxiety must dominate topping up");
  assert(
    nearlyFull < 0.2,
    "the top of the pack must not outbid an ordinary import price",
  );
});

Deno.test("a missing row falls back to the default and says so", () => {
  const { curves, warnings } = resolveValueCurves([]);

  assertEquals(warnings, []);
  for (const key of Object.keys(DEFAULT_VALUE_CURVES) as ValueStoreKey[]) {
    assertEquals(curves[key].source, "default");
  }
});

Deno.test("a customer curve overrides the default", () => {
  const { curves, warnings } = resolveValueCurves([{
    store_key: "pool",
    unit: "celsius",
    points: [{ at: 26, sek_per_unit: 9 }, { at: 30, sek_per_unit: 0 }],
  }]);

  assertEquals(warnings, []);
  assertEquals(curves.pool.source, "customer");
  assertEquals(curves.pool.curve.points.length, 2);
  assertEquals(curves.ev.source, "default");
});

Deno.test("a bad override falls back rather than failing the whole plan", () => {
  // Rising marginal value: the shape that would let the solver fill a store
  // without limit. It must not be silently repaired, and it must not take the
  // rest of the home's planning down with it.
  const { curves, warnings } = resolveValueCurves([{
    store_key: "pool",
    unit: "celsius",
    points: [{ at: 26, sek_per_unit: 1 }, { at: 30, sek_per_unit: 8 }],
  }]);

  assertEquals(curves.pool.source, "default");
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("not_concave"));
});

Deno.test("malformed points are rejected with a reason", () => {
  const cases: [string, unknown][] = [
    ["points must be an array", { at: 1 }],
    ["a curve needs at least one point", []],
    ["a point needs finite at and sek_per_unit", [{ at: "warm", sek_per_unit: 1 }]],
    ["negative_value", [{ at: 26, sek_per_unit: -1 }]],
    [
      "unsorted",
      [{ at: 30, sek_per_unit: 5 }, { at: 26, sek_per_unit: 1 }],
    ],
  ];
  for (const [expected, points] of cases) {
    const result = parseStoredCurve({
      store_key: "pool",
      unit: "celsius",
      points,
    });
    assertEquals(typeof result, "string", `${expected} should be rejected`);
    assert(
      (result as string).includes(expected),
      `expected "${expected}", got "${result}"`,
    );
  }
});

Deno.test("settings fall back per field, not all or nothing", () => {
  assertEquals(resolveValueSettings(null), DEFAULT_VALUE_SETTINGS);

  const partial = resolveValueSettings({
    battery_degradation_sek_per_kwh: 0.62,
  });
  assertEquals(partial.battery_degradation_sek_per_kwh, 0.62);
  assertEquals(partial.vehicle_fallback_sek_per_km, null);

  // A hybrid's fallback is the pump price per km, not a preference.
  const hybrid = resolveValueSettings({
    battery_degradation_sek_per_kwh: 0.4,
    vehicle_fallback_sek_per_km: 1.35,
  });
  assertEquals(hybrid.vehicle_fallback_sek_per_km, 1.35);
});

Deno.test("a nonsense degradation cost falls back rather than disabling wear", () => {
  const settings = resolveValueSettings({
    battery_degradation_sek_per_kwh: Number.NaN,
  });

  assertEquals(
    settings.battery_degradation_sek_per_kwh,
    DEFAULT_VALUE_SETTINGS.battery_degradation_sek_per_kwh,
    "zero wear would let the solver cycle the pack for pennies",
  );
});
