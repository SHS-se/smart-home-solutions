import { createWebsiteDemoActuals, createWebsiteDemoPlan } from './demo.ts';

const NOW = Date.parse('2026-08-10T16:27:30Z');

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
};

Deno.test('website example is a complete browser-only quarter-hour scenario', () => {
  const plan = createWebsiteDemoPlan(NOW);

  assertEquals(plan.mode, 'demo');
  assertEquals(plan.plan_id, 'website-demo');
  assertEquals(plan.plans.baseline.slots.length, 72 * 4);
  assertEquals(plan.plans.priority.slots.length, 72 * 4);
  assertEquals(plan.plans.cost.slots.length, 72 * 4);
  assert(
    Object.values(plan.sources).every(source => source?.quality === 'synthetic'),
    'every example source should be synthetic',
  );
  assert(
    plan.services.some(service => service.control.type === 'discrete_current'),
    'the example should demonstrate variable-current EV charging',
  );
});

Deno.test('website example actuals stay bounded to 96 complete quarters', () => {
  const actuals = createWebsiteDemoActuals(NOW);

  assertEquals(actuals.length, 96);
  assertEquals(new Set(actuals.map(slot => slot.start_ts)).size, 96);
  assert(
    actuals.every(slot => Date.parse(slot.start_ts) % (15 * 60_000) === 0),
    'every actual should start on a quarter-hour boundary',
  );
});

Deno.test('website example module has no storage client dependency', async () => {
  const source = await Deno.readTextFile(new URL('./demo.ts', import.meta.url));

  assertEquals(source.includes('@/integrations/supabase/client'), false);
  assertEquals(source.includes(".from('energy_"), false);
  assertEquals(source.includes('customer_id'), false);
  assertEquals(source.includes('home_id'), false);
});
