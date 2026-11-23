import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { syntheticRoomPlant, syntheticRoomResponseEvidence } from "./native-mean.fixture.ts";
import { learnRoomResponse } from "./response-learning.ts";
import { ROOM_TRANSITION_POLICY } from "../../planner/models/room/run-evidence.ts";
import { heatingBand } from "../../planner/heating-bands.ts";

const CYCLE = 32, DAYS = 40;
/** Independent RK4 plant with one constant gain and loss across a season:
 * outdoor drifts from −15 °C to +10 °C while the heater cycles 3 h on, 5 h off. */
function seasonalPlant() {
  return syntheticRoomPlant([900], DAYS * 96, .5, 0, {
    gain: .002, houseGain: .03, outdoorGain: .04, background: .01, roomStart: 19, startMs: Date.UTC(2025, 10, 1), steps: 30,
    forcing: i => ({ outdoor: -15 + 25 * i / (DAYS * 96), house: 20, watts: i % CYCLE >= 2 && i % CYCLE < 14 ? 700 : 0, solar: null }),
  }).rows;
}

Deno.test("one shared response recovers a constant gain and assesses every run against it", () => {
  const fit = learnRoomResponse(syntheticRoomResponseEvidence(seasonalPlant()), 700);
  assert(fit.result.ok, JSON.stringify(fit.result));
  const model = fit.result.model;
  assert(model.response_family !== "equilibrium");
  assertAlmostEquals(model.gain_c_per_wh, .002, .0002);
  const ledger = fit.run_ledger!;
  assertEquals(ledger.policy, ROOM_TRANSITION_POLICY);
  assertEquals(ledger.observed_runs, DAYS * 96 / CYCLE);
  assertEquals(model.sample_count, DAYS * 96 - 1);
  // Every run on this excited plant must recover the calibrated heater
  // gain, including events that exhibit a within-run residual change.
  for (const run of ledger.runs) {
    assert(run.gain !== null && run.gain_se !== null);
    assert(Math.abs(run.gain - model.gain_c_per_wh) <= 3 * run.gain_se + .0002, `${run.id} ${run.gain}`);
  }
  const outdoor = new Set(ledger.runs.map(run => heatingBand(run.outdoor_c!)));
  assert(outdoor.size >= 3);
  // Cool-downs agree with the shared loss model on a noiseless plant.
  for (const run of ledger.runs) if (run.cooldown?.residual_c_per_h != null) {
    assert(Math.abs(run.cooldown.residual_c_per_h) < .05, `${run.id} ${run.cooldown.residual_c_per_h}`);
  }
});
