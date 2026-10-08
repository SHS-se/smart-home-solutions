import policy from "../planner-core/policy.json" with { type: "json" };
import { OPPORTUNITY_RULES } from "../src/lib/planner-bench/opportunities.ts";
import {
  builderRecipe,
  RULE_KEYS,
} from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { loadWasmCandidate, readyProblem } from "../bench/wasm-planner.ts";
import { createWasmPlanner } from "../supabase/functions/_shared/planner-wasm/core.ts";
import type { ReadyProblem } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { bufferProblem, causalCase, command, forecastProblem, problem } from "./planner-wasm.fixture.ts";
import {
  projectHeatPumpResponse,
  stepThermalStore,
} from "../supabase/functions/_shared/planner/device-models.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { resolveRules, scoreQuarters } from "../src/lib/planner-bench/score.ts";
import { referee } from "../src/lib/planner-bench/referee.ts";
import { caseTargets, QUARTERS } from "../src/lib/planner-bench/case.ts";
import { createPlannerProbe } from "../supabase/functions/_shared/planner-wasm/probe.ts";
import { SOLVER_BASE64 } from "../supabase/functions/_shared/planner-wasm/solver-bytes.ts";
import build from "../supabase/functions/_shared/planner-wasm/artifact.json" with {
  type: "json",
};
import recipe from "../planner-core/recipe.json" with { type: "json" };

const root = new URL("..", import.meta.url).pathname;
const bytes = await Deno.readFile(
  `${root}/supabase/functions/_shared/planner-wasm/solver.wasm`,
);
const core = createWasmPlanner(bytes);
const solve = (p: ReadyProblem) => core.solve(p).outcome;

Deno.test("forecast opportunities defer safe expensive opening loads and beat the old score", () => {
  const p = forecastProblem();
  const result = solve(p);
  assert(result.kind === "selected");
  const s = result.selection;
  assertEquals(s.commands[0].pool_on, false);
  assertEquals(s.commands[0].ev_amps, 0);
  assert(s.commands[0].battery !== "grid_charge");
  const first = s.commands.findIndex(c => c.pool_on);
  assert(first > 0);
  assert(p.slots[first].import_price < p.slots[0].import_price);
  // Measured previous kernel: 70 points, pool-on at quarter zero. Rules and
  // forecasts are fixed; this tests a score improvement, not just a later start.
  assert(s.account.points > 70);
  assert(s.work_used <= p.work_grant);
  const projected = core.project(p, s.commands).outcome;
  assert(projected.kind === "projected");
  assertEquals(projected.quarters, s.quarters);
});

Deno.test("a cheap opening still supports immediate EV charging", () => {
  const p = forecastProblem();
  for (let i = 0; i < p.slots.length; i++) {
    p.slots[i].import_price = 1 - .8 * Math.cos(i % 96 / 96 * 2 * Math.PI);
    p.slots[i].export_price = p.slots[i].import_price - .5;
  }
  const result = solve(p);
  assert(result.kind === "selected");
  assert(result.selection.commands[0].ev_amps > 0);
});

function solarCompetitionProblem(solarW: number, ev = false): ReadyProblem {
  const p = problem();
  p.battery = null;
  p.initial.battery_kwh = null;
  if (!ev) {
    p.car = null; p.charger = null; p.initial.ev_kwh = null;
    p.targets.ev_km = null; p.targets.ev_limit_kwh = null;
  } else {
    p.initial.ev_kwh = 10;
  }
  p.initial.pool_c = 29.8;
  p.limits.import_w = 1000;
  p.slots = p.slots.map((s, i) => ({ ...s, base_w: 1000,
    solar_w: i === 0 ? solarW : 0, import_price: 2, export_price: 1,
    ev_available: i === 0 }));
  p.rules = [
    { key: "cheap_buy", threshold: .25, points: 1, required: false, unless: null },
    { key: "dear_load", threshold: .25, points: -2, required: false, unless: null },
  ];
  return p;
}

Deno.test("solar opportunities use surplus after base consumption", () => {
  for (const solar of [1500, 6000]) {
    const result = solve(solarCompetitionProblem(solar));
    assert(result.kind === "selected");
    assertEquals(result.selection.commands[0].pool_on, solar === 6000);
  }
});

Deno.test("joint loads compete for one solar surplus and one quarter reward", () => {
  const p = solarCompetitionProblem(6000, true);
  const result = solve(p);
  assert(result.kind === "selected");
  const s = result.selection;
  assert(s.commands[0].pool_on || s.commands[0].ev_amps > 0);
  assert(!(s.commands[0].pool_on && s.commands[0].ev_amps > 0));
  assertEquals(s.account.contributions[0][0], 1);
  for (const q of s.quarters) assert(q.net_w <= p.limits.import_w + 1e-7);
});

Deno.test("Wasm artifact matches every declared source and the binary digest", async () => {
  const planner = await loadWasmCandidate(root);
  assert(planner.version.startsWith("wasm-v5:"));
  assert(planner.artifact_bytes > 0);
  assertEquals(
    Uint8Array.from(atob(SOLVER_BASE64), (c) => c.charCodeAt(0)),
    bytes,
  );
});

Deno.test("probe refuses production, anonymous access and alternate work recipes", async () => {
  const handler = createPlannerProbe(
    SOLVER_BASE64,
    build,
    recipe,
    "test-secret",
    "https://vxqpgbzseckgceopitpm.supabase.co",
  );
  const request = (p = problem(), secret = "test-secret") =>
    new Request("https://test.invalid/probe", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify(p),
    });
  assertEquals((await handler(request(problem(), "wrong"))).status, 401);
  assertEquals((await handler(request())).status, 400);
  const prod = createPlannerProbe(
    SOLVER_BASE64,
    build,
    recipe,
    "test-secret",
    "https://oosxndduqzhvrorgogaw.supabase.co",
  );
  assertEquals((await prod(request())).status, 403);
  const p = problem();
  p.work_grant = recipe.work_grant;
  p.recipe = builderRecipe(recipe);
  const response = await handler(request(p));
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.outcome.kind, "selected");
  assertEquals(result.qualification, "test_live_candidate");
  assertEquals(result.cold, true);
  assertEquals((await (await handler(request(p))).json()).cold, false);
});

Deno.test("each solve is deterministic and uses private memory", () => {
  const p = problem();
  const first = solve(p);
  const other = problem();
  other.initial.pool_c = 45;
  solve(other);
  assertEquals(solve(p), first);
  assertEquals(p.initial.pool_c, 32);
});

Deno.test("Wasm exports accept a host-wrapped public Memory constructor", () => {
  const native = WebAssembly.Memory;
  try {
    WebAssembly.Memory = class HostMemory extends native {};
    assertEquals(solve(problem()).kind, "selected");
  } finally {
    WebAssembly.Memory = native;
  }
});

Deno.test("missing, incomplete and overlong accepted prefixes fail explicitly", () => {
  for (const endpoint of [0, 900, 3599]) {
    const p = problem();
    p.accepted = p.slots.map(() => command());
    p.locked_through_seconds = endpoint;
    assertEquals(solve(p), { kind: "failed", issue: "commitment_unavailable" });
  }
  const p = problem();
  p.locked_through_seconds = 3600;
  assertEquals(solve(p), { kind: "failed", issue: "commitment_unavailable" });
  p.accepted = [command()];
  assertEquals(solve(p), { kind: "failed", issue: "commitment_unavailable" });
  p.accepted = p.slots.map(() => command());
  assertEquals(solve(p), { kind: "failed", issue: "commitment_unavailable" });
});

Deno.test("first hour includes the intersecting partial quarter and keeps exact commands", () => {
  const p = problem();
  for (const s of p.slots) s.start_seconds -= 300;
  p.accepted = p.slots.filter((s) => s.start_seconds < 3600).map((_, i) =>
    command(i % 2 === 0)
  );
  p.accepted[0].ev_amps = 6;
  p.accepted[0].battery = "grid_charge";
  p.accepted[0].charge_limit_w = 1000;
  p.heater.response = {
    kind: "bergvarme",
    startup: [
      { elapsed_seconds: 0, electric_fraction: .5, heat_fraction: 0 },
      { elapsed_seconds: 1800, electric_fraction: 1, heat_fraction: 1 },
    ],
  };
  p.locked_through_seconds = 3600;
  const result = solve(p);
  assertEquals(result.kind, "selected");
  if (result.kind !== "selected") throw new Error(result.issue);
  assertEquals(result.selection.commands.slice(0, 5), p.accepted.slice(0, 5));
  const hours = 600 / 3600;
  const response = projectHeatPumpResponse(
    p.heater.response,
    p.heater,
    [3764],
    [hours],
    null,
  );
  const first = result.selection.quarters[0];
  assert(
    first.pool_c !== null && first.ev_kwh !== null &&
      first.battery_kwh !== null && first.heater_state !== null,
  );
  assertAlmostEquals(first.pool_w, response.draw_w[0], 1e-9);
  assertAlmostEquals(
    first.pool_c,
    stepThermalStore(
      p.pool_store,
      p.initial.pool_c,
      12000 * response.gain_fraction[0],
      10,
      hours,
    ),
    1e-9,
  );
  const evW = 6 * p.charger.voltage_v * p.charger.phase_count;
  assertAlmostEquals(
    first.ev_kwh,
    p.initial.ev_kwh + evW * hours / 1000 * p.car.charge_efficiency,
  );
  assertAlmostEquals(
    first.battery_kwh,
    p.initial.battery_kwh + 1000 * hours / 1000 * p.battery.charge_efficiency,
  );
  assertAlmostEquals(
    first.cost,
    (500 + response.draw_w[0] + evW + 1000) * hours / 1000,
  );
  assertEquals(first.heater_state.kind, "running");
  if (first.heater_state.kind !== "running") {
    throw new Error("Expected running heater.");
  }
  assertAlmostEquals(first.heater_state.seconds, 600, 1e-9);
  assert(result.selection.work_used <= p.work_grant);
  const shifted = structuredClone(p);
  for (const s of shifted.slots) s.start_seconds += 900;
  assertEquals(solve(shifted), {
    kind: "failed",
    issue: "missing_capture_interval",
  });
});

Deno.test("physical startup and measured thermal loss match the independent existing device model", () => {
  const p = problem();
  p.slots = p.slots.slice(0, 4);
  p.pool_store = {
    capacity_kwh_per_c: 63.965,
    loss: {
      kind: "measured",
      points: [
        { at_c: 25, c_per_h: -.03 },
        { at_c: 35, c_per_h: -.08 },
      ],
    },
  };
  p.heater.response = {
    kind: "bergvarme",
    startup: [
      { elapsed_seconds: 0, electric_fraction: .5, heat_fraction: 0 },
      { elapsed_seconds: 1800, electric_fraction: 1, heat_fraction: 1 },
    ],
  };
  p.accepted = p.slots.map(() => command(true));
  p.locked_through_seconds = 3600;
  const result = solve(p);
  assertEquals(result.kind, "selected");
  if (result.kind !== "selected") throw new Error(result.issue);
  let water = p.initial.pool_c;
  const response = projectHeatPumpResponse(
    p.heater.response,
    p.heater,
    p.slots.map(() => 3764),
    p.slots.map((s) => s.hours),
    null,
  );
  for (let i = 0; i < p.slots.length; i++) {
    const q = result.selection.quarters[i];
    assertAlmostEquals(q.pool_w, response.draw_w[i], 1e-9);
    water = stepThermalStore(
      p.pool_store,
      water,
      12000 * response.gain_fraction[i],
      10,
      .25,
    );
    assert(q.pool_c !== null);
    assertAlmostEquals(q.pool_c, water, 1e-9);
    assertEquals(q.pool_command_w, 3764);
    assertEquals(q.charge_w, 0);
    assertEquals(q.discharge_w, 0);
  }
});

Deno.test("invalid equipment fails without rejecting realistic above-target state", () => {
  const p = problem();
  p.battery = { ...p.battery, charge_efficiency: 1.1 };
  assertEquals(solve(p), { kind: "failed", issue: "invalid_model_parameters" });
  const valid = problem();
  valid.initial.pool_c = 45;
  valid.initial.ev_kwh = 75;
  assertEquals(solve(valid).kind, "selected");
});

Deno.test("opposite rules are retained even when a quarter scores zero", () => {
  const p = problem();
  p.slots = p.slots.slice(0, 4);
  p.initial.pool_c = 50;
  p.targets.pool_c = 50;
  p.pool_store = {
    capacity_kwh_per_c: 1,
    loss: { kind: "linear", kw_per_c: 1, surroundings_c: 10 },
  };
  p.rules = [{
    key: "pool_low",
    threshold: 0,
    points: -1,
    required: false,
    unless: null,
  }, {
    key: "cheapest_buy",
    threshold: 1,
    points: 1,
    required: false,
    unless: null,
  }];
  p.accepted = p.slots.map(() => command(true));
  p.locked_through_seconds = 3600;
  const result = solve(p);
  assertEquals(result.kind, "selected");
  if (result.kind !== "selected") throw new Error(result.issue);
  assertEquals(result.selection.account.contributions[0], [-1, 1]);
});

Deno.test("measurement rounding keeps equality outside a strictly-above buffer rule", () => {
  const p = problem();
  p.slots = Array.from(
    { length: 192 },
    (_, i) => ({
      ...p.slots[0],
      start_seconds: i * 900,
      import_price: i < 96 ? 1 : 2,
    }),
  );
  p.work_grant = 900_000_000;
  p.pool_store = {
    capacity_kwh_per_c: 1,
    loss: { kind: "linear", kw_per_c: 0, surroundings_c: null },
  };
  p.initial.pool_c = 32.0004;
  p.rules = [{
    key: "pool_buffer",
    threshold: 2,
    points: 1,
    required: false,
    unless: null,
  }];
  p.accepted = p.slots.filter((s) => s.start_seconds < 3600).map(() =>
    command()
  );
  p.locked_through_seconds = 3600;
  const result = solve(p);
  assertEquals(result.kind, "selected");
  if (result.kind !== "selected") throw new Error(result.issue);
  assertEquals(result.selection.account.contributions.slice(0, 4), [[0], [0], [
    0,
  ], [0]]);
  assertEquals(result.selection.quarters[0].pool_c, 32.0004);
});

Deno.test("a grant too small for a complete certified result fails without partial output", () => {
  const p = problem();
  p.work_grant = 1;
  assertEquals(solve(p), {
    kind: "failed",
    issue: "work_grant_cannot_construct_and_certify",
  });
  assertEquals(
    solve({
      ...problem(),
      initial: { ...problem().initial, pool_c: Number.NaN },
    }).kind,
    "failed",
  );
});

Deno.test("bounded construction returns a complete certified incumbent", () => {
  const p = problem();
  p.work_grant = 12_000_000;
  const result = solve(p);
  assertEquals(result.kind, "selected");
  if (result.kind !== "selected") throw new Error(result.issue);
  assert(result.selection.work_used <= p.work_grant);
  assertEquals(result.selection.commands.length, p.slots.length);
  assertEquals(result.selection.quarters.length, p.slots.length);
  assertEquals(result.selection.termination, "bounded_complete");
});

Deno.test("direct rule accounts agree with the independent quarter scorer when information matches", async () => {
  const c = causalCase();
  const planner = await loadWasmCandidate(root);
  const p = readyProblem(c, HOUSEHOLD);
  const result = planner.plan(p);
  if (result.outcome.kind !== "selected") throw new Error(result.outcome.issue);
  const { series, violations } = referee(
    c,
    HOUSEHOLD,
    caseTargets(c),
    result.record.decisions,
    p.slots.map((s) => s.import_price),
  );
  assertEquals(violations, []);
  const quarters = scoreQuarters(series, {}).quarters;
  const expected = quarters.map((q) =>
    p.rules.map((r) => q.fired.includes(r.key) ? r.points : 0)
  );
  assertEquals(result.outcome.selection.account.contributions, expected);
});

Deno.test("withheld future prices and actual household measurements cannot affect ready input", () => {
  const c = causalCase();
  for (let i = 96; i < QUARTERS; i++) {
    c.known_prices.import_sek_per_kwh[i] = null;
    c.known_prices.export_sek_per_kwh[i] = null;
  }
  const all = (value: number) => Array(QUARTERS).fill(value);
  const changed = structuredClone(c);
  changed.recorded.prices.import_sek_per_kwh.fill(999);
  changed.recorded.prices.export_sek_per_kwh.fill(-999);
  changed.recorded.actual = { base_load_w: all(9000), solar_w: all(9000) };
  assertEquals(readyProblem(changed, HOUSEHOLD), readyProblem(c, HOUSEHOLD));
});

Deno.test("every bench rule and economic family has an explicit planner mapping", () => {
  assertEquals(
    [...RULE_KEYS].sort(),
    resolveRules({}).map((r) => r.key).sort(),
  );
  assertEquals(
    [...policy.direct_rules, ...policy.witness_rules].sort(),
    [...RULE_KEYS].sort(),
  );
  assertEquals(
    policy.economic_rules.toSorted(),
    OPPORTUNITY_RULES.map((r) => r.key).sort(),
  );
  const criteria = {
    pool_low: { enabled: false },
    pool_buffer: { threshold: 1.2, points: -2 },
  };
  const p = readyProblem(causalCase(), HOUSEHOLD, criteria);
  assertEquals(
    p.rules,
    resolveRules(criteria).filter((r) => r.enabled).map((r) => ({
      key: r.key,
      threshold: r.threshold,
      points: r.points,
      required: r.required ?? false,
      unless: r.unless ?? null,
    })),
  );
  assertEquals(p.service_guard.pool, [1, 2]);
});

Deno.test("native restart events and signed scores match the referee at the twelve-hour boundary", () => {
  const c = causalCase();
  c.start_state.pool_heater = { kind: "off", seconds: 3600 };
  const criteria = Object.fromEntries(
    resolveRules().map(
      (r) => [r.key, {
        enabled: r.key === "pool_restart" || r.key === "cheapest_buy",
      }],
    ),
  );
  const p = readyProblem(c, HOUSEHOLD, criteria);
  // The exact accepted first hour starts, stops, restarts, then continues.
  p.accepted = p.slots.filter((s) => s.start_seconds < 3600).map((_, i) =>
    command(i === 0 || i === 2 || i === 3)
  );
  p.locked_through_seconds = 3600;
  const result = solve(p);
  if (result.kind !== "selected") throw new Error(result.issue);
  const selected = result.selection;
  const d = {
    pool_w: selected.quarters.map((q) => q.pool_command_w),
    ev_w: selected.quarters.map((q) => q.ev_w),
    battery_charge_w: selected.quarters.map((q) => q.charge_w),
    battery_discharge_w: selected.quarters.map((q) => q.discharge_w),
  };
  const series = referee(c, HOUSEHOLD, caseTargets(c), d).series;
  const scored = scoreQuarters(series, criteria);
  assertEquals(selected.quarters.map((q) => q.pool_start), series.poolStart);
  assertEquals(
    scored.quarters.slice(0, 4).flatMap((q, i) =>
      q.fired.includes("pool_restart") ? [i] : []
    ),
    [0, 2],
  );
  assertEquals(
    selected.account.contributions,
    scored.quarters.map((q) =>
      p.rules.map((r) => q.fired.includes(r.key) ? r.points : 0)
    ),
  );
  for (let i = 0; i < QUARTERS; i++) {
    assertAlmostEquals(selected.quarters[i].pool_w, series.poolW[i], 0.051);
    const poolC = selected.quarters[i].pool_c;
    assert(poolC !== null);
    assertAlmostEquals(poolC, series.poolC[i]!, 0.00051);
  }
  assertEquals(selected.account.contributions[0], [-2, 2]);
  assertEquals(selected.account.contributions[3], [0, 2]);
  p.initial.heater_state = { kind: "off", seconds: 43200 };
  const boundary = solve(p);
  if (boundary.kind !== "selected") throw new Error(boundary.issue);
  assertEquals(boundary.selection.account.contributions[0], [0, 2]);
});

Deno.test("ready ABI rejects obsolete heater inputs rather than assuming an off heater", () => {
  const obsolete = { ...problem(), abi: 3 };
  assertEquals(core.solve(obsolete as unknown as ReadyProblem).outcome, {
    kind: "failed",
    issue: "unsupported_abi_or_empty_problem",
  });
});

Deno.test("every selected result reports bounded witnesses and exact work accounting", () => {
  const p = problem();
  const result = solve(p);
  if (result.kind !== "selected") throw new Error(result.issue);
  const s = result.selection;
  assertEquals(s.work.used, s.work_used);
  assertEquals(s.work.limit, p.work_grant);
  assertEquals(s.work.reserved, 0);
  assertEquals(s.work.evaluations, s.evaluations);
  assertEquals(
    s.witness_coverage.map((c) => c.family).sort(),
    [...policy.witness_rules, ...policy.economic_rules].sort(),
  );
  const economic = new Set(
    s.economic.filter((hit) => hit.published).flatMap((hit) =>
      hit.quarters.map((i) => `${hit.rule}:${i}`)
    ),
  ).size;
  assertEquals(
    s.account.points,
    s.account.contributions.flat().reduce((a, b) => a + b, 0) - economic,
  );
});

Deno.test("public native projection keeps absent devices null and models PV curtailment", () => {
  const p: ReadyProblem = problem();
  p.battery = null;
  p.car = null;
  p.charger = null;
  p.heater = null;
  p.pool_store = null;
  p.initial = {
    battery_kwh: null,
    ev_kwh: null,
    pool_c: null,
    heater_state: null,
  };
  p.targets = { pool_c: null, ev_km: null, ev_limit_kwh: null };
  p.slots[0].solar_w = 20000;
  const commands = p.slots.map(() => ({
    ...command(),
    battery: "idle" as const,
    charge_limit_w: 0,
    discharge_limit_w: 0,
  }));
  const result = core.project(p, commands);
  assertEquals(result.outcome.kind, "projected");
  if (result.outcome.kind !== "projected") {
    throw new Error(result.outcome.issue);
  }
  const q = result.outcome.quarters[0];
  assertEquals([q.battery_kwh, q.ev_kwh, q.pool_c, q.heater_state], [
    null,
    null,
    null,
    null,
  ]);
  assertEquals([
    q.pool_w,
    q.pool_compressor_w,
    q.pool_auxiliary_w,
    q.pool_heat_w,
    q.ev_w,
    q.charge_w,
    q.discharge_w,
  ], [0, 0, 0, 0, 0, 0, 0]);
  assertEquals(q.curtailed_w, 3500);
  assertEquals(q.net_w, -16000);
});

Deno.test("deployed runtime configuration is generated from the measured recipe and policy", async () => {
  const runtime = JSON.parse(await Deno.readTextFile(`${root}/supabase/functions/_shared/planner-wasm/runtime-config.json`));
  assertEquals(runtime.recipe, recipe);
  assertEquals(runtime.policy_manifest, JSON.parse(await Deno.readTextFile(`${root}/planner-core/policy.json`)));
});

Deno.test("native frozen-event credit matches independent replay across restarts, seasons and point overrides", () => {
  for (const month of [7, 1]) for (const points of [2, -1]) for (const heatingPrefix of [true, false]) {
    const p = bufferProblem();
    if (!heatingPrefix) p.accepted = p.accepted!.map(() => command(false));
    p.rules[0].points = points;
    p.slots.forEach(slot => { slot.local_month = month; });
    const result = solve(p);
    assertEquals(result.kind, 'selected');
    if (result.kind !== 'selected') throw new Error(result.issue);
    const q = result.selection.quarters;
    const c = causalCase();
    const series = referee(c, HOUSEHOLD, { pool_c: 30, ev_km: 300 }, {
      pool_w: new Array(288).fill(0), ev_w: new Array(288).fill(0),
      battery_charge_w: new Array(288).fill(0), battery_discharge_w: new Array(288).fill(0),
    }).series;
    // Save the physical facts from the synthetic problem, not native earned flags.
    series.comfort!.pool_start_c = p.initial.pool_c;
    series.poolW = q.map(v => Math.round(v.pool_w * 10) / 10);
    series.poolC = q.map(v => Math.round(v.pool_c! * 1000) / 1000);
    series.poolStart = q.map(v => v.pool_start);
    series.importPrice = p.slots.map(v => v.import_price);
    series.solarW = p.slots.map(v => v.solar_w);
    series.poolThermal = { store: p.pool_store, outdoorC: p.slots.map(v => v.outdoor_c), localMonth: p.slots.map(v => v.local_month) };
    const independent = scoreQuarters(series, { pool_buffer: { points } });
    assertEquals(result.selection.account.contributions.map(row => row[0]), independent.thermalBuffer!.map(v => v.earns ? points : 0));
    if (month === 7) {
      assertEquals(independent.thermalBuffer![0].earns, !heatingPrefix);
      if (heatingPrefix) assertEquals(independent.thermalBuffer![2].earns, false);
      assertEquals(independent.thermalBuffer![282].earns, false);
    } else assertEquals(independent.counts.pool_buffer, undefined);
  }
});
