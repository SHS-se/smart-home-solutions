import { readdirSync } from "node:fs";
import { join } from "node:path";

export const TEST_DIRECTORIES = ["tests", "src/lib", "supabase/functions"];
const TEST_OPTIONS = [
  "test", "--parallel", "--no-check", "--sloppy-imports",
  "--allow-read", "--allow-write", "--allow-run", "--allow-env",
];

// Relative file costs from the 2026-10-05 CI log. Keep the expensive planner
// modules apart; distribute every other (including newly added) test as well.
// These are scheduling weights, never a filter on which tests run.
const COSTS: Record<string, number> = {
  "supabase/functions/_shared/energy-planning-step.test.ts": 153,
  "supabase/functions/_shared/energy-planning-step-dark.test.ts": 208,
  "supabase/functions/_shared/energy-planning-step-sunny.test.ts": 93,
  "supabase/functions/_shared/replan-continuity.test.ts": 338,
  "supabase/functions/_shared/planner/energy-optimisation-allocation.test.ts": 269,
  "supabase/functions/_shared/planner/energy-optimisation.test.ts": 213,
  "src/lib/energy-shift/planner-value-stores.test.ts": 118,
  "tests/bench-adapter.test.ts": 113,
  "supabase/functions/_shared/energy-optimisation-ev.test.ts": 96,
  "supabase/functions/_shared/battery-curve-override.test.ts": 62,
  "src/lib/energy-shift/plan-workbench.test.ts": 37,
};

export function testFiles(root: string): string[] {
  const files: string[] = [];
  const script = /\.(?:[cm]?[jt]s|[jt]sx)$/;
  const test = /(?:^|[_.])test\.(?:[cm]?[jt]s|[jt]sx)$/;
  const walk = (directory: string, inTests = false) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path, inTests || entry.name === "__tests__");
      else if (entry.isFile() && (test.test(entry.name) || inTests && script.test(entry.name))) files.push(path);
    }
  };
  for (const directory of TEST_DIRECTORIES) walk(directory);
  return files.sort();
}

export function shardFiles(files: readonly string[], count: number): string[][] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Shard count must be a positive integer");
  const shards = Array.from({ length: count }, () => ({ cost: 0, files: [] as string[] }));
  const cost = (file: string) => COSTS[file] ?? 1;
  const ordered = [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of ordered) {
    const next = shards.reduce((best, shard) => shard.cost < best.cost ? shard : best);
    next.files.push(file);
    next.cost += cost(file);
  }
  return shards.map(shard => shard.files.sort());
}

export function testArguments(args: string[], root: string): string[] {
  if (!args.length) return [...TEST_OPTIONS, ...TEST_DIRECTORIES.map(directory => `${directory}/`)];
  const match = args.length === 2 && args[0] === "--shard" && /^(\d+)\/(\d+)$/.exec(args[1]);
  if (!match) throw new Error("Usage: deno task test [--shard INDEX/COUNT]");
  const index = Number(match[1]), count = Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 1 || index > count) throw new Error("Shard index must be between 1 and COUNT");
  const files = testFiles(root);
  const selected = shardFiles(files, count)[index - 1];
  if (!selected.length) throw new Error("Test shard is empty");
  console.log(`Unit test shard ${index}/${count}: ${selected.length} of ${files.length} files`);
  return [...TEST_OPTIONS, ...selected];
}

if (import.meta.main) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: testArguments(Deno.args, Deno.cwd()),
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  }).spawn().status;
  Deno.exit(result.code);
}
