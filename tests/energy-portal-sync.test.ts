import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { HistoryCache, type ChangedValue, type HistoryDelta } from '../src/lib/energy-shift/portal-sync.ts';
import type { ThermalObservationSummary } from '../src/lib/energy-shift/thermal-readiness.ts';

interface ActualSlotRow { start_ts: string; total_load_kwh: number }
interface PortalDelta {
  plan: { plan_id: string } | null;
  actuals: HistoryDelta<ActualSlotRow>;
  devices: ChangedValue<{ name: string }[]>;
  thermal: ChangedValue<ThermalObservationSummary>;
  zone_models: ChangedValue<unknown[]>;
}

Deno.test('portal delta: access control, unchanged content, corrections, removals and home isolation', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE FUNCTION can_access_energy_billing_customer(id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT id = auth.uid() $$;
      CREATE FUNCTION energy_home_matches_customer(home uuid, customer uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT home = customer $$;
      CREATE TABLE energy_optimisation_current (
        customer_id uuid, home_id uuid, plan jsonb, captured_at timestamptz, updated_at timestamptz,
        plan_id uuid, generation_request_id uuid, plan_schema_version int, ha_runtime jsonb,
        ha_runtime_received_at timestamptz, ha_ack_status text, ha_acknowledged_at timestamptz,
        ha_integration_version text, ha_ack_request_id uuid, ha_ack_error jsonb,
        replan_request_id uuid, replan_requested_at timestamptz, replan_completed_request_id uuid, replan_error text);
      CREATE TABLE energy_optimisation_actual_slots (customer_id uuid, home_id uuid, start_ts timestamptz,
        total_load_kwh numeric, solar_production_kwh numeric, grid_import_kwh numeric, grid_export_kwh numeric,
        battery_charge_kwh numeric, battery_discharge_kwh numeric, battery_soc numeric, ev_soc numeric);
      CREATE TABLE energy_optimisation_price_slots (customer_id uuid, home_id uuid, start_ts timestamptz,
        import_price_sek_per_kwh numeric, export_price_sek_per_kwh numeric);
      CREATE TABLE energy_optimisation_devices (id uuid, customer_id uuid, home_id uuid, device_key text, statistic_id text,
        name text, category text, load_type_override text, planning_role_override text, planning_choice_at timestamptz,
        control_type_override text, mapping_status text, mapped_control_type text, mapping_error text,
        mapping_summary jsonb, mapping_reported_at timestamptz, active_power_w numeric, profile_sample_count int,
        last_seen_at timestamptz, retired_at timestamptz);
      CREATE TABLE energy_optimisation_device_slots (customer_id uuid, home_id uuid, start_ts timestamptz, device_id uuid, energy_kwh numeric);
      CREATE TABLE energy_optimisation_zone_models (customer_id uuid, home_id uuid, room_key text, trained boolean, rejection_reason text, sample_count int);
      CREATE TABLE energy_optimisation_thermal_slots (customer_id uuid, home_id uuid, start_ts timestamptz, room_key text);
      CREATE TABLE energy_optimisation_outdoor_slots (home_id uuid, start_ts timestamptz, temperature_c numeric);
    `);
    await db.exec(`
      CREATE INDEX idx_energy_optimisation_device_slots_home_start ON energy_optimisation_device_slots (home_id, start_ts DESC);
      CREATE INDEX idx_energy_optimisation_thermal_home_start ON energy_optimisation_thermal_slots (home_id, start_ts DESC);
    `);
    await db.exec(await Deno.readTextFile('supabase/migrations/20260924170000_speed_up_energy_portal_and_replan_reads.sql'));
    const deviceMigration = await Deno.readTextFile('supabase/migrations/20260811100000_add_empirical_energy_device_models.sql');
    const start = deviceMigration.indexOf('CREATE OR REPLACE FUNCTION public.get_energy_optimisation_device_slots(');
    await db.exec(deviceMigration.slice(start, deviceMigration.indexOf('$$;', start) + 3));
    await db.exec(await Deno.readTextFile('supabase/migrations/20260912090000_add_incremental_energy_portal_sync.sql'));
    const id = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    const sync = async (known = {}, home = id) => (await db.query<{ delta: PortalDelta }>(
      'SELECT get_energy_portal_delta($1, $2, $3::jsonb) AS delta', [id, home, JSON.stringify(known)])).rows[0].delta;
    await assertRejects(() => sync(), Error, 'access denied');
    await db.exec(`SET test.uid = '${id}';`);
    await assertRejects(() => sync({}, other), Error, 'access denied');
    await db.exec(`
      INSERT INTO energy_optimisation_current (customer_id, home_id, plan_id, plan)
        VALUES ('${id}', '${id}', '${id}', '{"plan_id":"${id}"}');
      INSERT INTO energy_optimisation_actual_slots (customer_id, home_id, start_ts, total_load_kwh)
        VALUES ('${id}', '${id}', date_bin(interval '15 minutes', now(), '2000-01-01') - interval '15 minutes', 1),
        ('${other}', '${other}', date_bin(interval '15 minutes', now(), '2000-01-01') - interval '15 minutes', 99);
      INSERT INTO energy_optimisation_devices (id, customer_id, home_id, name) VALUES ('${id}', '${id}', '${id}', 'Heater');
      INSERT INTO energy_optimisation_thermal_slots VALUES ('${id}', '${id}', now() - interval '1 day', 'room');
      INSERT INTO energy_optimisation_outdoor_slots SELECT home_id, start_ts, 12 FROM energy_optimisation_thermal_slots;
    `);
    const initial = await sync();
    assertEquals(initial.actuals.upserts.length, 1);
    assertEquals(initial.thermal.value.slotCount, 1);
    assertEquals(initial.thermal.value.outdoorSlotCount, 1);
    assertEquals(initial.thermal.value.observedRoomKeys, ['room']);
    assertEquals(initial.plan.plan_id, id);
    const cache = new HistoryCache<ActualSlotRow>();
    cache.apply(initial.actuals);
    const known = { plan_id: id, actuals: cache.hashes(), devices: initial.devices.hash,
      thermal: initial.thermal.hash, zone_models: initial.zone_models.hash };
    const unchanged = await sync(known);
    assertEquals(unchanged.plan, null);
    assertEquals(unchanged.devices.value, null);
    assertEquals(unchanged.thermal.value, null);
    assertEquals(unchanged.actuals, { upserts: [], removed: [] });
    await db.exec(`UPDATE energy_optimisation_actual_slots SET total_load_kwh = 2 WHERE home_id = '${id}';
      UPDATE energy_optimisation_devices SET name = 'Renamed heater' WHERE home_id = '${id}';`);
    const corrected = await sync(known);
    assertEquals(cache.apply(corrected.actuals)[0].total_load_kwh, 2);
    assertEquals(corrected.devices.value[0].name, 'Renamed heater');
    assertEquals(corrected.thermal.value, null);
    await db.exec(`DELETE FROM energy_optimisation_actual_slots WHERE home_id = '${id}';`);
    const deleted = await sync({ ...known, actuals: cache.hashes() });
    assertEquals(cache.apply(deleted.actuals), []);
    assertEquals(JSON.stringify(unchanged).length < JSON.stringify(initial).length, true);
  } finally { await db.close(); }
});
