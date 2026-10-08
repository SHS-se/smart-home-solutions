import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { projectPlanChart } from '../energy-shift/plan-chart-data';
import { benchChartData } from './chart-data';
import { HOUSEHOLD } from './household';
import { BENCH_DEVICE_KEYS } from './devices';
import { referee } from './referee';
import { plan, world, TARGETS } from './world.fixture';

Deno.test('live and bench projections interpret model-owned startup electricity and thermal trajectory identically', () => {
  const c = world({ start: { pool_heater: { kind: 'off', seconds: 43200 } } });
  const series = referee(c, HOUSEHOLD, TARGETS, plan({ pool: i => i < 4 ? 3764 : 0 })).series;
  const timeline = benchChartData(series, 'told/nominal');
  const input = { rows: timeline.rows, range: { from: 0, to: 4 }, timeZone: c.timezone, devices: series.devices };
  const live = projectPlanChart({ ...input, prices: { kind: 'live' } });
  const bench = projectPlanChart({ ...input, prices: timeline.prices });
  assertEquals(bench.consumption, live.consumption);
  assertEquals(bench.rows.map(({ plannerImportPriceSekPerKwh: _, ...r }) => r), live.rows);
  const pump = series.deviceW[BENCH_DEVICE_KEYS.poolPump], compressor = series.deviceW[BENCH_DEVICE_KEYS.poolHeater];
  assertEquals(pump[0], 764);
  assert(compressor[0] < compressor[1]);
  assertAlmostEquals(pump[0] + compressor[0], series.poolW[0], 1e-8);
  assertEquals(bench.rows[0].poolTemperatureC, series.poolC[0]);
  assertEquals(bench.consumption.baseValues, [500, 500, 500, 500]);
});

Deno.test('both charts restart selected-window cost, retain price evidence, and expose inconsistent meter totals', () => {
  const series = referee(world(), HOUSEHOLD, TARGETS, plan()).series;
  const data = benchChartData(series, 'told/nominal');
  data.rows[96].loadW = 1;
  data.rows[96].deviceW[BENCH_DEVICE_KEYS.poolHeater] = 1000;
  const chart = projectPlanChart({ ...data, range: { from: 96, to: 100 }, timeZone: 'Europe/Stockholm', devices: series.devices });
  assertEquals(chart.rows[0].cumulativeCostSek, series.costSek[96]);
  assertEquals(chart.rows[0].importPriceQuoted, false);
  assertEquals(chart.consumption.invalidIndices, [0]);
  assert(Number.isNaN(chart.consumption.baseValues[0]));
  assertThrows(() => benchChartData({ ...series, deviceW: {} }, 'told/nominal'));
});
