import {assert, assertEquals, assertRejects} from '@std/assert';
import {describeRoomRuns, readRoomDiagnostics, RoomDiagnosticRevisionChanged} from './room-diagnostics.ts';
import {syntheticOperationRoom} from './device-learning/room/measured-calibration.fixture.ts';
import {compactCapture} from './device-model-learning/room-evidence.fixture.ts';
import {connectedRoomSnapshot} from './room-network.fixture.ts';
import {readRoomResponseView} from '../../../src/lib/energy-shift/room-response-view.ts';
import type {ThermalQuarterRow} from './thermal-training.ts';

// Independent synthetic physical observations; no recorded household history.
Deno.test('thirty-day descriptive diagnostics retain measurable runs, independent lines and missing-data reasons without fitting', () => {
  const rows = syntheticOperationRoom({count: 30 * 96, lagHours: .6}).rows;
  const original = structuredClone(rows), start = performance.now(), result = describeRoomRuns(rows);
  assert(result.calibration.heating_runs > 0); assert(result.calibration.cooling_runs > 0);
  assert(result.calibration.lines.heating); assert(result.calibration.lines.cooling);
  assertEquals(rows, original);
  assert(result.runs.every(r => r.reference_heating_c_per_kwh === null && r.reference_cooling_c_per_h === null));
  console.info('[SYNTHETIC ROOM DIAGNOSTICS]', JSON.stringify({rows: rows.length, runs: result.runs.length, elapsed_ms: performance.now() - start}));
  for (const gap of ['latest', 'middle', 'counter'] as const) {
    const damaged = structuredClone(rows);
    if (gap === 'latest') damaged.at(-1)!.heat_w = null;
    if (gap === 'middle') damaged[96 * 15 + 2].heat_w = null;
    if (gap === 'counter') for (const r of damaged) r.heat_w = null;
    const measured = describeRoomRuns(damaged);
    assertEquals(measured.calibration.observed_runs, measured.runs.length);
    if (gap === 'counter') assertEquals(measured.runs, []);
    else assert(measured.calibration.observed_runs > 0);
  }
});
Deno.test('authorized diagnostic reads preserve accepted passive models and reject a revision race before returning charts', async () => {
  const rows = syntheticOperationRoom({count: 96 * 3}).rows;
  const accepted = connectedRoomSnapshot().room_network!.nodes[0].model;
  accepted.thermal.heater = null;
  const from = new Date(rows[0].start_ms).toISOString(), to = new Date(rows.at(-1)!.start_ms + 900000).toISOString();
  const evidence = {room: {trained: true, rejection_reason: null, shared_attempt: {status: 'fitted', attempted_at: to}},
    response: {revision: 'synthetic-current', binding: 'synthetic-binding', model: null, connected_exchange: accepted,
      training_from: from, training_to: to}, ledgers: []};
  const before = JSON.stringify(evidence), calls: string[] = [];
  let read = 0, race = false, deny = false;
  const caller = {rpc: (name: string) => {calls.push(name); read++; return Promise.resolve({
    data: race && read % 2 === 0 ? {...evidence, response: {...evidence.response, revision: 'new'}} : evidence,
    error: deny ? {message: 'access denied'} : null});}};
  const raw: ThermalQuarterRow[] = rows.map(r => ({room_key: 'room', room_name: 'Synthetic room', start_ts: new Date(r.start_ms).toISOString(),
    duration_s: 900, room_temperature_c: r.room_c, outdoor_temperature_c: r.outdoor_c, house_temperature_c: r.house_c,
    heat_w: r.heat_w, cooling: false, active_power_w: 600}));
  const service = {from: () => ({select: () => ({eq: () => ({single: () => Promise.resolve({data: {customer_id: 'synthetic'}, error: null})})})}),
    rpc: (name: string) => {calls.push(name);
      if (name === 'get_energy_room_thermal_interval_capture') return Promise.resolve({data: compactCapture(raw), error: null});
      if (name === 'get_energy_room_operation_facts') return Promise.resolve({data: [], error: null});
      throw new Error('Unexpected diagnostic write or control: ' + name);
    }};
  const output = await readRoomDiagnostics(caller, service, 'synthetic-home', 'room');
  assertEquals(JSON.stringify(evidence), before);
  const view = readRoomResponseView(output)!;
  assert(view); assert(view.response?.connected); assertEquals(view.response!.model, null);
  assertEquals(view.assessed, 'descriptive'); assert(view.measuredPoints.length > 0);
  assert(view.diagnostics!.calibration.lines.heating);
  race = true; read = 0;
  await assertRejects(() => readRoomDiagnostics(caller, service, 'synthetic-home', 'room'), RoomDiagnosticRevisionChanged);
  calls.length = 0; deny = true;
  await assertRejects(() => readRoomDiagnostics(caller, service, 'synthetic-home', 'room'), Error, 'access denied');
  assertEquals(calls, ['get_energy_room_response_evidence']);
});
