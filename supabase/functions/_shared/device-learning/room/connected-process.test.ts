import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { syntheticConnectedPlant, syntheticConnectedResponse } from "../../connected-exchange.fixture.ts";
import { filterConnectedRoomExchange, forecastConnectedExchange, readConnectedRoomResponse } from "../../planner/models/room/connected-exchange.ts";
import { advanceConnectedProcessInference, beginConnectedProcessInference, connectedProcessResponse, propagateConnectedProcessResponse } from "./connected-process.ts";

Deno.test("retained process weights update only new native evidence and exact checkpoint replay agrees", () => {
  const rows = syntheticConnectedPlant(true), model = syntheticConnectedResponse(false), boundary = 4 * 96 - 1;
  const finish = (p: ReturnType<typeof beginConnectedProcessInference>, observations: typeof rows, through: number) => {
    while (!p.complete) p = advanceConnectedProcessInference(observations, p, through, 5);
    return p;
  };
  const prefix = finish(beginConnectedProcessInference(model, rows.slice(0, boundary), undefined, 32), rows.slice(0, boundary), boundary * 900_000);
  const saved = JSON.parse(JSON.stringify(prefix.belief));
  assert(saved.hypotheses.every((h: { log_weight: number }) => Number.isFinite(h.log_weight)));
  const resumed = finish(beginConnectedProcessInference(model, rows, saved, 32), rows, rows.length * 900_000);
  const cold = finish(beginConnectedProcessInference(model, rows, undefined, 32), rows, rows.length * 900_000);
  assertEquals(resumed.belief, cold.belief);
  const response = connectedProcessResponse(resumed); assert(readConnectedRoomResponse(response));
  assertAlmostEquals(forecastConnectedExchange(response, response.reference_state, 0)[0], .7, .12);
  const tail = propagateConnectedProcessResponse(response, response.reference_state.through_ms + 900_000);
  assertEquals(response.reference_state.through_ms, rows.length * 900_000);
  assertEquals(tail.process_belief!.hypotheses[0].posterior.through_ms, rows.length * 900_000 + 900_000);
});

Deno.test("zero paths without identified receiver contrast never become free heat from topology alone", () => {
  const original = syntheticConnectedPlant(false, 3600), model = syntheticConnectedResponse(false);
  model.incoming = [{ kind: "constant", from: "peer", per_h: 0 }];
  for (const absent of [true, false]) {
    const rows = original.map(row => ({ ...row, peer_c: absent ? {} as Record<string, number | null> : { peer: row.room_c } }));
    let p = beginConnectedProcessInference(model, rows, undefined, 16);
    while (!p.complete) p = advanceConnectedProcessInference(rows, p, rows.length * 3600_000, 100);
    assert(p.belief.hypotheses.every(h => h.incoming.every(e => e.kind === "constant" && e.per_h === 0)));
    assertEquals(forecastConnectedExchange(connectedProcessResponse(p), connectedProcessResponse(p).reference_state, 24), [0]);
  }
});

Deno.test("zero and positive process hypotheses score the same missing-peer intervals and retain measured storage", () => {
  const model = syntheticConnectedResponse(false);
  model.incoming = [{ kind: "constant", from: "peer", per_h: 0 }];
  model.thermal.heater = { gain_c_per_wh: .001, lag_h: 2, gain_outdoor_slope_per_c: .01, gain_reference_outdoor_c: 5 };
  const rows = syntheticConnectedPlant(false).slice(0, 30).map((row, i) => ({ ...row, heat_w: 200, cooling: false,
    peer_c: i === 10 || i === 11 ? {} : row.peer_c }));
  let p = beginConnectedProcessInference(model, rows, undefined, 16);
  while (!p.complete) p = advanceConnectedProcessInference(rows, p, rows.length * 900_000, 100);
  const finite = p.belief.hypotheses.filter(h => h.log_weight !== -Number.MAX_VALUE);
  assert(finite.length > 2);
  assertEquals(new Set(finite.map(h => h.posterior.observations)).size, 1);
  assertEquals(new Set(finite.map(h => h.posterior.stored_heat_c)).size, 1);
  assert(finite[0].posterior.stored_heat_c > .35);
});

Deno.test("published regime belief validates replica mass and freezes its prior through corrected history", () => {
  const model = syntheticConnectedResponse(false), rows = syntheticConnectedPlant(false).slice(0, 12);
  let p = beginConnectedProcessInference(model, rows, undefined, 8);
  while (!p.complete) p = advanceConnectedProcessInference(rows, p, 12 * 900_000, 10);
  const response = connectedProcessResponse(p), belief = response.process_belief!;
  assert(readConnectedRoomResponse(JSON.parse(JSON.stringify(response))));
  assertEquals(belief.replicas.length, 4);
  for (let replica = 0; replica < 4; replica++) {
    const members = belief.hypotheses.filter(h => h.replica === replica);
    assertEquals(members.reduce((sum, h) => sum + h.multiplicity, 0), 8);
    assertAlmostEquals(members.reduce((sum, h) => sum + Math.exp(h.log_weight), 0), 1, 1e-12);
  }
  assert(Number(response.evidence.process_replica_ess) >= 1 && Number(response.evidence.process_replica_ess) <= 4 + 1e-12);
  const corrected = rows.map(row => ({ ...row, duration_s: 3600 as const, peer_c: { peer: 40 } }));
  const coldRepair = beginConnectedProcessInference(response, corrected, undefined, 8);
  assertEquals(coldRepair.belief.reset_priors, belief.reset_priors);
  assertEquals(coldRepair.belief.initial_hazard, belief.initial_hazard);
  assert(coldRepair.belief.hypotheses.every(h => h.posterior.observations === 0));
  assert(coldRepair.belief.replicas.every(r => r.log_evidence === 0));
  const broken = structuredClone(response); broken.process_belief!.hypotheses[0].multiplicity++;
  assertEquals(readConnectedRoomResponse(broken), null);
});

Deno.test("replica marginal likelihood equals the observation likelihood when all particles are identical", () => {
  const model = syntheticConnectedResponse(false), rows = syntheticConnectedPlant(false).slice(0, 20);
  model.incoming = [];
  let p = beginConnectedProcessInference(model, rows, undefined, 16);
  assertEquals(p.belief.hypotheses.length, 4);
  const seed = structuredClone(p.belief.hypotheses[0]);
  while (!p.complete) p = advanceConnectedProcessInference(rows, p, 20 * 900_000, 10);
  let state = seed.posterior, identified = false, logEvidence = 0;
  for (const row of rows) {
    const result = filterConnectedRoomExchange(model, [row], row.start_ms + 900_000, state, identified);
    state = result.posterior; identified = result.diagnostics.thermal_state_identified;
    logEvidence -= result.diagnostics.negative_log_likelihood;
  }
  for (const replica of p.belief.replicas) assertAlmostEquals(replica.log_evidence, logEvidence, 1e-9);
  assertEquals(p.belief.hypotheses.length, 4);
});

Deno.test("a reset activates one identified zero edge without erasing the other edge's correlated state", () => {
  // Independently synthetic covariance: outer product plus diagonal, hence PSD.
  const model = syntheticConnectedResponse(false), rows = syntheticConnectedPlant(false).slice(0, 2);
  model.incoming = [{ kind: "constant", from: "peer", per_h: 0 }, { kind: "constant", from: "steady", per_h: .12 }];
  const p = beginConnectedProcessInference(model, rows, undefined, 8);
  p.belief.reset_priors = p.belief.reset_priors.filter(prior => prior.from === "peer");
  p.belief.reset_priors[0].constant_probability = 1;
  const vector = [.1, .2, .3, .4], covariance = vector.map((a, i) => vector.map((b, j) => a * b + Number(i === j) * .01));
  for (const h of p.belief.hypotheses) {
    h.incoming = [{ kind: "constant", from: "peer", per_h: 0 }, { kind: "log_ou", from: "steady", mean_log_per_h: Math.log(.12), reversion_per_h: 0, stationary_variance: 0 }];
    h.posterior = { through_ms: 0, temperature_c: 20, stored_heat_c: .3, observations: 5,
      log_rates: [Math.log(.12)], log_centers: [Math.log(.11)], covariance: structuredClone(covariance) };
    h.hazards = [{ shape: 1000, rate_h: .25 }, { shape: .5, rate_h: .25 }];
  }
  const advanced = advanceConnectedProcessInference([], p, 900_000);
  for (const h of advanced.belief.hypotheses) {
    assertEquals(h.incoming[0].kind, "log_ou");
    assertEquals(h.posterior.log_rates[1], Math.log(.12));
    assertEquals(h.posterior.log_centers![1], Math.log(.11));
    const preserved = [0, 1, 3, 5];
    assertEquals(preserved.map(i => preserved.map(j => h.posterior.covariance[i][j])), covariance);
    assertEquals(h.hazards[1], { shape: .5, rate_h: .25 });
    assert(h.hazards[0].shape > 1000);
  }
  assertEquals(p.belief.hypotheses[0].posterior.log_rates.length, 1);
});

Deno.test("hourly observations and missing tail advance hazards without recording invented measurements", () => {
  const rows = syntheticConnectedPlant(false, 3600).slice(0, 6), model = syntheticConnectedResponse(false);
  let p = beginConnectedProcessInference(model, rows, undefined, 8);
  assertEquals(p.belief.initial_hazard, { shape: .5, rate_h: 1 });
  while (!p.complete) p = advanceConnectedProcessInference(rows, p, 6 * 3600_000, 5);
  const response = connectedProcessResponse(p), frozen = JSON.stringify(response), tail = propagateConnectedProcessResponse(response, 9 * 3600_000);
  assertEquals(JSON.stringify(response), frozen);
  assert(tail.process_belief!.hypotheses.every(h => h.posterior.through_ms === 9 * 3600_000 && h.posterior.observations === 6 && !h.thermal_state_identified));
  assert(tail.process_belief!.hypotheses.every(h => h.hazards[0].rate_h === 10));
});

Deno.test("cold correction replay restores the original zero tag and never invents a missing receiving scale", () => {
  const model = syntheticConnectedResponse(false), rows = syntheticConnectedPlant(false).slice(0, 12);
  model.incoming = [{ kind: "constant", from: "peer", per_h: 0 }];
  const initial = beginConnectedProcessInference(model, rows, undefined, 8);
  let fitted = initial;
  while (!fitted.complete) fitted = advanceConnectedProcessInference(rows, fitted, 12 * 900_000, 10);
  const response = connectedProcessResponse(fitted);
  assert(fitted.belief.hypotheses.some(h => h.incoming[0].kind === "log_ou"));
  const replay = beginConnectedProcessInference(response, rows, undefined, 8);
  assertEquals(replay.belief, initial.belief);
  model.thermal.outdoor_per_h = 0;
  let unidentified = beginConnectedProcessInference(model, rows, undefined, 8);
  assertEquals(unidentified.belief.reset_priors, []);
  while (!unidentified.complete) unidentified = advanceConnectedProcessInference(rows, unidentified, 12 * 900_000, 10);
  const unresolved = connectedProcessResponse(unidentified);
  assertEquals(unresolved.evidence.process_unresolved_scale_peers, ["peer"]);
  assert(unidentified.belief.hypotheses.every(h => h.incoming[0].kind === "constant" && h.incoming[0].per_h === 0));
});

Deno.test("JSON checkpoints inside a native row preserve candidates, replica evidence and random draws exactly", () => {
  const model = syntheticConnectedResponse(false), rows = syntheticConnectedPlant(true).slice(0, 4);
  const initial = beginConnectedProcessInference(model, rows, undefined, 4);
  let split = advanceConnectedProcessInference(rows, initial, 4 * 900_000, 0);
  assert(split.work && split.cursor === 0 && !split.complete);
  let iterations = 0;
  while (!split.complete) {
    split = advanceConnectedProcessInference(rows, JSON.parse(JSON.stringify(split)), 4 * 900_000, 0);
    assert(++iterations < 1000);
  }
  let whole = initial;
  while (!whole.complete) whole = advanceConnectedProcessInference(rows, whole, 4 * 900_000, 600);
  assertEquals(split.belief, whole.belief);
  assertEquals(split.numerical_failures, whole.numerical_failures);
  assertEquals(connectedProcessResponse(split), connectedProcessResponse(whole));
});
