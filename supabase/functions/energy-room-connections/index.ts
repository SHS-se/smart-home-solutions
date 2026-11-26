import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";
import { haApiResponse, haRequestId } from "../_shared/ha-api-contract.ts";

serve(async request => {
  const requestId = haRequestId(request);
  const json = (payload: unknown, status = 200) =>
    haApiResponse(requestId, payload, status, {}, request.headers.get("X-SHS-API-Version"));
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const paired = await authenticateDevice(db, request);
  if (!paired.ok) return json({ error: paired.error }, paired.status);
  // Local settings and their recovery are independent of subscription entitlement.
  let result;
  if (request.method === "GET") {
    result = await db.rpc("read_energy_room_connections", { p_home_id: paired.homeId });
  } else {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_body" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof body.owner !== "string" || !body.owner.trim() ||
        !Number.isSafeInteger(body.revision) || body.revision < 1 || !Array.isArray(body.connections)) {
      return json({ error: "invalid_room_connections" }, 400);
    }
    result = await db.rpc("publish_energy_room_connections", {
      p_home_id: paired.homeId, p_owner: body.owner, p_revision: body.revision, p_connections: body.connections,
    });
  }
  if (result.error) {
    const code = result.error.code;
    console.error("[ROOM-CONNECTIONS] storage failed", code);
    return json({ error: code === "40001" ? "room_connections_conflict" :
      code === "22023" ? "invalid_room_connections" : "storage_failed", message: result.error.message },
      code === "40001" ? 409 : code === "22023" ? 400 : 500);
  }
  return json(result.data);
});
