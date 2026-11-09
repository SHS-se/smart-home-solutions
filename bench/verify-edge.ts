import { BENCH_TOKEN_HEADER, BENCH_URL } from "./edge-version.ts";

const key = Deno.env.get("BENCH_SERVICE_ROLE_KEY");
const token = Deno.env.get("PLANNER_BENCH_EDGE_TOKEN");
const refs = Deno.args;
if (!key || !token || !refs.length || refs.some(sha => !/^[0-9a-f]{40}$/.test(sha))) {
  throw new Error("Set the TEST service key and Edge bench token and supply one or more exact commit SHAs");
}
const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", [BENCH_TOKEN_HEADER]: token };
const response = await fetch(`${BENCH_URL}/rest/v1/bench_edge_ready_cases?select=id&order=id`, { headers });
if (!response.ok) throw new Error(`Read TEST case coverage: ${response.status}`);
const cases = await response.json() as { id: string }[];
if (cases.length !== 24) throw new Error(`Expected 24 ready TEST cases, found ${cases.length}`);
let failed = false;
for (const sha of refs) {
  let verified = 0;
  for (let from = 0; from < cases.length; from += 2) {
    await Promise.all(cases.slice(from, from + 2).map(async ({ id }, index) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await fetch(`${BENCH_URL}/functions/v1/planner-bench-edge`, { method: "POST", headers,
          signal: AbortSignal.timeout(45_000), body: JSON.stringify({ action: "verify", sha, scenario: id }) });
        const evidence = await result.json() as { matches?: Record<string, boolean>; error?: string };
        if (result.ok && evidence.matches && Object.values(evidence.matches).every(Boolean)) {
          verified++;
          return;
        }
        if (attempt < 3 && (result.status >= 500 || /\(546\)/.test(evidence.error ?? ""))) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }
        const differences = Object.entries(evidence.matches ?? {}).filter(([, match]) => !match).map(([field]) => field);
        console.error(`${sha.slice(0, 12)} case ${from + index + 1}: ${result.status} ${differences.join(", ") || evidence.error || "request failed"}`);
        return;
      }
    }));
  }
  console.log(`${sha.slice(0, 12)}: ${verified}/${cases.length} exact case matches`);
  failed ||= verified !== cases.length;
}
if (failed) Deno.exit(1);
