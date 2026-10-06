import { assert, assertEquals } from "@std/assert";
import { classify, functionNames } from "../scripts/ci-changes.ts";

const root = new URL("..", import.meta.url).pathname;

Deno.test("a planner change deploys the energy functions and the portal, and runs the bench", () => {
  const c = classify(root, ["supabase/functions/_shared/planner/energy-optimisation.ts"]);
  assert(c.planner);
  // The portal's plan workbench runs the planner in the browser.
  assert(c.frontend);
  assert(c.functions.includes("energy-optimisation-plan-step"));
  assert(c.functions.includes("energy-optimisation-ingest"));
  assert(!c.functions.includes("energy-optimisation-planning-worker"));
  assert(!c.functions.includes("stripe-webhook"));
  assert(!c.migrations);
});

Deno.test("a website change deploys neither functions nor migrations", () => {
  const c = classify(root, ["src/pages/portal/PlannerBench.tsx"]);
  assertEquals({ ...c, functions: c.functions.length }, { code: true, frontend: true, migrations: false, functions: 0, planner: false, bench: false });
});

Deno.test("one function's change deploys only that function", () => {
  const c = classify(root, ["supabase/functions/stripe-webhook/index.ts"]);
  assertEquals(c.functions, ["stripe-webhook"]);
  assert(!c.frontend);
});

Deno.test("a function importing website code redeploys with it", () => {
  assert(classify(root, ["src/lib/ecb-rate-core.ts"]).functions.includes("fetch-ecb-exchange-rate"));
});

Deno.test("tests and docs deploy nothing", () => {
  const c = classify(root, ["supabase/functions/_shared/energy-optimisation.test.ts", "docs/x.md"]);
  assertEquals([c.frontend, c.migrations, c.functions.length, c.planner], [false, false, 0, false]);
  assert(!classify(root, ["README.md"]).code);
});

Deno.test("function config and unknown bases deploy everything", () => {
  assertEquals(classify(root, ["supabase/config.toml"]).functions, functionNames(root));
  const all = classify(root, "all");
  assert(all.frontend && all.migrations && all.planner);
});
