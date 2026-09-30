// Add replay files to the bench as test cases, from the command line.
// The bench page does the same one file at a time.
//
//   deno run -A --sloppy-imports --config deno.json bench/seed.ts NAME=path/to/plan-replay.json [...]
//
// Needs BENCH_SUPABASE_URL and BENCH_SERVICE_ROLE_KEY. A case whose replay
// input hash is already on the bench is skipped, so re-running is harmless.

import { stripReplay } from "../src/lib/planner-bench/strip.ts";

const url = Deno.env.get("BENCH_SUPABASE_URL"), key = Deno.env.get("BENCH_SERVICE_ROLE_KEY");
if (!url || !key) throw new Error("Set BENCH_SUPABASE_URL and BENCH_SERVICE_ROLE_KEY.");
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

for (const arg of Deno.args) {
  const at = arg.indexOf("=");
  if (at < 1) throw new Error(`Expected NAME=path, got ${arg}`);
  const name = arg.slice(0, at), path = arg.slice(at + 1);
  const stripped = stripReplay(JSON.parse(await Deno.readTextFile(path)));
  if (stripped.inputHash) {
    const existing = await (await fetch(`${url}/rest/v1/bench_scenarios?select=id&input_hash=eq.${encodeURIComponent(stripped.inputHash)}`, { headers })).json();
    if (Array.isArray(existing) && existing.length) {
      console.log(`${name}: already on the bench (${existing[0].id})`);
      continue;
    }
  }
  const response = await fetch(`${url}/rest/v1/bench_scenarios`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({
      name, captured_at: stripped.capturedAt, source_filename: path.split("/").pop(),
      input_hash: stripped.inputHash, input: stripped.input,
    }),
  });
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
  const [row] = await response.json();
  console.log(`${name}: added ${row.id} (${Math.round(JSON.stringify(stripped.input).length / 1024)} kB kept)`);
}
