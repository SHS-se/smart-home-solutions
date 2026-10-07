// A planner version is what the planner's code does, not the commit carrying
// it. Two commits share a version when the code their planner runs is the same
// once types, comments and formatting are stripped, so a commit that changes
// the website, the bench, tests, docs or only types keeps the same code hash.
//
// The planner is every module reached through code imports from the entry
// points the bench calls (bench/adapter.ts).

import { reach, type SourceTree } from "../scripts/module-graph.ts";

/** The planner's own folder; nothing in it imports from outside it. */
export const PLANNER_DIR = "supabase/functions/_shared/planner";
/** Where the planner lived, loose among other shared modules, before it had a folder. */
const LEGACY_DIR = "supabase/functions/_shared";
/** `planning-basis.ts` exists only in planners that build a basis from history; the adapter calls it for those. */
const ENTRIES = ["energy-optimisation.ts", "dispatch-plan.ts", "planning-basis.ts"];

/** The folder holding a tree's planner; null for commits with no planner. */
export const plannerDir = (tree: SourceTree): string | null =>
  [PLANNER_DIR, LEGACY_DIR].find(dir => tree.isFile(`${dir}/${ENTRIES[0]}`)) ?? null;

// Resolved from node_modules at run time, so a script that only needs
// PLANNER_DIR runs without them.
const ESBUILD = "npm:esbuild";

/**
 * The planner version of a source tree: `<method>:<sha-256>`. The method names
 * the minifier, so versions are compared only when computed the same way; the
 * runner records the current method when a commit is benched.
 */
export async function plannerVersion(tree: SourceTree): Promise<string> {
  const dir = plannerDir(tree);
  if (dir === null) throw new Error("This commit does not contain a planner entry point.");
  const { transform, stop, version } = await import(ESBUILD);
  const parts: string[] = [];
  try {
    for (const file of reach(tree, ENTRIES.map(entry => `${dir}/${entry}`))) {
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

const versionMethod = (esbuild: string) => `v2-esbuild${esbuild}`;

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
