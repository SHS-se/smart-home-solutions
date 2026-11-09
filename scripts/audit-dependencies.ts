/** Audit every npm package version the website and the deployed edge functions
 * resolve, and fail on a high or critical advisory.
 *
 * GitHub's Dependabot reads only package-lock.json. Edge functions resolve their
 * own dependencies at deploy time (esm.sh URLs, npm: specifiers, per-function
 * deno.json pins), so this resolves them the way deployment does — in a staged
 * copy without the website's package.json or node_modules — and audits the
 * exact versions in the resulting Deno locks, including what esm.sh bundles in.
 *
 * Allow a blocking advisory only with a reason and an expiry date in
 * .github/dependency-audit-allowlist.json; an expired entry fails the audit.
 *
 * Usage: deno task audit:dependencies
 */
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bundleBenchFunction, BUNDLED_BENCH_FUNCTIONS } from "../bench/edge-bundle.ts";
import {
  addDenoLock,
  addPackageLock,
  type Advisories,
  advisoryRequest,
  BLOCKING,
  type Finding,
  findings,
  Inventory,
  parseAllowances,
  verdict,
} from "./lib/dependency-audit.ts";

const root = new URL("..", import.meta.url).pathname;
const ADVISORY_ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const ALLOWLIST = join(root, ".github/dependency-audit-allowlist.json");

const inventory = new Inventory();
addPackageLock(inventory, JSON.parse(await Deno.readTextFile(join(root, "package-lock.json"))), "package-lock.json");
const unaudited = await addEdgeFunctions(inventory);

const advisories = await fetchAdvisories(advisoryRequest(inventory.packages));
const found = findings(inventory, advisories);
const allowances = parseAllowances(await Deno.readTextFile(ALLOWLIST));
const result = verdict(found, allowances, new Date().toISOString().slice(0, 10));

const versions = [...inventory.packages.values()].reduce((sum, set) => sum + set.size, 0);
console.log(`Audited ${versions} versions of ${inventory.packages.size} npm packages (website lockfile and deployed edge functions).`);
if (unaudited.length) console.log(`Not in the npm advisory database, not audited: ${unaudited.join(", ")}`);
report("Below the blocking level", result.notes);
report("Allowed until their allowlist expiry", result.allowed);
for (const entry of result.expired) {
  console.error(`Expired allowlist entry ${entry.id} (expired ${entry.expires}): ${entry.reason}`);
}
report(`Blocking (${BLOCKING} or worse)`, result.blocking);

if (result.blocking.length || result.expired.length) {
  console.error(
    "\nUpgrade the affected packages (sources above say where each version comes from). If no fix exists, " +
      "add the advisory to .github/dependency-audit-allowlist.json with a reason and an expiry date.",
  );
  Deno.exit(1);
}
console.log(`No unallowed ${BLOCKING} or critical advisories.`);

function report(heading: string, list: Finding[]) {
  if (!list.length) return;
  const write = list === result.blocking ? console.error : console.log;
  write(`\n${heading}:`);
  for (const f of list) {
    write(`  ${f.severity.padEnd(8)} ${f.name}@${f.version}  ${f.id}  ${f.title}`);
    write(`           from ${f.sources.join(", ")}`);
  }
}

/** Resolve each deployment group in isolation: one Deno lock per function
 * config, plus one for every function deployed without its own deno.json. */
async function addEdgeFunctions(inventory: Inventory): Promise<string[]> {
  const staging = await Deno.makeTempDir({ prefix: "shs-dependency-audit-" });
  try {
    // Functions import shared code from src/, so keep the repository layout.
    await mkdir(join(staging, "supabase"), { recursive: true });
    await cp(join(root, "supabase/functions"), join(staging, "supabase/functions"), { recursive: true });
    await cp(join(root, "src"), join(staging, "src"), { recursive: true });

    const plain: string[] = [];
    const configured: string[] = [];
    const bundled: string[] = [];
    for await (const entry of Deno.readDir(join(staging, "supabase/functions"))) {
      if (!entry.isDirectory || entry.name.startsWith("_")) continue;
      const dir = join("supabase/functions", entry.name);
      if (!await exists(join(staging, dir, "index.ts"))) continue;
      if (BUNDLED_BENCH_FUNCTIONS.includes(entry.name)) {
        // npm dependencies compiled into the bundle are already in package-lock.json.
        // Audit any remaining remote imports from the exact deployment entry point.
        const output = join(staging, dir, "audit-entry.js");
        await bundleBenchFunction(root, join(root, dir, "index.ts"), output);
        bundled.push(output);
        continue;
      }
      (await exists(join(staging, dir, "deno.json")) ? configured : plain).push(entry.name);
    }
    plain.sort();
    configured.sort();

    const unaudited = new Set<string>();
    const groups = [
      { label: "edge functions", config: null, entries: [...plain.map(entryPoint), ...bundled] },
      ...configured.map((name) => ({ label: `edge function ${name}`, config: name, entries: [entryPoint(name)] })),
    ];
    for (const [index, group] of groups.entries()) {
      if (!group.entries.length) continue;
      const lock = join(staging, `audit-${index}.lock`);
      const args = ["cache", `--lock=${lock}`, "--node-modules-dir=none", "--quiet"];
      if (group.config) args.push("--config", join("supabase/functions", group.config, "deno.json"));
      args.push(...group.entries);
      const output = await new Deno.Command(Deno.execPath(), { cwd: staging, args, stdout: "inherit", stderr: "inherit" }).output();
      if (!output.success) throw new Error(`Could not resolve dependencies for ${group.label}`);
      for (const module of addDenoLock(inventory, JSON.parse(await Deno.readTextFile(lock)), group.label)) {
        unaudited.add(module);
      }
    }
    return [...unaudited].sort();
  } finally {
    await Deno.remove(staging, { recursive: true });
  }
}

function entryPoint(name: string): string {
  return join("supabase/functions", name, "index.ts");
}

async function fetchAdvisories(body: Record<string, string[]>): Promise<Advisories> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(ADVISORY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) return await response.json() as Advisories;
      lastError = new Error(`${response.status} ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
  throw new Error(`npm advisory lookup failed: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
