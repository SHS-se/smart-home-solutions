import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { readRoomResponseView, roomResponseLines } from './room-response-view.ts';
import { roomRunPoints } from './room-run-points.ts';
import type { MeasuredRoomCalibration, MeasuredRoomAssessment } from '../../../supabase/functions/_shared/planner/models/room/measured-evidence.ts';

// Independently generated synthetic responses and runs; no household measurements.
const model = { response_family: 'finite', gain_c_per_wh: .002, cooling_constant_per_h: .04, house_coupling_per_h: .03,
  background_gain_c_per_h: .1, thermal_capacity_wh_per_c: 500, heat_loss_w_per_c: 35, time_constant_h: 14,
  heating_rate_c_per_h: 1, r2: .9, sample_count: 400, residual_std_c: .05 };
const run = (id: string, outdoor: number, gain: number, residual: number | null, disposition = 'fitted') => ({
  id, from_ms: 0, to_ms: 3_600_000, measured_wh: 1500, transitions: 6, gain: gain / 1000, gain_se: .0003,
  change_at_ms: null, change_size: null, change_phase: null, disposition, outdoor_c: outdoor,
  cooldown: { hours: 2, c_per_h: .8, room_c: 20, outdoor_c: outdoor, house_c: 20, residual_c_per_h: residual },
});
const evidence = (revision: string, assessed: string | null, runs: unknown[]) => ({
  room: { trained: true, rejection_reason: null, last_fit_attempt: null, shared_attempt: null },
  response: { revision, model, training_from: '2026-01-01T00:00:00Z', training_to: '2026-03-01T00:00:00Z', warnings: [],
    run_calibration: { fitted_runs: 3, maximum_runs: 24 } },
  ledgers: [{ scope_key: 'shared', created_at: '2026-03-01T00:00:00Z', evidence: { assessed_against: assessed, runs } }],
});

Deno.test('the published response draws a flat heating line and a falling cool-down line through comparable runs', () => {
  const view = readRoomResponseView(evidence('r1', 'r1', [run('a', -10, 2.1, .05), run('b', 0, 1.9, -.05), run('c', 8, 2, 0)]))!;
  assertEquals(view.assessed, 'shared');
  const lines = roomResponseLines(view)!;
  assertAlmostEquals(lines.heater.cPerKwh, 2, 1e-12);
  // L(T) = k(20 − T) + h(20 − 20) − b: falling with warmer weather, zero at the balance point.
  assertAlmostEquals(lines.cooling.at(-10), .04 * 30 - .1, 1e-12);
  assert(lines.cooling.at(10) < lines.cooling.at(-10));
  assertAlmostEquals(lines.cooling.balanceC!, 20 - .1 / .04, 1e-9);
  assertAlmostEquals(lines.cooling.at(lines.cooling.balanceC!), 0, 1e-12);
  // A run's point is the line at its outdoor temperature plus its own residual.
  assertAlmostEquals(lines.cooling.pointY(view.points[0])!, lines.cooling.at(-10) + .05, 1e-12);
  assertAlmostEquals(lines.holdKw(-10)!, lines.cooling.at(-10) / 2, 1e-12);
  assertEquals(lines.holdKw(30), null, 'no holding power where the room stays warm unheated');
});

Deno.test('a ledger assessed against another revision is never paired with the published lines', () => {
  const view = readRoomResponseView(evidence('r2', 'r1', [run('a', -10, 2.1, .05)]))!;
  assertEquals(view.assessed, null);
  assertEquals(roomResponseLines(view), null);
});

Deno.test('rollout rooms show legacy band assessments without a line', () => {
  const data = { room: null, response: null, ledgers: [
    { scope_key: '-10', created_at: '2026-01-01T00:00:00Z', evidence: { runs: [run('a', -8, 2, null)] } },
    { scope_key: 'attempt', created_at: '2026-01-01T00:00:00Z', evidence: { runs: [run('z', 1, 2, null)] } },
  ] };
  const view = readRoomResponseView(data)!;
  assertEquals(view.assessed, 'legacy');
  assertEquals(view.points.map(p => p.id), ['a']);
  assertEquals(roomResponseLines(view), null);
});

Deno.test('an algebraic response has no dynamic cool-down line', () => {
  const data = evidence('r1', 'r1', [run('a', -10, 2.1, null)]);
  data.response.model = { response_family: 'equilibrium', heater_c_per_w: .004, outdoor_share: .2, offset_c: 1,
    solar_c_per_wm2: null, r2: .8, sample_count: 400, residual_std_c: .1 } as unknown as typeof model;
  assertEquals(roomResponseLines(readRoomResponseView(data)!), null);
});

Deno.test('ledger runs merge across scopes, prefer their own band and tolerate older entries', () => {
  const base = { from_ms: 0, to_ms: 3_600_000, measured_wh: 1500, transitions: 6, gain: 0.002, gain_se: 0.0003,
    change_at_ms: null, change_size: null, change_phase: null, disposition: 'fitted' };
  const { points, skipped } = roomRunPoints([
    { scope_key: 'general', created_at: '2026-01-01T00:00:00Z', evidence: { runs: [{ ...base, id: 'a', outdoor_c: -7 }] } },
    { scope_key: '-10', created_at: '2026-01-01T00:00:00Z', evidence: { runs: [{ ...base, id: 'a', gain: 0.0021, outdoor_c: -7 }] } },
    { scope_key: '-5', created_at: '2026-01-01T00:00:00Z', evidence: { runs: [{ ...base, id: 'a', gain: 0.0019, outdoor_c: -7 },
      { ...base, id: 'b' }, { id: 'broken' }] } },
    { scope_key: '0', created_at: '2026-01-01T00:00:00Z', evidence: null },
  ]);
  assertEquals(points.map(p => p.id), ['a', 'b']);
  assertEquals(points[0].scope, '-10');
  assertAlmostEquals(points[0].gain!, 2.1, 1e-9);
  assertEquals(points[1].outdoorC, null);
  assertEquals(skipped, 2);
});

Deno.test('chronological support and per-run diagnostics are separate, including response-only observations', () => {
  const initial = evidence('current', 'current', []);
  const response = { ...initial.response, run_calibration: null,
    transition_calibration: { policy: 'shared_interval_transitions_v1', fitted_transitions: 10_001 } };
  const capture = (observed: number, runs: unknown[], revision = 'current') => ({
    ...initial, response, ledgers: [{ scope_key: 'shared', created_at: '2026-01-01T00:00:00Z', evidence: {
      assessed_against: revision, policy: 'shared_interval_transitions_v1', observed_runs: observed, runs,
    } }],
  });
  const empty = readRoomResponseView(capture(0, []))!;
  assertEquals(empty.response?.fittedTransitions, 10_001);
  assertEquals(empty.response?.fittedRuns, null);
  assertEquals(empty.observedRuns, 0);
  assertAlmostEquals(roomResponseLines(empty)!.cooling.at(0), .7, 1e-12);

  const runs = Array.from({ length: 50 }, (_, i) => run(String(i), i, 2, 0, 'assessed'));
  const firstPage = readRoomResponseView(capture(94, runs))!;
  assertEquals(firstPage.observedRuns, 94);
  assertEquals(firstPage.points.length, 50);
  assertEquals(firstPage.points[0].disposition, 'assessed');
  assertAlmostEquals(roomResponseLines(firstPage)!.cooling.at(0), roomResponseLines(empty)!.cooling.at(0), 1e-12);
  const stale = readRoomResponseView(capture(94, runs, 'older'))!;
  assertEquals(stale.points, []);
  assertEquals(stale.observedRuns, null);
  assertEquals(stale.assessed, null);
  assertAlmostEquals(roomResponseLines(stale)!.heater.cPerKwh, 2, 1e-12);
});

// Synthetic measured-run contract: values chosen independently of any household.
const measuredCalibration: MeasuredRoomCalibration = {
  policy: 'measured_room_runs_v1', measurement_method: 'native_mean_onset_peak_v1',
  fitted_observations: 200, residual_degrees_of_freedom: 196,
  observed_runs: 135, heating_runs: 130, cooling_runs: 120, heating_flagged_runs: 6, cooling_flagged_runs: 4, unmeasured_runs: 5,
  reference: { room_c: 20, house_c: 20 },
  lines: {
    heating: { reference_outdoor_c: 0, intercept: .7, slope_per_c: .03, robust_scale: .05, points: 130, effective_points: 125, constraint: 'rises', units: 'c_per_kwh' },
    cooling: { reference_outdoor_c: 0, intercept: .4, slope_per_c: -.02, robust_scale: .02, points: 120, effective_points: 115, constraint: 'falls', units: 'c_per_h' },
    reference_heating: null, reference_cooling: null,
  },
  validation: { training_to: '2026-03-01T00:00:00Z', observations: 20, trajectory_mae_c: .12, trajectory_bias_c: -.01, projected_trajectory_mae_c: .2, projected_trajectory_bias_c: -.08 },
};
const measuredRun = (id: string): MeasuredRoomAssessment => ({
  id, from_ms: 0, on_ms: 900_000, off_ms: 4_500_000, to_ms: 7_200_000, energy_kwh: 1,
  heating: { on_ms: 900_000, peak_ms: 4_500_000, peak_end_ms: 5_400_000, energy_kwh: 1, hours: 1.25,
    rise_c: .7, c_per_kwh: .7, room_start_c: 19, room_peak_c: 19.7, room_mean_c: 19.35,
    outdoor_c: 0, house_c: null, native_seconds: [900] },
  cooling: { from_ms: 5_400_000, to_ms: 7_200_000, hours: .5, c_per_h: .4, room_c: 19.5,
    outdoor_c: 0, house_c: null, energy_kwh: 0 },
  reasons: ['missing_house'], reference_heating_c_per_kwh: null, reference_cooling_c_per_h: null,
  heating_residual: 0, cooling_residual: 0, heating_status: 'consistent', cooling_status: 'above_line',
});
const measuredCapture = (runs: unknown[], total = 135, revision = 'measured-v1') => ({
  ...evidence('measured-v1', revision, []),
  response: { ...evidence('measured-v1', revision, []).response, run_calibration: null, measured_runs: measuredCalibration },
  ledgers: [{ scope_key: 'shared', created_at: '2026-03-01T00:00:00Z', evidence: {
    policy: 'measured_room_runs_v1', assessed_against: revision, observed_runs: total, runs,
  } }],
});

Deno.test('measured evidence uses a revision-scoped 100-run page and preserves published all-history lines', () => {
  const page = Array.from({ length: 100 }, (_, i) => measuredRun(`synthetic-${i}`));
  const view = readRoomResponseView(measuredCapture(page))!;
  assertEquals(view.assessed, 'shared');
  assertEquals(view.observedRuns, 135);
  assertEquals(view.measuredPoints.length, 100);
  assertEquals(view.points, []);
  assertEquals(roomResponseLines(view), null, 'measured curves never use the legacy intrinsic heater line');
  assertEquals(view.response!.measuredRuns, measuredCalibration);
  assertEquals(view.response!.measuredRuns!.lines.heating!.points, 130, 'a page is not the fitting population');
  const otherPage = page.map(run => ({ ...run, heating: { ...run.heating!, c_per_kwh: 100 } }));
  assertEquals(readRoomResponseView(measuredCapture(otherPage))!.response!.measuredRuns!.lines, measuredCalibration.lines);
});

Deno.test('a single measured run is displayed with missing reference values and original missing-data reasons', () => {
  const view = readRoomResponseView(measuredCapture([measuredRun('only')], 1))!;
  assertEquals(view.measuredPoints.length, 1, 'no minimum closed-run display gate');
  assertEquals(view.measuredPoints[0].heating!.house_c, null);
  assertEquals(view.measuredPoints[0].reference_heating_c_per_kwh, null, 'missing reference values are not filled with zero');
  assertEquals(view.measuredPoints[0].reasons, ['missing_house']);
});

Deno.test('unmeasured runs preserve their identity and reasons instead of disappearing', () => {
  const run: MeasuredRoomAssessment = { ...measuredRun('unmeasured'), heating: null, cooling: null, heating_residual: null, cooling_residual: null,
    heating_status: null, cooling_status: null, reasons: ['missing_energy', 'missing_cooling'] };
  const view = readRoomResponseView(measuredCapture([run], 1))!;
  assertEquals(view.measuredPoints, [run]);
});

Deno.test('heating and cooling statuses are read independently and earlier run-level flags are dropped', () => {
  const view = readRoomResponseView(measuredCapture([measuredRun('separate')], 1))!;
  assertEquals([view.measuredPoints[0].heating_status, view.measuredPoints[0].cooling_status], ['consistent', 'above_line']);
  const { heating_status: _h, cooling_status: _c, ...legacy } = measuredRun('legacy');
  const earlier = readRoomResponseView(measuredCapture([{ ...legacy, heating_residual: -1.7, disposition: 'above_line',
    reasons: ['missing_house', 'descriptive_line_residual'] }], 1))!;
  assertEquals(earlier.measuredPoints[0].reasons, ['missing_house'], 'the note for the run-level flag goes with it');
  assertEquals(earlier.measuredPoints[0].heating_status, null, 'a run-level flag never stands in for one measure');
  assertEquals(earlier.measuredPoints[0].heating_residual, null, 'residuals against reference lines are not shown as distances from drawn lines');
  assert(!('disposition' in earlier.measuredPoints[0]));
  const mixed = readRoomResponseView(measuredCapture([{ ...measuredRun('mixed'), disposition: 'consistent' }], 1))!;
  assertEquals(mixed.measuredPoints, [], 'one ledger never mixes both shapes');
});

Deno.test('missing, stale, malformed and truncated measured pages never attach points to the accepted revision', () => {
  const runs = Array.from({ length: 100 }, (_, i) => measuredRun(`synthetic-${i}`));
  for (const capture of [measuredCapture(runs, 135, 'old'), measuredCapture(runs.slice(0, 50)),
    measuredCapture([runs[0], runs[0]], 2), measuredCapture([{ ...runs[0], heating: { ...runs[0].heating!, c_per_kwh: NaN } }], 1),
    { ...measuredCapture(runs), ledgers: [] }]) {
    const view = readRoomResponseView(capture)!;
    assertEquals(view.assessed, null);
    assertEquals(view.measuredPoints, []);
    assertEquals(view.observedRuns, null);
    assertEquals(view.response!.measuredRuns!.lines, measuredCalibration.lines, 'the published summary remains available');
  }
});

Deno.test('failed attempt evidence never replaces the accepted measured ledger', () => {
  const capture = measuredCapture([measuredRun('accepted')], 1);
  capture.ledgers.unshift({ ...capture.ledgers[0], scope_key: 'attempt', evidence: {
    ...capture.ledgers[0].evidence, runs: [measuredRun('failed-attempt')],
  } });
  assertEquals(readRoomResponseView(capture)!.measuredPoints.map(point => point.id), ['accepted']);
});
