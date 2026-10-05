import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { auditShortGaps, SHORT_GAP_PRICE_TOLERANCE, type ShortGapWitness } from './short-gaps.ts';
import { HOUSEHOLD } from './household.ts';
import { simulate, type Decisions } from './referee.ts';
import { DEFAULT_SERVICE_GUARD } from './service.ts';
import { evaluate } from './evaluate.ts';
import { scoreQuarters } from './score.ts';
import { TARGETS, plan, world, within } from './world.fixture.ts';
import type { BenchCase } from './case.ts';
import type { PlanRecord } from './types.ts';

const audit = (c: BenchCase, d: Decisions) => auditShortGaps(c, HOUSEHOLD, TARGETS, d,
  simulate(c, HOUSEHOLD, d), DEFAULT_SERVICE_GUARD, { pool: SHORT_GAP_PRICE_TOLERANCE, ev: SHORT_GAP_PRICE_TOLERANCE });
const interrupted = (device: 'pool' | 'ev', length: number) => plan({
  [device]: (i: number) => within(i, 5, 8) || within(i, 8 + length, 11 + length) ? device === 'pool' ? 3764 : 3450 : 0,
});
const recordOf = (c: BenchCase, decisions: Decisions): PlanRecord => ({
  status: 'ready', generation: 'synthetic', curves: [], decisions,
  valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' },
  beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh, grid_cost_sek: null },
});
function alternative(d: Decisions, gap: ShortGapWitness) {
  const changed = structuredClone(d);
  const key = gap.device === 'pool' ? 'pool_w' : 'ev_w';
  for (const change of gap.changes) changed[key][change.quarter] = change.afterW;
  return changed;
}

Deno.test('EV and pool gaps of 1–4 quarters have energy-preserving continuous witnesses and score once per gap', () => {
  const c = world();
  for (const device of ['ev', 'pool'] as const) {
    for (let length = 1; length <= 4; length++) {
      const d = interrupted(device, length), evidence = audit(c, d);
      assertEquals(evidence.gaps.length, 1, `${device}, ${length} quarters`);
      const gap = evidence.gaps[0];
      assertEquals([gap.device, gap.from, gap.to], [device, 8, 8 + length]);
      const moved = alternative(d, gap), key = device === 'pool' ? 'pool_w' : 'ev_w';
      assertAlmostEquals(moved[key].reduce((sum, w) => sum + w, 0), d[key].reduce((sum, w) => sum + w, 0));
      const on = moved[key].flatMap((w, i) => w > 0 ? [i] : []);
      assertEquals(on.length, on.at(-1)! - on[0] + 1);
      const before = simulate(c, HOUSEHOLD, d), after = simulate(c, HOUSEHOLD, moved);
      assertEquals(after.violations, []);
      for (const store of ['batteryKwh', 'evKwh', 'poolC'] as const) assert(after[store][287] >= before[store][287] - 1e-6);
      const evaluated = evaluate(c, recordOf(c, d), {});
      assertEquals(evaluated.score.counts[`${device}_short_gap`], 1);
      assertEquals(evaluated.series.audit!.shortGaps.gaps.length, 1);
      assert(evaluated.series.audit!.shortGaps.gaps[0].changes.length > 0);
      const scored = scoreQuarters(evaluated.series);
      assertEquals(scored.quarters.flatMap((q, i) => q.fired.includes(`${device}_short_gap`) ? [i] : []), [8]);
      assertEquals(scoreQuarters(evaluated.series, { [`${device}_short_gap`]: { enabled: false } }).sum, scored.sum + 1);
    }
  }
});

Deno.test('short gaps compare every gap price with both bordering prices, including negative prices and exactly 10 öre', () => {
  const d = interrupted('ev', 2);
  for (const price of [-1, 0, 1]) {
    assertEquals(audit(world({ buy: i => within(i, 8, 10) ? price + 0.1 : price }), d).gaps.length, 1);
    assertEquals(audit(world({ buy: i => i === 9 ? price + 0.1001 : price }), d).gaps.length, 0);
    // Similar to the preceding quarter alone is insufficient.
    assertEquals(audit(world({ buy: i => i === 10 ? price + 0.2 : price }), d).gaps.length, 0);
  }
});

Deno.test('the default 10 öre tolerance accepts gaps 6–8 öre above adjacent running quarters for both devices', () => {
  const c = world({ buy: i => i === 7 ? 1.8122 : i === 8 ? 1.88665 : i === 9 ? 1.82131 : 1.8 });
  for (const device of ['ev', 'pool'] as const) {
    const result = evaluate(c, recordOf(c, interrupted(device, 1)), {});
    assertEquals(result.score.counts[`${device}_short_gap`], 1);
  }
});

Deno.test('five-quarter gaps, leading/trailing idle time and continuous runs are exempt', () => {
  const c = world();
  assertEquals(audit(c, interrupted('ev', 5)).candidates, []);
  for (const d of [plan(), plan({ ev: i => within(i, 0, 10) ? 3450 : 0 }), plan({ pool: i => within(i, 280, 288) ? 3764 : 0 })]) {
    assertEquals(audit(c, d).gaps, []);
  }
});

Deno.test('a gap with no grid capacity is not penalised in either device', () => {
  const c = world({ load: i => within(i, 8, 10) ? HOUSEHOLD.site.import_limit_w : 500 });
  for (const device of ['pool', 'ev'] as const) {
    const d = interrupted(device, 2);
    assertEquals(simulate(c, HOUSEHOLD, d).violations, []);
    const result = audit(c, d);
    assertEquals(result.candidates.length, 1);
    assertEquals(result.gaps, []);
  }
});

Deno.test('EV gaps can be joined by lowering running power without adding energy or extra stops', () => {
  const c = world(), d = plan({ ev: i => i === 5 || i === 7 ? 6900 : 0 });
  const result = audit(c, d);
  assertEquals(result.gaps.length, 1);
  const moved = alternative(d, result.gaps[0]);
  assert(moved.ev_w[5] > 0 && moved.ev_w[6] > 0 && moved.ev_w[7] > 0);
  assertEquals(moved.ev_w[5] + moved.ev_w[6] + moved.ev_w[7], 13800);
});

Deno.test('gap witnesses must preserve service; a colder pool cannot trade service for continuous operation', () => {
  const c = world({ start: { pool_water_c: 27 }, air: () => 10 });
  const d = plan({ pool: i => i === 200 || i === 202 ? 3764 : 0 });
  assertEquals(audit(c, d).gaps, []);
});

Deno.test('price and comfort threshold edits require recomputing gap witnesses; stale audits supply no penalties', () => {
  const c = world({ buy: i => i === 8 ? 1.04 : 1 }), d = interrupted('ev', 1);
  const record = recordOf(c, d);
  const result = evaluate(c, record, {});
  assertEquals(result.score.counts.ev_short_gap, 1);
  const pending = scoreQuarters(result.series, { ev_short_gap: { threshold: 0.01 } });
  assertEquals(pending.auditPending, true);
  assertEquals(pending.counts.ev_short_gap, undefined);
  assertEquals(scoreQuarters(result.series, { pool_low: { threshold: 0.5 } }).auditPending, true);
  assertEquals(evaluate(c, record, { ev_short_gap: { threshold: 0.01 } }).score.counts.ev_short_gap, undefined);
  const oldAudit = { ...result.series.audit!, version: result.series.audit!.version - 1 };
  delete (oldAudit as Partial<typeof oldAudit>).shortGaps;
  assertEquals(scoreQuarters({ ...result.series, audit: oldAudit }).counts.ev_short_gap, undefined);
});
