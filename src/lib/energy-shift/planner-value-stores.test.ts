import { assert, assertEquals } from 'jsr:@std/assert@1';
import { plannerValueStores, dispatchWorkbench, generateOptimisationPlan } from '../../../supabase/functions/_shared/energy-optimisation.ts';
import { curveFromPreference } from '../../../supabase/functions/_shared/value-preferences.ts';
import { snapshot } from './optimisation-snapshot.fixture.ts';

Deno.test('chart stores exactly match dispatch with the resolved price forecast and fitted equipment', () => {
  const source = snapshot();
  source.pool_model = { loss_kw_per_k: 1.2, rated_cop: 2.4, cop_per_air_c: 0.045 };
  source.value_curves = { pool: curveFromPreference(
    { urgent_below: 24, comfortable: 30, indifferent_above: 32, max_value_sek_per_kwh: 4.25 },
    'celsius', { units_per_kwh: 0.06, reference_sek_per_kwh: 2.3267 },
  ) };
  const plan = generateOptimisationPlan(source, new Date(source.captured_at));
  const outlook = { ...plan.price_outlook, shadow_import_sek_per_kwh: plan.price_outlook.shadow_import_sek_per_kwh.map(() => 0.6) };
  const chart = plannerValueStores(source, outlook);
  const workbench = dispatchWorkbench(source, [], outlook);
  assert(workbench);
  for (const store of chart) {
    const dispatched = workbench.stores.find(s => s.key === store.key)!;
    assertEquals(store.curve, dispatched.curve);
    assertEquals(store.initial_state, dispatched.initial_state);
    assertEquals(store.units_per_kwh(store.initial_state, 0), dispatched.units_per_kwh(dispatched.initial_state, 0));
  }
  const pool = chart.find(store => store.key === 'pool')!;
  const conversion = pool.units_per_kwh(pool.initial_state, 0);
  assert(Math.abs(pool.curve.points[0].sek_per_unit * conversion - 4.25) < 1e-6);
  assert(Math.abs(pool.curve.points[1].sek_per_unit * conversion - 0.6) < 1e-6);
});

Deno.test('vehicle chart preserves the saved curve and charge-limit clipping; explicit maximum uses current efficiency', () => {
  const source = snapshot();
  source.capabilities.ev = true;
  source.ev_battery = {
    name: 'Test EV', connected: true, capacity_kwh: 75, soc: 0.6,
    source_entity_ids: { connected: 'binary_sensor.connected', soc: 'sensor.soc', target_soc: 'number.target_soc', energy_remaining: null, charge_current: 'number.current' },
    departure_target_soc: 0.8, charge_efficiency: 0.94,
    available_from: source.slots[0].start, departure: source.slots[48].start, priority: 3,
  };
  source.services.push({
    id: 'ev:departure', device: 'ev', earliest_start: source.slots[0].start,
    deadline: source.slots[48].start, required_kwh: 8, priority: 3,
    baseline_preferred_start: source.slots[0].start,
    control: { type: 'discrete_current', min_current_a: 5, max_current_a: 16, current_step_a: 1, phase_count: 3, voltage_v: 230 },
  });
  const saved = curveFromPreference(
    { urgent_below: 100, comfortable: 300, indifferent_above: 390 },
    'km', { units_per_kwh: 5, reference_sek_per_kwh: 2.3267 },
  );
  source.value_curves = { ev: saved };
  const plan = generateOptimisationPlan(source, new Date(source.captured_at));
  const car = plannerValueStores(source, plan.price_outlook).find(store => store.key === 'ev')!;
  const actual = dispatchWorkbench(source, [], plan.price_outlook)!.stores.find(store => store.key === 'ev')!;
  assertEquals(car.curve, actual.curve);
  assertEquals(car.curve.points[0], saved.points[0]);
  assertEquals(car.curve.points.at(-1)!.at, car.max_state);
  assert(car.max_state! < 390);
  source.value_curves.ev = { ...saved, max_value_sek_per_kwh: 3.5 };
  const capped = plannerValueStores(source, plan.price_outlook).find(store => store.key === 'ev')!;
  assert(Math.abs(capped.curve.points[0].sek_per_unit * capped.units_per_kwh(capped.initial_state, 0) - 3.5) < 1e-5);
  source.value_curves.ev = { ...saved, urgent_price_multiplier: 2.5 };
  for (const reference of [0.6, 1.2]) {
    const outlook = { ...plan.price_outlook, shadow_import_sek_per_kwh: plan.price_outlook.shadow_import_sek_per_kwh.map(() => reference) };
    const relative = plannerValueStores(source, outlook).find(store => store.key === 'ev')!;
    assert(Math.abs(relative.curve.points[0].sek_per_unit * relative.units_per_kwh(relative.initial_state, 0) - 2.5 * reference) < 1e-5);
  }
});
