import { assertEquals } from '@std/assert';
import { boilerDemand, HOUSEHOLD, BOILER_PHASE_METERS } from './household.ts';

Deno.test('the boiler uses every disjoint phase meter, including an idle phase', () => {
  const [p1, p2, p3] = BOILER_PHASE_METERS;
  const phases = { meter_keys: BOILER_PHASE_METERS };
  assertEquals(boilerDemand({ [p1]: [100, 1500], [p2]: [200, 1500], [p3]: [0, 0],
    'sensor.hot_water_energy': [1574, 4274] }, phases), [300, 3000]);
  assertEquals(boilerDemand({ [p1]: [100, 1500] }, phases), null);
  assertEquals(boilerDemand({ 'sensor.hot_water_energy': [1274, 1274] }, HOUSEHOLD.hot_water), null);
});
