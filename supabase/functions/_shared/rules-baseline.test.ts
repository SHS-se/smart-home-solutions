import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { batterySnapshot, dispatchedEvSnapshot, rulesFixtureInput } from '../../../scripts/generate-ha-plan-fixture.ts';
import { createWasmPlanner } from './planner-wasm/core.ts';
import { SOLVER_BASE64 } from './planner-wasm/solver-bytes.ts';
import { projectLoadBalancedEv } from './planner-wasm/load-balanced-ev.ts';
import { projectRulesBaseline } from './rules-baseline.ts';
import { generateRulesPlan } from './rules-planner.ts';
import type { OptimisationSnapshot } from './planner/planning-contracts.ts';

const core = createWasmPlanner(Uint8Array.from(atob(SOLVER_BASE64), c => c.charCodeAt(0)));
function house(peakBaseW = 5000) {
  const ev = dispatchedEvSnapshot();
  const source: OptimisationSnapshot = {...ev, schema_version: 8,
    capabilities: {...ev.capabilities, battery: true},
    battery: {...batterySnapshot().battery!, capacity_kwh: 4, soc: .5},
    slots: ev.slots.slice(0, 8).map((slot, i) => ({...slot, pv_forecast_w: 0,
      base_load_forecast_w: i === 6 ? peakBaseW : i < 4 ? 5000 : 500,
      import_price_sek_per_kwh: i < 4 ? 3 : .1})),
  };
  source.ev_battery = {...source.ev_battery!, soc: .1, available_from: source.slots[6].start};
  return rulesFixtureInput(source);
}

Deno.test('comparison load-balances from its own depleted store and resumes full supported current', () => {
  const input = house();
  const solved = core.solve(input.problem).outcome;
  assert(solved.kind === 'selected');
  // Reproduces the old construction: it copied the selected EV request but
  // omitted the earlier battery purchases needed to support that request.
  const copied = solved.selection.commands.map(c => ({...c, battery: 'self_consumption' as const,
    charge_limit_w: 8800, discharge_limit_w: 9600}));
  assertEquals(core.project(input.problem, copied).outcome, {kind: 'failed', issue: 'shared_grid_limit'});
  const before = structuredClone(input.problem);
  const balanced = projectRulesBaseline(core, input, solved.selection.commands, solved.selection.quarters);
  assertEquals(input.problem, before);
  assert(balanced.outcome.kind === 'projected');
  assertEquals(balanced.commands[6].ev_amps, 14);
  assertEquals(balanced.commands[7].ev_amps, 16);
  assertEquals(balanced.outcome.quarters[6].net_w, 14660);
  assertAlmostEquals(balanced.outcome.quarters[6].battery_kwh!, .2);
  assertAlmostEquals(balanced.outcome.quarters[7].ev_kwh!, input.problem.initial.ev_kwh! + (14 + 16) * 690 * .25 * .92 / 1000);
  assertEquals(core.project(input.problem, balanced.commands).outcome, balanced.outcome,
    'every reported flow and final store must come from the full native projection');
  const plan = generateRulesPlan(input).plan;
  assertEquals(plan.status, 'ready');
  assertEquals(plan.plans.priority.slots[6].ev_target_current_a, 16);
  assertEquals(plan.plans.baseline.status, 'ready');
  assertEquals(plan.plans.baseline.slots[6].ev_target_current_a, 14);
  assertEquals(plan.plans.baseline.slots[7].ev_target_current_a, 16);
  assert(plan.planning_warnings!.some(w => w.code === 'baseline_ev_load_balanced'));
  assert(!plan.planning_warnings!.some(w => w.code === 'baseline_unavailable'));
  for (const slot of plan.plans.baseline.slots) {
    assert(slot.grid_import_w <= input.problem.limits.import_w + 1e-7);
    assert(slot.grid_export_w <= input.problem.limits.export_w + 1e-7);
    assertAlmostEquals(slot.pv_w + slot.grid_import_w + slot.battery_discharge_w,
      slot.load_w + slot.battery_charge_w + slot.grid_export_w + slot.curtailed_w, 1e-7);
  }
});

Deno.test('comparison pauses below the supported minimum rather than inventing a fractional charger command', () => {
  const input = house(12000);
  const plan = generateRulesPlan(input).plan;
  assertEquals(plan.plans.baseline.status, 'ready');
  assertEquals(plan.plans.baseline.slots[6].ev_target_current_a, 0);
  assertEquals(plan.plans.baseline.slots[6].grid_import_w, 12000);
  assertEquals(plan.plans.baseline.slots[7].ev_target_current_a, 16);
});

Deno.test('comparison cannot reduce an explicit future booking to disguise infeasibility', () => {
  const input = house();
  const solved = core.solve(input.problem).outcome;
  assert(solved.kind === 'selected');
  input.problem.fixed_commands![6] = solved.selection.commands[6];
  const balanced = projectRulesBaseline(core, input, solved.selection.commands, solved.selection.quarters);
  assertEquals(balanced.outcome, {kind: 'failed', issue: 'shared_grid_limit'});
  assertEquals(input.problem.fixed_commands![6].ev_amps, 16);
});

Deno.test('quarter load balancing respects battery eligibility bounds and real charger steps', () => {
  const input = house();
  const p = input.problem;
  const quarter = {...p, accepted: null, fixed_commands: null, locked_through_seconds: 0,
    initial: {...p.initial, battery_kwh: 4},
    slots: [{...p.slots[6], start_seconds: 0}],
    charger: {...p.charger!, min_current_a: 6, current_step_a: 2}};
  const requested = {pool_on: false, ev_amps: 16, battery: 'self_consumption' as const,
    charge_limit_w: 8800, discharge_limit_w: 9600};
  const result = projectLoadBalancedEv(core, quarter, requested, true,
    command => ({...command, discharge_limit_w: 0}));
  assert(result.outcome.kind === 'projected');
  assertEquals(result.command.ev_amps, 14);
  assertEquals(result.outcome.quarters[0].discharge_w, 0);
  assertEquals(result.outcome.quarters[0].net_w, 14660);
  const invalid = projectLoadBalancedEv(core, quarter, {...requested, charge_limit_w: -1});
  assertEquals(invalid.command.ev_amps, 16);
  assertEquals(invalid.outcome, {kind: 'failed', issue: 'negative_native_power_limit'});
});

Deno.test('comparison carries partial-quarter state and preserves current retained commands', () => {
  const input = house();
  input.problem.slots = input.problem.slots.map(slot => ({...slot, start_seconds: slot.start_seconds - 420}));
  const solved = core.solve(input.problem).outcome;
  assert(solved.kind === 'selected');
  input.problem.accepted = solved.selection.commands.slice(0, 2);
  input.problem.locked_through_seconds = input.problem.slots[1].start_seconds + 1;
  const result = projectRulesBaseline(core, input, solved.selection.commands, solved.selection.quarters);
  assert(result.outcome.kind === 'projected');
  assertEquals(result.commands.slice(0, 2), input.problem.accepted);
  assertEquals(core.project(input.problem, result.commands).outcome, result.outcome);
});
