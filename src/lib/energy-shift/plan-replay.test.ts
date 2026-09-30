import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { replayHistory, replayPlanSelection } from './plan-replay.ts';
import { buildEnergyTimeline, SLOT_MS } from './energy-timeline.ts';
import { generateOptimisationPlan } from '../../../supabase/functions/_shared/planner/energy-optimisation.ts';
import { mixedModeSnapshot } from '../../../scripts/generate-ha-plan-fixture.ts';

Deno.test('replay retains both branches of a scoped solve and bookmarks the displayed scenario', () => {
  const snapshot = mixedModeSnapshot();
  const now = new Date(snapshot.captured_at);
  const plan = generateOptimisationPlan(snapshot, now);
  for (const scenario of ['priority', 'baseline'] as const) {
    const slot = plan.plans[scenario].slots[1];
    const replay = replayPlanSelection(plan, scenario, slot.start);
    assertEquals(replay.selection, { scenario, quarter_index: 1, quarter_start: slot.start });
    assertEquals(replay.expected.planner_output, generateOptimisationPlan(snapshot, now, [], plan.price_outlook));
    assertEquals(replay.expected.selected_quarter, slot);
    assertEquals(replay.expected.planner_output.device_models.length, 2);
    assertEquals(replay.expected.planner_output.execution_plan!.plans, replay.expected.planner_output.plans);
  }
  assertThrows(() => replayPlanSelection(plan, 'priority', '2000-01-01T00:00:00Z'));
});

Deno.test('replay includes measured overnight device power outside the visible window and preserves gaps', () => {
  const at = Date.parse('2026-09-10T22:30:00Z');
  const start = new Date(at).toISOString();
  const timeline = buildEnergyTimeline({
    nowMs: at + 3 * SLOT_MS,
    planSlots: [], prices: [],
    actuals: [{ start_ts: start, total_load_kwh: .56, solar_production_kwh: 0,
      grid_import_kwh: .01, grid_export_kwh: 0, battery_charge_kwh: 0,
      battery_discharge_kwh: .55, battery_soc: .21, ev_soc: .8 }],
    deviceActuals: [{ start_ts: start, device_energy_kwh: { pump_id: .1875, heater_id: .185 } }],
    deviceKeyById: new Map([['pump_id', 'sensor.pump'], ['heater_id', 'sensor.heater']]),
  });
  timeline.push({ ...timeline[0], startMs: at + SLOT_MS,
    start: new Date(at + SLOT_MS).toISOString(), missing: true, loadW: null, deviceW: {} });
  timeline.push({ ...timeline[0], startMs: at + 3 * SLOT_MS,
    start: new Date(at + 3 * SLOT_MS).toISOString(), measured: false });
  const history = replayHistory(timeline, { from: 1, to: timeline.length }, 'Europe/Stockholm', start);
  const measured = history.slots.find(row => Date.parse(row.start) === at)!;
  assertEquals(measured.deviceW, { 'sensor.pump': 750, 'sensor.heater': 740 });
  assertEquals(measured.loadW, 2240);
  assertEquals(measured.batterySoc, .21);
  assertEquals(measured.importPriceSekPerKwh, null);
  assertEquals(history.selected_start, start);
  assertEquals(history.slots.length, 2);
  assertEquals(history.slots.every(row => row.measured), true);
  assertEquals(history.slots.filter(row => row.missing).every(row => row.loadW === null), true);
  assertEquals(history.timezone, 'Europe/Stockholm');
});
