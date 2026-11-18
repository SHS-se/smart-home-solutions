import { readPrivateTestProbe } from "./private-test-probe.ts";
import { createDeviceLearningReplay, type DeviceLearningReplayInput } from "./device-learning-replay.ts";
import { handleDeviceLearning } from "./device-learning-worker.ts";
import { decodeRoomBandFitCapture } from "./device-model-learning/room-band-fit-capture.ts";
import { finalizeIndependentRoomBand, fitIndependentRoomBandCell, parseRoomBandFitCells,
  prepareIndependentRoomBand, ROOM_BAND_FIT_CELL_COUNT } from "./device-learning/room/mean-observations.ts";
import { heatingBand } from "./planner/heating-bands.ts";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Executes one bounded production numerical stage. No database, model write,
 * or device capability is available through this diagnostic path. */
async function roomBandStep(raw: Record<string, unknown>, started: number): Promise<Response> {
  try {
    const { from_at, band_c, ratedPowerW } = raw, capture = record(raw.capture);
    if (Object.keys(raw).length !== 6 || typeof from_at !== "string" || !Number.isFinite(Date.parse(from_at)) ||
      typeof band_c !== "number" || !Number.isFinite(band_c) || heatingBand(band_c) !== band_c ||
      !(ratedPowerW === null || typeof ratedPowerW === "number" && Number.isFinite(ratedPowerW) && ratedPowerW >= 0) ||
      !capture || Object.keys(capture).length !== 2 || typeof capture.base64 !== "string" || typeof capture.sha256 !== "string") {
      throw new Error("Invalid room band step envelope");
    }
    const cells = parseRoomBandFitCells(raw.cells);
    const rows = await decodeRoomBandFitCapture(capture.base64, from_at, capture.sha256);
    const prepared = prepareIndependentRoomBand(rows, outdoor => heatingBand(outdoor) === band_c, ratedPowerW);
    const algorithmStarted = performance.now();
    const result = cells.length < ROOM_BAND_FIT_CELL_COUNT
      ? { phase: "cell", index: cells.length, cell: fitIndependentRoomBandCell(prepared, cells.length) }
      : { phase: "finalize", index: cells.length, fit: finalizeIndependentRoomBand(prepared, cells) };
    const algorithmElapsed = performance.now() - algorithmStarted;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(result))));
    return Response.json({ qualification: "test_room_band_step", ...result,
      capture_sha256: capture.sha256, row_count: rows.length,
      result_sha256: Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""),
      algorithm_elapsed_ms: algorithmElapsed, handler_elapsed_ms: performance.now() - started, runtime: Deno.version.v8 });
  } catch (error) {
    return Response.json({ error: "invalid_room_band_step", detail: error instanceof Error ? error.message : "Invalid room band step" }, { status: 400 });
  }
}

/** Executes the actual pool worker or a bounded room fit stage against inert inputs.
 * This module has no database client or publication/network capability. */
export function createDeviceLearningProbe(secret: string, projectUrl: string) {
  return async (request: Request): Promise<Response> => {
    const startedRequest = performance.now();
    const body = await readPrivateTestProbe(request, secret, projectUrl);
    if (body instanceof Response) return body;
    const tagged = record(body.payload);
    if (tagged?.kind === "room_band_step") return roomBandStep(tagged, startedRequest);
    if (tagged && Object.hasOwn(tagged, "kind")) return Response.json({ error: "unknown_learning_probe_kind" }, { status: 400 });
    const raw = body.payload as { now_ms?: number; input?: DeviceLearningReplayInput; include_publication?: boolean } | null;
    if (!raw || !Number.isFinite(raw.now_ms) || raw.input?.claim?.owner_kind !== "pool"
      || typeof raw.input.claim.id !== "string" || !raw.input.models || !raw.input.tables) {
      return Response.json({ error: "pool_learning_capture_required" }, { status: 400 });
    }
    const started = performance.now();
    const replay = createDeviceLearningReplay(raw.input);
    const response = await handleDeviceLearning(new Request("https://probe.test/learn", {
      method: "POST", headers: { "x-energy-learning-token": "inert-replay" },
      body: JSON.stringify({ job_id: raw.input.claim.id }),
    }), replay.db, () => raw.now_ms!);
    const result = await response.json();
    if (!response.ok || result.published !== true || replay.publications.length !== 1 || replay.failures.length) {
      return Response.json({ error: "learning_replay_failed", worker_status: response.status }, { status: 500 });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(replay.publications[0]));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Response.json({ qualification: "test_learning_candidate", handler_elapsed_ms: performance.now() - started,
      table_reads: replay.reads.length, publication_bytes: bytes.length,
      ...(raw.include_publication === true ? { publication: replay.publications[0] } : {}),
      publication_sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("") });
  };
}
