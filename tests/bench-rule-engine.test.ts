import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { loadPlanner } from "../bench/adapter.ts";
import { plannerVersion, usesRulePlanner } from "../bench/planner-version.ts";
import { hotWaterContext, loadWasmCandidate, readyProblem } from "../bench/wasm-planner.ts";
import { diskTree, type SourceTree } from "../scripts/module-graph.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { BASE_LANE, laneParts, LANES, toldCase } from "../src/lib/planner-bench/lanes.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { plannerCriteriaFingerprint, plannerRulesFingerprint } from "../src/lib/planner-bench/score.ts";
import type { CriteriaOverrides } from "../src/lib/planner-bench/types.ts";
import { causalCase } from "./planner-wasm.fixture.ts";

const root = new URL("..", import.meta.url).pathname;

Deno.test('default bench worker solves ten measured cases once each and skips them on retry', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'bench-base-count-' });
  try {
    const cases = `${dir}/cases`, output = `${dir}/results.json`;
    await Deno.mkdir(cases);
    const { recorded, ...dataset } = causalCase();
    for (let i = 0; i < 10; i++) await Deno.writeTextFile(`${cases}/case-${i}.json`, JSON.stringify({ dataset, recorded }));
    const run = async () => {
      const result = await new Deno.Command(Deno.execPath(), { cwd: root,
        args: ['run', '-A', '--no-check', '--sloppy-imports', '--config', `${root}/deno.json`, `${root}/bench/run.ts`,
          '--worker', 'HEAD', '--root', root, '--local', cases, '--out', output], stdout: 'piped', stderr: 'piped' }).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout);
    };
    assertEquals((await run()).match(/^ {2}START /gm)?.length, 10);
    const first = JSON.parse(await Deno.readTextFile(output));
    assertEquals(first.results.length, 10);
    assert(first.results.every((r: { lane: string }) => r.lane === BASE_LANE));
    assertEquals((await run()).match(/^ {2}START /gm), null);
    assertEquals(JSON.parse(await Deno.readTextFile(output)), first);
    // Missing solve provenance requires a real solve, never a score-only repair.
    delete first.results[0].record.planner_rules;
    await Deno.writeTextFile(output, JSON.stringify(first));
    assertEquals((await run()).match(/^ {2}START /gm)?.length, 1);
    const repaired = JSON.parse(await Deno.readTextFile(output));
    delete repaired.results[0].record.planner_criteria;
    await Deno.writeTextFile(output, JSON.stringify(repaired));
    assertEquals((await run()).match(/^ {2}START /gm)?.length, 1);
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("public bench selects the configured rule engine and passes its saved rules", async () => {
  const planner = await loadPlanner(root);
  const candidate = await loadWasmCandidate(root);
  const c = causalCase();
  const criteria = {
    pool_low: { enabled: false },
    pool_hot: { points: -2 },
  };
  assertEquals(planner.generation, "ready-wasm-v9");
  for (const lane of LANES) {
    const scale = laneParts(lane).scale;
    const actual = planner.plan(toldCase(c, lane), HOUSEHOLD, scale, criteria);
    const expected = candidate.plan(
      readyProblem(toldCase(c, lane), HOUSEHOLD, criteria),
      hotWaterContext(toldCase(c, lane), HOUSEHOLD),
    );
    assertEquals(actual.record, {
      ...expected.record,
      planner_rules: plannerRulesFingerprint(criteria),
      planner_criteria: plannerCriteriaFingerprint(criteria),
      valuation: { scale, pool: "none", ev: "none", battery: "none" },
    });
    assertEquals(actual.record.curves, []);
  }
  assert((await plannerVersion(diskTree(root))).startsWith("v12-rule-wasm:"));
});

Deno.test("configured rule engine versions change with artifacts and cannot silently use TypeScript", async () => {
  const files = new Map([
    [
      "bench/planner-engine.json",
      JSON.stringify({ engine: "rule-wasm", scope: "test-live" }),
    ],
    [
      "supabase/functions/_shared/planner-wasm/artifact.json",
      JSON.stringify({
        abi: 4,
        wasm_sha256: "binary-a",
        source_sha256: "source-a",
      }),
    ],
    ["supabase/functions/_shared/planner-wasm/solver.wasm", "binary"],
    ["bench/wasm-planner.ts", "producer"],
    ["supabase/functions/_shared/planner/energy-optimisation.ts", "legacy"],
  ]);
  const tree: SourceTree = {
    read: (p) => files.get(p) ?? null,
    isFile: (p) => files.has(p),
  };
  const first = await plannerVersion(tree);
  files.set(
    "supabase/functions/_shared/planner-wasm/artifact.json",
    JSON.stringify({
      abi: 4,
      wasm_sha256: "binary-b",
      source_sha256: "source-a",
    }),
  );
  assert(first !== await plannerVersion(tree));
  files.delete("supabase/functions/_shared/planner-wasm/solver.wasm");
  await assertRejects(
    () => plannerVersion(tree),
    Error,
    "Selected rule planner artifact is missing",
  );
  files.set(
    "bench/planner-engine.json",
    JSON.stringify({ engine: "unknown", scope: "test-live" }),
  );
  assertThrows(
    () => usesRulePlanner(tree),
    Error,
    "Unsupported committed bench engine",
  );
  files.delete("bench/planner-engine.json");
  assertEquals(usesRulePlanner(tree), false);
});

Deno.test("real bench worker stores all rule-engine lanes and replans when saved rules change", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bench-rule-engine-" });
  try {
    const cases = `${dir}/cases`;
    const output = `${dir}/results.json`;
    await Deno.mkdir(cases);
    const { recorded, ...dataset } = causalCase();
    await Deno.writeTextFile(
      `${cases}/fixture.json`,
      JSON.stringify({ dataset, recorded }),
    );
    const run = async () => {
      const result = await new Deno.Command(Deno.execPath(), {
        cwd: root,
        args: [
          "run",
          "-A",
          "--no-check",
          "--sloppy-imports",
          "--config",
          `${root}/deno.json`,
          `${root}/bench/run.ts`,
          "--scope",
          "diagnostics",
          "--worker",
          "HEAD",
          "--root",
          root,
          "--local",
          cases,
          "--out",
          output,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(
        result.success,
        new TextDecoder().decode(result.stderr) +
          new TextDecoder().decode(result.stdout),
      );
      return JSON.parse(await Deno.readTextFile(output));
    };
    const first = await run();
    assertEquals(first.results.length, LANES.length);
    const planner = await loadPlanner(root);
    const check = (file: typeof first, criteria: CriteriaOverrides) => {
      for (const lane of LANES) {
        const stored = file.results.find((r: { lane: string }) =>
          r.lane === lane
        );
        const record = planner.plan(
          toldCase(causalCase(), lane),
          HOUSEHOLD,
          laneParts(lane).scale,
          criteria,
        ).record;
        assertEquals(stored.status, "ok");
        assertEquals(stored.record, record);
        assertEquals(
          stored.score,
          evaluate(causalCase(), record, criteria, lane).score,
        );
      }
    };
    check(first, {});
    assertEquals(
      await run(),
      first,
      "unchanged rules retain the stored decisions",
    );
    const rules = { pool_hot: { points: -2 } };
    await Deno.writeTextFile(output, JSON.stringify({ ...first, rules }));
    const second = await run();
    check(second, rules);
    assertEquals(second.results.length, LANES.length);
    for (const lane of LANES) {
      assert(
        first.results.find((r: { lane: string }) => r.lane === lane)
          .input_hash !==
          second.results.find((r: { lane: string }) => r.lane === lane)
            .input_hash,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a case with a water heater forecast is planned with production's hot-water stage around the kernel", async () => {
  const planner = await loadPlanner(root);
  const c = causalCase();
  const keys = HOUSEHOLD.hot_water.meter_keys;
  const key = keys[0];
  c.other_devices_w = { ...c.other_devices_w, ...Object.fromEntries(keys.map(key => [key, c.base_load_forecast_w.map(() => 0)])), [key]: c.base_load_forecast_w.map((w, i) => Math.min(w, i % 96 < 28 ? 0 : 300)) };
  const context = hotWaterContext(c, HOUSEHOLD)!;
  // One window per local day, as the home sends them, covering the case and nothing else.
  assertEquals(Date.parse(context.input.services[0].earliest_start), Date.parse(c.start));
  assertEquals(Date.parse(context.input.services.at(-1)!.deadline), Date.parse(c.start) + 288 * 900_000);
  const required = context.input.services.reduce((sum, s) => sum + s.required_kwh, 0);
  assertEquals(Math.round(required * 1000), Math.round(c.other_devices_w[key].reduce((a, b) => a + b, 0) / 4));
  // Water allowances are added after the kernel selects the household loads.
  const problem = readyProblem(toldCase(c, BASE_LANE), HOUSEHOLD);
  const i = 60;
  assertEquals(problem.slots[i].base_w, context.input.other_house_w[i]);
  const { record } = planner.plan(toldCase(c, BASE_LANE), HOUSEHOLD);
  assertEquals(record.decisions.hot_water?.length, 288);
  assertEquals(record.decisions.hot_water_expected_w?.length, 288);
  // Missing boiler measurements do not remove the daily permission opportunity.
  assertEquals(planner.plan(toldCase(causalCase(), BASE_LANE), HOUSEHOLD).record.decisions.hot_water?.length, 288);
});
