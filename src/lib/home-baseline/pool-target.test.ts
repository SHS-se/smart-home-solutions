import { assertEquals, assertStrictEquals, assertThrows } from '@std/assert';
import { baselineFixture } from './fixture.ts';
import { prepareHomeBaseline } from './model.ts';
import { defaultSettings, DEFAULT_SETTINGS } from './controller.ts';
import { poolTarget, withPoolTarget } from './pool-target.ts';

const anchorOf = (snapshot: ReturnType<typeof baselineFixture>['snapshot']) => ({ snapshot, earliestStart: '2025-10-31T23:00:00.000Z', latestEnd: '2025-11-30T23:00:00.000Z' });

Deno.test('the estimate holds one pool temperature: the thermostat stops where the scheduler aims', () => {
  const fixture = baselineFixture();
  const pinned = withPoolTarget(anchorOf(fixture.snapshot), 27);
  assertEquals(poolTarget(pinned.snapshot), 27);
  assertEquals(fixture.snapshot.comfort!.pool!.target_c, 30.5, 'the home\'s own comfort target is left alone');
  fixture.snapshot = pinned.snapshot;
  const input = prepareHomeBaseline(fixture);
  assertEquals([input.problem.pool_stop_c, input.problem.targets.pool_c, input.settings.comfort!.pool!.target_c], [27, 27, 27]);
  assertEquals(defaultSettings(27), { ...DEFAULT_SETTINGS, poolStartC: 26.5, poolStopC: 27 });
});
Deno.test('without a request the pinned model keeps the comfort target, and the stock thermostat equals the fixture target', () => {
  const anchor = anchorOf(baselineFixture().snapshot);
  assertStrictEquals(withPoolTarget(anchor, null), anchor);
  assertEquals(defaultSettings(30.5), DEFAULT_SETTINGS);
  assertEquals(defaultSettings(null), DEFAULT_SETTINGS);
});
Deno.test('a pool temperature outside the comfort range is refused, and a home without a pool has none', () => {
  const fixture = baselineFixture();
  for (const bad of [9.9, 40.1, NaN]) assertThrows(() => withPoolTarget(anchorOf(fixture.snapshot), bad), Error, 'between 10 and 40');
  fixture.snapshot.capabilities.pool = false;
  const anchor = anchorOf(fixture.snapshot);
  assertStrictEquals(withPoolTarget(anchor, 27), anchor);
  assertEquals(poolTarget(fixture.snapshot), null);
});
