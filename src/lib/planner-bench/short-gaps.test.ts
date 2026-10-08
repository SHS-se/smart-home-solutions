import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { auditShortGaps, SHORT_GAP_PRICE_TOLERANCE, type ShortGapWitness } from './short-gaps.ts';
import { HOUSEHOLD } from './household.ts';
import { simulate, type Decisions } from './referee.ts';
import { DEFAULT_SERVICE_GUARD } from './service.ts';
import { evaluate } from './evaluate.ts';
import { scoreQuarters } from './score.ts';
import { TARGETS, plan, world, within, shortEvRestartFixture } from './world.fixture.ts';
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

Deno.test('EV and pool gaps of 1–4 quarters have energy-preserving continuous witnesses and score every gap quarter', () => {
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
      assertEquals(evaluated.score.counts[`${device}_short_gap`], length);
      assertEquals(evaluated.series.audit!.shortGaps.gaps.length, 1);
      assert(evaluated.series.audit!.shortGaps.gaps[0].changes.length > 0);
      const scored = scoreQuarters(evaluated.series);
      assertEquals(scored.quarters.flatMap((q, i) => q.fired.includes(`${device}_short_gap`) ? [i] : []), Array.from({ length }, (_, i) => 8 + i));
      assertEquals(scoreQuarters(evaluated.series, { [`${device}_short_gap`]: { enabled: false } }).sum, scored.sum + length);
    }
  }
});

Deno.test('gap prices use the larger of 10 öre and 10% of their own magnitude, inclusive at both boundaries', () => {
  for (const device of ['ev', 'pool'] as const) {
    const d = interrupted(device, 2);
    for (const price of [-3, -1, -0.05, 0, 0.05, 1, 3]) {
      const tolerance = Math.max(0.1, Math.abs(price) * 0.1);
      const buy = (i: number) => within(i, 8, 10) ? price : i < 8 ? price - tolerance : price + tolerance;
      assertEquals(audit(world({ buy }), d).gaps.length, 1, `${device}, ${price}`);
      // Either bordering running price can disqualify the whole gap.
      for (const border of [7, 10]) {
        assertEquals(audit(world({ buy: i => i === border ? buy(i) + (border === 7 ? -0.0001 : 0.0001) : buy(i) }), d).gaps.length, 0);
      }
    }
  }
});

Deno.test('each idle quarter uses its own tolerance, not the maximum or average price of the gap', () => {
  for (const device of ['ev', 'pool'] as const) {
    const c = world({ buy: i => i === 8 ? 2 : i === 9 ? 1.63 : 1.8 });
    assertEquals(audit(c, interrupted(device, 2)).gaps, []);
  }
});

Deno.test('the combined tolerance accepts the discussed 1-, 2- and 4-quarter gap price windows for both devices', () => {
  const windows = [
    [1.8122, 1.88665, 1.82131],
    [1.8122, 1.88665, 1.82131, 1.70208],
    [1.68275, 1.76646, 1.7636, 1.72264, 1.68929, 1.63933],
  ];
  for (const prices of windows) {
    const c = world({ buy: i => i >= 7 && i < 7 + prices.length ? prices[i - 7] : 1.8 });
    for (const device of ['ev', 'pool'] as const) {
      const result = evaluate(c, recordOf(c, interrupted(device, prices.length - 2)), {});
      assertEquals(result.score.counts[`${device}_short_gap`], prices.length - 2);
    }
  }
});

Deno.test('C-0616 told/low scores all four EV gap quarters by joining the restart to the earlier run', () => {
  // C-0616 told/low: both border prices pass every gap quarter's 10% envelope.
  const { c, decisions: d } = shortEvRestartFixture();
  const evaluated = evaluate(c, recordOf(c, d), {}, 'told/low');
  const result = evaluated.series.audit!.shortGaps;
  assertEquals(result.candidates, [{ device: 'ev', from: 12, to: 16 }]);
  assertAlmostEquals(d.ev_w.reduce((sum, w) => sum + w * 0.25 / 1000, 0), 2.76);
  assertEquals(result.gaps.length, 1);
  const moved = alternative(d, result.gaps[0]);
  assertEquals(moved.ev_w.slice(10, 17), [4140, 3450, 3450, 0, 0, 0, 0]);
  assertAlmostEquals(moved.ev_w.reduce((sum, w) => sum + w * 0.25 / 1000, 0), 2.76);
  const before = simulate(c, HOUSEHOLD, d), after = simulate(c, HOUSEHOLD, moved);
  assertEquals(after.violations, []);
  for (const store of ['batteryKwh', 'evKwh', 'poolC'] as const) assert(after[store][287] >= before[store][287] - 1e-6);
  assertEquals(evaluated.score.counts.ev_short_gap, 4);
  assertEquals(scoreQuarters(evaluated.series).quarters.flatMap((q, i) => q.fired.includes('ev_short_gap') ? [i] : []), [12, 13, 14, 15]);
});

Deno.test('short runs can join at either side of a longer gap without filling every idle quarter', () => {
  for (const device of ['ev', 'pool'] as const) {
    const power = device === 'ev' ? 3450 : 3764;
    const key = device === 'ev' ? 'ev_w' : 'pool_w';
    // Pool heat decays, so finishing earlier cannot preserve its final store.
    for (const blocked of device === 'ev' ? [5, 8] : [5]) {
      const c = world({ load: i => i === blocked ? HOUSEHOLD.site.import_limit_w : 500 });
      const d = plan({ [device]: (i: number) => i === 4 || i === 9 ? power : 0 });
      assertEquals(simulate(c, HOUSEHOLD, d).violations, []);
      const result = audit(c, d);
      if (device === 'pool') {
        // Joining two cold starts delivers more heat than the two separate
        // quarters. The equal-energy witness cannot invent partial commands.
        assertEquals(result.gaps.length, 0);
        continue;
      }
      assertEquals(result.gaps.length, 1, `${device}, blocked quarter ${blocked}`);
      const moved = alternative(d, result.gaps[0]);
      const on = moved[key].flatMap((w, i) => w > 0 ? [i] : []);
      assertEquals(on.length, 2);
      assertEquals(on[1] - on[0], 1);
      assertEquals(moved[key][blocked], 0);
      assertEquals(simulate(c, HOUSEHOLD, moved).violations, []);
      assertEquals(evaluate(c, recordOf(c, d), {}).score.counts[`${device}_short_gap`], 4);
    }
  }
});

Deno.test('joining short pool runs still cannot reduce the final heat inventory', () => {
  const c = world({ load: i => i === 8 ? HOUSEHOLD.site.import_limit_w : 500 });
  const d = plan({ pool: i => i === 4 || i === 9 ? 3764 : 0 });
  assertEquals(simulate(c, HOUSEHOLD, d).violations, []);
  assertEquals(audit(c, d).gaps, []);
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
  const c = world({ buy: i => i === 8 ? 0.04 : 0 }), d = interrupted('ev', 1);
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
