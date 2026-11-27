// Independently generated synthetic temperatures; no household replay data.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { connectedRoomSnapshot } from "./room-network.fixture.ts";
import { assembleConnectedRoomNodes, type ConnectedRoomFilterCapture } from "./room-network-capture.ts";
import { connectedRoomBoundary } from "./planner/models/room/connected-state.ts";
import type { RoomStateReading } from "./planner/models/room/state.ts";

const HOUR = 3_600_000, QUARTER = HOUR / 4;
function syntheticState(lateQuarters = 0, heater = false) {
  const snapshot = connectedRoomSnapshot(false, 4), origin = Date.parse(snapshot.captured_at);
  const elapsed = 6 * HOUR + HOUR / 12, now = origin + elapsed;
  snapshot.captured_at = new Date(now).toISOString();
  snapshot.slots = snapshot.slots.map((slot, i) => ({ ...slot, start: new Date(now + i * QUARTER).toISOString() }));
  snapshot.outdoor_temperature_c = snapshot.slots.map(() => 2);
  const roomKeys = ["synthetic-a", "synthetic-b"];
  const mean = (from: number, hours: number) => 2 + 19 * (Math.exp(-.03 * from) - Math.exp(-.03 * (from + hours))) / (.03 * hours);
  const captures: ConnectedRoomFilterCapture[] = snapshot.room_network!.nodes.map((node, i) => {
    const model = structuredClone(node.model);
    model.incoming = [{ kind: "constant", from: roomKeys[1 - i], per_h: 4 }];
    model.reference_state = { through_ms: origin, temperature_c: 21, stored_heat_c: 0,
      observations: 100, log_rates: [], covariance: [[0, 0], [0, 0]] };
    model.thermal.heater = heater && i === 0 ? { gain_c_per_wh: .001, lag_h: 1, gain_reference_outdoor_c: 2, gain_outdoor_slope_per_c: 0 } : null;
    model.process_belief = { revision: "connected_process_regimes_v2", initial_incoming: model.incoming,
      initial_hazard: { shape: .5, rate_h: .25 }, reset_priors: [], replicas: [{ rng_state: 1, particles: 1, log_evidence: 0 }],
      hypotheses: [{ replica: 0, multiplicity: 1, log_weight: 0, incoming: model.incoming,
        posterior: model.reference_state, thermal_state_identified: false, hazards: [{ shape: 1, rate_h: 1 }] }] };
    const rows = Array.from({ length: 24 - lateQuarters }, (_, q) => ({
      start_ms: origin + q * QUARTER, duration_s: 900 as const, room_c: mean(q / 4, .25),
      outdoor_c: 2, solar_w_per_m2: 0, heat_w: heater && i === 0 ? 500 : 0, cooling: false,
      peer_c: { [roomKeys[1 - i]]: mean(q / 4, .25) },
    }));
    return { room: { key: roomKeys[i], name: roomKeys[i], device_keys: [], model: null, connected_exchange: model,
      rated_power_w: 0, maximum_power_w_by_slot: [] }, model, rows,
      filtered: { posterior: structuredClone(model.reference_state), diagnostics: { thermal_state_identified: false,
        observed_intervals: 0, unavailable_intervals: 0, reinitializations: 0, numerical_failures: 0,
        negative_log_likelihood: 0, squared_error_c2: 0 } } };
  });
  const observations = new Map<string, RoomStateReading>(captures.map(c => {
    const row = c.rows.at(-1)!;
    return [c.room.key, { start_ms: row.start_ms, end_ms: row.start_ms + QUARTER, mean_c: row.room_c! }];
  }));
  const boundaries = captures.map(c => ({ key: c.room.key, model: c.model }));
  const run = () => assembleConnectedRoomNodes(snapshot, captures, observations, boundaries);
  return { snapshot, captures, observations, boundaries, origin, now, run, truth: 2 + 19 * Math.exp(-.03 * elapsed / HOUR) };
}

Deno.test("late strongly coupled indoor rooms cool gradually and ignore future outdoor lows", () => {
  for (const late of [0, 1, 2]) {
    const f = syntheticState(late), original = structuredClone(f.captures), result = f.run();
    assertEquals(result.nodes.length, 2);
    for (const node of result.nodes) assertAlmostEquals(node.start_temperature_c, f.truth, .12,
      "ordinary reporting delay must not turn internal exchange into outdoor exposure");
    assert(result.warnings.some(w => w.code === "room_state_boundary_late"));
    f.snapshot.outdoor_temperature_c = f.snapshot.outdoor_temperature_c!.map((v, i) => i ? -35 : v);
    assertEquals(f.run(), result, "future weather cannot change captured state");
    assertEquals(f.captures, original, "estimates never modify measured history or learned responses");
  }
});

Deno.test("bounded starting state is identical in staged and complete assembly", () => {
  const f = syntheticState(1), full = f.run();
  const staged = f.captures.flatMap(c => assembleConnectedRoomNodes(f.snapshot, [c], f.observations, f.boundaries).nodes);
  assertEquals(staged, full.nodes);
  const unrelated = structuredClone(f.boundaries[0]); unrelated.key = "synthetic-unconnected";
  unrelated.model.incoming = []; unrelated.model.reference_state.temperature_c = -25;
  const observations = new Map(f.observations).set(unrelated.key, { start_ms: f.now - QUARTER, end_ms: f.now, mean_c: -25 });
  assertEquals(assembleConnectedRoomNodes(f.snapshot, f.captures, observations, [...f.boundaries, unrelated]).nodes, full.nodes);
});

Deno.test("an already captured same-interval neighbour mean fills a missing peer field", () => {
  const complete = syntheticState(), missing = syntheticState();
  missing.captures[0].rows.at(-1)!.peer_c!["synthetic-b"] = null;
  assertAlmostEquals(missing.run().nodes[0].start_temperature_c, complete.run().nodes[0].start_temperature_c, 1e-12);
});

Deno.test("an unobserved exact-zero exchange source cannot cool another indoor boundary", () => {
  const f = syntheticState(1), before = f.run();
  f.captures[0].model.incoming.push({ kind: "constant", from: "synthetic-zero-source", per_h: 0 });
  assertEquals(f.run(), before);
});

Deno.test("cold measured neighbours still cool a receiver and returning data repairs estimates", () => {
  const warm = syntheticState(1), cold = syntheticState(1);
  cold.captures[1].rows.forEach(row => { row.room_c = row.room_c! - 8; });
  cold.captures[0].rows.forEach(row => { row.peer_c!["synthetic-b"] = row.peer_c!["synthetic-b"]! - 8; });
  cold.observations.get("synthetic-b")!.mean_c -= 8;
  assert(cold.run().nodes[0].start_temperature_c < warm.run().nodes[0].start_temperature_c - .5);
  const complete = syntheticState(), before = structuredClone(warm.captures[0].model);
  warm.captures.forEach((c, i) => { c.rows = structuredClone(complete.captures[i].rows); });
  warm.observations.clear(); for (const [key, reading] of complete.observations) warm.observations.set(key, reading);
  assertEquals(warm.run(), complete.run());
  assertEquals(warm.captures[0].model, before, "repair does not relearn the model");
});

Deno.test("middle peer holes and unavailable counters retain service, provenance and measured stored heat", () => {
  const f = syntheticState(1, true), known = f.run();
  const receiver = f.captures[0];
  receiver.rows = receiver.rows.filter((_row, i) => i !== 12);
  receiver.rows.at(-1)!.peer_c!["synthetic-b"] = null;
  receiver.rows.at(-1)!.heat_w = null;
  // Make the latest mean old enough for an actual missing-history warning.
  f.snapshot.captured_at = new Date(f.now + HOUR).toISOString();
  const result = f.run();
  assertEquals(result.nodes.length, 2);
  assert(result.warnings.some(w => w.code === "room_state_boundary_estimate"));
  assert(result.nodes[0].start_stored_heat_c > 0, "known earlier energy survives a missing counter");
  assert(result.nodes[0].start_stored_heat_c < known.nodes[0].start_stored_heat_c, "unknown heat receives no credit");
});

Deno.test("hourly peer means stay native intervals and future observations do not fill old holes", () => {
  const f = syntheticState(1), c = f.captures[0];
  const observations = new Map<string, RoomStateReading>([["synthetic-b", {
    start_ms: f.origin + 4 * HOUR, end_ms: f.origin + 5 * HOUR, mean_c: 18,
  }]]);
  const boundary = connectedRoomBoundary(c.room.key, f.boundaries, observations, [], 2, [4]);
  const span = { start_ms: f.origin + 5 * HOUR, end_ms: f.origin + 5 * HOUR + QUARTER };
  assert(boundary(span) < 18, "an hourly mean is conditioned and cooled, never held as an endpoint");
  assert(boundary(span) > 17, "missing same-hour upstream forcing remains indoor, not outdoor air");
  observations.set("synthetic-b", { start_ms: f.now, end_ms: f.now + QUARTER, mean_c: 35 });
  const later = connectedRoomBoundary(c.room.key, f.boundaries, observations, [], 2, [4]);
  const without = connectedRoomBoundary(c.room.key, f.boundaries, new Map(), [], 2, [4]);
  assertEquals(later(span), without(span), "a later observation cannot become earlier forcing");
});

Deno.test("warm hourly neighbours can use complete quarter means without a cold anchor artefact", () => {
  const f = syntheticState(), c = f.captures[0], end = f.origin + HOUR;
  const observations = new Map<string, RoomStateReading>([["synthetic-b", { start_ms: f.origin, end_ms: end, mean_c: 20 }]]);
  const quarters = Array.from({ length: 4 }, (_, i) => ({ ...c.rows[0], start_ms: f.origin + i * QUARTER,
    room_c: 20, peer_c: {}, duration_s: 900 as const }));
  const boundary = connectedRoomBoundary(c.room.key, f.boundaries, observations, quarters, 2, [4]);
  assert(boundary({ start_ms: end, end_ms: end + HOUR / 12 }) > 19,
    "strong exchange must not turn a warm hourly observation into an outdoor anchor");
});

Deno.test("long missing neighbour histories keep finite room state without a gap-length rejection", () => {
  const f = syntheticState(2);
  f.snapshot.captured_at = new Date(f.now + 10 * 24 * HOUR).toISOString();
  const result = f.run();
  assertEquals(result.nodes.length, 2);
  assert(result.nodes.every(n => Number.isFinite(n.start_temperature_c) && n.start_temperature_c < f.truth));
  assert(result.warnings.some(w => w.code === "room_state_boundary_estimate"));
});
