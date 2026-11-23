import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { syntheticRoomPlant } from "./native-mean.fixture.ts";
import { harvestBandRuns, mergeHarvests, runOutdoorBand, seasonalRunRows, ALL_OUTDOOR } from "./run-pool.ts";
import { roomHeatingRuns } from "./run-calibration.ts";
import { learnRoomResponse } from "./response-learning.ts";
import { MAX_ROOM_HEATING_RUNS, ROOM_RUN_POLICY, RUNS_PER_OUTDOOR_BAND } from "../../planner/models/room/run-evidence.ts";
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

Deno.test("the working view balances every outdoor stratum up to its total and is idempotent", () => {
  const rows = seasonalPlant();
  const view = seasonalRunRows(rows);
  const runs = roomHeatingRuns(view, ALL_OUTDOOR);
  assertEquals(runs.length, MAX_ROOM_HEATING_RUNS);
  const strata = new Map<number | null, number>();
  for (const run of runs) strata.set(runOutdoorBand(view, run), (strata.get(runOutdoorBand(view, run)) ?? 0) + 1);
  assert(strata.size >= 5, `strata ${[...strata.keys()]}`);
  const counts = [...strata.values()];
  assert(Math.max(...counts) - Math.min(...counts) <= 1, `counts ${counts}`);
  assertEquals(seasonalRunRows(view), view);
  // A one-season room keeps all its runs rather than a seasonal share.
  const oneSeason = rows.filter(row => heatingBand(row.outdoor_c!) === -10);
  const all = roomHeatingRuns(oneSeason, ALL_OUTDOOR).length;
  assertEquals(roomHeatingRuns(seasonalRunRows(oneSeason), ALL_OUTDOOR).length, Math.min(all, MAX_ROOM_HEATING_RUNS));
});

Deno.test("a band harvest keeps its newest runs and merged harvests prefer the later read", () => {
  const rows = seasonalPlant();
  const harvest = harvestBandRuns(rows, -10);
  const all = roomHeatingRuns(rows, c => heatingBand(c) === -10).map(run => run.id);
  assertEquals(harvest.observed_runs, all.length);
  assertEquals(harvest.run_ids, all.slice(-RUNS_PER_OUTDOOR_BAND));
  const corrected = harvest.rows.map(row => ({ ...row, room_c: row.room_c! + 1 }));
  const merged = mergeHarvests([{ harvested_at: "2026-01-02T00:00:00Z", rows: corrected },
    { harvested_at: "2026-01-01T00:00:00Z", rows: harvest.rows }]);
  assertEquals(merged, corrected);
});

Deno.test("one shared response recovers a constant gain and assesses every run against it", () => {
  const fit = learnRoomResponse(seasonalPlant(), 700);
  assert(fit.result.ok, JSON.stringify(fit.result));
  const model = fit.result.model;
  assert(model.response_family !== "equilibrium");
  assertAlmostEquals(model.gain_c_per_wh, .002, .0002);
  const ledger = fit.run_ledger!;
  assertEquals(ledger.policy, ROOM_RUN_POLICY);
  assert(ledger.fitted_runs >= 3);
  const credible = ledger.runs.filter(run => run.disposition === "fitted" || run.disposition === "provisional");
  assert(credible.length >= 5);
  // Comparable points: no run's gain departs from the shared gain by more than its own uncertainty allows.
  for (const run of credible) assert(Math.abs(run.gain! - model.gain_c_per_wh) <= 3 * run.gain_se! + .0002, `${run.id} ${run.gain}`);
  const outdoor = new Set(credible.map(run => heatingBand(run.outdoor_c!)));
  assert(outdoor.size >= 3);
  // Cool-downs agree with the shared loss model on a noiseless plant.
  for (const run of ledger.runs) if (run.cooldown?.residual_c_per_h != null) {
    assert(Math.abs(run.cooldown.residual_c_per_h) < .05, `${run.id} ${run.cooldown.residual_c_per_h}`);
  }
});
