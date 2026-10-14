/** Run separately from parallel unit tests: measure the complete cold worker,
 * including Wasm compilation, hot-water refinement, materialization and JSON.
 * Process CPU is a local regression gate, not a hosted platform measurement.
 */
import { cpuUsage } from "node:process";
import { assert, assertEquals } from "@std/assert";
import { cpuPlanningInput } from "../tests/planner-handler-cpu.fixture.ts";
import { RULES_PLANNING_PROTOCOL } from "../supabase/functions/_shared/rules-planning-client.ts";
import { handleEnergyPlanningStep } from "../supabase/functions/_shared/energy-planning-worker.ts";

const input = cpuPlanningInput();
const before = cpuUsage();
const started = performance.now();
const response = await handleEnergyPlanningStep(new Request("https://cpu.test/plan", {
  method: "POST", headers: { "x-shs-planning-secret": "cpu-test", "x-request-id": "cpu-regression" },
  body: JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, input }),
}), "cpu-test");
const body = await response.json();
const used = cpuUsage(before);
const cpuMs = (used.user + used.system) / 1000;
console.log(JSON.stringify({ cpu_ms: cpuMs, elapsed_ms: performance.now() - started, slots: input.problem.slots.length }));
assertEquals(response.status, 200, JSON.stringify(body));
assertEquals(body.result.plan.status, "ready");
assertEquals(body.result.plan.plans.priority.slots.length, 288);
// Reserve at least 500 ms below the hosted two-second CPU ceiling for host
// differences and transport. The native work and projection tests also bound
// work deterministically, independently of machine speed.
assert(cpuMs < 1500, `Complete cold planning worker used ${cpuMs.toFixed(1)} ms CPU; budget is 1500 ms`);
