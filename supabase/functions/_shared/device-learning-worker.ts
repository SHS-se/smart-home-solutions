import { captureDeviceModels } from "./device-model-store.ts";
import { runRoomLearning } from "./device-model-learning/room-response-run.ts";
import { fitStoredPool } from "./device-model-learning/pool.ts";
import { fitStoredWeatherHeating } from "./device-model-learning/weather-heating.ts";
import { fitStoredDevice } from "./device-model-learning/device.ts";
import { describeThrown } from "./ha-api-contract.ts";

interface LearningClaim {
  id: string; home_id: string; customer_id: string; owner_kind: "room" | "pool" | "device"; owner_key: string;
  generation: number; fence: number;
  room_history_to: string | null;
  room_fit_progress?: unknown;
  room_window_visits?: unknown;
  input: { location?: { latitude: number; longitude: number } | null; volume_m3?: number; device_keys?: string[]; auxiliary_keys?: string[]; weather_heating_binding?: string; banded_heating?: boolean };
}
/** One invocation fits exactly one owner; terminated workers are recovered by the database lease. */
// deno-lint-ignore no-explicit-any
export async function handleDeviceLearning(request: Request, db: any, now: () => number = Date.now): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const { data: authorized, error: authError } = await db.rpc("verify_energy_learning_token", {
    p_token: request.headers.get("x-energy-learning-token") ?? "",
  });
  if (authError) return Response.json({ error: "authentication_unavailable" }, { status: 503 });
  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });
  let claim: LearningClaim | null = null;
  try {
    const raw = await request.text();
    if (raw.length > 1024) return Response.json({ error: "request_too_large" }, { status: 413 });
    const { job_id } = JSON.parse(raw);
    const result = await db.rpc("claim_energy_device_learning", { p_job_id: job_id });
    if (result.error) throw new Error(result.error.message);
    claim = result.data;
    if (!claim) return Response.json({ claimed: false });
    const started = performance.now();
    const wallNow = now();
    const room = claim.owner_kind === "room" ? await runRoomLearning(db, claim, wallNow) : null;
    if (room?.kind === "handled") return Response.json(room.result);
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
    console.info("[ENERGY-LEARNING] attempt completed", { job_id: claim.id, kind: claim.owner_kind,
      generation: claim.generation, published: publication.data, elapsed_ms: Math.round(performance.now() - started) });
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
    if (claim?.owner_kind === "room") {
      try {
        const released = await db.rpc("release_energy_room_learning_lane", {
          p_job_id: claim.id, p_generation: claim.generation, p_fence: claim.fence,
        });
        if (released.error) console.error("[ENERGY-LEARNING] room admission release failed", released.error.message);
      } catch (error) {
        console.error("[ENERGY-LEARNING] room admission release failed", describeThrown(error));
      }
    }
  }
}
