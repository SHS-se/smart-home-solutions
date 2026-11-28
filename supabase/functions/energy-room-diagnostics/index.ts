import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { readRoomDiagnostics, RoomDiagnosticRevisionChanged } from "../_shared/room-diagnostics.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
Deno.serve(async request => {
  const json = (value: unknown, status = 200) => Response.json(value, {status, headers: cors});
  if (request.method === "OPTIONS") return new Response(null, {headers: cors});
  if (request.method !== "POST") return json({error: "method_not_allowed"}, 405);
  const authorization = request.headers.get("authorization");
  if (!authorization) return json({error: "unauthorized"}, 401);
  const url = Deno.env.get("SUPABASE_URL")!;
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {global: {headers: {Authorization: authorization}}});
  const {data: auth, error: authError} = await caller.auth.getUser();
  if (authError || !auth.user) return json({error: "unauthorized"}, 401);
  let body: {home_id?: unknown; room_key?: unknown};
  try { body = await request.json(); } catch { return json({error: "invalid_body"}, 400); }
  if (!body || typeof body.home_id !== "string" || typeof body.room_key !== "string") return json({error: "invalid_body"}, 400);
  try {
    const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    return json(await readRoomDiagnostics(caller, service, body.home_id, body.room_key));
  } catch (error) {
    if (error instanceof RoomDiagnosticRevisionChanged) return json({error: "response_changed"}, 409);
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ROOM-DIAGNOSTICS]", message);
    return json({error: message.startsWith("Room access:") ? "access_denied" : "diagnostics_unavailable"}, message.startsWith("Room access:") ? 403 : 503);
  }
});
