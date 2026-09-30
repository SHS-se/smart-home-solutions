// A planner version is what the planner's code does, not the commit carrying
// it. Two commits share a version when the code their planner runs is the same
// once types, comments and formatting are stripped, so a commit that changes
// the website, the bench, tests, docs or only types gets no new bench entry.
//
// The planner is every module the bench's entry points reach through code
// imports (bench/planner-adapter.ts), plus the version's own bench/prepare.ts.

import { reach, type SourceTree } from "../scripts/module-graph.ts";

/** The planner's own folder; nothing in it imports from outside it. */
export const PLANNER_DIR = "supabase/functions/_shared/planner";
/** Where the planner lived, loose among other shared modules, before it had a folder. */
const LEGACY_DIR = "supabase/functions/_shared";
const ENTRIES = ["energy-optimisation.ts", "dispatch-plan.ts"];
const PREPARE = "bench/prepare.ts";

/** The folder holding a tree's planner: its own, or _shared for older commits. */
export const plannerDir = (tree: SourceTree) =>
  tree.isFile(`${PLANNER_DIR}/${ENTRIES[0]}`) ? PLANNER_DIR : LEGACY_DIR;

// Resolved from node_modules at run time, so a script that only needs
// PLANNER_DIR runs without them.
const ESBUILD = "npm:esbuild";

/**
 * The planner version of a source tree: `<method>:<sha-256>`. The method names
 * the minifier, so versions are compared only when computed the same way; the
 * bench recomputes stored versions whose method differs from the current one.
 */
export async function plannerVersion(tree: SourceTree): Promise<string> {
  const { transform, stop, version } = await import(ESBUILD);
  const dir = plannerDir(tree);
  const parts: string[] = [];
  try {
    for (const file of reach(tree, [...ENTRIES.map(entry => `${dir}/${entry}`), PREPARE])) {
      // Keyed inside the planner folder, so moving the folder is not a new version.
      const key = file.startsWith(`${dir}/`) ? `planner/${file.slice(dir.length + 1)}` : file;
      // Not minifyIdentifiers: its short names depend on the whole text, types included.
      const { code } = await transform(tree.read(file)!, {
        loader: file.endsWith("x") ? "tsx" : "ts", minifyWhitespace: true, minifySyntax: true, format: "esm",
      });
      parts.push(`${key}\n${code}`);
    }
  } finally {
    stop(); // its service process would otherwise keep Deno running
  }
  parts.sort();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n\0\n")));
  return `${versionMethod(version)}:${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

const versionMethod = (esbuild: string) => `v1-esbuild${esbuild}`;

/** The method prefix `plannerVersion` writes today. */
export async function currentVersionMethod(): Promise<string> {
  return versionMethod((await import(ESBUILD)).version);
}

/** A commit's files, read from git without checking it out. */
export function commitTree(sha: string, cwd: string): SourceTree {
  const git = (...args: string[]) => {
    const out = new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "null" }).outputSync();
    return out.success ? new TextDecoder().decode(out.stdout) : null;
  };
  const listing = git("ls-tree", "-r", "--name-only", sha);
  if (listing === null) throw new Error(`Unknown commit ${sha}`);
  const files = new Set(listing.split("\n"));
  const cache = new Map<string, string | null>();
  return {
    isFile: path => files.has(path),
    read: path => {
      if (!files.has(path)) return null;
      if (!cache.has(path)) cache.set(path, git("show", `${sha}:${path}`));
      return cache.get(path)!;
    },
  };
}
