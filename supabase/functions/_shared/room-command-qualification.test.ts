import {assert, assertAlmostEquals, assertEquals} from '@std/assert';
import {nativePlanner} from './planner-wasm/runtime.ts';
import {syntheticJointRoomForecast} from './room-network-forecast.fixture.ts';
import type {NativeRoomNetworkAdvanceInput} from './room-network-contract.ts';

// Independently synthetic single-room plants. No household captures.
function intervalRoom(lag = 0, slots = 1): NativeRoomNetworkAdvanceInput {
  const input = syntheticJointRoomForecast(2, 0, slots / 4);
  const n = input.network;
  n.nodes = n.nodes.slice(0, 1); n.rooms = n.rooms.slice(0, 1); n.stage = 0;
  Object.assign(n.nodes[0], {start_c: 20, start_stored_heat_c: 0, outdoor_per_h: 0,
    lag_h: lag, gain_c_per_wh: Array(slots).fill(.002), forcing_c_per_h: Array(slots).fill(0), incoming: []});
  Object.assign(n.rooms[0].input, {start_c: 20, start_stored_heat_c: 0, thermostats: [],
    interval_heaters: [{kind: 'fixed', on_w: 2000}]});
  for (const q of n.rooms[0].input.quarters) Object.assign(q, {required_c: 21, maximum_c: 21.5,
    relay_w: [2000], fixed_relays: [null], fixed_targets_c: [],
    room_target: {preferred_c: 19, fixed_c: null, fixed_switches: []}});
  const h = input.beliefs[0].hypotheses[0];
  h.incoming = []; h.posterior.log_rates = []; h.posterior.covariance = [[0, 0], [0, 0]];
  h.posterior.temperature_c = 20; input.beliefs = [input.beliefs[0]];
  input.target_trajectories = 64; input.max_minute_steps = 100000;
  delete n.accepted;
  const p = nativePlanner(); n.literal = p.roomNetworkLiteral(n); n.accepted = p.roomNetwork(n).plans;
  return input;
}
function complete(input: NativeRoomNetworkAdvanceInput) {
  const p = nativePlanner();
  let x = p.roomNetworkAdvance(input);
  while (!x.reached_target) x = p.roomNetworkAdvance({...input, work: x.work});
  return {work: x.work, plan: p.roomNetworkFinalize({network: input.network, work: x.work})};
}
Deno.test('interval commands cannot add overheating on a warm possible start, with immediate or delayed heat', () => {
  for (const lag of [0, .05]) {
    const input = intervalRoom(lag), h = input.beliefs[0].hypotheses[0];
    h.log_weight = Math.log(.5);
    const hot = structuredClone(h); hot.posterior.temperature_c = 22;
    input.beliefs[0].hypotheses.push(hot);
    assertEquals(input.network.accepted![0].relays_on, [[true]]);
    const {work, plan} = complete(input);
    assert(work.statistics.infeasible[0] > 0);
    assertEquals(plan.plans[0].relays_on, [[false]]);
    assertAlmostEquals(plan.temperature_c[0][0], 21, 1e-9);
  }
});
Deno.test('optional heat from an earlier quarter is still avoidable when its delayed release overheats later', () => {
  const input = intervalRoom(1, 2), n = input.network;
  n.rooms[0].input.quarters[0].maximum_c = 100;
  Object.assign(n.rooms[0].input.quarters[1], {maximum_c: 20.05, fixed_relays: [false]});
  n.accepted = nativePlanner().roomNetwork(n).plans;
  assertEquals(n.accepted[0].relays_on, [[true], [false]]);
  const {work, plan} = complete(input);
  assert(work.statistics.infeasible[0] > 0);
  assertEquals(plan.plans[0].relays_on, [[false], [false]]);
});
Deno.test('mandatory heating, initial stored warmth and warm uncertainty remain available above the comfort maximum', () => {
  const input = intervalRoom(.5), n = input.network;
  n.nodes[0].start_stored_heat_c = 2;
  n.rooms[0].input.start_stored_heat_c = 2;
  n.rooms[0].input.quarters[0].maximum_c = 19;
  n.rooms[0].input.quarters[0].fixed_relays = [true];
  n.literal = nativePlanner().roomNetworkLiteral(n); n.accepted = nativePlanner().roomNetwork(n).plans;
  const {work, plan} = complete(input);
  assertEquals(work.statistics.infeasible, [0, 0, 0]);
  assertEquals(plan.plans[0].relays_on, [[true]]);
  assert(plan.temperature_c[0][0] > 20);
});
Deno.test('outside heat loss agrees with an independent exponential in proposals, literal and joint replay', () => {
  const input = intervalRoom(0, 4), n = input.network, k = .12, outside = -5;
  n.nodes[0].outdoor_per_h = k; n.nodes[0].forcing_c_per_h.fill(k * outside);
  for (const q of n.rooms[0].input.quarters) q.fixed_relays = [false];
  n.literal = nativePlanner().roomNetworkLiteral(n);
  const proposal = nativePlanner().roomNetwork(n); n.accepted = proposal.plans;
  const {plan} = complete(input);
  for (let i = 0; i < 4; i++) {
    const expected = outside + (20 - outside) * Math.exp(-k * (i + 1) / 4);
    for (const value of [proposal.temperature_c[0][i], plan.temperature_c[0][i], plan.literal[0].temperature_c[i]])
      assertAlmostEquals(value, expected, 1e-9);
  }
});
