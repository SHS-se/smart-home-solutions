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
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { diskTree, reach } from "./module-graph.ts";
import { PLANNER_DIR } from "../bench/planner-version.ts";

export interface Changes {
  /** Anything beyond documentation: lint, typecheck and unit tests run. */
  code: boolean;
  /** The website build: build, e2e and the Pages deploy run. */
  frontend: boolean;
  migrations: boolean;
  /** Edge functions to deploy, by name. */
  functions: string[];
  /** The planner the bench runs. */
  planner: boolean;
  /** The bench's own input and judgement: household, adapter, referee, scorer. */
  bench: boolean;
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
  if (changed === "all") return { code: true, frontend: true, migrations: true, functions: names, planner: true, bench: true };

  const any = (test: (f: string) => boolean) => changed.some(test);
  const touches = (files: Set<string>) => any(f => files.has(f));

  const tree = diskTree(root);
  const frontendGraph = reach(tree, ["src/main.tsx", "vite.config.ts"]);
  const frontend = touches(frontendGraph)
    || any(f => FRONTEND_FILES.includes(f) || f.startsWith("public/") || f.startsWith("e2e/")
      || (f.startsWith("src/") && !isTest(f) && !isDoc(f)));

  const allFunctions = any(f => f === "supabase/config.toml" || f === "supabase/functions/deno.json");
  const functions = names.filter(name => {
    if (allFunctions) return true;
    const dir = `supabase/functions/${name}/`;
    const graph = reach(tree, [`${dir}index.ts`]);
    if (name === "energy-optimisation-plan-step") graph.add("scripts/deploy-energy-planning.sh");
    if (name === "energy-planner-probe") {
      graph.add("scripts/deploy-planner-probe.ts");
      graph.add("scripts/planner-probe-auth.ts");
    }
    return any(f => (f.startsWith(dir) && !isTest(f) && !isDoc(f)) || (graph.has(f) && !isTest(f)));
  });

  // A cheap gate only: the bench itself skips a commit whose planner version it
  // already has (bench/planner-version.ts), so over-including costs one CI job.
  const planner = any(f => (f.startsWith(`${PLANNER_DIR}/`) && !isTest(f) && !isDoc(f)));

  return {
    code: any(f => !isDoc(f)),
    frontend,
    migrations: any(f => f.startsWith("supabase/migrations/")),
    functions,
    planner,
    bench: any(f => (f.startsWith("bench/") || f.startsWith("src/lib/planner-bench/")) && !isDoc(f) && !isTest(f)),
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
    `bench=${c.bench}`,
  ];
  console.log(changed === "all" ? "Changed: everything" : `Changed files (${changed.length}):\n  ${changed.join("\n  ")}`);
  console.log(lines.join("\n"));
  const out = Deno.env.get("GITHUB_OUTPUT");
  if (out) Deno.writeTextFileSync(out, lines.join("\n") + "\n", { append: true });
}
