import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { auditShortGaps, SHORT_GAP_PRICE_TOLERANCE, type ShortGapWitness } from './short-gaps.ts';
import { HOUSEHOLD } from './household.ts';
import { simulate, type Decisions } from './referee.ts';
import { DEFAULT_SERVICE_GUARD } from './service.ts';
import { evaluate } from './evaluate.ts';
import { REMOVED_RULE_KEYS, resolveRules, scoreQuarters } from './score.ts';
import { TARGETS, plan, world, within } from './world.fixture.ts';
import type { BenchCase } from './case.ts';
import type { PlanRecord } from './types.ts';

const audit = (c: BenchCase, d: Decisions) => auditShortGaps(c, HOUSEHOLD, TARGETS, d,
  simulate(c, HOUSEHOLD, d), DEFAULT_SERVICE_GUARD, { pool: SHORT_GAP_PRICE_TOLERANCE });
/** Pool heating paused for `length` quarters between two three-quarter runs. */
const interrupted = (length: number) => plan({
  pool: (i: number) => within(i, 5, 8) || within(i, 8 + length, 11 + length) ? 3764 : 0,
});
const recordOf = (c: BenchCase, decisions: Decisions): PlanRecord => ({
  status: 'ready', generation: 'synthetic', curves: [], decisions,
  valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' },
  beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh, grid_cost_sek: null },
});
function alternative(d: Decisions, gap: ShortGapWitness) {
  const changed = structuredClone(d);
  for (const change of gap.changes) changed.pool_w[change.quarter] = change.afterW;
  return changed;
}

Deno.test('pool gaps of 1–4 quarters have energy-preserving continuous witnesses, charged once by the restart', () => {
  const c = world();
  for (let length = 1; length <= 4; length++) {
    const d = interrupted(length), evidence = audit(c, d);
    assertEquals(evidence.gaps.length, 1, `${length} quarters`);
    const gap = evidence.gaps[0];
    assertEquals([gap.device, gap.from, gap.to], ['pool', 8, 8 + length]);
    const moved = alternative(d, gap);
    assertAlmostEquals(moved.pool_w.reduce((sum, w) => sum + w, 0), d.pool_w.reduce((sum, w) => sum + w, 0));
    const on = moved.pool_w.flatMap((w, i) => w > 0 ? [i] : []);
    assertEquals(on.length, on.at(-1)! - on[0] + 1);
    const before = simulate(c, HOUSEHOLD, d), after = simulate(c, HOUSEHOLD, moved);
    assertEquals(after.violations, []);
    for (const store of ['batteryKwh', 'evKwh', 'poolC'] as const) assert(after[store][287] >= before[store][287] - 1e-6);
    const evaluated = evaluate(c, recordOf(c, d), {});
    assertEquals(evaluated.series.audit!.shortGaps.gaps.length, 1);
    assert(evaluated.series.audit!.shortGaps.gaps[0].changes.length > 0);
    const scored = scoreQuarters(evaluated.series), rule = 'pool_short_gap', gapQuarters = Array.from({ length }, (_, i) => 8 + i);
    const where = (list: 'fired' | 'noted', key: string, from = scored) => from.quarters.flatMap((q, i) => q[list].includes(key) ? [i] : []);
    // One pause, one deduction: the restart takes its two points and the gap is noted.
    assertEquals([evaluated.score.counts[rule], evaluated.score.noted[rule], where('noted', rule)], [undefined, length, gapQuarters]);
    assertEquals(where('fired', 'pool_restart'), [8 + length]);
    assertEquals(scoreQuarters(evaluated.series, { [rule]: { enabled: false } }).sum, scored.sum);
    // Where the restart rule does not charge the pause, the gap rule does.
    const unowned = scoreQuarters(evaluated.series, { pool_restart: { enabled: false } });
    assertEquals([where('fired', rule, unowned), unowned.sum], [gapQuarters, scored.sum + 2 - length]);
    const brief = scoreQuarters(evaluated.series, { pool_restart: { threshold: 0.1 } });
    assertEquals(where('fired', rule, brief), gapQuarters);
  }
});

Deno.test('a pause in car charging is no rule: it is neither audited nor charged, and an old override of it is ignored', () => {
  const c = world();
  const d = plan({ ev: i => within(i, 5, 8) || within(i, 9, 12) ? 3450 : 0 });
  const evaluated = evaluate(c, recordOf(c, d), { ev_short_gap: { points: -2 } });
  assertEquals(evaluated.series.audit!.shortGaps.candidates, []);
  assertEquals(Object.keys({ ...evaluated.score.counts, ...evaluated.score.noted }).filter(key => key.includes('short_gap')), []);
  assertEquals(evaluated.score.sum, evaluate(c, recordOf(c, d), {}).score.sum);
  assert(REMOVED_RULE_KEYS.includes('ev_short_gap'));
  assertEquals(resolveRules().some(r => r.key === 'ev_short_gap'), false);
});

/** Nothing but the grid to run on: no sun, and a battery at its cut-off. */
const gridOnly = { start: { battery_soc: HOUSEHOLD.battery.min_soc } };

Deno.test('a dearer gap excuses the pause beyond the larger of 10 öre and 10% of its own magnitude, inclusive, when it would have to be bought', () => {
  const d = interrupted(2);
  for (const price of [-3, -1, -0.05, 0, 0.05, 1, 3]) {
    const tolerance = Math.max(0.1, Math.abs(price) * 0.1);
    const buy = (i: number) => within(i, 8, 10) ? price : price - tolerance;
    assertEquals(audit(world({ buy, ...gridOnly }), d).gaps.length, 1, `${price}`);
    // Either bordering running quarter a hair cheaper excuses the whole gap.
    for (const border of [7, 10]) {
      assertEquals(audit(world({ buy: i => i === border ? buy(i) - 0.0001 : buy(i), ...gridOnly }), d).gaps.length, 0, `${price}, ${border}`);
    }
    // A cheaper gap is never an excuse.
    assertEquals(audit(world({ buy: i => within(i, 8, 10) ? price - 1 : price, ...gridOnly }), d).gaps.length, 1, `${price}, cheaper`);
  }
});

Deno.test('each idle quarter is judged at its own price, not the average of the gap', () => {
  // 2.00 is within its own 10% of 1.80; averaged with the cheap quarter beside it, it would not be.
  assertEquals(audit(world({ buy: i => i === 8 ? 2 : i === 9 ? 1 : 1.8, ...gridOnly }), interrupted(2)).gaps.length, 1);
  assertEquals(audit(world({ buy: i => i === 8 ? 2.01 : i === 9 ? 1 : 1.8, ...gridOnly }), interrupted(2)).gaps, []);
});

Deno.test('a dearer gap the sun or spare battery could have carried is no excuse', () => {
  const dear = (i: number) => within(i, 8, 10) ? 3 : 1;
  const sunny = (i: number) => within(i, 8, 10) ? 5000 : 0;
  // A half-full battery carries the heat pump and the house through both quarters.
  assertEquals(audit(world({ buy: dear }), interrupted(2)).gaps.length, 1);
  assertEquals(audit(world({ buy: dear, ...gridOnly }), interrupted(2)).gaps, []);
  assertEquals(audit(world({ buy: dear, solar: sunny, ...gridOnly }), interrupted(2)).gaps.length, 1);
});

Deno.test('the combined tolerance accepts the discussed 1-, 2- and 4-quarter gap price windows', () => {
  const windows = [
    [1.8122, 1.88665, 1.82131],
    [1.8122, 1.88665, 1.82131, 1.70208],
    [1.68275, 1.76646, 1.7636, 1.72264, 1.68929, 1.63933],
  ];
  for (const prices of windows) {
    const c = world({ buy: i => i >= 7 && i < 7 + prices.length ? prices[i - 7] : 1.8 });
    const result = evaluate(c, recordOf(c, interrupted(prices.length - 2)), {});
    // The gap is noted; its restart is charged instead.
    assertEquals(result.score.noted.pool_short_gap, prices.length - 2);
  }
});

Deno.test('joining short pool runs still cannot reduce the final heat inventory', () => {
  // Joining two cold starts delivers more heat than the two separate quarters,
  // and the equal-energy witness cannot invent partial commands: whichever
  // side of the gap is blocked, no witness is found.
  for (const blocked of [5, 8]) {
    const c = world({ load: i => i === blocked ? HOUSEHOLD.site.import_limit_w : 500 });
    const d = plan({ pool: i => i === 4 || i === 9 ? 3764 : 0 });
    assertEquals(simulate(c, HOUSEHOLD, d).violations, []);
    assertEquals(audit(c, d).gaps, []);
  }
});

Deno.test('five-quarter gaps, leading/trailing idle time and continuous runs are exempt', () => {
  const c = world();
  assertEquals(audit(c, interrupted(5)).candidates, []);
  for (const d of [plan(), plan({ pool: i => within(i, 0, 10) ? 3764 : 0 }), plan({ pool: i => within(i, 280, 288) ? 3764 : 0 })]) {
    assertEquals(audit(c, d).gaps, []);
  }
});

Deno.test('a gap with no grid capacity is not penalised', () => {
  const c = world({ load: i => within(i, 8, 10) ? HOUSEHOLD.site.import_limit_w : 500 });
  const d = interrupted(2);
  assertEquals(simulate(c, HOUSEHOLD, d).violations, []);
  const result = audit(c, d);
  assertEquals(result.candidates.length, 1);
  assertEquals(result.gaps, []);
});

Deno.test('gap witnesses must preserve service; a colder pool cannot trade service for continuous operation', () => {
  const c = world({ start: { pool_water_c: 27 }, air: () => 10 });
  const d = plan({ pool: i => i === 200 || i === 202 ? 3764 : 0 });
  assertEquals(audit(c, d).gaps, []);
});

Deno.test('price and comfort threshold edits require recomputing gap witnesses; stale audits supply no findings', () => {
  // The gap quarter is 4 öre dearer than its borders, with only the grid to run on.
  const c = world({ buy: i => i === 8 ? 0.04 : 0, ...gridOnly }), d = interrupted(1);
  const record = recordOf(c, d);
  const result = evaluate(c, record, {});
  assertEquals(result.score.noted.pool_short_gap, 1);
  const pending = scoreQuarters(result.series, { pool_short_gap: { threshold: 0.01 } });
  assertEquals(pending.auditPending, true);
  assertEquals(pending.noted.pool_short_gap, undefined);
  assertEquals(scoreQuarters(result.series, { pool_low: { threshold: 0.5 } }).auditPending, true);
  // Recomputed at a 1 öre tolerance, the dearer quarter excuses the pause.
  assertEquals(evaluate(c, record, { pool_short_gap: { threshold: 0.01 } }).score.noted.pool_short_gap, undefined);
  const oldAudit = { ...result.series.audit!, version: result.series.audit!.version - 1 };
  delete (oldAudit as Partial<typeof oldAudit>).shortGaps;
  assertEquals(scoreQuarters({ ...result.series, audit: oldAudit }).noted.pool_short_gap, undefined);
});
