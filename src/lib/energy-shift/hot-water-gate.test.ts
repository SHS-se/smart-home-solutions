import { assertEquals } from 'jsr:@std/assert@1';
import { hotWaterQuarter } from './hot-water-gate.ts';
import { HOT_WATER_SERIES_KEY, projectPlanChart } from './plan-chart-data.ts';
import type { TimelineRow } from './energy-timeline.ts';

const slot = (overrides: Partial<Parameters<typeof hotWaterQuarter>[0]>) => ({
  boiler_expected_w: 500, boiler_permitted: true, ...overrides,
});

Deno.test('a load gate the forecast stays under is allowed, and carries both limits', () => {
  assertEquals(hotWaterQuarter(slot({ device_commands: {
    tank: { type: 'house_demand_permission', expected_permitted: true, allow_below_w: 3_000, inhibit_above_w: 6_000 },
  } }), ['tank']), { state: 'allowed', expectedW: 500, allowBelowW: 3_000, inhibitAboveW: 6_000 });
});

Deno.test('a load gate the forecast crosses is told apart from a plan block', () => {
  const gated = hotWaterQuarter(slot({ device_commands: {
    tank: { type: 'house_demand_permission', expected_permitted: false, allow_below_w: 2_000, inhibit_above_w: 5_000 },
  } }), ['tank']);
  const blocked = hotWaterQuarter(slot({ device_commands: { tank: { type: 'permit_inhibit', permitted: false } } }), ['tank']);
  assertEquals([gated.state, blocked.state], ['load_gate', 'blocked']);
  assertEquals(blocked.allowBelowW, null);
});

Deno.test('outside every window the heater is not controlled', () => {
  assertEquals(hotWaterQuarter(slot({ device_commands: {
    tank: { type: 'unavailable', reason: 'External forecast owner has no planner command' },
  } }), ['tank']).state, 'uncontrolled');
});

Deno.test('without per-device commands the aggregate decision is used', () => {
  assertEquals(hotWaterQuarter(slot({ boiler_permitted: false }), []).state, 'blocked');
  assertEquals(hotWaterQuarter(slot({ boiler_permitted: true }), []).state, 'allowed');
});

Deno.test('hot water is one pinned band: plan forecast ahead, meters behind', () => {
  const row = (i: number, measured: boolean, deviceW: Record<string, number>): TimelineRow => ({
    startMs: Date.parse('2026-10-14T10:00:00Z') + i * 900_000,
    start: new Date(Date.parse('2026-10-14T10:00:00Z') + i * 900_000).toISOString(),
    measured, solarW: 0, loadW: 2_000, baseW: null, gridImportW: 2_000, gridExportW: 0,
    batteryChargeW: 0, batteryDischargeW: 0, batterySoc: null, evSoc: null, deviceW, costSek: 0,
    importPriceSekPerKwh: 1, exportPriceSekPerKwh: 0.5, shadowImportSekPerKwh: null, shadowExportSekPerKwh: null,
  });
  const rows = [row(0, true, { tank: 300 }), row(1, false, { tank: 900 })];
  const quarter = hotWaterQuarter(slot({ boiler_expected_w: 900, device_commands: {
    tank: { type: 'house_demand_permission', expected_permitted: true, allow_below_w: 3_000, inhibit_above_w: 6_000 },
  } }), ['tank']);
  const chart = projectPlanChart({
    rows, range: { from: 0, to: 2 }, timeZone: 'Europe/Stockholm', prices: { kind: 'live' },
    devices: [{ key: 'tank', name: 'Tank', schedulable: true }],
    hotWater: { name: 'Hot water', colour: 'blue', keys: ['tank'], byStart: new Map([[rows[1].startMs, quarter]]) },
  });
  // A tiny draw still earns the band, and the meter is never drawn twice.
  assertEquals(chart.consumption.series.map(s => [s.key, s.colour, s.values]), [[HOT_WATER_SERIES_KEY, 'blue', [300, 900]]]);
  assertEquals(chart.consumption.baseValues, [1_700, 1_100]);
  assertEquals(chart.rows.map(r => r.hotWater?.state ?? null), [null, 'allowed']);
});
