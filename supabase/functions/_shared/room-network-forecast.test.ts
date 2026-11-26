import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
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

Deno.test("native cost certificate preserves deadline improvement exception and unresolved threshold states", () => {
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
  // Higher cost is permitted by the existing improvement exception.
  const improved = assess(()=>0);
  assertEquals(improved.proposal_rejection, null);
  assertEquals(improved.deadline_resolved, true);
  // Near the unchanged 1e-6 deadline threshold, more integration is required.
  const ambiguous = assess(r=>r===3?4e-6:0);
  assertEquals(ambiguous.proposal_rejection, null);
  assertEquals(ambiguous.deadline_resolved, false);
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
