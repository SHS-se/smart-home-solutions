import { assert, assertEquals } from "@std/assert";
import { classify, classifyPipeline, functionNames } from "../scripts/ci-changes.ts";

const root = new URL("..", import.meta.url).pathname;

Deno.test("pipeline edits rerun all checks but deploy only changed service source", () => {
  const pipeline = ".github/workflows/ci-deploy.yml";
  const c = classifyPipeline(root, [pipeline, "supabase/functions/integration-tariff/index.ts"], [pipeline]);
  assert(c.code && c.frontend && c.planner && c.bench);
  assertEquals(c.functions, ["integration-tariff"]);
  assert(!c.migrations);
  assertEquals(classifyPipeline(root, [pipeline], [pipeline]).functions, []);
  assertEquals(classifyPipeline(root, "all", [pipeline]).functions, functionNames(root));
});

Deno.test("a solve implementation change deploys worker and probe without loading search into ingest", () => {
  const c = classify(root, ["supabase/functions/_shared/rules-planner.ts"]);
  assert(c.planner);
  // The live portal renders this published contract; the isolated comparison uses its own Wasm boundary.
  assert(!c.frontend);
  assert(c.functions.includes("energy-optimisation-plan-step"));
  assert(!c.functions.includes("energy-optimisation-ingest"));
  assert(c.functions.includes("energy-planner-probe"), "complete-handler hosted qualification must follow planner changes");
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

Deno.test("probe credential and deployment changes redeploy only the private probe", () => {
  for (const path of ["scripts/deploy-planner-probe.ts", "scripts/planner-probe-auth.ts"]) {
    assertEquals(classify(root, [path]).functions, ["energy-planner-probe"]);
  }
});

Deno.test("market archive setup changes select its TEST-only deployment lane", () => {
  const changes = classify(root, ["scripts/deploy-market-archive.ts"]);
  assertEquals(changes.functions, ["energy-market-archive", "energy-price-experiment"]);
  assert(!changes.frontend && !changes.planner && !changes.migrations);
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

Deno.test("rule planner artifacts and explicit engine selection trigger benchmark qualification", () => {
  for (const path of [
    "planner-core/solver/src/builder.rs",
    "planner-core/recipe.json",
    "supabase/functions/_shared/planner-wasm/artifact.json",
    "bench/planner-engine.json",
  ]) {
    const c = classify(root, [path]);
    assert(c.planner, path);
    assertEquals(c.frontend, path === "planner-core/recipe.json" || path.endsWith("artifact.json"), path);
    if (path === "planner-core/recipe.json" || path.endsWith("artifact.json")) {
      assert(c.functions.includes("energy-optimisation-plan-step"), path);
      assert(c.functions.includes("energy-optimisation-ingest"), path);
    } else assert(!c.functions.includes("energy-optimisation-plan-step"), path);
  }
  assert(classify(root, ["bench/planner-engine.json"]).bench);
});

Deno.test("home baseline worker dependencies rebuild the preview without deploying a new planner", () => {
  const c = classify(root, ["src/lib/home-baseline/worker.ts"]);
  assert(c.frontend);
  assertEquals([c.planner, c.bench, c.functions.length], [false, false, 0]);
  assert(classify(root, ["supabase/functions/_shared/planner-wasm/solver.wasm"]).frontend);
});

Deno.test("capture assembly changes deploy ingest while protocol identity changes deploy both sides", () => {
  const capture = classify(root, ["supabase/functions/_shared/rules-planning-capture.ts"]);
  assert(capture.functions.includes("energy-optimisation-ingest"));
  assert(!capture.functions.includes("energy-optimisation-plan-step"));
  const identity = classify(root, ["supabase/functions/_shared/rules-planner-identity.ts"]);
  for (const endpoint of ["energy-optimisation-ingest", "energy-optimisation-plan-step", "energy-planner-probe"]) {
    assert(identity.functions.includes(endpoint), endpoint);
  }
  assert(!identity.functions.includes("stripe-webhook"));
});
