// deno run --allow-read scripts/compile-battery-coverage.ts regional-battery-case.json
import { compileBatteryPolicyCoverage } from "../supabase/functions/_shared/battery-policy-coverage.ts";
const [path, ...extra] = Deno.args;
if (!path || extra.length) {
  throw new Error(
    "Usage: compile-battery-coverage.ts regional-battery-case.json",
  );
}
if ((await Deno.stat(path)).size > 2_000_000) {
  throw new Error("Input exceeds 2 MB");
}
const result = compileBatteryPolicyCoverage(
  JSON.parse(await Deno.readTextFile(path)),
);
console.log(JSON.stringify(result, null, 2));
if (
  result.status !== "compiled" ||
  !result.cells.some((c) => c.status === "accepted_empirical")
) Deno.exitCode = 1;
