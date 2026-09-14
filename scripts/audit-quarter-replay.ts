// deno run --allow-read scripts/audit-quarter-replay.ts capture.json [capture.json ...]
import { auditQuarterReplay } from "./lib/quarter-replay-audit.ts";

if (!Deno.args.length) {
  throw new Error(
    "Usage: audit-quarter-replay.ts capture.json [capture.json ...]",
  );
}
for (const path of Deno.args) {
  const result = auditQuarterReplay(JSON.parse(await Deno.readTextFile(path)));
  console.log(JSON.stringify({ path, ...result }, null, 2));
  if (result.status !== "passed") Deno.exitCode = 1;
}
