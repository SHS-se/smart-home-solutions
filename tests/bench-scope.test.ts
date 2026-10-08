import { assertEquals, assertThrows } from '@std/assert';
import { refreshRequest, refreshTargets, requiredLanes } from '../bench/scope.ts';
import { BASE_LANE, LANES } from '../src/lib/planner-bench/lanes.ts';

Deno.test('routine refresh solves only dev and main once per case; history and variants are explicit', () => {
  assertEquals(refreshRequest('workflow_run', 'all', 'diagnostics'), { selection: 'heads', scope: 'base' });
  assertEquals(refreshRequest('workflow_dispatch', 'all', 'diagnostics'), { selection: 'all', scope: 'diagnostics' });
  assertEquals(refreshRequest(undefined), { selection: 'HEAD', scope: 'base' });
  const heads = { test: 'dev', current: 'main' };
  assertEquals(refreshTargets('heads', heads, ['old', 'older']), ['dev', 'main']);
  assertEquals(refreshTargets('selected', heads, ['old']), ['selected']);
  assertEquals(refreshTargets('all', heads, ['older', 'main', 'dev']), ['dev', 'main', 'older']);
  assertEquals(refreshTargets('heads', { test: 'same', current: 'same' }, []), ['same']);
  assertEquals(requiredLanes(), [BASE_LANE]);
  assertEquals(new Set(requiredLanes('diagnostics')), new Set(LANES));
  assertThrows(() => refreshTargets('heads', {}, []));
  assertThrows(() => requiredLanes('unknown'));
});
