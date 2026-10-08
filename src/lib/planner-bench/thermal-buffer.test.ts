import { assertEquals, assert } from '@std/assert';
import { thermalBufferTrace } from './thermal-buffer';
import { localMonths } from '../../../supabase/functions/_shared/planner-wasm/calendar';
import { scoreQuarters } from './score';
import type { BenchSeries } from './types';

function series(): BenchSeries {
  const n = 288, values = (v: number) => new Array(n).fill(v);
  return {
    devices: [], deviceW: {}, start: Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 6, 17) + i * 900000).toISOString()),
    hours: values(.25), published: values(1), importPrice: values(1), exportPrice: values(0),
    solarW: values(1000), loadW: values(0), poolW: values(0), poolStart: values(null),
    hotWaterW: values(0), carW: values(0), gridImportW: values(0), gridExportW: values(0),
    batteryChargeW: values(0), batteryDischargeW: values(0), baseLoadBatteryCoverW: values(0),
    homeSoc: values(50), homeStartSoc: 50, carSoc: values(80), carConnected: values(1), poolC: values(32.6), costSek: values(0),
    comfort: { pool_target_c: 30.5, ev_target_km: 360, pool_start_c: 30.5, ev_start_km: 360, poolReachableC: values(35), carReachableKm: values(360) },
    poolThermal: { store: { capacity_kwh_per_c: 1, loss: { kind: 'measured', points: [{ at_c: 30, c_per_h: -1 / 30 }] } }, outdoorC: values(20), localMonth: values(7) },
  };
}
const trace = (s: BenchSeries, cycle = 43200) => thermalBufferTrace(s, 2, 1, cycle)!;

Deno.test('buffer credits freeze the original event and a short restart ends continuously warm credit', () => {
  const s = series();
  s.solarW = s.solarW.map((_, i) => i < 96 ? 1000 : i < 192 ? 500 : 100);
  s.poolStart![6] = { off_seconds: 900 };
  const t = trace(s);
  assertEquals(t.slice(0, 6).map(q => q.earns), new Array(6).fill(true));
  assert(t.slice(6).every(q => !q.earns));
  assertEquals(t[0].event, { from: 96, to: 192, reheatQuarter: 121, highPrices: false, lowSolar: true });
  // At quarter 71 the freshly computed need maps to day three; the active episode keeps day two.
  s.poolStart![6] = null;
  const frozen = trace(s);
  assertEquals(frozen[71].event, frozen[0].event);
  assert(frozen[121].earns);
  assert(!frozen[122].earns);
});

Deno.test('long OFF opens a cycle but cannot reuse a claimed event; a distinct event can earn credit', () => {
  const s = series();
  s.solarW = s.solarW.map((_, i) => i < 96 ? 1000 : i < 192 ? 500 : 100);
  s.poolStart![1] = { off_seconds: 43199 };
  s.poolStart![2] = { off_seconds: 43200 };
  s.poolStart![96] = { off_seconds: 43200 };
  s.poolC.fill(32, 3, 96);
  const t = trace(s);
  assert(t[0].earns);
  assert(t.slice(1, 71).every(q => !q.earns));
  assert(t[96].earns);
  assertEquals(t[96].event?.from, 192);
  // Disabled deduction still retains the configured cycle threshold.
  const scored = scoreQuarters(s, { pool_restart: { enabled: false, threshold: 13 } });
  assertEquals(scored.thermalBuffer?.[96].earns, false);
});

Deno.test('solar credit uses May–September locally; price credit remains valid in winter and combines causes', () => {
  const s = series();
  s.solarW = s.solarW.map((_, i) => i < 96 ? 1000 : 100);
  for (const month of [1, 4, 5, 9, 10, 12]) {
    s.poolThermal!.localMonth.fill(month);
    assertEquals(trace(s)[0].earns, month === 5 || month === 9);
  }
  s.importPrice = s.importPrice.map((_, i) => i < 96 ? 1 : 2);
  assertEquals(trace(s)[0].event?.highPrices, true);
  assertEquals(trace(s)[0].event?.lowSolar, false);
  s.poolThermal!.localMonth.fill(5);
  assertEquals(trace(s)[0].event, { from: 96, to: 192, reheatQuarter: 121, highPrices: true, lowSolar: true });
  assertEquals(localMonths(['2026-04-30T22:15:00Z', '2026-09-30T22:15:00Z'], 'Europe/Stockholm'), [5, 10]);
});

Deno.test('warmth alone, no modeled need, unknown stop, and stale evidence cannot manufacture buffer points', () => {
  const s = series();
  assertEquals(trace(s).some(q => q.earns), false);
  s.importPrice = s.importPrice.map((_, i) => i < 96 ? 1 : 2);
  s.poolC.fill(32.5);
  assertEquals(trace(s).some(q => q.earns), false);
  s.poolC.fill(32.6);
  s.poolStart![1] = { off_seconds: 900 };
  s.poolStart![2] = { off_seconds: null };
  assertEquals(trace(s)[2].earns, false);
  s.poolThermal!.store.loss = { kind: 'linear', kw_per_c: 0, surroundings_c: null };
  assertEquals(trace(s).some(q => q.earns), false);
  delete s.poolThermal;
  assertEquals(trace(s), null);
  const score = scoreQuarters(s);
  assertEquals(score.auditPending, true);
  assertEquals(score.complete, false);
});

Deno.test('a crossing quarter earns credit, followed by seven warm coasting quarters; continued heating spends the episode', () => {
  const s = series();
  s.comfort!.pool_start_c = 32.49;
  s.importPrice = s.importPrice.map((_, i) => i < 96 ? 1 : 2);
  s.poolW[0] = 4000;
  s.poolC = s.poolC.map((_, i) => Math.round((32.58 - i * .01) * 1000) / 1000);
  assertEquals(trace(s).filter(q => q.earns).length, 8);
  const coasting = scoreQuarters(s);
  assertEquals(coasting.counts.pool_buffer, 8);
  assertEquals(coasting.quarters[0].fired, ['pool_buffer', 'cheapest_buy']);
  assertEquals(coasting.quarters[1].fired, ['pool_buffer']);
  // An extra heating quarter cannot extend credit, even after the heater stops.
  s.poolW[1] = 4000;
  s.poolC.fill(39, 1);
  assertEquals(trace(s).filter(q => q.earns).length, 1);
  const continued = scoreQuarters(s);
  assertEquals(continued.quarters[1].fired, ['pool_hot']);
  assertEquals(continued.counts.pool_buffer, 1);
});

Deno.test('heating at the buffer boundary loses overheating points on the final day; other devices retain cheap credit', () => {
  const s = series();
  s.comfort!.pool_start_c = 32.5;
  s.poolC.fill(32.6);
  s.poolW.fill(4000);
  s.importPrice.fill(1);
  const hot = scoreQuarters(s);
  assertEquals(hot.quarters[0].fired, ['pool_hot']);
  assertEquals(hot.quarters[287].fired, ['pool_hot']);
  assertEquals(hot.counts.cheapest_buy, undefined);
  s.carW[287] = 1000;
  assertEquals(scoreQuarters(s).quarters[287].fired, ['pool_hot', 'cheapest_buy']);
  s.carW[287] = 0;
  s.batteryChargeW[287] = 1000;
  assertEquals(scoreQuarters(s).quarters[287].fired, ['pool_hot', 'cheapest_buy']);
  // Rule controls still apply: disabling overheating also removes its price-credit exclusion.
  assertEquals(scoreQuarters(s, { pool_hot: { enabled: false } }).quarters[0].fired, ['cheapest_buy']);
});
