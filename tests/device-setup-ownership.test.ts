import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from '@std/assert';

const DEVICE = '11111111-1111-4111-8111-111111111111';
Deno.test('app setup keeps the same device and fences replay while website participation remains independent', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '11111111-1111-4111-8111-111111111111'::uuid $$;
      CREATE FUNCTION public.can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1 = auth.uid() $$;
      CREATE TABLE public.energy_optimisation_devices (
        id uuid PRIMARY KEY, customer_id uuid NOT NULL, device_key text UNIQUE,
        load_type_override text NOT NULL, control_type_override text,
        planning_role_override text NOT NULL, planning_choice_at timestamptz,
        mapped_control_type text, retired_at timestamptz,
        CONSTRAINT energy_optimisation_devices_planning_override_consistent
          CHECK (planning_role_override = 'base_load' OR control_type_override IS NOT NULL)
      );
      CREATE FUNCTION public.set_energy_device_planning(uuid,text,text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.set_energy_device_load_type(uuid,text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
      INSERT INTO energy_optimisation_devices VALUES
        ('${DEVICE}', auth.uid(), 'heater', 'duty_cycle', 'switch_schedule', 'controllable', null, 'switch_schedule', now());
    `);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261112203000_move_device_setup_to_app.sql'));
    const values = async () => (await db.query(`
      SELECT id, load_type_override AS load, control_type_override AS method,
             planning_role_override AS role, mapped_control_type AS mapped
      FROM energy_optimisation_devices WHERE device_key = 'heater'`)).rows[0];
    assertEquals(await values(), {id: DEVICE, load: 'duty_cycle', method: 'switch_schedule', role: 'controllable', mapped: 'switch_schedule'});

    const sync = async (revision: number, method: string, load: string) => await db.query(`
      INSERT INTO energy_optimisation_devices (id, customer_id, device_key, planning_role_override,
        load_type_override, app_setup, mapped_control_type)
      VALUES (gen_random_uuid(), auth.uid(), 'heater', 'base_load', 'fixed_full_load',
        jsonb_build_object('revision', $1::int, 'control_type', $2::text, 'load_type', $3::text), $2)
      ON CONFLICT (device_key) DO UPDATE SET app_setup = excluded.app_setup,
        mapped_control_type = excluded.mapped_control_type, retired_at = null
    `, [revision, method, load]);
    await sync(4, 'setpoint', 'inverter');
    await sync(3, 'switch_schedule', 'duty_cycle');
    await sync(4, 'switch_schedule', 'duty_cycle');
    await db.query('UPDATE energy_optimisation_devices SET app_setup = null WHERE id = $1', [DEVICE]);
    assertEquals(await values(), {id: DEVICE, load: 'inverter', method: 'setpoint', role: 'controllable', mapped: 'setpoint'});

    await db.query("SELECT set_energy_device_participation($1, 'base_load')", [DEVICE]);
    assertEquals(await values(), {id: DEVICE, load: 'inverter', method: 'setpoint', role: 'base_load', mapped: 'setpoint'});
    await db.query("SELECT set_energy_device_participation($1, 'controllable')", [DEVICE]);
    assertEquals(await values(), {id: DEVICE, load: 'inverter', method: 'setpoint', role: 'controllable', mapped: 'setpoint'});
    await assertRejects(() => db.query("SELECT set_energy_device_planning($1, 'base_load', 'switch_schedule')", [DEVICE]), Error, 'does not exist');
    await assertRejects(() => db.query("SELECT set_energy_device_load_type($1, 'duty_cycle')", [DEVICE]), Error, 'does not exist');
  } finally {
    await db.close();
  }
});
