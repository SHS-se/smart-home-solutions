import { assertEquals, assertThrows } from "@std/assert";
import { compareRoomFitCells } from "../scripts/probe-room-learning-comparison.ts";
import { ROOM_BAND_FINITE_PROFILE_LOG_RESOLUTION, type RoomBandFitCell } from "../supabase/functions/_shared/device-learning/room/mean-observations.ts";

function unshifted(): RoomBandFitCell {
  return { lag_h: 1, partition: "full", fits: {
    finite: { k: .25, n: 20_000, dof: 19_990, beta: [.004, -.06, .12], mse: .03 },
    equilibrium: null,
    integrator: { k: 0, n: 20_000, dof: 19_992, beta: [.005, -.15, 0], mse: .05 },
  } };
}

Deno.test("room qualification checks the coefficients at an adjacent finite profile point", () => {
  const expected = unshifted(), actual = unshifted(), finite = actual.fits.finite!;
  finite.k *= Math.exp(ROOM_BAND_FINITE_PROFILE_LOG_RESOLUTION / 2);
  finite.mse += Number.EPSILON;
  finite.beta[1] += 1e-7;
  let calls = 0;
  const result = compareRoomFitCells(expected, actual, k => {
    calls++;
    assertEquals(k, finite.k);
    return { ...finite, beta: [.004, -.06 + 1e-7, .12 + 8 * Number.EPSILON] };
  });
  assertEquals(calls, 1);
  assertEquals(result.profileChoice, true);
  assertEquals(result.differences.map(d => d.path).sort(), ["fits.finite.beta.1", "fits.finite.k", "fits.finite.mse"]);
});

Deno.test("room qualification rejects profile, objective, coefficient and discrete mismatches", () => {
  const expected = unshifted(), actual = unshifted(), finite = actual.fits.finite!;
  const failIfEvaluated = () => { throw new Error("Unexpected profile evaluation"); };
  finite.k *= Math.exp(ROOM_BAND_FINITE_PROFILE_LOG_RESOLUTION * 2);
  assertThrows(() => compareRoomFitCells(expected, actual, failIfEvaluated), Error, "search bracket width");
  finite.k = .25 * Math.exp(ROOM_BAND_FINITE_PROFILE_LOG_RESOLUTION / 2);
  finite.mse = .031;
  assertThrows(() => compareRoomFitCells(expected, actual, failIfEvaluated), Error, "objective roundoff");
  finite.mse = .03;
  finite.beta[1] += .001;
  assertThrows(() => compareRoomFitCells(expected, actual, k => ({ ...expected.fits.finite!, k })), Error, "beta.1 exceeds");
  actual.fits.finite = { ...expected.fits.finite! };
  actual.fits.integrator!.dof++;
  assertThrows(() => compareRoomFitCells(expected, actual, failIfEvaluated), Error, "fits.integrator.dof");
  actual.fits.integrator = null;
  assertThrows(() => compareRoomFitCells(expected, actual, failIfEvaluated), Error, "fits.integrator availability");
});

Deno.test("room qualification accepts accumulated roundoff at unchanged profile and limit coordinates", () => {
  const expected = unshifted(), actual = unshifted();
  actual.fits.finite!.beta[0] += 64 * Number.EPSILON;
  actual.fits.integrator!.mse += 32 * Number.EPSILON;
  const failIfEvaluated = () => { throw new Error("Unexpected profile evaluation"); };
  const result = compareRoomFitCells(expected, actual, failIfEvaluated);
  assertEquals(result.profileChoice, false);
  assertEquals(result.differences.map(d => d.path), ["fits.finite.beta.0", "fits.integrator.mse"]);
  actual.fits.integrator!.k = Number.EPSILON;
  assertThrows(() => compareRoomFitCells(expected, actual, failIfEvaluated), Error, "limit coordinate");
});
