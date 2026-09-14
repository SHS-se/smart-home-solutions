// deno run --allow-read scripts/compile-battery-policy.ts resolved-battery-case.json
import { compileBatteryPolicy } from "../supabase/functions/_shared/battery-policy.ts";
const [path, ...extra] = Deno.args;
if (!path || extra.length) {
  throw new Error(
    "Usage: compile-battery-policy.ts resolved-battery-case.json",
  );
}
if ((await Deno.stat(path)).size > 2_000_000) {
  throw new Error("Input file exceeds 2 MB limit");
}
const result = compileBatteryPolicy(JSON.parse(await Deno.readTextFile(path)));
console.log(JSON.stringify(result, null, 2));
if (result.status !== "compiled") Deno.exitCode = 1;
