// Start the planner bench workflow from the bench page (docs/planner-bench/README.md).
//
// The browser cannot hold a GitHub token, so staff ask this function and it
// dispatches .github/workflows/planner-bench.yml on dev with their inputs.
// Needs the PLANNER_BENCH_GITHUB_TOKEN secret: a fine-grained token for
// SHS-se/smart-home-solutions with "Actions: read and write". It is set only in
// the TEST project; elsewhere the function answers `not_configured`.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const REPOSITORY = "SHS-se/smart-home-solutions";
const WORKFLOW = "planner-bench.yml";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const githubToken = Deno.env.get("PLANNER_BENCH_GITHUB_TOKEN");
  if (!url || !serviceKey) return json({ error: "Server configuration error" }, 500);
  if (!githubToken) return json({ error: "not_configured", message: "PLANNER_BENCH_GITHUB_TOKEN is not set in this project." }, 503);

  const token = (request.headers.get("Authorization") ?? "").replace(/^bearer\s+/i, "").trim();
  if (!token) return json({ error: "Unauthorized" }, 401);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json({ error: "Unauthorized" }, 401);
  const { data: staff, error: staffError } = await admin.from("staff_users").select("role").eq("user_id", user.id).maybeSingle();
  if (staffError) return json({ error: "Failed to verify staff access" }, 500);
  if (!staff) return json({ error: "Staff only" }, 403);

  let inputs: { shas: string; scenario: string; force: string };
  try {
    const body = await request.json();
    const shas = String(body?.shas ?? "all").trim();
    const scenario = String(body?.scenario ?? "").trim();
    if (!/^(all|none|[0-9a-f]{7,40}(,[0-9a-f]{7,40})*)$/.test(shas)) return json({ error: "shas must be 'all', 'none' or commit SHAs" }, 400);
    if (scenario && !/^[0-9a-f-]{36}$/.test(scenario)) return json({ error: "scenario must be a test case id" }, 400);
    inputs = { shas, scenario, force: body?.force ? "true" : "false" };
  } catch {
    return json({ error: "invalid_body" }, 400);
  }

  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shs-planner-bench",
    },
    body: JSON.stringify({ ref: "dev", inputs }),
  });
  if (!response.ok) {
    console.error("[PLANNER-BENCH] dispatch failed", response.status, await response.text());
    return json({ error: "dispatch_failed", status: response.status }, 502);
  }
  return json({ ok: true, runs_url: `https://github.com/${REPOSITORY}/actions/workflows/${WORKFLOW}` });
});
