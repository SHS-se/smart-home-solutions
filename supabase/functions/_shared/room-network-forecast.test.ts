import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { createHash } from "node:crypto";
import { nativePlanner } from "./planner-wasm/runtime.ts";
import { syntheticJointRoomForecast } from "./room-network-forecast.fixture.ts";
import type { NativeRoomNetworkAdvanceInput } from "./room-network-contract.ts";
function packStatistics(values: number[]) {
  const bytes = new Uint8Array(values.length * 8), view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return btoa(String.fromCharCode(...bytes));
}
function drain(input: NativeRoomNetworkAdvanceInput) {
  const planner = nativePlanner();
  let next = input;
  for (;;) {
    const advanced = planner.roomNetworkAdvance(next);
    if (advanced.reached_target) return advanced.work;
    next = { ...input, work: JSON.parse(JSON.stringify(advanced.work)) };
  }
}
Deno.test("fixed peer power charges and releases the learned heat store in proposals and joint forecasts", () => {
  const input = syntheticJointRoomForecast(2, 0, 1), { network } = input;
  network.rooms.pop();
  network.accepted!.pop();
  network.stage = 0;
  // An isolated receiving equation gives an independent closed-form reference.
  // Its outgoing edge still transmits the delayed temperature rise to room 0.
  const node = network.nodes[1];
  node.start_c = 20;
  node.start_stored_heat_c = .2;
  node.lag_h = .5;
  node.outdoor_per_h = 0;
  node.forcing_c_per_h.fill(0);
  node.incoming = [];
  input.beliefs[1].hypotheses = [];
  node.gain_c_per_wh = [.001, .002, .002, .001];
  const watts = [400, 400, 0, 0];
  network.fixed_heaters = [{node: 1, watts}];
  network.nodes[0].incoming[0].rates = network.hours.map(h => Array(Math.ceil(h * 60)).fill(.2));
  for (const [i, quarter] of network.rooms[0].input.quarters.entries()) {
    quarter.fixed_targets_c = [5];
    quarter.room_target = { ...quarter.room_target!, fixed_c: 5, preferred_c: 5 };
    network.accepted![0].targets_c[i] = [5];
  }
  let temperature = node.start_c, stored = node.start_stored_heat_c;
  const expected = network.hours.map((hours, i) => {
    const gain = node.gain_c_per_wh[i] * watts[i], carry = Math.exp(-hours / node.lag_h);
    const next = stored * carry + gain * node.lag_h * (1 - carry);
    temperature += gain * hours + stored - next;
    stored = next;
    return temperature;
  });
  const planner = nativePlanner();
  const proposal = planner.roomNetwork(network);
  const final = planner.roomNetworkFinalize({network, work: drain(input)});
  for (const projected of [proposal, final]) {
    projected.temperature_c[1].forEach((t, i) => assertAlmostEquals(t, expected[i], 1e-10));
    assertEquals(projected.plans[0].power_w, [0, 0, 0, 0]);
  }
  network.fixed_heaters = [];
  const unheated = planner.roomNetworkFinalize({network, work: drain(input)});
  for (let i = 0; i < network.hours.length; i++) {
    assertEquals(final.literal[0].temperature_c[i], final.plans[0].temperature_c[i]);
    assertEquals(final.temperature_c[0][i] > unheated.temperature_c[0][i], true);
  }
});
Deno.test("joint trajectories are invariant to minute continuation boundaries", () => {
  const input = syntheticJointRoomForecast(2, .65, 2, .02);
  input.target_trajectories = 8;
  const a = drain({ ...input, max_minute_steps: 100000 }),
    b = drain({ ...input, max_minute_steps: 17 });
  assertEquals(a.statistics, b.statistics);
  assertEquals(a.cursor, b.cursor);
  assertEquals(
    nativePlanner().roomNetworkFinalize({ network: input.network, work: a }),
    nativePlanner().roomNetworkFinalize({ network: input.network, work: b }),
  );
});

Deno.test("hot-room counterfactuals preserve each checkpoint, physical outcome and feasibility decision", () => {
  // Computed with the original unconditional minute-by-minute counterfactual
  // replay at bb137df. Each digest includes every physical continuation and
  // final command output, including packed Float64 totals and replica statistics.
  // Policy assessment is tested separately: partial recovery now permits cost.
  const equal = [
    "9ee0512f721c03510eb4034f429901534d925b150cf177daf9821a1251299a3b",
    "16f1fbad049851cc51499eb60baa0c76e9d8596bb0eb25175f6602aeef616542",
  ];
  const rejected = [
    "bd3133833da11e1ffcadda3b3b02ac2b239a98b0e9dd1b87c5ddad9eaebafddb",
    "23dd8ea1959d633677e48a85fa7aa8e34d6eee6daddd4a7e26d28add704c563c",
  ];
  for (const cause of ["equal", "overheat", "headroom"] as const) {
    const input = syntheticJointRoomForecast(2, .25, .5, .01);
    input.target_trajectories = 8;
    for (const [r, room] of input.network.rooms.entries()) {
      for (const [q, quarter] of room.input.quarters.entries()) {
        quarter.transition = { ...quarter.transition, carry: 0 };
        quarter.maximum_c = cause === "headroom" && q === 0 ? 100 : 15;
        quarter.fixed_targets_c = [null];
        quarter.room_target = { ...quarter.room_target!, fixed_c: null, preferred_c: 5 };
        input.network.accepted![r].targets_c[q] = [cause !== "equal" && r === 0 ? 35 : 5];
      }
    }
    if (cause === "headroom") input.network.headroom_w[0] = 100;
    const planner = nativePlanner();
    for (const [run, budget] of [100000, 7].entries()) {
      const trace = createHash("sha256");
      let work: NativeRoomNetworkAdvanceInput["work"];
      for (;;) {
        const advanced = planner.roomNetworkAdvance({ ...input, work, max_minute_steps: budget });
        trace.update(JSON.stringify({...advanced, assessment: undefined}));
        work = advanced.work;
        if (advanced.reached_target) break;
        work = JSON.parse(JSON.stringify(work));
      }
      const output = planner.roomNetworkFinalize({ network: input.network, work });
      trace.update(JSON.stringify(output));
      assertEquals(work.statistics.infeasible, [cause === "equal" ? 0 : 8, 0, 0]);
      assertEquals(output.plans[0].targets_c, [[5], [5]]);
      assertEquals(trace.digest("hex"), (cause === "equal" ? equal : rejected)[run]);
    }
  }
});

Deno.test("opaque checkpoint Float64 bytes equal completed numeric statistics across JSON transport", () => {
  const input = syntheticJointRoomForecast(2, .2, .5, .01);
  input.target_trajectories = 8;
  const partial = nativePlanner().roomNetworkAdvance({
    ...input,
    max_minute_steps: 1,
  });
  assertEquals(partial.statistics, null);
  const resumed = nativePlanner().roomNetworkAdvance({
    ...input,
    max_minute_steps: 100000,
    work: JSON.parse(JSON.stringify(partial.work)),
  });
  assertEquals(resumed.reached_target, true);
  const bytes = Uint8Array.from(
    atob(resumed.work.statistics.total),
    (c) => c.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer);
  const decoded = Array.from(
    { length: bytes.length / 8 },
    (_, i) => view.getFloat64(i * 8, true),
  );
  assertEquals(decoded, resumed.statistics!.total);
  assertEquals(
    resumed.work.statistics,
    drain({ ...input, max_minute_steps: 100000 }).statistics,
  );
});
Deno.test("zero uncertainty uses one exact path and never samples known heater inventory", () => {
  const input = syntheticJointRoomForecast(2, 0, 4);
  input.network.nodes[0].start_stored_heat_c = 2;
  input.beliefs[0].hypotheses[0].posterior.covariance[1][1] = 25;
  const a = drain(input);
  assertEquals(a.deterministic, true);
  assertEquals(a.statistics.trajectories, 1);
  input.beliefs[0].hypotheses[0].posterior.covariance[1][1] = 0;
  assertEquals(a.statistics, drain(input).statistics);
});
Deno.test("identified process hypotheses preserve different thermal posterior centers", () => {
  const input = syntheticJointRoomForecast(2, 0, .25);
  input.target_trajectories = 2;
  for (let i = 0; i < 2; i++) {
    const node = input.network.nodes[i];
    node.outdoor_per_h = 0;
    node.forcing_c_per_h = [0];
    node.gain_c_per_wh = [0];
    node.incoming = [];
    const base = input.beliefs[i].hypotheses[0];
    base.incoming = [];
    base.posterior.log_rates = [];
    base.posterior.covariance = [[0, 0], [0, 0]];
    base.posterior.temperature_c = 19;
    const other = structuredClone(base);
    other.posterior.temperature_c = 25;
    input.beliefs[i].hypotheses = [base, other];
  }
  const work = drain(input),
    result = nativePlanner().roomNetworkFinalize({
      network: input.network,
      work,
    });
  assertEquals(work.deterministic, false);
  assertAlmostEquals(result.temperature_c[0][0], 22, 1e-12);
  assertAlmostEquals(result.temperature_c[1][0], 22, 1e-12);
});
Deno.test("bounded initial thermal state ignores stale posterior temperature and cross-covariance", () => {
  const input = syntheticJointRoomForecast(2, 0, 1);
  input.target_trajectories = 8;
  for (const belief of input.beliefs) {
    belief.bounded_thermal = true;
    const posterior = belief.hypotheses[0].posterior;
    posterior.temperature_c = 100;
    posterior.covariance = [[25, 0, .1], [0, 16, 0], [.1, 0, .02]];
  }
  const a = drain(input);
  for (const belief of input.beliefs) {
    const p = belief.hypotheses[0].posterior;
    p.temperature_c = -100;
    p.covariance[0][0] = 1;
    p.covariance[0][2] = p.covariance[2][0] = 0;
  }
  assertEquals(a.statistics, drain(input).statistics);
});

Deno.test("bounded-only thermal uncertainty retains the one-path exact calculation", () => {
  const input = syntheticJointRoomForecast(2, 0, 1);
  for (const belief of input.beliefs) {
    belief.bounded_thermal = true;
    belief.hypotheses[0].posterior.covariance[0][0] = 4;
  }
  const work = drain(input);
  assertEquals(work.deterministic, true);
  assertEquals(work.statistics.trajectories, 1);
});
Deno.test("native joint posterior rejects a materially asymmetric covariance", () => {
  const input = syntheticJointRoomForecast(2, .65, 1);
  const p = input.beliefs[0].hypotheses[0].posterior;
  p.covariance = [[1, 0, .1], [0, 0, 0], [0, 0, 1]];
  assertThrows(
    () => nativePlanner().roomNetworkAdvance(input),
    Error,
    "not symmetric",
  );
});

Deno.test("a known static OU center has the same law as the fixed-center descriptor", () => {
  const input = syntheticJointRoomForecast(2, .15, 1);
  input.target_trajectories = 8;
  for (const node of input.beliefs) {
    const hypothesis = node.hypotheses[0];
    hypothesis.posterior.log_centers = [Math.log(.5)];
    hypothesis.posterior.covariance = Array.from(
      { length: 4 },
      () => Array(4).fill(0),
    );
  }
  const expected = structuredClone(input);
  for (const node of expected.beliefs) {
    const hypothesis = node.hypotheses[0];
    delete hypothesis.posterior.log_centers;
    hypothesis.posterior.covariance = Array.from(
      { length: 3 },
      () => Array(3).fill(0),
    );
    const edge = hypothesis.incoming[0];
    if (edge.kind === "log_ou") edge.mean_log_per_h = Math.log(.5);
  }
  assertEquals(drain(input).statistics, drain(expected).statistics);
});

Deno.test("static-center sampling preserves joint temperature/rate/center covariance without sampling Q", () => {
  const input = syntheticJointRoomForecast(2, .15, 1);
  input.max_minute_steps = 1;
  const posterior = input.beliefs[0].hypotheses[0].posterior;
  posterior.log_centers = [Math.log(.2)];
  const direction = [.2, 0, .3, -.4];
  posterior.covariance = direction.map((a) => direction.map((b) => a * b));
  posterior.covariance[1][1] = 25;
  input.network.nodes[0].start_stored_heat_c = 2;
  const work = nativePlanner().roomNetworkAdvance(input).work;
  const path = work.path as {
    processes: Array<Array<{ value: { center: number } }>>;
    starts: Array<{ temperatures: number[]; heat: number[] }>;
  };
  const standardized =
    (path.starts[0].temperatures[0] - posterior.temperature_c) / .2;
  assertAlmostEquals(
    path.processes[0][0].value.center,
    posterior.log_centers[0] - .4 * standardized,
    1e-12,
  );
  assertEquals(path.starts[0].heat[0], 2);
});

function resetFixture(rateHours: number, hours: number) {
  const input = syntheticJointRoomForecast(2, 0, hours);
  for (const node of input.network.nodes) {
    node.outdoor_per_h = 0;
    node.forcing_c_per_h.fill(0);
    node.gain_c_per_wh.fill(0);
  }
  for (const belief of input.beliefs) {
    const h = belief.hypotheses[0];
    h.incoming = [{ kind: "constant", from: h.incoming[0].from, per_h: 0 }];
    h.posterior.log_rates = [];
    h.posterior.covariance = [[0, 0], [0, 0]];
  }
  input.beliefs[0].reset_priors = [{
    from: 1,
    center_mean: Math.log(.8),
    center_variance: 0,
    log_reversion_mean: 0,
    log_reversion_sd: 0,
    stationary_variance_scale: 0,
    constant_probability: 1,
  }];
  input.beliefs[0].hypotheses[0].hazards = [{ shape: 1, rate_h: rateHours }];
  return input;
}

Deno.test("rare reset branches contribute their probability even when ordinary draws would miss every event", () => {
  const input = resetFixture(454, 1);
  input.target_trajectories = 256;
  input.max_minute_steps = 100000;
  const work = drain(input);
  assertEquals(work.statistics.replayed_paths, 512);
  assertEquals(work.statistics.trajectories, 256);
  const output = nativePlanner().roomNetworkFinalize({
    network: input.network,
    work,
  });
  // Independent first-event integral: Gamma(1,b) survival is b/(b+t),
  // and the receiver warms by5(1-exp(-.8*(1-t))) after activation.
  let expected = 0;
  const intervals = 10000;
  for (let i = 0; i < intervals; i++) {
    const t = (i + .5) / intervals;
    expected += 5 * (1 - Math.exp(-.8 * (1 - t))) * 454 / (454 + t) ** 2 /
      intervals;
  }
  const warming = output.temperature_c[0].at(-1)! - 19;
  assertAlmostEquals(warming, expected, .00025);
  assertEquals(warming > .0005, true);
});

Deno.test("conditional reset branches resume inside event work without changing weighted forecasts", () => {
  const input = resetFixture(.02, .25);
  input.target_trajectories = 4;
  const whole = drain({ ...input, max_minute_steps: 100000 });
  const divided = drain({ ...input, max_minute_steps: 3 });
  assertEquals(whole.statistics, divided.statistics);
  assertEquals(whole.cursor, divided.cursor);
  assertEquals(whole.statistics.replayed_paths, 8);
  assertEquals(whole.cursor > 8 * 15, true);
});

Deno.test("native rejection certificate follows unconditional horizon comfort loss rather than cost alone", () => {
  const input = syntheticJointRoomForecast(2, 0, 1);
  input.target_trajectories = 16;
  input.max_minute_steps = 100000;
  // Duplicate exact components keep the estimator branch active with zero
  // numerical variance, so the certificate can be checked without tolerances.
  for (const node of input.beliefs) {
    node.hypotheses.push(structuredClone(node.hypotheses[0]));
  }
  input.network.accepted![0].targets_c = input.network.accepted![0].targets_c
    .map(() => [16]);
  const rejected = nativePlanner().roomNetworkAdvance(input);
  assertEquals(rejected.assessment.proposal_rejection?.room, 0);
  assertEquals(
    nativePlanner().roomNetworkFinalize({
      network: input.network,
      work: rejected.work,
    }).plans[0].targets_c[0],
    [21],
  );
  input.network.accepted![0].targets_c = input.network.accepted![0].targets_c
    .map(() => [22]);
  const warmer = nativePlanner().roomNetworkAdvance(input);
  assertEquals(warmer.assessment.proposal_rejection, null);
});

Deno.test("native cost certificate preserves satisfied quarters and resolves partial comfort improvement", () => {
  const input = syntheticJointRoomForecast(2, 0, 1);
  input.target_trajectories = 16;
  for (const node of input.beliefs) node.hypotheses.push(structuredClone(node.hypotheses[0]));
  const base = drain({ ...input, max_minute_steps: 100000 });
  const slots = 4, rooms = 2, nodes = 2, stride = 42;
  const assess = (newMiss: (replicate: number) => number) => {
    const work = structuredClone(base);
    const replicates = work.statistics.replicates.map((r,index)=>{
      const values = Array(stride * 3).fill(0);
      values[(rooms+2*nodes)*slots+1] = newMiss(index);
      values[stride+(rooms+2*nodes)*slots] = 1;
      values[stride+(rooms+2*nodes)*slots+2] = 2;
      for(let room=0;room<rooms;room++) values[stride-rooms+room] = 1;
      return values.map(v=>v*r.trajectories);
    });
    work.statistics.total = packStatistics(replicates[0].map((_,i)=>replicates.reduce((sum,r)=>sum+r[i],0)));
    work.statistics.replicates.forEach((r,i)=>r.total=packStatistics(replicates[i]));
    return nativePlanner().roomNetworkAdvance({ ...input, work }).assessment;
  };
  // Overall horizon comfort improves, but one new miss disallows higher cost.
  const rejected = assess(()=>2);
  assertEquals(rejected.proposal_rejection?.kind, "prefix_cost");
  assertEquals(rejected.deadline_resolved, true);
  // Higher cost is permitted by lower total comfort exposure.
  const improved = assess(()=>0);
  assertEquals(improved.proposal_rejection, null);
  assertEquals(improved.deadline_resolved, true);
  // Near the unchanged 1e-6 deadline threshold, more integration is required.
  const ambiguous = assess(r=>r===3?4e-6:0);
  assertEquals(ambiguous.proposal_rejection, null);
  assertEquals(ambiguous.deadline_resolved, false);
});

Deno.test("synthetic joint selection pays for partial comfort recovery with uncertainty in every quarter", () => {
  const input = syntheticJointRoomForecast(2, 0, 1);
  input.target_trajectories = 16;
  for (const belief of input.beliefs) belief.hypotheses.push(structuredClone(belief.hypotheses[0]));
  const base = drain({...input, max_minute_steps: 100000});
  const slots = 4, rooms = 2, nodes = 2, stride = 42;
  const compare = (improvement: number) => {
    const work = structuredClone(base);
    const replicates = work.statistics.replicates.map((replica, index) => {
      const values = Array(stride * 3).fill(0);
      for (let room = 0; room < rooms; room++) {
        for (let slot = 0; slot < slots; slot++) {
          const cell = (rooms + 2 * nodes + room) * slots + slot;
          // Every independent replica remains short in every quarter; its
          // paired exposure still records useful recovery without perfect heat.
          values[cell] = 2 + index / 10;
          values[stride + cell] = values[cell] + improvement;
        }
        values[stride - rooms + room] = 1;
      }
      return values.map(value => value * replica.trajectories);
    });
    work.statistics.total = packStatistics(replicates[0].map((_, i) => replicates.reduce((sum, row) => sum + row[i], 0)));
    work.statistics.replicates.forEach((replica, i) => replica.total = packStatistics(replicates[i]));
    return {assessment: nativePlanner().roomNetworkAdvance({...input, work}).assessment,
      output: nativePlanner().roomNetworkFinalize({network: input.network, work})};
  };
  const useful = compare(1);
  assertEquals(useful.assessment.proposal_rejection, null);
  assertEquals(useful.assessment.deadline_resolved, true);
  assertEquals(useful.output.plans[0].targets_c, input.network.accepted![0].targets_c);
  assertEquals(compare(0).assessment.proposal_rejection?.kind, "prefix_cost");
  assertEquals(compare(0).output.plans[0].targets_c, [[21], [21], [21], [21]]);
  assertEquals(compare(-1).assessment.proposal_rejection?.kind, "horizon_shortfall");
});

Deno.test("common shortfall during a held first hour cannot invent a new deadline miss", () => {
  const input = syntheticJointRoomForecast(2, 0, 2);
  input.target_trajectories = 16;
  for (const belief of input.beliefs) belief.hypotheses.push(structuredClone(belief.hypotheses[0]));
  const work = drain({ ...input, max_minute_steps: 100000 });
  const slots = 8, rooms = 2, nodes = 2, stride = 82;
  // Independent synthetic replica estimates: identical held-hour shortfalls
  // have uncertain common magnitude, but their paired difference is exactly
  // zero. Later quarters improve comfort and justify the higher prefix cost.
  const replicates = work.statistics.replicates.map((replica, index) => {
    const values = Array(stride * 3).fill(0);
    for (let quarter = 0; quarter < 4; quarter++) {
      const cell = (rooms + 2 * nodes) * slots + quarter;
      values[cell] = values[stride + cell] = index === 3 ? 2 ** -10 : 0;
    }
    values[stride + (rooms + 2 * nodes) * slots + 4] = 1;
    for (let room = 0; room < rooms; room++) values[stride - rooms + room] = 1;
    return values.map(value => value * replica.trajectories);
  });
  work.statistics.total = packStatistics(replicates[0].map((_, i) => replicates.reduce((sum, row) => sum + row[i], 0)));
  work.statistics.replicates.forEach((replica, i) => replica.total = packStatistics(replicates[i]));
  const assessment = nativePlanner().roomNetworkAdvance({ ...input, work }).assessment;
  assertEquals(assessment.proposal_rejection, null);
  assertEquals(assessment.unresolved_deadline_prefixes, 0);
  assertEquals(assessment.deadline_resolved, true);
});

Deno.test("fast stored heat preserves the disconnected legacy owner's endpoint and interval mean", () => {
  const input = syntheticJointRoomForecast(2, 0, .25);
  // Independent binary scale near machine precision, not a measured fit.
  input.network.nodes[0].lag_h = 2 ** -48;
  input.network.nodes[0].start_stored_heat_c = .2;
  input.network.nodes.push({
    key: "synthetic-legacy", start_c: 18, start_stored_heat_c: 0,
    outdoor_per_h: 0, gain_c_per_wh: [0], lag_h: 0,
    forcing_c_per_h: [0], incoming: [],
    legacy_steps: [{ step: { decay: .99, offset_c: .1, stored_heat_release: 0,
      gain_c_per_w: 0, stored_heat_gain_c_per_w: 0, carry: 1 }, memory_scale: null }],
  });
  input.beliefs.push({ hypotheses: [], thermal_noise_c2_per_h: 0, bounded_thermal: true });
  const work = drain(input);
  const result = nativePlanner().roomNetworkFinalize({ network: input.network, work });
  let temperature = 18, mean = 0;
  for (let minute = 0; minute < 15; minute++) {
    const next = temperature * .99 + .1;
    mean += (temperature + next) / 30;
    temperature = next;
  }
  assertAlmostEquals(result.temperature_c[2][0], temperature, 1e-13);
  assertAlmostEquals(result.mean_temperature_c[2][0], mean, 1e-13);
});
