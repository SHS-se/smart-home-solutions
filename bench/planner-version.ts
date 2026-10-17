// A planner version is what the planner's code does, not the commit carrying
// it. Two commits share a version when the code their planner runs is the same
// once types, comments and formatting are stripped, so a commit that changes
// the website, the bench, tests, docs or only types keeps the same code hash.
//
// The planner is every module reached through code imports from the entry
// points the bench calls (bench/adapter.ts).

import { type SourceTree } from "../scripts/module-graph.ts";

/** The planner's own folder; nothing in it imports from outside it. */
export const PLANNER_DIR = "supabase/functions/_shared/planner";
export const WASM_PLANNER_DIR = "supabase/functions/_shared/planner-wasm";
export const BENCH_ENGINE_FILE = "bench/planner-engine.json";

/** A committed selection applies only to this commit's bench execution. */
export function usesRulePlanner(tree: SourceTree): boolean {
  const source = tree.read(BENCH_ENGINE_FILE);
  // Earlier commits precede explicit bench engine selection and retain their
  // historical TypeScript entry point. A configured engine never falls back.
  if (source === null) return false;
  const selection: unknown = JSON.parse(source);
  if (
    typeof selection !== "object" || selection === null ||
    !("engine" in selection) || selection.engine !== "rule-wasm" ||
    !("scope" in selection) || !["bench-only", "test-live"].includes(String(selection.scope)) ||
    Object.keys(selection).length !== 2
  ) throw new Error("Unsupported committed bench engine selection.");
  return true;
}
export const plannerDir = (tree: SourceTree): string | null => usesRulePlanner(tree) ? WASM_PLANNER_DIR : null;

export async function plannerVersion(tree: SourceTree): Promise<string> {
  if (usesRulePlanner(tree)) {
    const manifest = tree.read(`${WASM_PLANNER_DIR}/artifact.json`);
    if (
      !manifest || !tree.isFile(`${WASM_PLANNER_DIR}/solver.wasm`) ||
      !tree.isFile("bench/wasm-planner.ts")
    ) throw new Error("Selected rule planner artifact is missing.");
    const artifact: unknown = JSON.parse(manifest);
    if (
      typeof artifact !== "object" || artifact === null ||
      !("abi" in artifact) || (artifact.abi !== 2 && artifact.abi !== 3 && artifact.abi !== 4 && artifact.abi !== 5 && artifact.abi !== 6 && artifact.abi !== 7 && artifact.abi !== 8 && artifact.abi !== 9 && artifact.abi !== 10) ||
      !("wasm_sha256" in artifact) ||
      typeof artifact.wasm_sha256 !== "string" ||
      !("source_sha256" in artifact) ||
      typeof artifact.source_sha256 !== "string"
    ) throw new Error("Selected rule planner artifact is invalid.");
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        engine: tree.read(BENCH_ENGINE_FILE),
        binary: artifact.wasm_sha256,
        source: artifact.source_sha256,
      }),
    );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `v${artifact.abi}-rule-wasm:${
      [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0"))
        .join("")
    }`;
  }
  throw new Error("This commit has no supported native rules planner artifact.");
}

/** A commit's files, read from git without checking it out. */
export function commitTree(sha: string, cwd: string): SourceTree {
  const git = (...args: string[]) => {
    const out = new Deno.Command("git", {
      args,
      cwd,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    return out.success ? new TextDecoder().decode(out.stdout) : null;
  };
  const listing = git("ls-tree", "-r", "--name-only", sha);
  if (listing === null) throw new Error(`Unknown commit ${sha}`);
  const files = new Set(listing.split("\n"));
  const cache = new Map<string, string | null>();
  return {
    isFile: (path) => files.has(path),
    read: (path) => {
      if (!files.has(path)) return null;
      if (!cache.has(path)) cache.set(path, git("show", `${sha}:${path}`));
      return cache.get(path)!;
    },
  };
}
