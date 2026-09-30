/** Local import graph of TypeScript modules, read from disk or from a commit.
 *
 * Only relative and `@/` imports are local; packages and URLs are not followed.
 * A match inside a comment only over-includes.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SourceTree {
  /** Repository-relative file contents, or null when there is no such file. */
  read(path: string): string | null;
  isFile(path: string): boolean;
}

export function diskTree(root: string): SourceTree {
  return {
    read: path => {
      try { return readFileSync(join(root, path), "utf8"); } catch { return null; }
    },
    isFile: path => {
      try { return statSync(join(root, path)).isFile(); } catch { return false; }
    },
  };
}

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
// `import … from "x"` and `export … from "x"` (group 1 marks `import type`),
// then `import "x"` and `import("x")`.
const FROM = /\b(?:import|export)\s+(type\s)?[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\2/g;
// A side-effect import starts a statement, so `"import" | "export"` is not one.
const BARE = /(?:^|[;}])\s*import\s*(['"])([^'"\n]+)\1|\bimport\s*\(\s*(['"])([^'"\n]+)\3/gm;

/**
 * Every specifier a module imports. Without `types`, `import type` is left
 * out: it leaves no code behind, so it cannot change what the module does.
 */
export function specifiers(text: string, { types = false } = {}): string[] {
  return [
    ...[...text.matchAll(FROM)].filter(m => types || !m[1]).map(m => m[3]),
    ...[...text.matchAll(BARE)].map(m => m[2] ?? m[4]),
  ];
}

/** Repository-relative path of a local import, or null for packages and URLs. */
export function resolve(tree: SourceTree, from: string, specifier: string): string | null {
  const bare = specifier.split("?")[0];
  let base: string;
  if (bare.startsWith("./") || bare.startsWith("../")) base = join(dirname(from), bare);
  else if (bare.startsWith("@/")) base = `src/${bare.slice(2)}`;
  else return null;
  return EXTENSIONS.map(ext => base + ext).find(candidate => tree.isFile(candidate)) ?? null;
}

/** Every local file the entry points reach through code imports, entries included. */
export function reach(tree: SourceTree, entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.filter(e => tree.isFile(e));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(tsx?|jsx?|mjs)$/.test(file)) continue;
    for (const specifier of specifiers(tree.read(file) ?? "")) {
      const next = resolve(tree, file, specifier);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}
