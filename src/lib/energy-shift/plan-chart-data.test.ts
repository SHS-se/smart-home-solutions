import { assertEquals } from '@std/assert';
import { projectPlanChart, type ChartDevice, type ChartHotWater } from './plan-chart-data';
import type { ChartInstructionSlot } from './plan-device-instruction';
import type { TimelineRow } from './energy-timeline';

// Independently generated synthetic devices and quarter-hour observations.
const START = Date.parse('2026-11-01T00:00:00Z');
const devices: ChartDevice[] = ['charger', 'heater', 'pump', 'boiler'].map(key => ({
  key, name: key, colour: '#123456', schedulable: true,
}));
function row(index: number, measured = false): TimelineRow {
  const startMs = START + index * 900_000;
  return {
    startMs, start: new Date(startMs).toISOString(), measured,
    solarW: 0, loadW: 5000, baseW: 1000, gridImportW: 5000, gridExportW: 0,
    batteryChargeW: 0, batteryDischargeW: 0, batterySoc: null, evSoc: null,
    deviceW: Object.fromEntries(devices.map(device => [device.key, 1000])),
    costSek: 1, importPriceSekPerKwh: 1, exportPriceSekPerKwh: 0,
    shadowImportSekPerKwh: null, shadowExportSekPerKwh: null,
  };
}
function slot(index: number, available: boolean): ChartInstructionSlot {
  return {
    start: row(index).start, device_loads_w: row(index).deviceW,
    device_commands: available ? {
      charger: { type: 'variable_power', value: 6, unit: 'A' },
      heater: { type: 'setpoint', target_c: 21, minimum_c: 5, maximum_c: 30 },
      pump: { type: 'switch_schedule', on_seconds: 900 },
      boiler: { type: 'permit_inhibit', permitted: true },
    } : Object.fromEntries(devices.map(device => [device.key,
      { type: 'unavailable' as const, reason: 'Synthetic observation outage' }])),
  };
}
function project(rows: TimelineRow[], planSlots: ChartInstructionSlot[], hotWater?: ChartHotWater) {
  return projectPlanChart({ rows, planSlots, devices, hotWater,
    range: { from: 0, to: rows.length }, timeZone: 'UTC', prices: { kind: 'live' } });
}

Deno.test('unavailable services stay in household demand without becoming planned device bands', () => {
  const result = project([row(0)], [slot(0, false)]);
  assertEquals(result.consumption.series, []);
  assertEquals(result.consumption.baseValues, [5000]);
  assertEquals(result.rows[0].loadW, 5000);
  assertEquals(result.rows[0].gridImportW, 5000);
});

Deno.test('outages and recovery change only affected forecast quarters, preserving measured device history', () => {
  const rows = [row(0, true), row(1), row(2), row(3)];
  const result = project(rows, [slot(1, true), slot(2, false), slot(3, true)]);
  assertEquals(result.consumption.baseValues, [1000, 1000, 5000, 1000]);
  for (const series of result.consumption.series) assertEquals(series.values, [1000, 1000, 0, 1000]);
  assertEquals(rows[2].deviceW.charger, 1000, 'Projection leaves the producer forecast unchanged');
});

Deno.test('missing commands and missing slots cannot imply scheduled operation', () => {
  const result = project([row(0), row(1)], [{ start: row(0).start, device_loads_w: row(0).deviceW }]);
  assertEquals(result.consumption.series, []);
  assertEquals(result.consumption.baseValues, [5000, 5000]);
});

Deno.test('dedicated pool permission preserves its meter forecast without inventing a meter command', () => {
  const rows = [row(0), row(1)];
  const result = projectPlanChart({ rows, devices, range: { from: 0, to: 2 }, timeZone: 'UTC',
    prices: { kind: 'live' }, poolHeaterKeys: new Set(['heater']),
    planSlots: [{ ...slot(0, false), pool_permitted: true }, { ...slot(1, false), pool_permitted: null }],
  });
  assertEquals(result.consumption.series.map(series => [series.key, series.values]), [['heater', [1000, 0]]]);
  assertEquals(result.consumption.baseValues, [4000, 5000]);
});

Deno.test('uncontrolled hot-water forecasts stay in background demand and recover with explicit permissions', () => {
  const rows = [row(0), row(1)];
  const result = project(rows, [slot(0, false), slot(1, true)], {
    name: 'Hot water', colour: '#654321', keys: ['boiler'],
    byStart: new Map([[START, { state: 'uncontrolled', expectedW: 1000 }],
      [START + 900_000, { state: 'allowed', expectedW: 1000 }]]),
  });
  assertEquals(result.consumption.series.find(series => series.key === 'boiler')?.values, [0, 1000]);
  assertEquals(result.consumption.baseValues, [5000, 1000]);
});

Deno.test('entirely uncontrolled hot water does not create an empty scheduled band', () => {
  const result = project([row(0)], [slot(0, false)], {
    name: 'Hot water', colour: '#654321', keys: ['boiler'],
    byStart: new Map([[START, { state: 'uncontrolled', expectedW: 1000 }]]),
  });
  assertEquals(result.consumption.series, []);
  assertEquals(result.consumption.baseValues, [5000]);
});
