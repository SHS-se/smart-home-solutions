import {assertEquals} from '@std/assert';
import {archiveAccuracyForecast} from '../supabase/functions/_shared/forecast-accuracy-store.ts';
import type {OptimisationPlan} from '../supabase/functions/_shared/planner/planning-contracts.ts';

Deno.test('accuracy archive preserves physical mode provenance and stores exact model means rather than endpoints', async () => {
  // Independently synthetic already-materialized plan, no household inputs.
  const start = '2001-01-01T00:00:00Z';
  const room = (key: string, device: string) => ({key, name: key, device_keys: [device],
    planned_temperature_c: [22], planned_mean_temperature_c: [21], comfort_min_c: [20]});
  const plan = {plan_id: 'synthetic', timezone: 'UTC', capabilities: {battery: true}, battery: {},
    device_models: [{key: 'real', name: 'Real synthetic heater'}, {key: 'verify', name: 'Verification synthetic heater'}],
    operating_scope: {modes: {real: 'controlling', verify: 'control_verification', $battery: 'control_verification'}, device_owners: {real: 'real', verify: 'verify'}},
    thermal_projection: {starts: [start], zones: [room('controlled', 'real'), room('counterfactual', 'verify')]},
    plans: {priority: {slots: [{start, duration_hours: .25, device_loads_w: {real: 1000, verify: 1000}}]}}} as unknown as OptimisationPlan;
  let saved: Record<string, unknown>;
  const db = {from: (table: string) => ({insert: (value: Record<string, unknown>) => {
    assertEquals(table, 'energy_forecast_records'); saved = value; return Promise.resolve({error: null});
  }})} as unknown as Parameters<typeof archiveAccuracyForecast>[0];
  await archiveAccuracyForecast(db, 'home', 'customer', plan);
  const forecast = saved!.forecast as {slots: {room_mean_temperature_c: unknown; device_loads_w: unknown}[]; rooms: unknown; devices: unknown; battery_mode: string};
  assertEquals(forecast.slots[0].room_mean_temperature_c, {controlled: 21});
  assertEquals(forecast.slots[0].device_loads_w, {real: 1000, verify: 1000}, 'baseline partition retains the full component ledger');
  assertEquals(forecast.battery_mode, 'control_verification');
  assertEquals(forecast.rooms, [{key: 'controlled', name: 'controlled', comparison: 'executed_interval_mean'},
    {key: 'counterfactual', name: 'counterfactual', comparison: 'counterfactual'}]);
});
