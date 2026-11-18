import { assert, assertEquals } from "@std/assert";
import {
  ROOM_BAND_FINITE_PROFILE_LOG_RESOLUTION, ROOM_BAND_OBJECTIVE_ROUNDOFF_SCALE, type RoomBandFitCell,
} from "../supabase/functions/_shared/device-learning/room/mean-observations.ts";

type Fit = NonNullable<RoomBandFitCell["fits"]["finite"]>;
export interface RoomFitDifference { path: string; expected: number; actual: number; absolute: number; ulps?: number }

function difference(path: string, expected: number, actual: number): RoomFitDifference {
  const result: RoomFitDifference = { path, expected, actual, absolute: Math.abs(expected - actual) };
  if (Math.sign(expected) === Math.sign(actual)) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, expected);
    const a = view.getBigUint64(0);
    view.setFloat64(0, actual);
    const b = view.getBigUint64(0);
    result.ulps = Number(a > b ? a - b : b - a);
  }
  return result;
}

function assertSameSupport(expected: Fit, actual: Fit, path: string) {
  assertEquals(actual.n, expected.n, `${path}.n`);
  assertEquals(actual.dof, expected.dof, `${path}.dof`);
  assertEquals(actual.beta.length, expected.beta.length, `${path}.beta.length`);
}

/** TEST qualification for intermediate room cells. Repeat hashes and finished
 * models are compared exactly in the runner. */
export function compareRoomFitCells(expected: RoomBandFitCell, actual: RoomBandFitCell,
  finiteAt: (k: number) => Fit | null): { differences: RoomFitDifference[]; profileChoice: boolean } {
  assertEquals(actual.lag_h, expected.lag_h, "Room fit lag");
  assertEquals(actual.partition, expected.partition, "Room fit partition");
  const differences: RoomFitDifference[] = [];
  let profileChoice = false;
  for (const family of ["finite", "equilibrium", "integrator"] as const) {
    const a = expected.fits[family], b = actual.fits[family], path = `fits.${family}`;
    if (!a || !b) {
      assertEquals(b, a, `${path} availability`);
      continue;
    }
    assertSameSupport(a, b, path);
    // The usual γₙ scale grows with arithmetic over n observed pairs. The
    // unit floor covers small coefficients without dividing by near-zero.
    const accumulated = a.n * Number.EPSILON;
    const roundoff = accumulated / (1 - accumulated);
    const withinRoundoff = (x: number, y: number) => Math.abs(x - y) <= roundoff * Math.max(1, Math.abs(x), Math.abs(y));
    let reference = a;
    if (family === "finite" && Math.abs(a.k - b.k) > roundoff * Math.max(a.k, b.k)) {
      // Distinguish adjacent nearly equal profile minima from shifted model
      // equations. Compare at the hosted point inside one final log bracket.
      const logShift = Math.abs(Math.log(b.k / a.k));
      assert(logShift <= ROOM_BAND_FINITE_PROFILE_LOG_RESOLUTION, `${path}.k exceeds final search bracket width`);
      // The production objective's squared-contribution scale bounds MSE.
      // Using MSE in its place gives the conservative baseline used here.
      const objectiveRoundoff = ROOM_BAND_OBJECTIVE_ROUNDOFF_SCALE * Math.max(1, a.mse, b.mse);
      assert(Math.abs(a.mse - b.mse) <= objectiveRoundoff, `${path}.mse exceeds profile objective roundoff`);
      const checked = finiteAt(b.k);
      assert(checked, `${path} unidentified at hosted exchange`);
      assertEquals(checked.k, b.k, `${path}.k at hosted exchange`);
      assertSameSupport(a, checked, path);
      reference = checked;
      profileChoice = true;
    } else if (family !== "finite") {
      assertEquals(b.k, a.k, `${path}.k limit coordinate`);
    }
    assert(withinRoundoff(reference.mse, b.mse), `${path}.mse exceeds accumulated roundoff`);
    for (let i = 0; i < a.beta.length; i++) {
      assert(withinRoundoff(reference.beta[i], b.beta[i]), `${path}.beta.${i} exceeds accumulated roundoff`);
      if (!Object.is(a.beta[i], b.beta[i])) differences.push(difference(`${path}.beta.${i}`, a.beta[i], b.beta[i]));
    }
    if (!Object.is(a.k, b.k)) differences.push(difference(`${path}.k`, a.k, b.k));
    if (!Object.is(a.mse, b.mse)) differences.push(difference(`${path}.mse`, a.mse, b.mse));
  }
  return { differences, profileChoice };
}
