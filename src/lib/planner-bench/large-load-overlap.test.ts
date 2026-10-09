import { assert, assertEquals } from '@std/assert';
import { auditLargeLoadOverlap } from './large-load-overlap.ts';
import { HOUSEHOLD } from './household.ts';
import { referee, simulate, type Decisions } from './referee.ts';
import { DEFAULT_SERVICE_GUARD } from './service.ts';
import { scheduleWitness } from './schedule-witness.ts';
import { measuredQuarters, scoreQuarters } from './score.ts';
import { evaluate } from './evaluate.ts';
import { TARGETS, plan, within, world } from './world.fixture.ts';
import type { BenchCase } from './case.ts';

const audit = (c: BenchCase, d: Decisions, h = HOUSEHOLD) =>
  auditLargeLoadOverlap(c, h, TARGETS, d, simulate(c, h, d), DEFAULT_SERVICE_GUARD, 2000);

Deno.test('two large bookings incur one penalty with a feasible cheaper quarter, even on day three', () => {
  const c = world({ buy: i => i === 287 ? 0.5 : 2, published: 288 });
  const d = plan({ pool: i => i === 100 ? 3764 : 0, ev: i => i === 100 ? 4140 : 0 });
  const evidence = audit(c, d);
  assertEquals(evidence.moves.length, 1);
  assertEquals([evidence.moves[0].from, evidence.moves[0].to], [100, 287]);
  assertEquals(evidence.moves[0].device, 'ev');
  const record = { decisions: d, beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh } };
  const evaluated = evaluate(c, record, {});
  assertEquals(evaluated.score.noted.large_load_overlap, 1);
  assert(evaluated.series.audit!.overlap.moves[0].movedW > 0);
  // The same purchase is also an early grid charge; the two never note a quarter together.
  assertEquals(evaluated.score.noted.early_grid_charge, undefined);
  assertEquals(scoreQuarters(evaluated.series, { large_load_overlap: { enabled: false } }).noted.early_grid_charge, 1);
  // Both are evidence: switching them off changes no points.
  assertEquals(scoreQuarters(evaluated.series, { large_load_overlap: { enabled: false }, early_grid_charge: { enabled: false } }).points, evaluated.score.points);
  assertEquals(measuredQuarters(evaluated.series).sum, measuredQuarters(evaluated.series, { large_load_overlap: { enabled: false }, early_grid_charge: { enabled: false } }).sum - 1);
  // Threshold changes require new witnesses; the browser never invents a move.
  assertEquals(scoreQuarters(evaluated.series, { large_load_overlap: { threshold: 5000 } }).auditPending, true);
  assertEquals(evaluate(c, record, { large_load_overlap: { threshold: 5000 } }).score.noted.large_load_overlap, undefined);
});

Deno.test('a cheaper isolated pool quarter cannot justify splitting a heating cycle when battery charging cannot move', () => {
  const c = world({
    start: { battery_soc: HOUSEHOLD.battery.min_soc, pool_water_c: 35 },
    buy: i => i === 200 ? 0.5 : 2,
  });
  const d = plan({
    pool: i => within(i, 96, 112) ? 3764 : 0,
    charge: i => i === 100 ? 3000 : 0,
    discharge: i => i === 101 ? 2707.5 : 0,
  });
  const original = simulate(c, HOUSEHOLD, d);
  assertEquals(original.violations, []);
  // Startup losses also prevent the isolated move preserving final heat;
  // the overlap rule independently keeps this continuous heating cycle fixed.
  const splitPool = structuredClone(d);
  splitPool.pool_w[100] = 0;
  splitPool.pool_w[200] = 3764;
  assert(!scheduleWitness(c, HOUSEHOLD, TARGETS, original, DEFAULT_SERVICE_GUARD)(splitPool, 'pool', [100, 200]));
  const evidence = audit(c, d);
  assertEquals(evidence.overlappingQuarters, [100]);
  assertEquals(evidence.moves, []);
  assertEquals(evaluate(c, { decisions: d, beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh } }, {}).score.noted.large_load_overlap, undefined);
});

Deno.test('filled cheapest quarter is skipped for the next cheapest with feasible room', () => {
  const c = world({ buy: i => i === 0 ? 0.1 : i === 1 ? 0.2 : 2, load: i => i === 0 ? HOUSEHOLD.site.import_limit_w : 500 });
  const d = plan({ pool: i => i === 100 ? 3764 : 0, ev: i => i === 100 ? 4140 : 0 });
  assertEquals(audit(c, d).moves.map(m => m.to), [1]);
  c.base_load_forecast_w[1] = HOUSEHOLD.site.import_limit_w;
  assertEquals(audit(c, d).moves, []);
});

Deno.test('seven variable EV bookings use distinct cheaper quarters in price order and execute together', () => {
  const c = world({ buy: i => i < 7 ? 0.1 + i / 10 : 2 });
  c.recorded.actual = { base_load_w: new Array(288).fill(500), solar_w: new Array(288).fill(0) };
  const d = plan({
    pool: i => within(i, 100, 107) ? 3764 : 0,
    ev: i => within(i, 100, 107) ? 3450 + 690 * ((i - 100) % 4) : 0,
  });
  const evidence = audit(c, d);
  assertEquals(evidence.moves.map(m => [m.from, m.to, m.device, m.movedW]),
    Array.from({ length: 7 }, (_, i) => [100 + i, i, 'ev', d.ev_w[100 + i]]));
  const altered = structuredClone(d);
  for (const move of evidence.moves) {
    altered.ev_w[move.from] -= move.movedW;
    altered.ev_w[move.to] += move.movedW;
  }
  for (const mode of ['told', 'recorded'] as const) {
    const before = simulate(c, HOUSEHOLD, d, mode), after = simulate(c, HOUSEHOLD, altered, mode);
    assertEquals(after.violations, []);
    assert(after.evKwh[287] >= before.evKwh[287] - 1e-6);
    assert(after.poolC[287] >= before.poolC[287] - 1e-6);
    assert(after.batteryKwh[287] >= before.batteryKwh[287] - 1e-6);
    for (const move of evidence.moves) assertEquals(after.evW[move.to], move.movedW);
  }
});

Deno.test('one cheaper destination justifies only one penalty even with spare charger capacity', () => {
  const c = world({ buy: i => i === 0 ? 0.1 : 2 });
  const d = plan({
    pool: i => within(i, 100, 107) ? 3764 : 0,
    ev: i => within(i, 100, 107) ? 3450 : 0,
  });
  assertEquals(audit(c, d).moves.map(m => [m.from, m.to]), [[100, 0]]);
  const record = { decisions: d, beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh } };
  assertEquals(evaluate(c, record, {}).score.noted.large_load_overlap, 1);
});

Deno.test('a destination is reserved across devices, not just for the moved device', () => {
  const c = world({ buy: i => i === 0 ? 0.1 : 2 });
  const d = plan({
    pool: i => within(i, 100, 102) ? 3764 : 0,
    ev: i => i === 100 ? 3450 : 0,
    charge: i => i === 101 ? 3000 : 0,
  });
  assertEquals(audit(c, d).moves.map(m => [m.from, m.to, m.device]), [[100, 0, 'ev']]);
});

Deno.test('distinct battery destinations cannot reuse the same intervening storage margin', () => {
  const h = structuredClone(HOUSEHOLD);
  h.battery.max_soc = 0.6;
  const c = world({ start: { battery_soc: 0.6 - 0.01 / h.battery.capacity_kwh }, buy: i => i < 2 ? 0.1 + i / 10 : 2 });
  const d = plan({
    pool: i => within(i, 100, 102) ? 3764 : 0,
    charge: i => within(i, 100, 102) ? 3000 : 0,
    discharge: i => within(i, 99, 101) ? 3000 : 0,
  });
  assertEquals(simulate(c, h, d).violations, []);
  const moves = audit(c, d, h).moves;
  assertEquals(moves.map(m => [m.from, m.to, m.device]), [[100, 0, 'battery']]);
  assert(moves[0].movedW > 0 && moves[0].movedW < 100);
});

Deno.test('pool, EV and battery pairs count, while one large load and exactly 2 kW do not', () => {
  const c = world({ buy: i => i === 0 ? 0.5 : 2, published: 288 });
  for (const [pool, ev, charge] of [[3764, 4140, 0], [3764, 0, 3000], [0, 4140, 3000], [3764, 4140, 3000], [0, 4140, 2001]]) {
    const d = plan({ pool: i => i === 100 ? pool : 0, ev: i => i === 100 ? ev : 0, charge: i => i === 100 ? charge : 0 });
    assertEquals(audit(c, d).moves.length, 1);
  }
  for (const [pool, ev, charge] of [[3764, 0, 0], [0, 4140, 2000], [0, 4140, 1999]]) {
    const d = plan({ pool: i => i === 100 ? pool : 0, ev: i => i === 100 ? ev : 0, charge: i => i === 100 ? charge : 0 });
    assertEquals(audit(c, d).moves, []);
  }
  const flat = world();
  assertEquals(audit(flat, plan({ pool: i => i === 100 ? 3764 : 0, ev: i => i === 100 ? 4140 : 0 })).moves, []);
});

Deno.test('a partially filled cheap battery quarter takes only its remaining storage capacity', () => {
  const h = structuredClone(HOUSEHOLD);
  h.battery.max_soc = 0.6;
  const c = world({ start: { battery_soc: 0.6 - 0.01 / h.battery.capacity_kwh }, buy: i => i === 0 ? -1 : 2 });
  const d = plan({ pool: i => i === 100 ? 3764 : 0, charge: i => i === 100 ? 3000 : 0, discharge: i => i === 99 ? 3000 : 0 });
  assertEquals(simulate(c, h, d).violations, []);
  const moves = audit(c, d, h).moves;
  assertEquals(moves.length, 1);
  assertEquals(moves[0].device, 'battery');
  assert(moves[0].movedW > 0 && moves[0].movedW < 100);
});

Deno.test('measured load does not turn a forecast-overloaded cheaper booking into a legal one', () => {
  const c = world({ buy: i => i === 0 ? 0.5 : 2, load: i => i === 0 ? HOUSEHOLD.site.import_limit_w : 500 });
  c.recorded.actual = { base_load_w: new Array(288).fill(500), solar_w: new Array(288).fill(0) };
  const d = plan({ pool: i => i === 100 ? 3764 : 0, ev: i => i === 100 ? 4140 : 0 });
  assertEquals(audit(c, d).moves, []);
});

Deno.test('cheaper room cannot justify reducing comfort or final stored energy', () => {
  // Below-target car: delaying charge increases its service deficit. Earlier pool heat loses final warmth.
  const c = world({ start: { ev: { soc: 0.3 } }, air: () => 10, buy: i => i === 287 ? 0.5 : 2 });
  const d = plan({ ev: i => i === 100 ? 4140 : 0, charge: i => i === 100 ? 3000 : 0, discharge: i => i === 101 ? 2707.5 : 0 });
  // The pack has just enough inventory for its original discharge, so delaying its charge is impossible.
  c.start_state.battery_soc = HOUSEHOLD.battery.min_soc;
  assertEquals(simulate(c, HOUSEHOLD, d).violations, []);
  assertEquals(audit(c, d).moves, []);
  // A full battery at the cheap quarter cannot take an earlier booking.
  const full = world({ start: { battery_soc: HOUSEHOLD.battery.max_soc }, buy: i => i === 0 ? 0.5 : 2 });
  const later = plan({ pool: i => i === 100 ? 3764 : 0, charge: i => i === 100 ? 3000 : 0, discharge: i => i === 99 ? 3000 : 0 });
  full.recorded.outdoor_temperature_c.fill(10);
  assertEquals(audit(full, later).moves, []);
});

Deno.test('a partial EV move must stay on charger levels and preserve the original stores', () => {
  const c = world({ buy: i => i === 0 ? 0.5 : 2, load: i => i === 0 ? HOUSEHOLD.site.import_limit_w - 4140 : 500 });
  const d = plan({ pool: i => i === 100 ? 3764 : 0, ev: i => i === 100 ? 6900 : 0 });
  const evidence = audit(c, d);
  assertEquals(evidence.moves.length, 1);
  const move = evidence.moves[0];
  assertEquals(move.device, 'ev');
  const altered = structuredClone(d);
  altered.ev_w[move.from] -= move.movedW;
  altered.ev_w[move.to] += move.movedW;
  assertEquals(simulate(c, HOUSEHOLD, altered).violations, []);
  const before = referee(c, HOUSEHOLD, TARGETS, d), after = referee(c, HOUSEHOLD, TARGETS, altered);
  assert(after.terminal.ev_kwh >= before.terminal.ev_kwh - 1e-6);
  assert(after.terminal.pool_c >= before.terminal.pool_c - 1e-6);
});
