import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import { PlanningJobs } from "../_shared/energy-planning-jobs.ts";
import { HA_UUID } from "../_shared/ha-api-contract.ts";

// Database-owned wakes carry only a job identity. Claims and fencing make
// duplicate wakes harmless and keep all household data behind the service role.
Deno.serve(withTrafficMetrics("energy-optimisation-planning-worker", async (request, traffic) => {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const token = request.headers.get("x-energy-planning-token");
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false }, global: { fetch: traffic.fetch } });
  const { data: authorised, error } = await db.rpc("verify_energy_planning_token", { p_token: token });
  if (error) return Response.json({ error: "authentication_unavailable" }, { status: 503 });
  if (authorised !== true) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (Number(request.headers.get("content-length")) > 256) return Response.json({ error: "request_too_large" }, { status: 413 });
  let jobId: string;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 256) return Response.json({ error: "request_too_large" }, { status: 413 });
    const body = JSON.parse(raw);
    if (typeof body?.job_id !== "string" || !HA_UUID.test(body.job_id) || Object.keys(body).length !== 1) throw new Error("job_id");
    jobId = body.job_id;
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  await new PlanningJobs(db).advance(jobId);
  return new Response(null, { status: 204 });
}));
