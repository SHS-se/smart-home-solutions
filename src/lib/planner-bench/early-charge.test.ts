import { assert, assertEquals } from '@std/assert';
import { auditEarlyCharge, EARLY_CHARGE_PRICE_TOLERANCE } from './early-charge.ts';
import { HOUSEHOLD } from './household.ts';
import { simulate, type Decisions } from './referee.ts';
import { DEFAULT_SERVICE_GUARD } from './service.ts';
import { scoreQuarters } from './score.ts';
import { evaluate } from './evaluate.ts';
import { TARGETS, plan, within, world } from './world.fixture.ts';
import type { BenchCase } from './case.ts';

const audit = (c: BenchCase, d: Decisions) => auditEarlyCharge(c, HOUSEHOLD, TARGETS, d,
  simulate(c, HOUSEHOLD, d), DEFAULT_SERVICE_GUARD, EARLY_CHARGE_PRICE_TOLERANCE);
const record = (c: BenchCase, decisions: Decisions) => ({ decisions, beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh } });
/** A morning at 1.40 with one quarter at 1.00 an hour and a half in. */
const morning = (cheap = 1) => world({ buy: i => i === 7 ? cheap : 1.4, published: 288 });

Deno.test('three thin grid charges move into one clearly cheaper quarter, and each loses a point', () => {
  const c = morning(), d = plan({ charge: i => i === 0 || i === 2 || i === 5 ? 2000 : 0 });
  const evidence = audit(c, d);
  assertEquals(evidence.candidates.map(x => [x.quarter, x.device, x.boughtW]), [[0, 'battery', 2000], [2, 'battery', 2000], [5, 'battery', 2000]]);
  // One cheaper quarter takes all three: 6 kW of the battery's 8.8.
  assertEquals(evidence.moves, [0, 2, 5].map(from => ({ from, to: 7, device: 'battery', movedW: 2000 })));
  const evaluated = evaluate(c, record(c, d), {});
  assertEquals(evaluated.score.counts.early_grid_charge, 3);
  const scored = scoreQuarters(evaluated.series);
  assertEquals(scored.quarters.flatMap((q, i) => q.fired.includes('early_grid_charge') ? [i] : []), [0, 2, 5]);
  assertEquals(scoreQuarters(evaluated.series, { early_grid_charge: { enabled: false } }).sum, scored.sum + 3);
  // A new price margin needs new witnesses; the page never invents a move.
  assertEquals(scoreQuarters(evaluated.series, { early_grid_charge: { threshold: 0.5 } }).auditPending, true);
  assertEquals(evaluate(c, record(c, d), { early_grid_charge: { threshold: 0.5 } }).score.counts.early_grid_charge, undefined);
});

Deno.test('the later quarter must be cheaper by more than the larger of 10 öre and 10% of the charging price', () => {
  const d = plan({ charge: i => i === 0 ? 2000 : 0 });
  // 10% of 1.40 is 14 öre: exactly that is not clearly cheaper, a hair more is.
  assertEquals(audit(morning(1.26), d).moves, []);
  assertEquals(audit(morning(1.2599), d).moves.length, 1);
  // At low prices the 10 öre floor decides.
  const low = (cheap: number) => world({ buy: i => i === 7 ? cheap : 0.5, published: 288 });
  assertEquals(audit(low(0.4), d).moves, []);
  assertEquals(audit(low(0.3999), d).moves.length, 1);
  // An earlier cheaper quarter is no witness: the charge was not bought early.
  assertEquals(audit(world({ buy: i => i === 0 ? 1 : 1.4, published: 288 }), plan({ charge: i => i === 7 ? 2000 : 0 })).moves, []);
});

Deno.test('charging the sun carries is not a purchase, and less than 500 W from the grid is not judged', () => {
  const sunny = world({ buy: i => i === 7 ? 1 : 1.4, solar: i => i === 0 ? 2100 : 0, published: 288 });
  // 500 W of load and 2 kW of charging on 2.1 kW of sun: 400 W bought.
  assertEquals(audit(sunny, plan({ charge: i => i === 0 ? 2000 : 0 })).candidates, []);
  assertEquals(audit(morning(), plan({ charge: i => i === 0 ? 499 : 0 })).candidates, []);
});

Deno.test('a cheaper quarter without the power for all that was bought is no witness', () => {
  const c = morning(), room = HOUSEHOLD.battery.charge_max_w;
  // The cheap quarter is already charging at all but 1 kW of the battery's power.
  const d = plan({ charge: i => i === 0 ? 2000 : i === 7 ? room - 1000 : 0 });
  assertEquals(audit(c, d).moves, []);
  assertEquals(audit(c, plan({ charge: i => i === 0 ? 1000 : i === 7 ? room - 1000 : 0 })).moves.length, 1);
});

Deno.test('energy needed before the cheaper quarter stays where it was bought', () => {
  // The battery starts at its cut-off and supplies the house right after charging.
  const c = world({ buy: i => i === 7 ? 1 : 1.4, start: { battery_soc: HOUSEHOLD.battery.min_soc }, published: 288 });
  const d = plan({ charge: i => i === 0 ? 2000 : 0, discharge: i => within(i, 1, 4) ? 450 : 0 });
  assertEquals(simulate(c, HOUSEHOLD, d).violations, []);
  const evidence = audit(c, d);
  assertEquals(evidence.candidates.length, 1);
  assertEquals(evidence.moves, []);
});

Deno.test('a move that would raise the bill is no witness', () => {
  // The charge is sold at 3.00 before the cheaper quarter comes: bought later, it could not be.
  const c = world({ buy: i => i === 7 ? 1 : 1.4, sell: i => i === 3 ? 3 : 0.5, start: { battery_soc: HOUSEHOLD.battery.min_soc }, published: 288 });
  const d = plan({ charge: i => i === 0 ? 4000 : 0, discharge: i => i === 3 ? 3000 : 0 });
  assertEquals(simulate(c, HOUSEHOLD, d).violations, []);
  assertEquals(audit(c, d).moves, []);
});

Deno.test('the car moves in whole amps, and the rule never takes a quarter the overlap rule took', () => {
  const c = morning(), d = plan({ ev: i => i === 0 ? 4140 : 0 });
  const evidence = audit(c, d);
  assertEquals(evidence.moves, [{ from: 0, to: 7, device: 'ev', movedW: 4140 }]);
  assertEquals(evaluate(c, record(c, d), {}).score.counts.early_grid_charge, 1);
  // With the heat pump beside it the same quarter is a large-workload overlap, scored once.
  const both = evaluate(c, record(c, plan({ ev: i => i === 0 ? 4140 : 0, pool: i => i === 0 ? 3764 : 0 })), {});
  assertEquals([both.score.counts.large_load_overlap, both.score.counts.early_grid_charge], [1, undefined]);
  assert(both.series.audit!.earlyCharge.moves.length === 1);
});
