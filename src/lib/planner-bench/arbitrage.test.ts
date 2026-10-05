import { assertEquals } from '@std/assert';
import { evaluate } from './evaluate.ts';
import { HOUSEHOLD } from './household.ts';
import { arbitragePreparation, resolveRules, scoreQuarters } from './score.ts';
import type { BenchSeries, CriteriaOverrides, PlanRecord } from './types.ts';
import { plan, world } from './world.fixture.ts';

const keys = ['arbitrage_no_export', 'arbitrage_not_full'];
const onlyArbitrage: CriteriaOverrides = Object.fromEntries(resolveRules().filter(r => !keys.includes(r.key)).map(r => [r.key, { enabled: false }]));
function series(): BenchSeries {
  const n = 8, zeros = () => new Array(n).fill(0);
  return {
    start: Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 9, 5, 0, i * 15)).toISOString()),
    hours: new Array(n).fill(0.25), published: zeros(), importPrice: new Array(n).fill(2),
    exportPrice: [0.5, 0.5, 0.5, 4.01, 4, 6, 0.5, 4.25],
    solarW: zeros(), loadW: new Array(n).fill(500), poolW: zeros(), hotWaterW: zeros(), carW: zeros(),
    gridImportW: zeros(), gridExportW: zeros(), batteryChargeW: zeros(), batteryDischargeW: zeros(),
    homeStartSoc: 50, homeSoc: new Array(n).fill(50), carSoc: zeros(), carConnected: zeros(), poolC: zeros(), costSek: zeros(),
  };
}

Deno.test('three high-sale quarters without preparation or export lose six points; exactly 4 does not qualify', () => {
  const s = series(), score = scoreQuarters(s, onlyArbitrage);
  assertEquals(score.sum, -6);
  assertEquals(score.counts, { arbitrage_no_export: 3, arbitrage_not_full: 3 });
  assertEquals(score.quarters.map(q => q.score), [0, 0, 0, -2, 0, -2, 0, -2]);
  assertEquals(score.requiredFired, []);
  s.gridExportW = s.gridExportW.map(() => 0.1);
  assertEquals(scoreQuarters(s, onlyArbitrage).counts, { arbitrage_not_full: 3 });
});

Deno.test('the last pre-opportunity charge finishing full avoids preparation penalties despite intervening discharge', () => {
  const s = series();
  s.batteryChargeW[0] = 2000; s.homeSoc[0] = 80;
  s.batteryChargeW[1] = 2000; s.homeSoc[1] = 100;
  s.batteryDischargeW[2] = 3000; s.homeSoc[2] = 74;
  s.gridExportW[3] = 0.1; s.gridExportW[5] = 5000; s.gridExportW[7] = 1;
  assertEquals(arbitragePreparation(s, 4), { firstQuarter: 3, lastChargeQuarter: 1, prepared: true });
  assertEquals(scoreQuarters(s, onlyArbitrage).sum, 0);
  s.gridExportW[7] = 0;
  assertEquals(scoreQuarters(s, onlyArbitrage).counts, { arbitrage_no_export: 1 });
});

Deno.test('a later partial recharge before the first opportunity supersedes an earlier full charge', () => {
  const s = series();
  s.batteryChargeW[0] = 2000; s.homeSoc[0] = 100;
  s.homeSoc[1] = 50; s.batteryChargeW[2] = 1000; s.homeSoc[2] = 60;
  assertEquals(arbitragePreparation(s, 4), { firstQuarter: 3, lastChargeQuarter: 2, prepared: false });
  assertEquals(scoreQuarters(s, onlyArbitrage).counts.arbitrage_not_full, 3);
});

Deno.test('charging during or after the first opportunity cannot remove penalties from subsequent separated high-price quarters', () => {
  const s = series();
  s.batteryChargeW[3] = 2000; s.homeSoc[3] = 100;
  s.batteryChargeW[4] = 2000; s.homeSoc[4] = 100;
  assertEquals(arbitragePreparation(s, 4), { firstQuarter: 3, lastChargeQuarter: null, prepared: false });
  assertEquals(scoreQuarters(s, onlyArbitrage).counts.arbitrage_not_full, 3);
});

Deno.test('an initially full battery counts without a later charge, including an opportunity in the first quarter', () => {
  const s = series(); s.homeStartSoc = 100;
  assertEquals(arbitragePreparation(s, 4).prepared, true);
  s.exportPrice[0] = 5;
  assertEquals(arbitragePreparation(s, 4), { firstQuarter: 0, lastChargeQuarter: null, prepared: true });
  assertEquals(scoreQuarters(s, onlyArbitrage).counts.arbitrage_not_full, undefined);
  s.homeStartSoc = 99.9;
  assertEquals(scoreQuarters(s, onlyArbitrage).counts.arbitrage_not_full, 4);
});

Deno.test('arbitrage rules have independent price thresholds, enabled states and points', () => {
  const s = series();
  assertEquals(scoreQuarters(s, { ...onlyArbitrage, arbitrage_no_export: { enabled: false } }).sum, -3);
  assertEquals(scoreQuarters(s, { ...onlyArbitrage, arbitrage_not_full: { enabled: false } }).sum, -3);
  assertEquals(scoreQuarters(s, { ...onlyArbitrage, arbitrage_not_full: { points: -2 } }).sum, -9);
  s.batteryChargeW[4] = 2000; s.homeSoc[4] = 100;
  const score = scoreQuarters(s, { ...onlyArbitrage, arbitrage_no_export: { threshold: 4.25 }, arbitrage_not_full: { threshold: 5 } });
  assertEquals(score.counts, { arbitrage_no_export: 1 });
  s.exportPrice.fill(4);
  assertEquals(scoreQuarters(s, onlyArbitrage).sum, 0);
  assertEquals(arbitragePreparation(s, 4).firstQuarter, -1);
});

Deno.test('real referee decisions preserve initial SOC and full-charge history in stored and live arbitrage scores', () => {
  const c = world({ buy: () => 2, sell: i => [3, 5, 7].includes(i) ? 4.25 : 0.5, start: { battery_soc: 0.9 } });
  const chargeW = (1 - c.start_state.battery_soc) * HOUSEHOLD.battery.capacity_kwh * 1000 / (HOUSEHOLD.battery.charge_efficiency * 0.25);
  const record: PlanRecord = {
    status: 'ready', generation: 'test', valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' },
    decisions: plan({ charge: i => i === 1 ? chargeW : 0, discharge: i => i === 2 ? 2000 : [3, 5, 7].includes(i) ? 1000 : 0 }),
    beliefs: { import_sek_per_kwh: [], grid_cost_sek: null }, curves: [],
  };
  const evaluated = evaluate(c, record, onlyArbitrage);
  assertEquals(evaluated.series.homeStartSoc, 90);
  assertEquals(evaluated.series.homeSoc[1], 100);
  assertEquals(evaluated.score.sum, 0);
  assertEquals(evaluated.score.points, scoreQuarters(evaluated.series, onlyArbitrage).points);
  record.decisions.battery_charge_w.fill(0);
  const unprepared = evaluate(c, record, onlyArbitrage);
  assertEquals(unprepared.score.counts, { arbitrage_not_full: 3 });
});
