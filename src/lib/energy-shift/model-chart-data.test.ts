import { assertEquals } from '@std/assert';
import { modelChartData, type ModelChartSeries } from './model-chart-data';
import { projectPlanChart } from './plan-chart-data';

Deno.test('shared model charts retain a complete calendar month and restart costs for any selected range', () => {
  const n = 2980;
  const values = (v: number) => Array(n).fill(v);
  const series: ModelChartSeries = {
    start: Array.from({ length: n }, (_, i) => new Date(Date.parse('2026-09-30T22:00:00Z') + i * 900_000).toISOString()),
    devices: [{ key: 'ev', name: 'Car', schedulable: true }], deviceW: { ev: values(400) },
    solarW: values(0), loadW: values(1000), gridImportW: values(1000), gridExportW: values(0),
    batteryChargeW: values(0), batteryDischargeW: values(0), homeSoc: values(50), carSoc: values(80),
    poolC: values(30), costSek: values(0.5), importPrice: values(2), exportPrice: values(0.5),
  };
  const data = modelChartData(series);
  const project = (from: number, to: number) => projectPlanChart({ ...data, devices: series.devices,
    timeZone: 'Europe/Stockholm', range: { from, to } });
  const month = project(0, n);
  assertEquals(month.rows.length, n);
  assertEquals(month.rows.at(-1)!.startMs, Date.parse('2026-10-31T22:45:00Z'));
  assertEquals(month.rows.at(-1)!.cumulativeCostSek, n * 0.5);
  assertEquals(month.consumption.baseValues, values(600));
  const period = project(n - 288, n);
  assertEquals(period.rows.length, 288);
  assertEquals(period.rows[0].cumulativeCostSek, 0.5);
  assertEquals(period.rows.at(-1)!.cumulativeCostSek, 144);
});
