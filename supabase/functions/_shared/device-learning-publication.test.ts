import { assertEquals, assertThrows } from "@std/assert";
import { compareLearningPublications } from "./device-learning-publication.ts";

// Independently specified synthetic IEEE-754 neighbors, no measured household data.
const adjacent = (value: number, ulps: bigint) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + ulps);
  return view.getFloat64(0);
};
const publication = (rmse = 1, rate = 2) => ({ p_model: {
  thermal_dynamics: { heat_c_per_kwh: .1, state: { pending_heat_kwh: 2 },
    recovery_evidence: { profile: [{ rmse_c: rmse, recovery_rate_per_h: rate }] } },
  last_fit_attempt: { recovery_selection: { constant_rmse_c: .2 } },
} });

Deno.test("cross-runtime learning comparison allows at most two ULPs only in named profile diagnostics", () => {
  const base = publication();
  assertEquals(compareLearningPublications(base, base), []);
  assertThrows(() => compareLearningPublications(undefined, undefined), Error, "missing at root");
  assertEquals(compareLearningPublications(base, publication(adjacent(1, 1n), adjacent(2, 2n))).map(row => row.ulps), [1, 2]);
  assertThrows(() => compareLearningPublications(base, publication(adjacent(1, 3n))), Error, "profile.0.rmse_c");
  assertThrows(() => compareLearningPublications(base, publication(1, adjacent(2, 3n))), Error, "profile.0.recovery_rate_per_h");
  assertThrows(() => compareLearningPublications(base, publication(-1)), Error, "profile.0.rmse_c");
  assertThrows(() => compareLearningPublications(base, publication(Infinity)), Error, "profile.0.rmse_c");
});

Deno.test("cross-runtime learning comparison rejects any selected coefficient, state or score difference", () => {
  const base = publication();
  const coefficient = publication(); coefficient.p_model.thermal_dynamics.heat_c_per_kwh = adjacent(.1, 1n);
  const state = publication(); state.p_model.thermal_dynamics.state.pending_heat_kwh = adjacent(2, 1n);
  const score = publication(); score.p_model.last_fit_attempt.recovery_selection.constant_rmse_c = adjacent(.2, 1n);
  for (const changed of [coefficient, state, score]) assertThrows(() => compareLearningPublications(base, changed), Error, "Learning publication mismatch");
  assertThrows(() => compareLearningPublications(base, { ...base, extra: true }), Error, "root");
});
