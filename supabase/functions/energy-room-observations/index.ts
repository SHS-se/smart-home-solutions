import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";
import { haApiResponse, haRequestId } from "../_shared/ha-api-contract.ts";
import { parseRoomUpload } from "./upload.ts";

serve(async (request) => {
  const requestId = haRequestId(request);
  const json = (payload: unknown, status = 200) =>
    haApiResponse(requestId, payload, status, {}, request.headers.get("X-SHS-API-Version"));
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const paired = await authenticateDevice(db, request);
  if (!paired.ok) return json({ error: paired.error }, paired.status);
  if (!paired.subscriptionActive) return json({ error: "subscription_inactive" }, 402);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 2_000_000) return json({ error: "request_too_large" }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); }
  catch { return json({ error: "invalid_body" }, 400); }
  const upload = parseRoomUpload(body, Date.now());
  if (!upload) return json({ error: "invalid_room_inventory" }, 400);

  const { data, error } = await db.rpc("record_energy_room_observations", {
    p_home_id: paired.homeId, p_rooms: upload.rooms, p_slots: upload.slots,
  });
  if (error) {
    console.error("[ROOM-OBSERVATIONS] storage failed", error.code);
    return json({ error: "storage_failed" }, 500);
  }
  return json({ ...data, readings_ignored: upload.ignored });
});
