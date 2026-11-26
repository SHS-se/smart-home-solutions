import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { syntheticConnectedPlant, syntheticConnectedResponse, syntheticConnectedNetwork } from "../../connected-exchange.fixture.ts";
import { advanceConnectedRoomFit, beginConnectedRoomFit, parseConnectedFitProgress } from "./connected-response.ts";
import { roomResponseTrainingLength, connectedRoomResponseTrainingLength } from "./chronological-evidence.ts";
import { forecastConnectedExchange, readConnectedRoomResponse } from "../../planner/models/room/connected-exchange.ts";

Deno.test("connected response learns a passive receiving equation through resumable native mean likelihood", () => {
  const rows = syntheticConnectedPlant(false, 3600), evidence = { fullRows: rows,
    trainingRows: rows.slice(0, roomResponseTrainingLength(rows.map(row => row.duration_s!))) };
  let progress = beginConnectedRoomFit(evidence, { peers: ["peer"], observedOnly: true, ratedPowerW: null,
    basis: syntheticConnectedResponse().basis });
  let slices = 0;
  while (progress.stage !== "complete" && slices++ < 1000) {
    progress = advanceConnectedRoomFit(evidence, progress, 10);
    const parsed = parseConnectedFitProgress(JSON.parse(JSON.stringify(progress)));
    assert(parsed); progress = parsed;
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
