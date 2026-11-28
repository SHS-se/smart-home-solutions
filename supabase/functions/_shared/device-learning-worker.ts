import { captureDeviceModels } from "./device-model-store.ts";
import { roomLearningWorkerCapabilities } from "./room-learning-worker-capabilities.ts";
import { runRoomLearning, type RoomSliceTrace } from "./device-model-learning/room-response-run.ts";
import { fitStoredPool } from "./device-model-learning/pool.ts";
import { fitStoredWeatherHeating } from "./device-model-learning/weather-heating.ts";
import { fitStoredDevice } from "./device-model-learning/device.ts";
import { describeThrown } from "./ha-api-contract.ts";

interface LearningOwner {
  queue_ms?: number | null;
  id: string; home_id: string; customer_id: string; owner_key: string;
  generation: number; fence: number;
  room_history_to: string | null;
  room_fit_progress?: unknown;
  room_window_visits?: unknown;
  input: { learner_version?: string; location?: { latitude: number; longitude: number } | null; volume_m3?: number; device_keys?: string[]; auxiliary_keys?: string[]; weather_heating_binding?: string; banded_heating?: boolean };
}
type LearningClaim = LearningOwner & (
  { owner_kind: "room"; work_class: "source" | "numerical" | "finalization" } |
  { owner_kind: "pool" | "device"; work_class: "device" }
);
const isolateId = crypto.randomUUID();
let isolateRequests = 0;
/** One invocation fits exactly one owner; terminated workers are recovered by the database lease. */
// deno-lint-ignore no-explicit-any
export async function handleDeviceLearning(request: Request, db: any, now: () => number = Date.now, executor?: string): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const token = request.headers.get("x-energy-learning-token") ?? "";
  const isolateRequest = ++isolateRequests;
  const capability = roomLearningWorkerCapabilities();
  const trace: RoomSliceTrace = {};
  const started = performance.now();
  let claimMs = 0;
  let outcome = "failed";
  let claim: LearningClaim | null = null;
  try {
    const raw = await request.text();
    if (raw.length > 1024) return Response.json({ error: "request_too_large" }, { status: 413 });
    const { job_id, action, delivery_id } = JSON.parse(raw);
    if (action === "capabilities") {
      const { data, error } = await db.rpc("verify_energy_learning_token", { p_token: token });
      if (error) return Response.json({ error: "authentication_unavailable" }, { status: 503 });
      if (data !== true) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json(capability);
    }
    if (typeof job_id !== "string" || !job_id) return Response.json({ error: "invalid_job_id" }, { status: 400 });
    const claimStarted = performance.now();
    const result = await db.rpc("claim_energy_learning_request", { p_job_id: job_id, p_worker: capability,
      p_token: token, p_delivery_id: delivery_id ?? null });
    claimMs = Math.round(performance.now() - claimStarted);
    if (result.error) throw new Error(result.error.message);
    if (result.data === false) return Response.json({ error: "unauthorized" }, { status: 401 });
    claim = result.data;
    if (!claim) return Response.json({ claimed: false });
    const wallNow = now();
    const room = claim.owner_kind === "room" ? await runRoomLearning(db, claim, wallNow, trace) : null;
    if (room?.kind === "handled") {
      outcome = room.result.incompatible ? "incompatible" : room.result.superseded ? "superseded" : room.result.published ? "published" : "checkpointed";
      return Response.json(room.result);
    }
    let revision: number, row;
    if (room) {
      revision = room.revision;
      row = room.model;
    } else {
      const models = await captureDeviceModels(db, claim.home_id);
      const previous = claim.owner_kind === "device" ? models.devices.find(model => model.device_key === claim!.owner_key) : models.pool;
      revision = previous?.model_revision ?? 0;
      row = claim.owner_kind === "device"
        ? claim.input.weather_heating_binding
          ? await fitStoredWeatherHeating(db, claim.home_id, claim.customer_id, claim.owner_key,
            claim.input.weather_heating_binding, previous?.operating_points, now(), claim.input.banded_heating)
          : await fitStoredDevice(db, claim.customer_id, claim.home_id, claim.owner_key, now())
        : await fitStoredPool(db, claim.customer_id, claim.home_id, claim.input.volume_m3!, claim.input.device_keys!, now(), claim.input.auxiliary_keys ?? []);
    }
    if (!row) throw new Error("Learning did not produce an attempt");
    const publication = await db.rpc("publish_energy_device_learning", {
      p_job_id: claim.id, p_generation: claim.generation, p_fence: claim.fence,
      p_revision: revision, p_model: row,
    });
    if (publication.error) throw new Error(publication.error.message);
    outcome = publication.data ? "published" : "superseded";
    return Response.json({ published: publication.data });
  } catch (error) {
    const detail = describeThrown(error);
    if (claim) {
      const failed = await db.rpc("fail_energy_device_learning", { p_job_id: claim.id,
        p_generation: claim.generation, p_fence: claim.fence, p_error: detail });
      if (failed.error) console.error("[ENERGY-LEARNING] failure persistence failed", failed.error.message);
    }
    console.error("[ENERGY-LEARNING] attempt failed", detail);
    return Response.json({ error: "learning_failed" }, { status: 500 });
  } finally {
    // The home reservation follows the actual invocation, independently of a
    // job generation being invalidated while its history query is still running.
    // A terminated worker or lost release is recovered by the existing lease.
    const releaseStarted = performance.now();
    if (claim?.owner_kind === "room") {
      try {
        const released = await db.rpc("release_energy_learning_work", {
          p_job_id: claim.id, p_generation: claim.generation, p_fence: claim.fence,
        });
        if (released.error) console.error("[ENERGY-LEARNING] room admission release failed", released.error.message);
      } catch (error) {
        console.error("[ENERGY-LEARNING] room admission release failed", describeThrown(error));
      }
    }
    const queueMs = claim?.queue_ms;
    if (claim) console.info(JSON.stringify({ event: "energy_learning_slice", executor, isolate: isolateId, isolate_request: isolateRequest,
      job_id: claim.id, kind: claim.owner_kind,
      generation: claim.generation, fence: claim.fence, work_class: claim.work_class, outcome,
      queue_ms: typeof queueMs === "number" && Number.isSafeInteger(queueMs) && queueMs >= 0 ? queueMs : null, claim_ms: claimMs,
      release_ms: Math.round(performance.now() - releaseStarted), elapsed_ms: Math.round(performance.now() - started), ...trace }));
  }
}
