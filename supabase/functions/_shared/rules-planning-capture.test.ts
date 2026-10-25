import { diskTree, reach } from "../../../scripts/module-graph.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { dispatchedEvSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { captureRulesPlanningInput } from "./rules-planning-capture.ts";
import { executeRulesPlanning, prepareCapturedRulesInput } from "./rules-planning-execution.ts";
import { generateRulesPlan, prepareRulesPlanningInput } from "./rules-planner.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import type { RulesPlanningSource } from "./rules-planning-capture.ts";

Deno.test("preparation owns every caller object without copying its derived schedules", () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const source: RulesPlanningSource = { snapshot, now: snapshot.captured_at,
    resolved_price_outlook: rulesFixtureInput(snapshot).price_outlook };
  const policy = resolveRulePolicy();
  const initial = generateRulesPlan(prepareRulesPlanningInput(source, null, policy));
  const slots = initial.plan.plans.priority.slots;
  const reference = { plan_id: "synthetic-retained", slots };
  source.fixed_plan = { id: "synthetic-booking", starts_at: slots[6].start,
    ends_at: slots[7].start, source_snapshot_id: snapshot.snapshot_id,
    slots: [{ start: slots[6].start, targets: slots[6], power_w: {}, discharge_w: {}, allow_export: false }] };
  const callers = { source, reference, policy };
  const before = structuredClone(callers);
  const freeze = (value: unknown) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  };
  freeze(callers);
  const prepared = prepareRulesPlanningInput(source, reference, policy);
  const expected = structuredClone(prepared);
  prepared.snapshot.slots[0].base_load_forecast_w += 100;
  prepared.price_outlook.shadow_import_sek_per_kwh[0] += 1;
  prepared.problem.rules.length = 0;
  prepared.held_reference[0].device_commands = {};
  prepared.fixed_slots[6].device_commands = {};
  assertEquals(callers, before);
  assertEquals(prepareRulesPlanningInput(source, reference, policy), expected);
});

Deno.test("capture stores detached source facts and policy without prepared search state", () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const source = { snapshot, now: snapshot.captured_at,
    resolved_price_outlook: rulesFixtureInput(snapshot).price_outlook };
  const policy = resolveRulePolicy();
  const reference = { plan_id: "accepted", slots: [] };
  const capture = captureRulesPlanningInput(source, reference, policy);
  const before = structuredClone(capture);
  snapshot.slots[0].base_load_forecast_w += 2000;
  reference.plan_id = "changed";
  policy.rules.length = 0;
  source.resolved_price_outlook!.shadow_import_sek_per_kwh[0] = 100;
  assertEquals(capture, before);
  assertEquals("problem" in capture, false);
  assertEquals("rooms" in capture, false);
  assertEquals(capture.execution_replan, null);
});

Deno.test("captured complete execution preserves existing ordered preparation and solve exactly", () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const source = { snapshot, now: snapshot.captured_at,
    resolved_price_outlook: rulesFixtureInput(snapshot).price_outlook };
  const policy = resolveRulePolicy();
  const capture = captureRulesPlanningInput(source, null, policy);
  const expected = generateRulesPlan(prepareRulesPlanningInput(source, null, policy));
  assertEquals(executeRulesPlanning(capture), expected);
  assertEquals(executeRulesPlanning(capture), expected);
  assertThrows(() => prepareCapturedRulesInput({ ...capture, model_version: "obsolete" }), Error,
    "Captured rules planner version changed");
});

Deno.test("admission identity, captures and durable transport cannot load search kernels", () => {
  const shared = "supabase/functions/_shared/";
  const root = new URL("../../../", import.meta.url).pathname;
  const graph = reach(diskTree(root), ["rules-planning-capture.ts", "rules-planner-identity.ts",
    "rules-planning-client.ts", "energy-planning-jobs.ts"].map(file => shared + file));
  assertEquals([...graph].filter(path => /(?:rules-planner\.ts|rules-room-services\.ts|room-heating-schedule\.ts|planner-wasm\/(?:runtime|core|solver-bytes)\.ts)$/.test(path)), []);
});
