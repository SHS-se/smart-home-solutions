import { assert, assertEquals } from '@std/assert';
import { hotWaterSnapshot } from '../../../scripts/generate-ha-plan-fixture.ts';
import { prepareRulesPlanningInput, generateRulesPlan } from './rules-planner.ts';
import { createWasmPlanner } from './planner-wasm/core.ts';
import { SOLVER_BASE64 } from './planner-wasm/solver-bytes.ts';
import { resolveRulePolicy } from './planner-wasm/rule-policy.ts';
import { addHotWater } from './rules-hot-water.ts';
import { cpuPlanningInput } from '../../../tests/planner-handler-cpu.fixture.ts';
const core = createWasmPlanner(Uint8Array.from(atob(SOLVER_BASE64), c => c.charCodeAt(0)));
Deno.test('water adds one projection and no further solves on the 72-hour household', () => {
  const p = cpuPlanningInput(); const native = core.solve(p.problem).outcome; assert(native.kind === 'selected');
  let projections = 0;
  const selected = addHotWater({ ...core, project(problem, commands) { projections++; return core.project(problem, commands); }, solve() { throw new Error('Water must not solve again'); } }, p, native.selection);
  assertEquals(projections, 1);
  const replay = core.project(selected.input.problem, selected.selection.commands).outcome;
  assert(replay.kind === 'projected'); assertEquals(replay.quarters, selected.selection.quarters);
});
Deno.test('published binary commands and watts use the same selected water schedule', () => {
  const s = hotWaterSnapshot(); s.captured_at = s.slots[0].start;
  const p = prepareRulesPlanningInput({ snapshot: s, now: s.captured_at, resolved_price_outlook: { shaped: true, observed_days: 1, effective_days: 1, level_sek_per_kwh: 1,
    shadow_import_sek_per_kwh: s.slots.map(s => s.import_price_sek_per_kwh!) } }, null, resolveRulePolicy());
  const plan = generateRulesPlan(p).plan;
  const slots = plan.plans.priority.slots;
  assertEquals(slots.filter(s => s.boiler_permitted).length, 10);
  for (const slot of slots) {
    assertEquals(slot.device_commands!.water, { type: 'permit_inhibit', permitted: slot.boiler_permitted });
    assertEquals(slot.load_w, slot.base_w + slot.boiler_expected_w);
    assertEquals(slot.boiler_battery_allowed, false);
  }
});

Deno.test('a high battery alone grants no water supply; solar refill allowance is finite and loss adjusted', async () => {
  const { hotWaterSurplusPermissions } = await import('./rules-hot-water.ts');
  const p = cpuPlanningInput();
  const solved = core.solve(p.problem).outcome; assert(solved.kind === 'selected');
  const battery = p.problem.battery!;
  p.problem.slots = p.problem.slots.map((s, i) => ({ ...s, solar_w: 0, start_seconds: i * 900 }));
  const baseline = solved.selection.quarters.map(q => ({ ...q, battery_kwh: battery.max_soc * battery.capacity_kwh, discharge_w: 0, net_w: 1000 }));
  const water = p.problem.slots.map((_s, i) => i < 10 ? 3000 : 0);
  p.locked_slots = [];
  assertEquals(hotWaterSurplusPermissions(p, baseline, water).filter(Boolean).length, 0);
  baseline[20].net_w = -8000;
  const allowed = hotWaterSurplusPermissions(p, baseline, water);
  const spentWh = allowed.reduce((sum, yes, i) => sum + (yes ? water[i] * p.problem.slots[i].hours : 0), 0);
  assert(spentWh > 0);
  assert(spentWh <= 8000 * .25 * battery.charge_efficiency * battery.discharge_efficiency);
  baseline[20].discharge_w = 8000;
  assertEquals(hotWaterSurplusPermissions(p, baseline, water).filter(Boolean).length, 0, 'battery export cannot masquerade as solar refill');
});

Deno.test('grid charging reserves the full allowed heater draw even when the thermostat forecast is idle', async () => {
  const { waterBatteryCommands } = await import('./rules-hot-water.ts');
  const p = cpuPlanningInput();
  const solved = core.solve(p.problem).outcome; assert(solved.kind === 'selected');
  p.locked_slots = [];
  p.problem.limits.import_w = 5000;
  p.boiler_permitted[0] = true;
  p.boiler_rated_w[0] = 3000;
  p.boiler_battery_allowed[0] = false;
  const q = solved.selection.quarters.map(q => ({ ...q, pool_w: 0, ev_w: 0 }));
  const commands = solved.selection.commands.map(c => ({ ...c, battery: 'grid_charge' as const, charge_limit_w: 5000, discharge_limit_w: 0 }));
  for (const expected of [0, 500]) {
    p.boiler_w[0] = expected;
    p.problem.slots[0] = { ...p.problem.slots[0], base_w: 1000 + expected, solar_w: 0 };
    assertEquals(waterBatteryCommands(p, commands, q)[0].charge_limit_w, 1000);
  }
});
