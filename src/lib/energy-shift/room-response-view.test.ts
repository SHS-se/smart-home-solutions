import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { readRoomResponseView, roomResponseLines } from './room-response-view.ts';
import { roomRunPoints } from './room-run-points.ts';

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
