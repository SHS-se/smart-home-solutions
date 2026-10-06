import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { HOUSEHOLD } from './household.ts';
import { referee } from './referee.ts';
import { BASE_LOAD_DEAR_RULE_KEYS, DEFAULT_RULES, scoreQuarters, storedScore } from './score.ts';
import { baseLoadGridSupplyW } from './supply.ts';
import type { BenchSeries } from './types.ts';
import { TARGETS, plan, world } from './world.fixture.ts';

const onlyBase = Object.fromEntries(DEFAULT_RULES.filter(r => !BASE_LOAD_DEAR_RULE_KEYS.includes(r.key))
  .map(r => [r.key, { enabled: false }]));
const highPrices = (i: number) => i === 0 ? 3.93 : i === 1 ? 4.40 : i >= 240 ? 5 : 1 + i / 1000;

Deno.test('base-load imports lose one or two points by price rank, never both, regardless of an extreme peak', () => {
  const s = referee(world({ buy: highPrices, load: () => 1960, start: { battery_soc: 1 } }), HOUSEHOLD, TARGETS, plan()).series;
  assertEquals(s.baseLoadBatteryCoverW.slice(0, 2), [1960, 1960]);
  const scored = scoreQuarters(s, onlyBase);
  assertEquals(scored.quarters[0], { score: -1, fired: ['base_load_dear_import'] });
  assertEquals(scored.quarters[1], { score: -1, fired: ['base_load_dear_import'] });
  assertEquals(scored.quarters[240], { score: -2, fired: ['base_load_dearest_import'] });
  assertEquals(scored.quarters[2], { score: 0, fired: [] });
  s.importPrice[287] = 6.11;
  assertEquals(scoreQuarters(s, onlyBase).quarters.slice(0, 2), scored.quarters.slice(0, 2));
  s.importPrice[287] = 20;
  assertEquals(scoreQuarters(s, onlyBase).quarters.slice(0, 2), scored.quarters.slice(0, 2));
  assertEquals(scoreQuarters(s, { ...onlyBase, base_load_dearest_import: { enabled: false } }).quarters[240],
    { score: -1, fired: ['base_load_dear_import'] });
  assertEquals(scoreQuarters(s, { ...onlyBase, base_load_dear_import: { threshold: 0.1 } }).quarters[0].score, 0);
});

Deno.test('the battery must cover the whole imported base load, at least 500 W, for the full quarter', () => {
  const c = world({ buy: highPrices, load: () => 1000 });
  const h = structuredClone(HOUSEHOLD);
  h.battery.discharge_max_w = 999.9;
  const limited = referee(c, h, TARGETS, plan()).series;
  assertEquals(limited.baseLoadBatteryCoverW[0], 999.9);
  assertEquals(scoreQuarters(limited, onlyBase).quarters[0].score, 0);
  h.battery.discharge_max_w = 1000;
  assertEquals(scoreQuarters(referee(c, h, TARGETS, plan()).series, onlyBase).quarters[0].score, -1);
  for (const [load, expected] of [[499.9, 0], [500, -1]]) {
    const s = referee(world({ buy: highPrices, load: () => load }), h, TARGETS, plan()).series;
    assertEquals(scoreQuarters(s, onlyBase).quarters[0].score, expected);
  }
  h.battery.capacity_kwh = 1;
  h.battery.min_soc = 0.1;
  h.battery.discharge_efficiency = 0.5;
  c.start_state.battery_soc = 0.5; // 0.4 kWh usable DC => 0.2 kWh AC, insufficient for 1000 W over 15 min.
  const energyLimited = referee(c, h, TARGETS, plan()).series;
  assertEquals(energyLimited.baseLoadBatteryCoverW[0], 800);
  assertEquals(scoreQuarters(energyLimited, onlyBase).quarters[0].score, 0);
  c.start_state.battery_soc = 0.1;
  assertEquals(referee(c, h, TARGETS, plan()).series.baseLoadBatteryCoverW[0], 0);
});

Deno.test('existing discharge uses battery headroom and energy before additional base-load supply', () => {
  const h = structuredClone(HOUSEHOLD);
  h.battery.discharge_max_w = 1500;
  const c = world({ buy: highPrices, load: () => 1500 });
  const s = referee(c, h, TARGETS, plan({ discharge: i => i === 0 ? 1000 : 0 })).series;
  assertEquals([baseLoadGridSupplyW(s, 0), s.baseLoadBatteryCoverW[0]], [500, 500]);
  assertEquals(scoreQuarters(s, onlyBase).quarters[0].score, -1);
  h.battery.discharge_max_w = 1499.9;
  assertEquals(scoreQuarters(referee(c, h, TARGETS, plan({ discharge: () => 1000 })).series, onlyBase).quarters[0].score, 0);
  h.battery.capacity_kwh = 1;
  h.battery.min_soc = 0.1;
  h.battery.discharge_efficiency = 0.5;
  c.start_state.battery_soc = 0.5;
  const drained = referee(c, h, TARGETS, plan({ discharge: i => i === 0 ? 800 : 0 })).series;
  assertAlmostEquals(drained.homeSoc[0]!, 10);
  assertEquals(drained.baseLoadBatteryCoverW[0], 0);
  assertEquals(scoreQuarters(drained, onlyBase).quarters[0].score, 0);
});

Deno.test('solar supply, charging and flexible imports are not misidentified as coverable base-load imports', () => {
  const c = world({ buy: highPrices, load: () => 1000, solar: i => i === 0 ? 600 : 0 });
  const s = referee(c, HOUSEHOLD, TARGETS, plan()).series;
  assertEquals(baseLoadGridSupplyW(s, 0), 400);
  assertEquals(scoreQuarters(s, onlyBase).quarters[0].score, 0);
  const charging = referee(world({ buy: highPrices, load: () => 1000 }), HOUSEHOLD, TARGETS,
    plan({ charge: i => i === 0 ? 500 : 0 })).series;
  assertEquals(baseLoadGridSupplyW(charging, 0), 1000);
  assertEquals(charging.baseLoadBatteryCoverW[0], 0);
  assertEquals(scoreQuarters(charging, onlyBase).quarters[0].score, 0);
  const flexible = referee(world({ buy: highPrices, load: () => 400 }), HOUSEHOLD, TARGETS,
    plan({ pool: i => i === 0 ? 3764 : 0 })).series;
  assertEquals(baseLoadGridSupplyW(flexible, 0), 400);
  assertEquals(scoreQuarters(flexible, onlyBase).quarters[0].score, 0);
  flexible.hotWaterW[0] = 400;
  assertEquals(baseLoadGridSupplyW(flexible, 0), 0);
});

Deno.test('measured base load and solar determine battery coverage, including unpublished expensive quarters', () => {
  const c = world({ buy: highPrices, load: () => 400, published: 1 });
  c.recorded.actual = { base_load_w: new Array(288).fill(2440), solar_w: new Array(288).fill(480) };
  const s = referee(c, HOUSEHOLD, TARGETS, plan()).series;
  assertEquals([s.gridImportW[1], s.baseLoadBatteryCoverW[1], s.published[1]], [1960, 1960, 0]);
  assertEquals(scoreQuarters(s, onlyBase).quarters[1].score, -1);
});

Deno.test('missing referee evidence is pending and cannot produce a stored score', () => {
  const s = referee(world(), HOUSEHOLD, TARGETS, plan()).series;
  delete (s as Partial<BenchSeries>).baseLoadBatteryCoverW;
  const score = scoreQuarters(s, onlyBase);
  assertEquals([score.auditPending, score.complete], [true, false]);
  assertThrows(() => storedScore(s, onlyBase));
});
