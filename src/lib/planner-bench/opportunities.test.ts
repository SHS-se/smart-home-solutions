import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import type { BenchCase } from './case.ts';
import { evaluate } from './evaluate.ts';
import { HOUSEHOLD, TARGETS } from './household.ts';
import { LANES, type LaneId } from './lanes.ts';
import {
  findOpportunities, MAX_TRIALS, NOT_MODELLED, OPPORTUNITY_RULES, ruleState, summariseAudit, type OpportunityAudit,
} from './opportunities.ts';
import { referee, type Decisions } from './referee.ts';
import { economicPoints, scoreQuarters, storedPassed, storedScore } from './score.ts';
import { DEFAULT_SERVICE_GUARD, serviceNotWorse, type ServiceExposure, type ServiceGuard } from './service.ts';
import type { PlanRecord } from './types.ts';
import { clockPlan, plan, realisticWorld, within, world } from './world.fixture.ts';

const END = 287;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const record = (decisions: Decisions): PlanRecord => ({
  status: 'ready', generation: 'test', valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' },
  decisions, beliefs: { import_sek_per_kwh: decisions.pool_w.map(() => null), grid_cost_sek: null }, curves: [],
});

/**
 * Audit a plan and hold the audit to its own claims, by replaying the improved
 * plan through the referee independently of the search.
 */
function audited(c: BenchCase, d: Decisions, lane: LaneId = 'told/nominal', guard: ServiceGuard = DEFAULT_SERVICE_GUARD): OpportunityAudit {
  const untouched = structuredClone(d);
  const { audit, improved } = findOpportunities(c, HOUSEHOLD, TARGETS, d, lane, guard);
  assertEquals(d, untouched, 'the plan was changed by auditing it');
  assertEquals(audit.status, 'complete');

  const before = referee(c, HOUSEHOLD, TARGETS, d), after = referee(c, HOUSEHOLD, TARGETS, improved);
  // The household can carry out the improved plan, and it costs what the audit says.
  assertEquals(after.violations, []);
  assertAlmostEquals(after.cost_sek, audit.improvedCostSek, 1e-3);
  assertAlmostEquals(before.cost_sek, audit.originalCostSek, 1e-3);
  // Every store ends where the plan ended it; the pool never colder, and warmer by less than one running
  // quarter of its heat pump (12.45 kW into 64 kWh per degree), which is the least it can be heated by.
  assertAlmostEquals(after.terminal.battery_kwh, before.terminal.battery_kwh, 1e-4);
  assertAlmostEquals(after.terminal.ev_kwh, before.terminal.ev_kwh, 1e-4);
  const warmer = after.series.poolC[END]! - before.series.poolC[END]!;
  assert(warmer >= -0.0011 && warmer <= 12.45 / 4 / 63.965 + 0.0011, `pool ends ${warmer} °C off`);
  // Whatever the audit moved, the heat pump is on at its setting or off in every quarter.
  assert(improved.pool_w.every(w => w === 0 || w === 3764), `the pool runs between off and on: ${[...new Set(improved.pool_w)]}`);
  // Comfort is no worse, rule by rule, so store by store.
  const was = scoreQuarters(before.series).counts, is = scoreQuarters(after.series).counts;
  for (const key of ['pool_low', 'pool_cold', 'ev_low', 'ev_short']) assert((is[key] ?? 0) <= (was[key] ?? 0), `${key} got worse`);
  // One saving, counted once: the findings add up to the difference between the two plans.
  assertAlmostEquals(audit.originalCostSek - audit.improvedCostSek - audit.wearSek, audit.avoidableSek, 2e-3);
  assertAlmostEquals(sum(audit.findings.map(f => f.savingSek)), audit.avoidableSek, 2e-3);
  assertAlmostEquals(sum(Object.values(audit.rules).map(r => r.knownSek + r.hindsightSek)), audit.avoidableSek, 2e-3);
  assertAlmostEquals(audit.knownSek + audit.hindsightSek, audit.avoidableSek, 2e-4);
  assertAlmostEquals(sum(audit.findings.filter(f => f.basis === 'known').map(f => f.savingSek)), audit.knownSek, 2e-3);
  for (const f of audit.findings) {
    assert(f.savingSek > 0 && f.kwh > 0 && Math.abs(f.gridSavingSek - f.wearSek - f.savingSek) < 0.001, `${f.id} claims no saving`);
    assertEquals(f.tags[0], f.rule);
    // Known findings come first and touch only published quarters.
    if (f.basis === 'known' && lane.startsWith('told')) assert(Math.max(f.fromEnd, f.toEnd) < before.series.published.filter(Boolean).length);
    const own = f.device === 'pool' ? 'poolC' : f.device === 'ev' ? 'carKm' : 'homeSoc';
    assertEquals([f.before[own].length, f.after[own].length], [288, 288]);
  }
  const bases = audit.findings.map(f => f.basis);
  assertEquals(bases, [...bases].sort((a, b) => a === b ? 0 : a === 'known' ? -1 : 1));
  assert(audit.trials <= MAX_TRIALS + 8);
  return audit;
}

const rulesFound = (audit: OpportunityAudit) => audit.findings.map(f => f.rule);

Deno.test('the catalogue names every rule the audit reports on', () => {
  const audit = audited(world(), plan());
  const keys = OPPORTUNITY_RULES.map(r => r.key);
  assertEquals(new Set(keys).size, keys.length);
  assertEquals(Object.keys(audit.rules).sort(), [...keys].sort());
  assertEquals(Object.keys(audit.applicability).sort(), [...keys].sort());
  for (const rule of OPPORTUNITY_RULES) {
    assert(rule.label && rule.description && ['battery', 'pool', 'ev'].includes(rule.device) && ['solar', 'price', 'waste'].includes(rule.category));
    assert(audit.applicability[rule.key].reason.length > 0);
  }
  assert(NOT_MODELLED.length > 0);
});

Deno.test('a flat world gives nothing to find, and that reads as no loss found or not applicable, never optimal', () => {
  const audit = audited(world(), plan());
  assertEquals(audit.findings, []);
  assertEquals([audit.knownSek, audit.hindsightSek, audit.avoidableSek, audit.limitReached], [0, 0, 0, false]);
  assertEquals(ruleState(audit, 'battery_price_spread'), 'no_loss_found');
  assertEquals(ruleState(audit, 'export_before_import'), 'not_applicable');
  assertEquals(ruleState(audit, 'uneconomic_cycling'), 'no_loss_found');
  // 500 W for 72 hours at 1 kr: the household's exposure with no store acting.
  assertAlmostEquals(audit.scaleSek, 36, 1e-6);
});

// Surplus solar at midday, a dear evening, a battery with room that the plan never uses.
const spilled = (published = 96) => world({
  solar: i => within(i, 40, 64) ? 5000 : 0, load: i => within(i, 68, 88) ? 3000 : 500,
  buy: i => within(i, 68, 88) ? 2 : 1, start: { battery_soc: 0.2 }, published,
});

Deno.test('solar exported and bought back the same evening is found, at what it cost', () => {
  const audit = audited(spilled(), plan());
  const first = audit.findings[0];
  assertEquals([first.rule, first.device, first.basis], ['export_before_import', 'battery', 'known']);
  assert(first.tags.includes('import_avoidable_by_storage'));
  assert(first.from >= 40 && first.fromEnd < 64 && first.to >= 68 && first.toEnd < 88);
  // The battery's room is 80 % of 18.08 kWh: 15.2 kWh in from the panels at 0.5 kr forgone,
  // 13.7 kWh out against a 2 kr import, less 5 öre of wear per kWh discharged.
  assertAlmostEquals(first.kwh, 15.225, 0.01);
  assertAlmostEquals(first.savingSek, 13.741 * 2 - 15.225 * 0.5 - 13.741 * 0.05, 0.02);
  assertAlmostEquals(first.wearSek, 13.741 * 0.05, 0.01);
  // The trace is the battery's own: empty at the start of the sun before, full after.
  assert(first.after.homeSoc[63] > 99 && first.before.homeSoc[63] === 20);
  assertEquals([first.after.poolC, first.after.carKm], [[], []]);
  assertEquals(ruleState(audit, 'export_before_import'), 'loss_found');
  assertEquals(ruleState(audit, 'pool_solar_preheat'), 'no_loss_found');
});

Deno.test('a single quarter is never judged: a cheap export or an idle battery is only a loss if another hour proves it', () => {
  // Exporting at 0.95 kr with room in the battery: no later import pays for the losses, so nothing is lost.
  const fairExport = audited(world({ solar: i => within(i % 96, 40, 64) ? 5000 : 0, sell: () => 0.95, start: { battery_soc: 0.2 } }), plan());
  assertEquals(fairExport.findings, []);
  assertEquals(fairExport.applicability.export_before_import.applicable, true);
  // Importing at a slightly dearer price with a charged battery idle: the plan is saving it for the 3 kr hours,
  // and it holds exactly enough for them.
  const hours = 11 * 0.25, kept = 2 * hours / 0.95;
  const saving = world({
    load: () => 2000, buy: i => within(i, 50, 56) ? 1.08 : within(i, 100, 111) ? 3 : 1,
    start: { battery_soc: 0.05 + kept / 18.08 + 1e-9 },
  });
  assertEquals(audited(saving, plan({ discharge: i => within(i, 100, 111) ? 2000 : 0 })).findings, []);
});

Deno.test('a battery cycle that lost money is found as waste, including the wear avoided', () => {
  const audit = audited(world({ load: () => 3000 }), plan({ charge: i => within(i, 12, 20) ? 2000 : 0, discharge: i => within(i, 32, 40) ? 1800 : 0 }));
  assertEquals(rulesFound(audit), ['uneconomic_cycling']);
  // 3.6 kWh came back out of about 4 kWh put in, at one price.
  assertAlmostEquals(audit.knownSek, 3.6 / 0.9025 - 3.6 + 3.6 * 0.05, 0.01);
  assertAlmostEquals(audit.wearSek, -3.6 * 0.05, 0.01);
});

Deno.test('a battery emptied before the dearer hours is found', () => {
  const c = world({ load: () => 2000, buy: i => within(i, 100, 112) ? 3 : 1, start: { battery_soc: 0.25 } });
  // 3.4 kWh is all it holds above its floor, and the plan spends 3 of it at 1 kr with 3 kr hours ahead.
  const audit = audited(c, plan({ discharge: i => within(i, 48, 54) ? 2000 : 0 }));
  const first = audit.findings[0];
  assertEquals([first.rule, first.tags], ['battery_preserve', ['battery_preserve', 'import_avoidable_by_storage']]);
  assert(first.from >= 48 && first.fromEnd < 54 && first.to >= 100 && first.toEnd < 112);
  // The same discharge an hour at a time, no extra wear: 2 kWh at 2 kr more.
  assertEquals([first.kwh, first.wearSek], [2, 0]);
  assertAlmostEquals(first.savingSek, 4, 0.01);
  // The rest of the 3 kr hours is worth charging for, found as a price spread.
  assert(rulesFound(audit).includes('battery_price_spread'));
});

Deno.test('a high export price with energy in the battery is found, wear paid', () => {
  const c = world({ load: () => 300, buy: i => within(i, 60, 64) ? 4.5 : 1, sell: i => within(i, 60, 64) ? 4 : 0.5 });
  const audit = audited(c, plan());
  assertEquals(audit.findings[0].rule, 'high_value_export');
  assert(audit.findings[0].to >= 60 && audit.findings[0].toEnd < 64);
  assert(audit.knownSek > 15 && audit.wearSek > 0.3, `${audit.knownSek} kr, wear ${audit.wearSek}`);
  assertEquals(audit.applicability.high_value_export.applicable, true);
});

Deno.test('negative prices are priced as they are', () => {
  // Paid to import for two hours, and paying to export at midday.
  const c = world({
    solar: i => within(i, 136, 160) ? 4000 : 0,
    buy: i => within(i, 20, 28) ? -0.5 : 1, sell: i => within(i, 20, 28) ? -0.6 : within(i, 136, 160) ? -0.2 : 0.5,
    start: { battery_soc: 0.3 }, published: 288,
  });
  const audit = audited(c, plan());
  assert(audit.knownSek > 5, `${audit.knownSek}`);
  assert(audit.findings.some(f => f.from >= 20 && f.fromEnd < 28), 'charging while paid to import');
  assert(audit.findings.some(f => f.tags.includes('export_before_import') && f.from >= 136 && f.fromEnd < 160), 'storing what cost money to export');
  assert(audit.improvedCostSek < 0 && audit.originalCostSek > 30);
  // Exposure is counted at absolute prices, so being paid does not shrink it.
  assert(audit.scaleSek > 36 - 4 * 0.5 * 0.5);
});

Deno.test('a full battery in front of the sun: using it first is found as headroom', () => {
  const c = world({ solar: i => within(i, 40, 64) ? 5000 : 0, load: i => i < 40 ? 2000 : 500, buy: i => i < 40 ? 2 : 1, start: { battery_soc: 1 } });
  const audit = audited(c, plan());
  assertEquals(audit.applicability.battery_headroom_solar.applicable, true);
  const first = audit.findings[0];
  assertEquals(first.rule, 'battery_headroom_solar');
  // Out before the sun, back in from the surplus.
  assert(first.toEnd < 40 && first.from >= 40 && first.fromEnd < 64);
  assert(first.before.homeSoc[39] === 100 && first.after.homeSoc[39] < 50);
});

// A cool autumn: the heat pump works in 15 °C air, power is 2 kr and surplus solar earns 0.3 kr.
const autumn = { air: () => 15, buy: () => 2, sell: () => 0.3, published: 288 };

Deno.test('a sunny day before a dull one: heating the pool ahead on the surplus is found, above target if need be', () => {
  const c = world({ ...autumn, solar: i => within(i, 40, 64) ? 5000 : 0 });
  const audit = audited(c, plan({ pool: i => within(i, 100, 140) ? 3764 : 0 }));
  const preheat = audit.findings.find(f => f.rule === 'pool_solar_preheat')!;
  assert(preheat, rulesFound(audit).join());
  assert(preheat.to >= 40 && preheat.toEnd < 64 && preheat.from >= 100);
  assert(preheat.savingSek > 5, `${preheat.savingSek}`);
  // Warmer than the 30 °C target at the end of the sun, where the plan had let it cool.
  assert(Math.max(...preheat.after.poolC) > 30 && preheat.before.poolC[63] < 29.6);
  assertEquals([preheat.after.homeSoc, preheat.after.carKm], [[], []]);
  // A warm pool is marked and loses nothing; the price rules are set aside to show it.
  const warm = scoreQuarters({ ...referee(c, HOUSEHOLD, TARGETS, plan({ pool: i => i < 30 ? 3764 : 0 })).series },
    { cheap_buy: { enabled: false }, cheapest_buy: { enabled: false }, dear_load: { enabled: false }, dearest_load: { enabled: false } });
  assertEquals(warm.sum, 0);
});

Deno.test('a dull day before a sunny one: waiting for the sun is found, as far as the comfort band allows', () => {
  // Enough sun on the second day for the battery and the pool both.
  const sunLater = { ...autumn, solar: (i: number) => within(i, 136, 160) ? 12_000 : 0 };
  // Six hours of heat on the first evening; the sun on the second day could give all of it.
  const heatEarly = plan({ pool: i => within(i, 76, 100) ? 3764 : 0 });
  // Starting warm, the pool can coast to the sun within a degree of target.
  const free = audited(world({ ...sunLater, start: { pool_water_c: 30.8 } }), heatEarly);
  const wait = free.findings.find(f => f.rule === 'pool_wait_for_sun')!;
  assert(wait && wait.from >= 76 && wait.to >= 136 && wait.toEnd < 160 && wait.savingSek > 10, rulesFound(free).join());
  assert(free.rules.pool_wait_for_sun.kwh > 12, `${free.rules.pool_wait_for_sun.kwh}`);
  // Starting a degree cooler, most of that heat is needed before the sun: without it the pool would be
  // more than a degree short by the morning. Less can wait, and the pool stays in its band until the sun.
  const held = audited(world({ ...sunLater, start: { pool_water_c: 29.7 } }), heatEarly);
  assert(held.rules.pool_wait_for_sun.kwh < free.rules.pool_wait_for_sun.kwh - 4, `${held.rules.pool_wait_for_sun.kwh} vs ${free.rules.pool_wait_for_sun.kwh}`);
  for (const f of held.findings.filter(f => f.device === 'pool')) assert(Math.min(...f.after.poolC.slice(0, 160)) >= 29, `${f.id} leaves the band`);
});

Deno.test('comfort is guarded store by store: a warmer pool never pays for a shorter car', () => {
  const exposure = (pool: number, ev: number): ServiceExposure => ({ pool: { mild: pool, severe: 0, worst: pool / 10, mildDeficitHours: pool / 10, severeDeficitHours: 0 }, ev: { mild: ev, severe: 0, worst: ev / 10, mildDeficitHours: ev / 10, severeDeficitHours: 0 } });
  assertEquals(serviceNotWorse(exposure(10, 0), exposure(10, 0)), true);
  assertEquals(serviceNotWorse(exposure(10, 0), exposure(0, 5)), false);
  assertEquals(serviceNotWorse(exposure(10, 5), exposure(12, 0)), false);
  // The same count, deeper: still worse.
  assertEquals(serviceNotWorse(exposure(10, 0), { ...exposure(10, 0), pool: { ...exposure(10, 0).pool, worst: 3 } }), false);

  // A car 100 km short that the plan charges at 7 A for two hours, 9.66 kWh, at a dear time. Power is cheapest on the last day,
  // but waiting for it leaves the car short for a day and more: the charge may move earlier, not there.
  // (The battery starts empty and the spread is too thin for it, so the car is the only thing to move.)
  const prices = { buy: (i: number) => within(i, 90, 98) ? 1.8 : i >= 200 ? 0.5 : 1.5, published: 288 };
  const short = audited(world({ ...prices, start: { battery_soc: 0.05, ev: { soc: 0.42 } } }), plan({ ev: i => within(i, 90, 98) ? 4830 : 0 }));
  const car = (audit: OpportunityAudit) => audit.findings.filter(f => f.device === 'ev');
  assert(car(short).length > 0 && car(short).every(f => f.rule === 'ev_timing'));
  // 250 km counts from a day after it was reachable; the car is never below it there, as in the plan.
  for (const f of car(short)) assert(Math.min(...f.after.carKm.slice(100)) >= 250, `${f.id} leaves the car short`);
  // 9.66 kWh at 0.3 kr less; a whole 5 A quarter more could wait for the 0.5 kr day only if the car had that to spare.
  assert(short.rules.ev_timing.knownSek >= 9.66 * 0.3 - 1e-3 && short.rules.ev_timing.knownSek < 4.5, `${short.rules.ev_timing.knownSek}`);
  // The same charge for a car already within 50 km of target can all wait for the cheap day.
  const fine = audited(world({ ...prices, start: { battery_soc: 0.05, ev: { soc: 0.56 } } }), plan({ ev: i => within(i, 90, 98) ? 4830 : 0 }));
  assert(car(fine).some(f => f.to >= 200), JSON.stringify(car(fine).map(f => [f.rule, f.to])));
  assertAlmostEquals(fine.rules.ev_timing.knownSek, 9.66 * 1.3, 0.01);
  // Every alternative the audit made for the car is one the charger can carry out.
  const levels = new Set(Array.from({ length: 12 }, (_, i) => (5 + i) * 690).concat(0));
  const moved = findOpportunities(world({ ...prices, start: { battery_soc: 0.05, ev: { soc: 0.56 } } }), HOUSEHOLD, TARGETS, plan({ ev: i => within(i, 90, 98) ? 4830 : 0 }), 'told/nominal').improved;
  assert(moved.ev_w.every(w => levels.has(w)), `the car is charged between two amp steps: ${[...new Set(moved.ev_w)]}`);
  assertAlmostEquals(sum(moved.ev_w), 8 * 4830, 1e-6);
});

Deno.test('what took hindsight is found and kept apart, and cannot use up what was knowable', () => {
  // One hour of battery, spent at 1 kr. A 2 kr hour was published; a 5 kr hour on the third day was not.
  const stored = 2 / 0.95;
  const spec = { load: () => 2000, start: { battery_soc: 0.05 + stored / 18.08 + 1e-9 }, published: 96 };
  const c = world({ ...spec, buy: i => within(i, 40, 44) ? 2 : within(i, 240, 244) ? 5 : 1 });
  const spent = plan({ discharge: i => within(i, 8, 12) ? 2000 : 0 });
  const told = audited(c, spent, 'told/nominal');
  assertEquals(told.findings[0].basis, 'known');
  assert(told.findings[0].to >= 40 && told.findings[0].toEnd < 44);
  assert(told.hindsightSek > 5, `${told.hindsightSek}`);
  assert(told.findings.filter(f => f.basis === 'hindsight').every(f => Math.max(f.fromEnd, f.toEnd) >= 96));
  // What was knowable is what the same plan loses in a world without the surprise.
  const calm = audited(world({ ...spec, buy: i => within(i, 40, 44) ? 2 : 1 }), spent, 'oracle/nominal');
  assert(calm.knownSek > 1.9);
  assertAlmostEquals(told.knownSek, calm.knownSek, 1e-3);
  // Told the real prices, all of it was knowable.
  const oracle = audited(c, spent, 'oracle/nominal');
  assertEquals(oracle.hindsightSek, 0);
  assert(oracle.knownSek > told.knownSek + 5);
  // Only the price lane matters to what was knowable.
  for (const lane of LANES) {
    const audit = audited(c, spent, lane);
    assertEquals(audit.lane, lane);
    assertAlmostEquals(audit.knownSek, lane.startsWith('told') ? told.knownSek : oracle.knownSek, 1e-9);
  }
});

Deno.test('with every hour unpublished but the first day, a solar miss on day two is hindsight, not a known loss', () => {
  const late = world({
    solar: i => within(i, 136, 160) ? 5000 : 0, load: i => within(i, 164, 184) ? 3000 : 500,
    buy: i => within(i, 164, 184) ? 2 : 1, start: { battery_soc: 0.2 }, published: 96,
  });
  const told = audited(late, plan());
  assertEquals(told.knownSek, 0);
  assert(told.hindsightSek > 15 && told.findings[0].rule === 'export_before_import' && told.findings[0].basis === 'hindsight');
  assertAlmostEquals(audited(late, plan(), 'oracle/low').knownSek, told.hindsightSek, 1e-6);
});

Deno.test('the audit is deterministic', () => {
  const c = realisticWorld();
  const a = findOpportunities(c, HOUSEHOLD, TARGETS, clockPlan(), 'told/nominal');
  const b = findOpportunities(structuredClone(c), HOUSEHOLD, TARGETS, clockPlan(), 'told/nominal');
  assertEquals(a, b);
});

Deno.test('a plan the household cannot carry out fails the case and earns no economic claim', () => {
  // A battery read below its floor is taken as read, not lifted to the floor.
  const low = world({ start: { battery_soc: 0.02 } });
  const idle = referee(low, HOUSEHOLD, TARGETS, plan());
  assertEquals([idle.violations, idle.series.homeSoc[0]], [[], 2]);
  const drain = referee(low, HOUSEHOLD, TARGETS, plan({ discharge: i => i === 4 ? 1000 : 0 }));
  assertEquals(drain.violations, [{ quarter: 4, kind: 'battery_empty', clipped_w: 1000 }]);
  // It can be charged, and then gives back only what is above the floor.
  const lifted = referee(low, HOUSEHOLD, TARGETS, plan({ charge: i => i < 4 ? 2000 : 0, discharge: i => i === 4 ? 1000 : 0 }));
  assertEquals(lifted.violations.length, 0);

  // A negative request is reported, not read as zero.
  const negative = referee(world(), HOUSEHOLD, TARGETS, plan({ pool: i => i === 7 ? -500 : 0 }));
  assertEquals(negative.violations, [{ quarter: 7, kind: 'negative_request', clipped_w: 500 }]);
  assertEquals(negative.series.poolW[7], 0);

  // The car stops at its own charge limit: 70 % to 80 % of 75.6 kWh is 7.56 kWh, 8.2 kWh at the wall.
  const car = world({ start: { ev: { soc: 0.7, target_soc: 0.8 } } });
  const within80 = referee(car, HOUSEHOLD, TARGETS, plan({ ev: i => i < 2 ? 11_040 : i === 2 ? 10_350 : 0 }));
  assertEquals(within80.violations, []);
  assertAlmostEquals(within80.series.carSoc[END]!, 80, 0.15);
  const past = referee(car, HOUSEHOLD, TARGETS, plan({ ev: i => i < 8 ? 11_040 : 0 }));
  assert(past.violations.length > 0 && past.violations.every(v => v.kind === 'ev_full'));
  assertAlmostEquals(Math.max(...past.series.carSoc as number[]), 80, 0.05);
  // What it can reach is bounded the same way: 80 % is 378 km.
  assertAlmostEquals(Math.max(...past.series.comfort!.carReachableKm), 378, 0.1);
  // A car read above its limit is taken as read, and cannot be charged.
  const over = referee(world({ start: { ev: { soc: 0.85, target_soc: 0.8 } } }), HOUSEHOLD, TARGETS, plan({ ev: i => i === 0 ? 3450 : 0 }));
  assertEquals([over.violations[0].kind, over.series.carSoc[END]], ['ev_full', 85]);

  // The charger holds whole amps from 5 to 16 on three phases: between two it runs at the lower, below 5 A not at all.
  const offStep = referee(world({ start: { ev: { soc: 0.3 } } }), HOUSEHOLD, TARGETS, plan({ ev: i => i === 0 ? 4000 : i === 1 ? 2000 : i === 2 ? 4830 : 0 }));
  assertEquals(offStep.violations, [{ quarter: 0, kind: 'ev_step', clipped_w: 550 }, { quarter: 1, kind: 'ev_step', clipped_w: 2000 }]);
  assertEquals(offStep.series.carW!.slice(0, 3), [3450, 0, 4830]);

  // The failed plan: no alternative is compared, the case fails whatever the verdict, and it gets no economic credit.
  const failed = evaluate(spilled(), record(plan({ discharge: i => i < 96 ? 9600 : 0 })), {}, 'told/nominal');
  const audit = failed.series.audit!;
  assertEquals([audit.status, audit.findings, audit.knownSek, audit.trials], ['invalid', [], 0, 1]);
  assert(audit.reason!.includes('battery_empty') && audit.violations.length === failed.outcome.violations.length);
  assertEquals(ruleState(audit, 'export_before_import'), 'unverified');
  assertEquals([failed.score.physical_failed, failed.score.economic_points], [true, 0]);
  assertEquals([failed.score.audit.violations > 0, failed.score.audit.violationKinds.battery_empty > 0], [true, true]);
  assertEquals([storedPassed(failed.score, 'pass'), storedPassed(failed.score, null)], [false, false]);
  const live = scoreQuarters(failed.series, { pool_low: { enabled: false }, pool_cold: { enabled: false }, ev_low: { enabled: false } }, 'pass');
  assertEquals([live.physicalFailed, live.passed, live.economicPoints], [true, false, 0]);
});

Deno.test('a case scores each affected known-price quarter under its primary rule, hindsight beside it', () => {
  // No plan here heats the pool, which cools all the while: its comfort is set aside to leave the battery's story.
  const unheated = { pool_low: { enabled: false }, pool_cold: { enabled: false } };
  const lost = evaluate(spilled(), record(plan()), unheated, 'told/nominal');
  const { score } = lost, audit = lost.series.audit!;
  assertEquals(score.audit, summariseAudit(audit));
  assertEquals([score.audit.findingCount, 'findings' in score.audit], [audit.findings.length, false]);
  assertEquals(score.sum, 0);
  // The monetary saving is evidence; raw points count changed quarters under primary rules.
  assertAlmostEquals(audit.scaleSek, 74, 1e-6);
  assert(audit.knownSek > 0);
  assertEquals(score.economic_points, -sum(Object.values(audit.rules).map(r => r.knownQuarters.length)));
  assertEquals([score.points, economicPoints(audit)], [score.sum + score.economic_points, score.economic_points]);
  // The same miss, unknowable when planned: shown, not scored.
  const unforeseen = evaluate(spilled(40), record(plan()), unheated, 'told/nominal');
  assert(unforeseen.series.audit!.hindsightSek > 15);
  assertEquals(unforeseen.score.economic_points, 0);
  assert(evaluate(spilled(40), record(plan()), unheated, 'oracle/nominal').score.economic_points < 0);
  // A plan that takes the opportunity is left with next to nothing.
  const taken = evaluate(spilled(), record(plan({ charge: i => within(i, 40, 64) ? 2500 : 0, discharge: i => within(i, 68, 88) ? 2700 : 0 })), unheated, 'told/nominal');
  assertEquals(taken.outcome.violations, []);
  assert(taken.score.points > lost.score.points && taken.series.audit!.knownSek < 0.15 * lost.series.audit!.knownSek, `${taken.score.points} ${taken.series.audit!.knownSek}`);
});

Deno.test('the page scores a stored plan without replaying it, and never shows an audit its thresholds do not support', () => {
  const c = world({ ...autumn, solar: i => within(i, 136, 160) ? 5000 : 0, start: { pool_water_c: 30.6 } });
  const { series, score } = evaluate(c, record(plan({ pool: i => within(i, 60, 100) ? 3764 : 0 })), {}, 'told/nominal');
  const live = scoreQuarters(series);
  assertEquals([live.points, live.sum, live.economicPoints], [score.points, score.sum, score.economic_points]);
  assertEquals([live.complete, live.auditPending, live.audit === series.audit], [true, false, true]);
  // A wider band: every stored witness still holds, so the audit stands.
  assertEquals(scoreQuarters(series, { pool_low: { threshold: 1.5 } }).auditPending, false);
  // A band of 0.05 °C: the alternative lets the pool sag further than that, so the audit must be made again.
  const tight = scoreQuarters(series, { pool_low: { threshold: 0.05 } });
  assertEquals([tight.auditPending, tight.economicPoints, tight.complete], [true, null, false]);
  assertThrows(() => storedScore(series, { pool_low: { threshold: 0.05 } }), Error, 'other comfort thresholds');
  // Evaluated under the tight band, the audit holds itself to it.
  const strict = evaluate(c, record(plan({ pool: i => within(i, 60, 100) ? 3764 : 0 })), { pool_low: { threshold: 0.05 } }, 'told/nominal');
  assertEquals(strict.series.audit!.guard, { pool: [0.05, 2], ev: [50, 100] });
  assertEquals(scoreQuarters(strict.series, { pool_low: { threshold: 0.05 } }).auditPending, false);
  // A series from before the audit: no economic score, said so, and no stored score to be had.
  const { audit: _, ...old } = series;
  const bare = scoreQuarters(old);
  assertEquals([bare.audit, bare.economicPoints, bare.complete, bare.auditPending, bare.physicalFailed], [null, null, false, false, false]);
  assertEquals(bare.points, bare.sum);
  assertThrows(() => storedScore(old), Error, 'opportunity audit');
});

Deno.test('real-sized audits stay within their deterministic replay budget', () => {
  const plans: [string, Decisions][] = [['by the clock', clockPlan()], ['idle', plan()], ['pool only', plan({ pool: i => within(i % 96, 0, 30) ? 3764 : 0 })]];
  const lines: string[] = [];
  for (const [name, d] of plans) {
    for (const lane of ['told/nominal', 'oracle/nominal'] as LaneId[]) {
      const c = realisticWorld();
      const audit = audited(c, d, lane);
      // `audited` replays and scores as well; time the audit alone.
      const t0 = performance.now();
      findOpportunities(c, HOUSEHOLD, TARGETS, d, lane);
      const ms = performance.now() - t0;
      lines.push(`${name} ${lane}: ${ms.toFixed(0)} ms, ${audit.trials} replays, ${audit.findings.length} findings (${sum(audit.findings.map(f => f.transfers))} transfers), known ${audit.knownSek.toFixed(1)} kr, hindsight ${audit.hindsightSek.toFixed(1)} kr of ${audit.scaleSek.toFixed(0)} kr${audit.limitReached ? ', budget reached' : ''}`);
    }
  }
  const c = realisticWorld();
  const t0 = performance.now();
  for (const lane of LANES) evaluate(c, record(clockPlan()), {}, lane);
  lines.push(`evaluate, six lanes: ${(performance.now() - t0).toFixed(0)} ms`);
  console.log(lines.join('\n'));

});
