import { learnRoomResponse } from "./response-learning.ts";
import { assert, assertEquals } from "@std/assert";
import { advanceRoomHeatingBands, publishRoomHeatingBandFit } from "./heating-bands.ts";
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { canonicalHeatingBands, publishHeatingBand, roomHeatingBandAt, type RoomHeatingBands } from "../../planner/heating-bands.ts";
import type { ThermalZoneModel } from "../../planner/models/room/thermal.ts";

const quarter = 900_000, start = Date.UTC(2026, 0, 1);
const reference: ThermalZoneModel = {
  gain_c_per_wh: .001, cooling_constant_per_h: .01, house_coupling_per_h: .1, background_gain_c_per_h: 0,
  heat_lag_h: 0, heating_rate_c_per_h: .5, thermal_capacity_wh_per_c: 1000, heat_loss_w_per_c: 110,
  time_constant_h: 1 / .11, sample_count: 1000, r2: .99, residual_std_c: .1,
};

/** Synthetic independently integrated room, with different warm-weather response. */
function observations(): RoomMeanQuarter[] {
  let room = 21;
  return Array.from({ length: 96 * 8 }, (_, index) => {
    const outdoor = 2 + Math.sin(index / 16), house = 21 + Math.sin(index / 42);
    const heat = index % 24 < 9 ? 500 : 0;
    let sum = 0;
    for (let minute = 0; minute < 15; minute++) {
      const rate = .003 * heat - .03 * (room - outdoor) - .1 * (room - house) + .21;
      sum += room + rate / 120;
      room += rate / 60;
    }
    return { start_ms: start + index * quarter, room_c: sum / 15, outdoor_c: outdoor, house_c: house,
      solar_w_per_m2: null, heat_w: heat, cooling: false };
  });
}

Deno.test("an identified empirical band publishes without beating the general model and retains other seasons", () => {
  const rows = observations();
  const cold = { revision: "cold-fit", band_c: -10, observed_min_c: -9, observed_max_c: -6,
    training_from: "2025-01-01", training_to: "2025-01-08", model: reference };
  const current: RoomHeatingBands = { reference_revision: "general", binding: "synthetic-room",
    since: "2025-01-01", active: [cold], candidates: [], attempted: {} };
  const fitted = advanceRoomHeatingBands(current, rows.slice(0, 96 * 4), reference, 500);
  assertEquals(fitted.candidates, []);
  const warm = roomHeatingBandAt(fitted.active, 2)!;
  assert(warm.model.response_family !== "equilibrium");
  assert(warm.model.gain_c_per_wh > .0029);
  assertEquals(roomHeatingBandAt(fitted.active, -7)?.revision, cold.revision);
  const insufficient = rows.map(row => ({ ...row, heat_w: null }));
  assertEquals(advanceRoomHeatingBands(fitted, insufficient, reference, 500).active, fitted.active);
  // Late readings can improve the next fit without a manual reset.
  const incomplete = rows.slice(0, -1).map((row, index) => index === 450 ? { ...row, heat_w: null } : row);
  const refitted = advanceRoomHeatingBands(fitted, incomplete, reference, 500);
  assert(roomHeatingBandAt(refitted.active, 2)?.revision !== warm.revision);
  assertEquals(roomHeatingBandAt(refitted.active, -7)?.revision, cold.revision);
  assertEquals(roomHeatingBandAt(refitted.active, 4)?.revision, roomHeatingBandAt(refitted.active, 2)?.revision);
});

Deno.test("a narrower room revision replaces the active revision over its whole nominal band", () => {
  const rows = observations();
  const old = { revision: "wide", band_c: 0, observed_min_c: 0, observed_max_c: 4,
    training_from: "2025-10-01", training_to: "2025-10-08", model: reference };
  const library: RoomHeatingBands = { reference_revision: "general", binding: "synthetic-room", since: "2025-10-01",
    active: [old], candidates: [], attempted: {} };
  const staged = advanceRoomHeatingBands(library, rows.slice(0, 96 * 4), reference, 500);
  const promoted = advanceRoomHeatingBands(staged, rows, reference, 500);
  assertEquals(promoted.active.length, 1);
  assertEquals(roomHeatingBandAt(promoted.active, 0)?.revision, promoted.active[0].revision);
  assertEquals(roomHeatingBandAt(promoted.active, 4.999)?.revision, promoted.active[0].revision);
  assertEquals(roomHeatingBandAt(promoted.active, 5), undefined);
  assert(roomHeatingBandAt(promoted.active, 2)?.revision !== roomHeatingBandAt(staged.active, 2)?.revision);
});

Deno.test("historical backfill cannot split a band around its preferred newer revision", () => {
  const current = { revision: "current", band_c: 0, observed_min_c: 1, observed_max_c: 4,
    training_from: "2026-01-01", training_to: "2026-01-21", model: reference };
  const historical = { ...current, revision: "historical", observed_min_c: 0,
    training_from: "2025-01-01", training_to: "2025-01-21" };
  const bands = publishHeatingBand([current], historical);
  assertEquals(roomHeatingBandAt(bands, 2)?.revision, "current");
  assertEquals(roomHeatingBandAt(bands, .5)?.revision, "current");
  assertEquals(bands.length, 1);
});

Deno.test("published heater evidence dates exclude unknown meter prefixes and suffixes", () => {
  const measured = observations().slice(0, 96 * 4);
  const rows = [{ ...measured[0], start_ms: start - quarter, heat_w: null }, ...measured,
    { ...measured.at(-1)!, start_ms: start + measured.length * quarter, heat_w: null }];
  const library: RoomHeatingBands = { reference_revision: "general", binding: "synthetic-room",
    since: "2025-01-01", active: [], candidates: [], attempted: {} };
  const fit = learnRoomResponse(rows, () => true, 500);
  const fitted = publishRoomHeatingBandFit(library, rows, 0, rows.at(-1)!.start_ms, fit);
  assertEquals(fitted.active[0].training_from, fit.run_ledger!.oldest_run_at!);
  assertEquals(fitted.active[0].training_to, fit.run_ledger!.newest_run_at!);
  assert(Date.parse(fitted.active[0].training_from) >= start);
  assert(Date.parse(fitted.active[0].training_to) <= start + measured.length * quarter);
});

Deno.test("a run-qualified replay supersedes a wider legacy revision from the same evidence", () => {
  const fit = learnRoomResponse(observations(), () => true, 500);
  assert(fit.result.ok);
  const legacy = { revision: "legacy-capture-dates", band_c: 0, observed_min_c: 0, observed_max_c: 5,
    training_from: "2025-01-01", training_to: "2026-12-01", model: reference };
  const library: RoomHeatingBands = { binding: "synthetic-room", reference_revision: "general", since: "2025-01-01",
    active: [legacy], candidates: [], attempted: {} };
  const published = publishRoomHeatingBandFit(library, observations(), 0, start, fit, "2026-11-22T12:00:00Z");
  assert(roomHeatingBandAt(published.active, 2)!.revision !== legacy.revision);
  assertEquals(roomHeatingBandAt(published.active, .1)!.revision, roomHeatingBandAt(published.active, 2)!.revision);
  assertEquals(published.active.length, 1);
});

Deno.test("fixed negative and positive bands select one preferred revision at every quarter boundary", () => {
  const point = (band_c: number, revision: string) => ({ revision, band_c,
    observed_min_c: band_c + 1, observed_max_c: band_c + 2,
    training_from: "2025-01-01", training_to: "2025-01-02", model: reference });
  const old = point(-10, "old"), current = { ...old, revision: "qualified",
    learning_evidence: { run_calibration: { policy: "recent_independent_runs_v1", fitted_runs: 3 } } };
  const bands = canonicalHeatingBands([old, point(0,"zero"), current, point(-5,"minus-five")]);
  assertEquals(bands.map(b => b.revision), ["qualified","minus-five","zero"]);
  const forecasts = [-10,-9.999,-5.001,-5,-.001,0,4.999,5];
  assertEquals(forecasts.map(c => roomHeatingBandAt(bands,c)?.revision ?? null),
    ["qualified","qualified","qualified","minus-five","minus-five","zero","zero",null]);
  assertEquals(canonicalHeatingBands(bands), bands, "canonicalization is idempotent");
  assertEquals(canonicalHeatingBands([old, { ...old, revision: "same-date" }])[0].revision,"old", "equal preferences preserve received order");
});
