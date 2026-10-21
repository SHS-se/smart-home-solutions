import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { scaleOldHouseHotWater, separateBoilerHistory, type MeterStatistics } from './boiler-history.ts';
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

Deno.test('old-house hot water scales the boiler and takes the same energy out of base load', () => {
  const { c, statistics } = sample();
  const split = separateBoilerHistory(c, c.recorded, statistics);
  const before = { ...split.dataset, start: '2026-08-27T22:00:00.000Z', timezone: 'Europe/Stockholm' }; // 28 Aug local midnight
  const scaled = scaleOldHouseHotWater(before, split.recorded, 0.75);
  assertEquals(scaled.scaled_quarters, 96); // 28 Aug only; 29 and 30 Aug are the current house.
  const boiler = scaled.recorded.actual!.other_devices_w!['sensor.water_boiler_energy'];
  assertEquals([boiler[0], boiler[95], boiler[96]], [450, 450, 600]);
  const base = scaled.recorded.actual!.base_load_w;
  assertEquals([base[0], base[96]], [2400 - 150, 2400]);
  assertEquals(scaled.dataset.other_devices_w['sensor.water_boiler_energy'][0], 450 * .75);
  assertEquals(scaled.dataset.base_load_forecast_w[0], before.base_load_forecast_w[0] - 450 * .25);
  // Heat-pump preheat and the rest of the house are untouched.
  assertEquals(scaled.recorded.actual!.other_devices_w!['sensor.heat_pump_hot_water_energy'], split.recorded.actual!.other_devices_w!['sensor.heat_pump_hot_water_energy']);
  assertEquals(scaled.recorded.actual!.other_devices_w!['sensor.hot_water_energy'][0], 1200 - 150);
  assertThrows(() => scaleOldHouseHotWater(scaled.dataset, scaled.recorded), Error, 'already scaled');
});
