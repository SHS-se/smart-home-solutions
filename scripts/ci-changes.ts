/** Decide which CI and deploy jobs a set of changed files needs.
 *
 * The website and the edge functions import each other's modules (the portal
 * renders planner code from supabase/functions/_shared, functions import from
 * src/lib), so a folder rule cannot tell a planner change from a website change.
 * Instead each deploy target is the set of files its entry points reach through
 * local imports: a change affects a target only when that target reaches it.
 *
 * Usage: deno run -A scripts/ci-changes.ts --base <sha> [--workflow <file>]
 * An empty or unreachable base (first push, force push) means everything
 * changed. Writes key=value lines to $GITHUB_OUTPUT when it is set.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Changes {
  /** Anything beyond documentation: lint, typecheck and unit tests run. */
  code: boolean;
  /** The website build: build, e2e and the Pages deploy run. */
  frontend: boolean;
  migrations: boolean;
  /** Edge functions to deploy, by name. */
  functions: string[];
  /** The planner the bench replays. */
  planner: boolean;
}

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
// `import … from "x"` and `export … from "x"`, skipping `import type`, which
// leaves no code behind; then `import "x"` and `import("x")`. A match inside a
// comment only over-includes.
const FROM = /\b(?:import|export)\s+(type\s)?[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\2/g;
const BARE = /\bimport\s*\(?\s*(['"])([^'"\n]+)\1/g;

const specifiers = (text: string) => [
  ...[...text.matchAll(FROM)].filter(m => !m[1]).map(m => m[3]),
  ...[...text.matchAll(BARE)].map(m => m[2]),
];

const isFile = (path: string) => {
  try { return statSync(path).isFile(); } catch { return false; }
};

/** Repository-relative path of a local import, or null for packages and URLs. */
function resolve(root: string, from: string, specifier: string): string | null {
  const bare = specifier.split("?")[0];
  let base: string;
  if (bare.startsWith("./") || bare.startsWith("../")) base = join(dirname(from), bare);
  else if (bare.startsWith("@/")) base = `src/${bare.slice(2)}`;
  else return null;
  return EXTENSIONS.map(ext => base + ext).find(candidate => isFile(join(root, candidate))) ?? null;
}

/** Every local file the entry points reach, entries included. */
export function reach(root: string, entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.filter(e => existsSync(join(root, e)));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(tsx?|jsx?|mjs)$/.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const specifier of specifiers(text)) {
      const next = resolve(root, file, specifier);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

const isDoc = (f: string) => f.endsWith(".md") || f.startsWith("docs/");
const isTest = (f: string) => /\.test\.tsx?$/.test(f);

/** Build inputs that are not imported but still change the website. */
const FRONTEND_FILES = [
  "index.html", "package.json", "package-lock.json", "vite.config.ts", "tailwind.config.ts",
  "postcss.config.js", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "components.json",
  "wrangler.toml", ".env", ".env.test", "playwright.config.ts", "playwright.local.config.ts",
  "scripts/verify-pages-deployment.mjs",
];

export function functionNames(root: string): string[] {
  const dir = join(root, "supabase/functions");
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(dir, d.name, "index.ts")))
    .map(d => d.name)
    .sort();
}

export function classify(root: string, changed: readonly string[] | "all"): Changes {
  const names = functionNames(root);
  if (changed === "all") return { code: true, frontend: true, migrations: true, functions: names, planner: true };

  const any = (test: (f: string) => boolean) => changed.some(test);
  const touches = (files: Set<string>) => any(f => files.has(f));

  const frontendGraph = reach(root, ["src/main.tsx", "vite.config.ts"]);
  const frontend = touches(frontendGraph)
    || any(f => FRONTEND_FILES.includes(f) || f.startsWith("public/") || f.startsWith("e2e/")
      || (f.startsWith("src/") && !isTest(f) && !isDoc(f)));

  const allFunctions = any(f => f === "supabase/config.toml" || f === "supabase/functions/deno.json");
  const functions = names.filter(name => {
    if (allFunctions) return true;
    const dir = `supabase/functions/${name}/`;
    const graph = reach(root, [`${dir}index.ts`]);
    if (name === "energy-optimisation-plan-step") graph.add("scripts/deploy-energy-planning.sh");
    return any(f => (f.startsWith(dir) && !isTest(f) && !isDoc(f)) || (graph.has(f) && !isTest(f)));
  });

  // The bench loads these by path from each planner commit (bench/planner-adapter.ts).
  const plannerGraph = reach(root, [
    "supabase/functions/_shared/energy-optimisation.ts",
    "supabase/functions/_shared/dispatch-plan.ts",
    "bench/prepare.ts",
    "bench/run.ts",
  ]);
  const planner = any(f => (plannerGraph.has(f) && !isTest(f)) || f === "bench/schema.sql");

  return {
    code: any(f => !isDoc(f)),
    frontend,
    migrations: any(f => f.startsWith("supabase/migrations/")),
    functions,
    planner,
  };
}

function git(args: string[]): { ok: boolean; out: string } {
  const result = new Deno.Command("git", { args, stdout: "piped", stderr: "null" }).outputSync();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim() };
}

/** Files changed from `base` to HEAD, or "all" when there is no usable base. */
export function changedSince(base: string, workflowFiles: readonly string[]): readonly string[] | "all" {
  if (!base || /^0+$/.test(base)) return "all";
  if (!git(["merge-base", "--is-ancestor", base, "HEAD"]).ok) return "all";
  const diff = git(["diff", "--name-only", "--no-renames", base, "HEAD"]);
  if (!diff.ok) return "all";
  const files = diff.out ? diff.out.split("\n") : [];
  // A changed pipeline may deploy differently, so it redeploys everything.
  return files.some(f => workflowFiles.includes(f)) ? "all" : files;
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = Deno.args.indexOf(`--${name}`);
    return i >= 0 ? Deno.args[i + 1] ?? "" : "";
  };
  const workflow = arg("workflow");
  const changed = changedSince(arg("base"), [
    "scripts/ci-changes.ts",
    ...(workflow ? [`.github/workflows/${workflow}`] : []),
  ]);
  const c = classify(Deno.cwd(), changed);
  const lines = [
    `code=${c.code}`,
    `frontend=${c.frontend}`,
    `migrations=${c.migrations}`,
    `functions=${c.functions.join(" ")}`,
    `planner=${c.planner}`,
  ];
  console.log(changed === "all" ? "Changed: everything" : `Changed files (${changed.length}):\n  ${changed.join("\n  ")}`);
  console.log(lines.join("\n"));
  const out = Deno.env.get("GITHUB_OUTPUT");
  if (out) Deno.writeTextFileSync(out, lines.join("\n") + "\n", { append: true });
}
