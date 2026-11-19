/** Independently generated 400-day room qualification. TEST-only and no DB writes.
 * --local runs the same endpoint in-process without reading credentials.
 * --execute runs all cells, finalization, and repeat claims on TEST. */
import { assertEquals } from "@std/assert";
import { syntheticRoomBandStress } from "../supabase/functions/_shared/device-learning/room/native-mean.fixture.ts";
import { encodeRoomBandFitCapture } from "../supabase/functions/_shared/device-model-learning/room-band-fit-capture.ts";
import { createDeviceLearningProbe } from "../supabase/functions/_shared/device-learning-probe.ts";
import {
  evaluateRoomBandFiniteTrial, parseRoomBandFitCells, prepareIndependentRoomBand, ROOM_BAND_FIT_CELL_COUNT,
  type PreparedIndependentRoomBand, type RoomBandFitCell, type RoomHeatFitState,
} from "../supabase/functions/_shared/device-learning/room/mean-observations.ts";
import { heatingBand } from "../supabase/functions/_shared/planner/heating-bands.ts";
import { PROBE_PROJECT, testProbeServiceKey } from "./planner-probe-auth.ts";
import { compareRoomFitCells, type RoomFitDifference } from "./probe-room-learning-comparison.ts";

const localOnly = Deno.args.includes("--local"), fragmented = !Deno.args.includes("--dense");
if (!localOnly && !Deno.args.includes("--execute")) {
  console.log("Usage: deno run -A scripts/probe-room-learning-hosted.ts --local|--execute [--dense]");
  Deno.exit(0);
}
const rows = syntheticRoomBandStress(fragmented);
assertEquals(rows.length, 400 * 96);
const from_at = new Date(rows[0].start_ms).toISOString();
const band_c = heatingBand(rows.find(row => row.outdoor_c !== null)!.outdoor_c!);
const ratedPowerW = rows.reduce((watts, row) => Math.max(watts, row.heat_w ?? 0), 0);
const { base64, sha256 } = await encodeRoomBandFitCapture(rows, from_at);
const secret = localOnly ? "synthetic-local-probe" : await testProbeServiceKey();
const projectUrl = `https://${PROBE_PROJECT}.supabase.co`;
const url = `${projectUrl}/functions/v1/energy-device-learning-probe`;
const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
const probe = createDeviceLearningProbe(secret, projectUrl);
const cells: RoomBandFitCell[] = [], localCells: RoomBandFitCell[] = [];
const allDifferences: RoomFitDifference[] = [];
const differingStages = new Set<number>();
const profileChoices = new Set<number>();
let localDesign: PreparedIndependentRoomBand | undefined;
interface Result {
  qualification: string; phase: "cell" | "finalize" | "iteration"; heat_state?: RoomHeatFitState; index: number; cell?: RoomBandFitCell; fit?: unknown;
  capture_sha256: string; result_sha256: string; row_count: number; runtime: string;
  handler_elapsed_ms: number; algorithm_elapsed_ms: number;
}
const results: Result[] = [];
const measurements: Result[] = [];
function payload(prefix: number, values = cells, heat_state: RoomHeatFitState | null = null) {
  return JSON.stringify({ kind: "room_band_step", from_at, band_c, ratedPowerW,
    capture: { base64, sha256 }, cells: values.slice(0, prefix), heat_state });
}
async function run(prefix: number, repeat: number): Promise<Result> {
  const body = payload(prefix);
  const execute = async (hosted: boolean, values: RoomBandFitCell[]) => {
    let state: RoomHeatFitState | null = null, maximumHandler = 0, maximumAlgorithm = 0;
    for (let iteration = 0; iteration < 10000; iteration++) {
      const request = new Request(url, { method: "POST", headers, body: payload(prefix, values, state),
        signal: AbortSignal.timeout(15_000) });
      const response = hosted ? await fetch(request) : await probe(request);
      const result: Result = await response.json();
      assertEquals(response.status, 200, `Room stage ${prefix} HTTP failure: ${JSON.stringify(result)}`);
      maximumHandler = Math.max(maximumHandler, result.handler_elapsed_ms);
      maximumAlgorithm = Math.max(maximumAlgorithm, result.algorithm_elapsed_ms);
      if (result.phase !== "iteration") return { ...result, handler_elapsed_ms: maximumHandler, algorithm_elapsed_ms: maximumAlgorithm };
      state = result.heat_state!;
    }
    throw new Error("Bounded room numerical iterations did not finish");
  };
  const expected = await execute(false, localCells);
  const actual = localOnly ? expected : await execute(true, cells);
  assertEquals(actual.qualification, "test_room_band_step");
  assertEquals(actual.capture_sha256, sha256);
  assertEquals(actual.row_count, rows.length);
  assertEquals(actual.phase, prefix < ROOM_BAND_FIT_CELL_COUNT ? "cell" : "finalize");
  assertEquals(actual.index, prefix);
  let differences: RoomFitDifference[] = [], profileChoice = false;
  if (actual.phase === "finalize") {
    assertEquals(actual.cell, undefined);
    assertEquals(actual.fit, expected.fit, "Final result and evidence must match exactly");
    assertEquals(actual.result_sha256, expected.result_sha256, "Final result hash must match exactly");
  } else {
    assertEquals(actual.fit, undefined);
    const [localCell] = parseRoomBandFitCells([...localCells.slice(0, prefix), expected.cell]).slice(prefix);
    const [hostedCell] = parseRoomBandFitCells([...cells.slice(0, prefix), actual.cell]).slice(prefix);
    ({ differences, profileChoice } = compareRoomFitCells(localCell, hostedCell, k => {
      localDesign ??= prepareIndependentRoomBand(rows, outdoor => heatingBand(outdoor) === band_c, ratedPowerW);
      return evaluateRoomBandFiniteTrial(localDesign, prefix, k);
    }));
    if (!differences.length || localOnly) {
      assertEquals(actual.result_sha256, expected.result_sha256, "An exact cell result must have the same hash");
    }
    if (repeat === 0) {
      localCells.push(localCell);
      cells.push(hostedCell);
      allDifferences.push(...differences);
      if (differences.length) differingStages.add(prefix);
      if (profileChoice) profileChoices.add(prefix);
    }
  }
  if (repeat > 0) {
    assertEquals(actual.runtime, results[prefix].runtime, "Retry uses the same hosted runtime");
    assertEquals(actual.result_sha256, results[prefix].result_sha256, `Room stage ${prefix} retries are exact`);
  }
  measurements.push(actual);
  console.log(JSON.stringify({ mode: localOnly ? "local" : "hosted_TEST", project: PROBE_PROJECT,
    fragmented, rows: rows.length, phase: actual.phase, index: prefix, repeat,
    request_bytes: new TextEncoder().encode(body).length, handler_elapsed_ms: actual.handler_elapsed_ms,
    algorithm_elapsed_ms: actual.algorithm_elapsed_ms, local_elapsed_ms: expected.handler_elapsed_ms,
    runtime: actual.runtime, local_runtime: expected.runtime, result_sha256: actual.result_sha256,
    parity: profileChoice ? "finite_profile_resolution" : differences.length ? "accumulated_roundoff" : "exact",
    differences }));
  return actual;
}
for (let index = 0; index <= ROOM_BAND_FIT_CELL_COUNT; index++) results.push(await run(index, 0));
const worst = results.reduce((slowest, result) => result.handler_elapsed_ms > slowest.handler_elapsed_ms ? result : slowest);
// Repeat all cases where the two runtimes disagreed. Repeat the slowest and
// final claims twice to exercise identical input and prefix on one runtime.
for (const index of new Set([worst.index, ROOM_BAND_FIT_CELL_COUNT, ...differingStages])) await run(index, 1);
for (const index of new Set([worst.index, ROOM_BAND_FIT_CELL_COUNT])) await run(index, 2);
const peak = measurements.reduce((slowest, result) => result.handler_elapsed_ms > slowest.handler_elapsed_ms ? result : slowest);
console.log(JSON.stringify({ mode: localOnly ? "local" : "hosted_TEST", fragmented, stages: results.length,
  repeat_checks: measurements.length - results.length, maximum_handler_elapsed_ms: peak.handler_elapsed_ms, worst_stage: peak.index,
  qualification: "numerical_and_codec_only", database_writes: 0, final_parity: "exact",
  cross_runtime_difference_count: allDifferences.length, profile_resolution_stages: [...profileChoices],
  maximum_absolute_difference: Math.max(0, ...allDifferences.map(d => d.absolute)),
  maximum_ulp_difference: Math.max(0, ...allDifferences.map(d => d.ulps ?? 0)),
  note: "Actual worker source recapture, queue persistence and publication require separate TEST validation." }));
