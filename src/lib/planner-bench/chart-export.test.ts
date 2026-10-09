import { assertEquals } from '@std/assert';
import { benchChartExport, benchChartFilename } from './chart-export.ts';
import { evaluate } from './evaluate.ts';
import { resolveRules, scoreQuarters } from './score.ts';
import { plan, world } from './world.fixture.ts';
import type { PlanRecord } from './types.ts';

const c = world();
c.recorded.actual = { base_load_w: c.base_load_forecast_w, solar_w: c.solar_forecast_w };
const record: PlanRecord = { status: 'ready', generation: 'unit', valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' }, decisions: plan(), beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh, grid_cost_sek: null }, curves: [] };
const { series } = evaluate(c, record, {});
const score = scoreQuarters(series, {});
const source = (name: string, sha: string) => ({ name, sha, committed_at: '2026-10-08T20:01:58Z', subject: name, series, score });
const scenario = { id: 'case', name: 'C-0924', captured_at: series.start[0], revision: 'r1', start_state: c.start_state };
const n = series.start.length;
const exported = (from: number, to: number, label: string, test = source('dev', 'b')) => benchChartExport({
  scenario, timeZone: 'Europe/Stockholm', period: { label, from, to }, shown: 'test',
  plans: { current: source('main', 'a'), test }, rules: resolveRules({}),
});

Deno.test('the whole period exports every quarter of both planners as the chart draws them', () => {
  const file = exported(0, n, 'full 72 h');
  assertEquals([file.period.from_quarter, file.period.to_quarter, file.period.quarters, file.period.start], [0, n, n, series.start[0]]);
  assertEquals(file.plans.map(p => [p.name, p.role, p.shown, p.quarters.length]), [['main', 'production', false, n], ['dev', 'compared', true, n]]);
  const dev = file.plans[1];
  assertEquals(dev.quarters.map(q => q.score), score.quarters.map(q => q.score));
  assertEquals(dev.period.deduction_points, score.sum);
  assertEquals(dev.quarters.at(-1)!.cumulative_cost_sek, series.costSek.reduce((a, b) => a + b, 0));
  // A fired rule carries the points it gave or took, so a quarter's rules add up to its score.
  for (const q of dev.quarters) assertEquals(Object.values(q.rules_fired).reduce((a: number, b) => a + (b ?? 0), 0), q.score);
  assertEquals(Object.keys(dev.quarters[0].devices_w), series.devices.map(d => d.key));
});

Deno.test('a single day exports only that day, with its cost counted from the start of the day', () => {
  const file = exported(96, 192, '25/09');
  const dev = file.plans[1];
  assertEquals([file.period.quarters, file.period.start, dev.quarters[0].index, dev.quarters.at(-1)!.index], [96, series.start[96], 96, 191]);
  assertEquals(file.period.end, new Date(Date.parse(series.start[191]) + 900_000).toISOString());
  assertEquals(dev.quarters[0].cumulative_cost_sek, series.costSek[96]);
  assertEquals(dev.period.deduction_points, score.quarters.slice(96, 192).reduce((a, q) => a + q.score, 0));
  // The case's own totals stay the case's, whatever the period.
  assertEquals([dev.case!.points, dev.case!.deduction_points, dev.case!.net_bill_sek], [score.complete ? score.points : null, score.sum, score.bill?.net_sek ?? null]);
});

Deno.test('one commit on both sides is exported once, and the file is named after what it holds', () => {
  assertEquals(exported(0, n, 'full 72 h', source('main', 'a')).plans.map(p => [p.name, p.shown]), [['main', true]]);
  assertEquals(benchChartFilename('C-0924', 'main · dev', '25/09'), 'bench-C-0924-main-dev-25-09.json');
});
