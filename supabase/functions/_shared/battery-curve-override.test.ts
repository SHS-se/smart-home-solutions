import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { snapshot, CAPTURED_AT } from '../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts';
import { generateOptimisationPlan } from './planner/energy-optimisation.ts';
import { resolveValueCurves } from './planner/value-curves.ts';

Deno.test('custom battery values are uncapped, retain every point, and change dispatch', () => {
  const input = snapshot();
  const capacity = input.battery!.capacity_kwh * (input.battery!.max_soc - input.battery!.min_soc);
  const points = Array.from({length: 15}, (_, i) => ({at: i * capacity / 14, sek_per_unit: 100 - i}));
  const override = resolveValueCurves([{store_key: 'battery', unit: 'kwh', points}]).curves.battery!.curve;
  const custom = generateOptimisationPlan({...input, value_curves: {battery: override}}, new Date(CAPTURED_AT));
  const automatic = generateOptimisationPlan(input, new Date(CAPTURED_AT));
  assertEquals(custom.battery_value_curve!.source, 'customer');
  assertEquals(custom.battery_value_curve!.curve.points, points);
  assert(custom.battery_value_curve!.curve.points[0].sek_per_unit > custom.battery_value_curve!.terminal_replacement_sek_per_kwh);
  assertEquals(custom.battery_value_curve!.automatic_curve, automatic.battery_value_curve!.curve);
  assert(custom.plans.priority.summary.battery_soc_end > automatic.plans.priority.summary.battery_soc_end);
  assertEquals(resolveValueCurves([]).curves.battery, undefined);
});

Deno.test('invalid battery overrides fail explicitly rather than selecting automatic', () => {
  assertThrows(() => resolveValueCurves([{store_key:'battery', unit:'kwh', points:[{at:0, sek_per_unit:-1}]}]), Error, 'Battery curve');
  const input = snapshot();
  assertThrows(() => generateOptimisationPlan({...input, value_curves:{battery:{unit:'celsius', points:[{at:0, sek_per_unit:1}]}}}, new Date(CAPTURED_AT)), Error, 'Battery curve');
});
