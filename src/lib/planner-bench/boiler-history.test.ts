import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { separateBoilerHistory, type MeterStatistics } from './boiler-history.ts';
import { referee } from './referee.ts';
import { loadCase } from './case.ts';
import { BOILER_PHASE_METERS, HOUSEHOLD } from './household.ts';
import { world, quarters, TARGETS, plan } from './world.fixture.ts';

function sample() {
  const c = world({ load: () => 2000 });
  c.other_devices_w = { 'sensor.hot_water_energy': quarters(() => 900) };
  c.recorded.actual = { base_load_w: quarters(() => 2400), solar_w: quarters(() => 0),
    other_devices_w: { 'sensor.hot_water_energy': quarters(() => 1200) } };
  const statistics: MeterStatistics = { entities: [...BOILER_PHASE_METERS, 'sensor.hot_water_energy'].map((key, i) => ({ entity_id: key,
    statistics: Array.from({ length: 72 }, (_, h) => ({ start: Date.parse(c.start) + h * 3600000,
      change: i === 3 ? 1.2 : i < 2 ? .3 : 0 })) })) };
  return { c, statistics };
}
Deno.test('phase history separates the captured forecast and actuals without adding or shifting household energy', () => {
  const { c, statistics } = sample();
  const fixed = separateBoilerHistory(c, c.recorded, statistics);
  assertEquals(fixed.dataset.base_load_forecast_w, c.base_load_forecast_w);
  assertEquals(fixed.recorded.actual!.base_load_w, c.recorded.actual!.base_load_w);
  assertEquals(fixed.dataset.other_devices_w['sensor.water_boiler_energy'], quarters(() => 450));
  assertEquals(fixed.recorded.actual!.other_devices_w!['sensor.water_boiler_energy'], quarters(() => 600));
  assertEquals(fixed.recorded.actual!.other_devices_w!['sensor.heat_pump_hot_water_energy'], quarters(() => 600));
  assertEquals(c.other_devices_w['sensor.water_boiler_energy'], undefined);
  assertAlmostEquals(fixed.recorded.actual!.other_devices_w!['sensor.water_boiler_energy'].reduce((a, b) => a + b, 0) / 4000, 43.2);
});
Deno.test('unavailable phase evidence stays a named data gap and is never replaced by zero', () => {
  const { c, statistics } = sample();
  statistics.entities[0].statistics[0].change = null;
  assertThrows(() => separateBoilerHistory(c, c.recorded, statistics), Error, BOILER_PHASE_METERS[0]);
});
Deno.test('a case can start inside an hour and uses the matching measured hour for each quarter', () => {
  const { c, statistics } = sample();
  c.start = new Date(Date.parse(c.start) + 900000).toISOString();
  for (const entity of statistics.entities) entity.statistics.push({ ...entity.statistics[0], start: entity.statistics[0].start + 72 * 3600000 });
  const fixed = separateBoilerHistory(c, c.recorded, statistics);
  assertEquals(fixed.dataset.other_devices_w['sensor.water_boiler_energy'].length, 288);
});

Deno.test('a repaired case produces modeled boiler consumption and heating assessment', () => {
  const { c, statistics } = sample();
  const fixed = separateBoilerHistory(c, c.recorded, statistics);
  const outcome = referee(loadCase(fixed.dataset, fixed.recorded), HOUSEHOLD, TARGETS, plan());
  assertEquals(outcome.series.hotWater!.demandKnown, true);
  assertEquals(outcome.series.hotWaterW, quarters(() => 600));
  assertEquals(outcome.series.loadW, c.recorded.actual!.base_load_w);
});
