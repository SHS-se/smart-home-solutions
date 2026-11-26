import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from "@std/assert";
import { syntheticConnectedPlant, syntheticConnectedResponse, syntheticConnectedNetwork } from "../../connected-exchange.fixture.ts";
import { advanceConnectedRoomFit, beginConnectedRoomFit, parseConnectedFitProgress } from "./connected-response.ts";
import { roomResponseTrainingLength, connectedRoomResponseTrainingLength } from "./chronological-evidence.ts";
import { filterConnectedRoomExchange, forecastConnectedExchange, readConnectedRoomResponse } from "../../planner/models/room/connected-exchange.ts";

Deno.test("connected response learns a passive receiving equation through resumable native mean likelihood", () => {
  const rows = syntheticConnectedPlant(false, 3600), evidence = { fullRows: rows,
    trainingRows: rows.slice(0, roomResponseTrainingLength(rows.map(row => row.duration_s!))) };
  let progress = beginConnectedRoomFit(evidence, { peers: ["peer"], observedOnly: true, ratedPowerW: null,
    basis: syntheticConnectedResponse().basis });
  let slices = 0;
  let checkpoint = JSON.stringify(progress);
  while (progress.stage !== "complete") {
    slices++;
    progress = advanceConnectedRoomFit(evidence, progress, 10);
    const nextCheckpoint = JSON.stringify(progress);
    assertNotEquals(nextCheckpoint, checkpoint, `A bounded ${progress.stage} slice must advance its durable work`);
    const parsed = parseConnectedFitProgress(JSON.parse(nextCheckpoint));
    assert(parsed); progress = parsed;
    checkpoint = nextCheckpoint;
  }
  assertEquals(progress.stage, "complete");
  assert(progress.result?.response, JSON.stringify(progress.result));
  const model = progress.result.response;
  assert(readConnectedRoomResponse(model)); assertEquals(model.thermal.heater, null);
  assertAlmostEquals(model.thermal.outdoor_per_h, .04, .025);
  assertAlmostEquals(model.thermal.background_per_h, 0, .3);
  assert(slices > 1);
});

Deno.test("an unobserved configured peer is unresolved evidence, not a fitted zero or a veto on useful exchange", () => {
  const rows = syntheticConnectedPlant(false, 3600), evidence = { fullRows: rows,
    trainingRows: rows.slice(0, roomResponseTrainingLength(rows.map(row => row.duration_s!))) };
  let p = beginConnectedRoomFit(evidence, { peers: ["peer", "unobserved"], observedOnly: true, ratedPowerW: null, basis: syntheticConnectedResponse().basis });
  while (p.stage !== "complete") p = advanceConnectedRoomFit(evidence, p, 100);
  assert(p.result?.response);
  assertEquals(p.result.response.incoming.map(edge => edge.from), ["peer"]);
  assertEquals(p.result.response.evidence.unresolved_peer_sources, ["unobserved"]);
});

Deno.test("an installed heater without measured excitation retains a passive receiving response", () => {
  const rows = syntheticConnectedPlant(false, 3600).map(row => ({ ...row, heat_w: 0, cooling: false }));
  const evidence = { fullRows: rows, trainingRows: rows.slice(0, roomResponseTrainingLength(rows.map(row => row.duration_s!))) };
  let p = beginConnectedRoomFit(evidence, { peers: ["peer"], observedOnly: false, ratedPowerW: 600, basis: syntheticConnectedResponse().basis });
  while (p.stage !== "complete") p = advanceConnectedRoomFit(evidence, p, 100);
  const response = p.result?.response; assert(response);
  assertEquals(response.thermal.heater, null); assertEquals(p.result?.model, null);
  assertEquals(response.evidence.heater_identified, false); assertEquals(response.evidence.unidentified_heater, true);
  assertEquals(p.configuredContext.observedOnly, false);
  assertEquals(p.context.observedOnly, true);
});

/** Independent synthetic hourly means: heater commissioning occurs only after
 * the chronological training prefix. No production measurements are used. */
function lateHeaterEvidence(heatedHours: number, solarAt: (hour: number) => number | null = () => null) {
  let temperature = 19, heated = 0;
  return Array.from({ length: 192 }, (_, hour) => {
    const outdoor = 5 + 3 * Math.sin(hour / 31), peer = 23 + 2 * Math.sin(hour / 17);
    const power = hour >= 128 && hour % 2 === 0 && heated < heatedHours ? 600 : 0;
    if (power > 0) heated++;
    const solar = solarAt(hour);
    let sum = 0;
    for (let second = 0; second < 3600; second++) {
      sum += temperature;
      temperature += (.04 * (outdoor - temperature) + .1 * (peer - temperature) + .001 * power + .002 * (solar ?? 0)) / 3600;
    }
    return { start_ms: hour * 3600_000, duration_s: 3600 as const,
      room_c: sum / 3600 + .005 * Math.sin(hour * 1.7), outdoor_c: outdoor,
      house_c: null, peer_c: { peer }, heat_w: power, cooling: false, solar_w_per_m2: solar };
  });
}

for (const heatedHours of [32, 13]) Deno.test(`full causal basis reconsiders late heater excitation (${heatedHours} measured hours) without claiming holdout validation`, () => {
  const rows = lateHeaterEvidence(heatedHours), evidence = { fullRows: rows, trainingRows: rows.slice(0, 128) };
  const context = { peers: ["peer"], observedOnly: false, ratedPowerW: 600, basis: syntheticConnectedResponse().basis };
  const prefix = beginConnectedRoomFit({ fullRows: evidence.trainingRows, trainingRows: evidence.trainingRows }, context);
  assertEquals(prefix.unidentifiedHeater, true);
  let progress = beginConnectedRoomFit(evidence, context);
  assertEquals(progress.trainingBasis, "full_capture");
  assertEquals(progress.configuredContext.observedOnly, false);
  assertEquals(progress.context.observedOnly, false);
  assertEquals(progress.unidentifiedHeater, false);
  // The published response and its admission evidence are produced before the
  // separately tested process-posterior continuation begins.
  while (!progress.result) progress = advanceConnectedRoomFit(evidence, progress, 100);
  const response = progress.result.response;
  assert(response?.thermal.heater);
  assertAlmostEquals(response.thermal.heater.gain_c_per_wh, .001, .0002);
  assertEquals(response.evidence.heater_identified, heatedHours >= 24);
  assertEquals(response.evidence.measured_heated_hours, heatedHours);
  assertEquals(response.evidence.validation_available, false);
  assertEquals(response.evidence.selection, "penalized_full_likelihood_without_validation");
  assertEquals(response.evidence.observed_only, false);
  assertEquals(response.evidence.training_basis, "full_capture");
  assert(parseConnectedFitProgress(JSON.parse(JSON.stringify(progress))));
});

Deno.test("varying solar first observed in the tail is learned on the full causal basis", () => {
  const rows = lateHeaterEvidence(0, hour => hour < 128 ? 0 : 300 * Math.max(0, Math.sin(hour / 4)));
  const evidence = { fullRows: rows, trainingRows: rows.slice(0, 128) };
  const context = { peers: ["peer"], observedOnly: true, ratedPowerW: null, basis: syntheticConnectedResponse().basis };
  let progress = beginConnectedRoomFit(evidence, context);
  assertEquals(progress.trainingBasis, "full_capture");
  assert(progress.seed.solarPresent);
  while (!progress.result) progress = advanceConnectedRoomFit(evidence, progress, 100);
  const response = progress.result.response;
  assert(response);
  assertAlmostEquals(response.thermal.solar_per_wm2_h, .002, .0004);
  assertEquals(response.evidence.validation_available, false);
});

Deno.test("missing solar followed by constant measured zero does not identify a solar coefficient", () => {
  const rows = lateHeaterEvidence(0, hour => hour === 0 ? null : 0);
  const evidence = { fullRows: rows, trainingRows: rows.slice(0, 128) };
  const progress = beginConnectedRoomFit(evidence, { peers: ["peer"], observedOnly: true,
    ratedPowerW: null, basis: syntheticConnectedResponse().basis });
  assertEquals(progress.trainingBasis, "chronological_prefix");
  assertEquals(progress.seed.solarPresent, false);
});

Deno.test("two excluded solar intervals cannot qualify twenty-three measured heated hours", () => {
  const rows = lateHeaterEvidence(25, hour => 200 * Math.max(0, Math.sin(hour / 4)));
  rows[132].solar_w_per_m2 = null;
  rows[142].solar_w_per_m2 = null;
  const evidence = { fullRows: rows, trainingRows: rows.slice(0, 128) };
  let progress = beginConnectedRoomFit(evidence, { peers: ["peer"], observedOnly: false,
    ratedPowerW: 600, basis: syntheticConnectedResponse().basis });
  while (!progress.result) progress = advanceConnectedRoomFit(evidence, progress, 100);
  const response = progress.result.response;
  assert(response?.thermal.heater);
  assertEquals(response.evidence.measured_heated_hours, 23);
  assertEquals(response.evidence.observed_hours, rows.length - 2);
  const batched = filterConnectedRoomExchange(response, rows, rows.length * 3600_000);
  const final = progress.optimizer.evaluation;
  assertEquals(final.posterior, batched.posterior);
  assertEquals(final.observations, batched.diagnostics.observed_intervals);
  assertEquals(final.nll, batched.diagnostics.negative_log_likelihood);
  assertEquals(response.evidence.heater_identified, false);
});

Deno.test("full source qualification identifies a peer absent from the independently qualified prefix", () => {
  const rows = syntheticConnectedPlant(false, 3600);
  const evidence = { fullRows: rows, trainingRows: rows.slice(0, 128).map(row => ({ ...row, peer_c: {} })) };
  const progress = beginConnectedRoomFit(evidence, { peers: ["peer"], observedOnly: true,
    ratedPowerW: null, basis: syntheticConnectedResponse().basis });
  assertEquals(progress.trainingBasis, "full_capture");
  assertEquals(progress.context.peers, ["peer"]);
  assertEquals(progress.unresolvedPeers, []);
  assert(progress.seed.rates[0] > 0);
});

Deno.test("an exactly redundant boundary is explicit unidentified topology while independent exchange remains learnable", () => {
  const rows = syntheticConnectedPlant(false, 3600).map(row => ({ ...row, peer_c: { ...row.peer_c, redundant: row.outdoor_c } }));
  const evidence = { fullRows: rows, trainingRows: rows.slice(0, roomResponseTrainingLength(rows.map(row => row.duration_s!))) };
  let p = beginConnectedRoomFit(evidence, { peers: ["peer", "redundant"], observedOnly: true, ratedPowerW: null, basis: syntheticConnectedResponse().basis });
  while (p.stage !== "complete") p = advanceConnectedRoomFit(evidence, p, 100);
  const response = p.result?.response; assert(response);
  assertEquals(response.incoming.map(edge => edge.from), ["peer"]);
  assertEquals(response.evidence.unidentified_peer_combinations, [["redundant", "outdoor"]]);
});

Deno.test("repeated independent heating and exchange regimes separate heater storage from learned persistence", () => {
  const { rows } = syntheticConnectedNetwork(30, 24), evidence = { fullRows: rows, trainingRows: rows.slice(0, 20 * 96) };
  let progress = beginConnectedRoomFit(evidence, { peers: ["peer"], observedOnly: false, ratedPowerW: 850,
    basis: { ...syntheticConnectedResponse().basis, history_to: new Date(30 * 86400_000).toISOString() } });
  while (progress.stage !== "complete") progress = advanceConnectedRoomFit(evidence, progress, 100);
  const model = progress.result?.response;
  assert(model && model.thermal.heater);
  assertAlmostEquals(model.thermal.outdoor_per_h, .04, .012);
  assertAlmostEquals(model.thermal.heater.gain_c_per_wh, .001, .0002);
  assertAlmostEquals(model.thermal.heater.lag_h, 1, .3);
  const edge = model.incoming[0]; assertEquals(edge.kind, "log_ou");
  if (edge.kind === "log_ou") assertAlmostEquals(1 / edge.reversion_per_h, 24, 12);
  assert(progress.validationAdaptive! < progress.validationStatic!);
  assertEquals(model.evidence.heater_identified, true);
});

Deno.test("recent usable native evidence trains now and a no-holdout fit explicitly reports unavailable validation", () => {
  const rows = syntheticConnectedPlant(false, 3600).map((row, i) => ({ ...row, room_c: i < 120 ? null : row.room_c }));
  const context = { peers: ["peer"], observedOnly: true, ratedPowerW: null, basis: syntheticConnectedResponse().basis };
  const length = connectedRoomResponseTrainingLength(rows, context);
  assert(length > roomResponseTrainingLength(rows.map(row => row.duration_s!)));
  for (const trainingRows of [rows.slice(0, length), rows]) {
    const evidence = { fullRows: rows, trainingRows };
    let p = beginConnectedRoomFit(evidence, context);
    while (p.stage !== "complete") p = advanceConnectedRoomFit(evidence, p, 100);
    const response = p.result?.response; assert(response);
    assertEquals(response.evidence.validation_available, trainingRows.length < rows.length);
    if (trainingRows.length === rows.length) assertEquals(response.evidence.selection, "penalized_full_likelihood_without_validation");
  }
});
