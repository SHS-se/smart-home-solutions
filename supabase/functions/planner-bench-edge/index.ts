import { CASE_ID, EdgeBench, SHA } from "../../../bench/edge-runner.ts";
import { BENCH_TOKEN_HEADER, BENCH_URL, benchWorkerToken } from "../../../bench/edge-version.ts";

Deno.serve(async request => {
  if (Deno.env.get("SUPABASE_URL") !== BENCH_URL) return Response.json({ error: "test_only" }, { status: 403 });
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = benchWorkerToken();
  if (!key || !token) return Response.json({ error: "not_configured" }, { status: 503 });
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  try {
    const body = await request.json();
    const { action, sha, scenario, environment } = body;
    const bench = new EdgeBench(key, token);
    const internal = request.headers.get(BENCH_TOKEN_HEADER) === token;
    if (action === "verify" || action === "advance" || action === "deployment") {
      if (!internal) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (action === "advance") {
        await bench.advance();
        return new Response(null, { status: 204 });
      }
      if (action === "verify") {
        if (!SHA.test(sha) || !CASE_ID.test(scenario)) return Response.json({ error: "invalid_verification_request" }, { status: 400 });
        const result = await bench.verify(sha, scenario);
        return Response.json(result, { status: Object.values(result.matches).every(Boolean) ? 200 : 409 });
      }
      if (!SHA.test(sha) || (environment !== "test" && environment !== "production")) {
        return Response.json({ error: "invalid_deployment" }, { status: 400 });
      }
      const active = await bench.rpc<boolean>("bench_edge_deployment", { p_sha: sha, p_environment: environment });
      return Response.json({ id: active ? await bench.enqueue({ shas: "heads" }, "deployment") : null });
    }
    const bearer = (request.headers.get("authorization") ?? "").replace(/^bearer\s+/i, "");
    if (!internal && (!bearer || !await bench.staff(bearer))) return Response.json({ error: "staff_only" }, { status: 403 });
    if (action === "status") return Response.json({ run: await bench.rpc("bench_edge_status") });
    if (action !== undefined) return Response.json({ error: "invalid_action" }, { status: 400 });
    return Response.json({ ok: true, id: await bench.enqueue(body, "staff") }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
  }
});
