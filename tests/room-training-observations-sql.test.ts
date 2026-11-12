import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals, assertRejects } from "@std/assert";

Deno.test("room learning distinguishes complete metered zero, incomplete power and absent power", async () => {
  const db = new PGlite();
  // Independently generated synthetic installation and readings.
  const home = "11111111-1111-4111-8111-111111111111", customer = "22222222-2222-4222-8222-222222222222";
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
      CREATE FUNCTION can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION energy_home_matches_customer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE TABLE energy_optimisation_devices(id integer PRIMARY KEY, home_id uuid, customer_id uuid,
        mapping_summary jsonb, active_power_w numeric, retired_at timestamptz,
        planning_role_override text, control_type_override text, mapping_status text, mapped_control_type text);
      CREATE TABLE energy_optimisation_device_slots(device_id integer, home_id uuid, customer_id uuid,
        start_ts timestamptz, energy_kwh numeric);
      CREATE TABLE energy_optimisation_thermal_slots(home_id uuid,customer_id uuid,room_key text,
        start_ts timestamptz,room_temperature_c numeric,cooling_duty numeric);
      CREATE TABLE energy_optimisation_outdoor_slots(home_id uuid,start_ts timestamptz,temperature_c numeric,solar_w_per_m2 numeric);
      CREATE TABLE energy_optimisation_house_slots(home_id uuid,start_ts timestamptz,temperature_c numeric);
      INSERT INTO energy_optimisation_devices
      SELECT id,'${home}','${customer}','{"room_key":"synthetic_room","room_name":"Synthetic room"}',
        500,null,'controllable','switch_schedule','ready','switch_schedule' FROM generate_series(1,2) id;
      INSERT INTO energy_optimisation_thermal_slots
      SELECT '${home}','${customer}','synthetic_room',slot,20,0
        FROM generate_series('2026-10-01T00:00Z'::timestamptz,'2026-10-01T01:00Z',interval '15 minutes') slot;
      INSERT INTO energy_optimisation_device_slots VALUES
        (1,'${home}','${customer}','2026-10-01T00:00Z',.1),
        (1,'${home}','${customer}','2026-10-01T00:15Z',0),
        (2,'${home}','${customer}','2026-10-01T00:15Z',0),
        (1,'${home}','${customer}','2026-10-01T00:30Z',.1),
        (2,'${home}','${customer}','2026-10-01T00:30Z',.05),
        (1,'${home}','${customer}','2026-10-01T00:45Z',.1),
        (2,'${home}','${customer}','2026-10-01T00:45Z',null);
    `);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261026002000_preserve_unknown_room_heat_observations.sql"));
    const query = "SELECT heat_w FROM get_energy_thermal_training_quarters($1,$2,'2026-10-01','2026-10-02')";
    assertEquals((await db.query<{heat_w: number | null}>(query, [customer, home])).rows.map(r => r.heat_w), [null, 0, 600, null, null]);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261112180000_read_room_planning_history.sql"));
    // 00:30 has complete energy and no temperature. 00:00 and 00:45 have
    // temperature and an incomplete meter set.
    await db.exec(`DELETE FROM energy_optimisation_thermal_slots WHERE start_ts = '2026-10-01T00:30Z';
      GRANT SELECT ON energy_optimisation_devices, energy_optimisation_device_slots, energy_optimisation_thermal_slots TO service_role;
      SET ROLE service_role;`);
    const history = "SELECT * FROM get_energy_room_planning_history($1,$2,$3,'2026-10-01','2026-10-01T01:00Z')";
    const start = Date.parse("2026-10-01T00:00Z");
    assertEquals((await db.query(history, [customer, home, ["synthetic_room"]])).rows, [{
      room_key: "synthetic_room",
      temperature_starts: [start, start + 900_000, start + 2_700_000],
      heater_quarters: [[start + 900_000, 0], [start + 1_800_000, 600]],
    }]);
    assertEquals((await db.query(history, [customer, home, ["other_room"]])).rows, []);
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE anon");
    await assertRejects(() => db.query(query, [customer, home]), Error, "permission denied");
    await assertRejects(() => db.query(history, [customer, home, ["synthetic_room"]]), Error, "permission denied");
    await db.exec("RESET ROLE");
  } finally { await db.close(); }
});
