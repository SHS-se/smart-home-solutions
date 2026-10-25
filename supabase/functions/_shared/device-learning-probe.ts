import { readPrivateTestProbe } from "./private-test-probe.ts";
import { createDeviceLearningReplay, type DeviceLearningReplayInput } from "./device-learning-replay.ts";
import { handleDeviceLearning } from "./device-learning-worker.ts";

/** Executes the actual pool worker against captured, inert database responses.
 * This module has no database client or publication/network capability. */
export function createDeviceLearningProbe(secret: string, projectUrl: string) {
  return async (request: Request): Promise<Response> => {
    const body = await readPrivateTestProbe(request, secret, projectUrl);
    if (body instanceof Response) return body;
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
