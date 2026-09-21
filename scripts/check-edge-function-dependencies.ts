/** Resolve deployment dependencies without the website's package.json/node_modules.
 * Cache, do not execute, entrypoints: no service credentials or live writes.
 */
import { cp } from "node:fs/promises";
import { join } from "node:path";

const source = new URL("../supabase/functions/", import.meta.url);
const staging = await Deno.makeTempDir({ prefix: "shs-edge-dependencies-" });
try {
  const functions = join(staging, "functions");
  await cp(source, functions, { recursive: true });
  // Check these entrypoints even if a config is accidentally removed: discovering
  // only existing deno.json files would silently skip the broken deployment.
  for (
    const name of [
      "energy-optimisation-battery-curve",
      "energy-optimisation-fixed-plan",
      "energy-optimisation-ingest",
      "energy-optimisation-plan-step",
    ]
  ) {
    const entry = join(functions, name);
    const result = await new Deno.Command(Deno.execPath(), {
      cwd: staging,
      args: [
        "cache",
        "--config",
        join(entry, "deno.json"),
        "--no-lock",
        "--node-modules-dir=none",
        join(entry, "index.ts"),
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!result.success) {
      throw new Error(`Deployment dependencies failed: ${name}`);
    }
    console.log(`Deployment dependencies resolved: ${name}`);
  }
} finally {
  await Deno.remove(staging, { recursive: true });
}
