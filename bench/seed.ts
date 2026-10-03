// Add replay files to the bench as test cases, from the command line.
// The bench page does the same one file at a time.
//
//   deno run -A --sloppy-imports --config deno.json bench/seed.ts NAME=path/to/plan-replay.json [...]
//
// Needs BENCH_SUPABASE_URL and BENCH_SERVICE_ROLE_KEY. Each replay is converted
// to a test case (src/lib/planner-bench/convert-replay.ts); the next bench run
// fills in what the home recorded for its 72 hours. A case file, as
// seed-history.ts writes them, is added as it is, with what it recorded. A
// case whose name is already on the bench is skipped, so re-running is
// harmless.

import { parseRecorded, parseScenarioData } from "../src/lib/planner-bench/case.ts";
import { caseFromReplay } from "../src/lib/planner-bench/convert-replay.ts";

const url = Deno.env.get("BENCH_SUPABASE_URL"), key = Deno.env.get("BENCH_SERVICE_ROLE_KEY");
if (!url || !key) throw new Error("Set BENCH_SUPABASE_URL and BENCH_SERVICE_ROLE_KEY.");
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

for (const arg of Deno.args) {
  const at = arg.indexOf("=");
  if (at < 1) throw new Error(`Expected NAME=path, got ${arg}`);
  const name = arg.slice(0, at), path = arg.slice(at + 1);
  const filename = path.split("/").pop()!;
  const file = JSON.parse(await Deno.readTextFile(path));
  const data = file.dataset ? parseScenarioData(file.dataset) : caseFromReplay(file, filename).data;
  const recorded = file.dataset && file.recorded ? parseRecorded(file.recorded) : null;
  const existing = await (await fetch(`${url}/rest/v1/bench_scenarios?select=id&name=eq.${encodeURIComponent(name)}`, { headers })).json();
  if (Array.isArray(existing) && existing.length) {
    console.log(`${name}: already on the bench (${existing[0].id})`);
    continue;
  }
  const response = await fetch(`${url}/rest/v1/bench_scenarios`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({ name, captured_at: data.start, source_filename: filename, dataset: data, ...(recorded ? { recorded } : {}) }),
  });
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
  const [row] = await response.json();
  console.log(`${name}: added ${row.id}, 72 hours from ${data.start}`);
}
