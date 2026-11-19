import { PGlite } from "@electric-sql/pglite";
import { assert, assertEquals } from "@std/assert";

const home = "10000000-0000-4000-8000-000000000001", otherHome = "10000000-0000-4000-8000-000000000002";
const customer = "20000000-0000-4000-8000-000000000001", otherCustomer = "20000000-0000-4000-8000-000000000002";
const alpha = "30000000-0000-4000-8000-000000000001", beta = "30000000-0000-4000-8000-000000000002";
const heater = "40000000-0000-4000-8000-000000000001", monitoring = "40000000-0000-4000-8000-000000000002";
const passive = "40000000-0000-4000-8000-000000000003", spare = "40000000-0000-4000-8000-000000000004";

Deno.test("staged room fits hold only live, owner-qualified evidence during age pruning", async () => {
  const db = new PGlite();
  try {
    // All homes, measurements, and windows in this fixture are synthetic.
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA private; CREATE SCHEMA cron;
      CREATE TABLE cron.commands(name text PRIMARY KEY,schedule text,command text);
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
        INSERT INTO cron.commands VALUES($1,$2,$3)
        ON CONFLICT(name) DO UPDATE SET schedule=EXCLUDED.schedule,command=EXCLUDED.command RETURNING 1::bigint
      $$;
      CREATE TABLE homes(id uuid PRIMARY KEY,customer_id uuid);
      INSERT INTO homes VALUES('${home}','${customer}'),('${otherHome}','${otherCustomer}');
      CREATE FUNCTION energy_home_matches_customer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT FROM homes WHERE id=$1 AND customer_id=$2)
      $$;
      CREATE TABLE private.energy_learning_jobs(
        id uuid PRIMARY KEY,owner_kind text,owner_key text,home_id uuid,customer_id uuid,
        pending boolean DEFAULT true,generation bigint DEFAULT 1,fence bigint DEFAULT 1,attempts int DEFAULT 0,
        lease_until timestamptz,wake_after timestamptz,last_error text,finished_at timestamptz,input jsonb
      );
      INSERT INTO private.energy_learning_jobs(id,owner_kind,owner_key,home_id,customer_id,lease_until)
        VALUES('${alpha}','room','alpha','${home}','${customer}',now()+interval '1 minute'),
          ('${beta}','room','beta','${home}','${customer}',now()+interval '1 minute');
      CREATE TABLE energy_optimisation_zone_models(
        home_id uuid,room_key text,model_revision bigint,model jsonb,PRIMARY KEY(home_id,room_key)
      );
      INSERT INTO energy_optimisation_zone_models VALUES('${home}','alpha',1,'{}'),('${home}','beta',1,'{}');
      CREATE FUNCTION private.wake_energy_learning_job(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION publish_energy_device_learning(uuid,bigint,bigint,bigint,jsonb) RETURNS boolean LANGUAGE sql AS $$
        UPDATE private.energy_learning_jobs SET pending=false,lease_until=NULL WHERE id=$1 RETURNING true
      $$;
      CREATE TABLE energy_heating_observations(
        home_id uuid,customer_id uuid,room_key text,source_revision text,source_key text,device_statistics jsonb,
        start_ts timestamptz,duration_s int,source text,room_temperature_c double precision,
        outdoor_temperature_c double precision,house_temperature_c double precision,solar_w_per_m2 double precision,
        device_energy_kwh jsonb,heater_energy_limits_w jsonb,cooling boolean,
        PRIMARY KEY(home_id,room_key,source_revision,start_ts,duration_s)
      );
      CREATE FUNCTION private.energy_heating_observation_sources(uuid)
        RETURNS TABLE(room_key text,source_key text,device_statistics jsonb) LANGUAGE sql AS $$
        SELECT 'alpha'::text,'receiver'::text,'{}'::jsonb
      $$;
      CREATE FUNCTION private.energy_heating_source_matches(uuid,text,text,jsonb,text,jsonb,timestamptz,int)
        RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION private.retract_weather_heating_meter(uuid,uuid,jsonb) RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE TABLE private.energy_weather_heating_withdrawals(home_id uuid,start_ts timestamptz);
      INSERT INTO private.energy_weather_heating_withdrawals VALUES('${home}','2020-02-01');
      CREATE TABLE energy_heating_probe_observations(
        home_id uuid,customer_id uuid,start_ts timestamptz,duration_s int,probes jsonb,PRIMARY KEY(home_id,start_ts,duration_s)
      );
      CREATE FUNCTION private.merge_heating_probe_facts(jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT $2 $$;
      CREATE TABLE energy_optimisation_devices(
        id uuid PRIMARY KEY,home_id uuid,customer_id uuid,mapping_summary jsonb,
        retired_at timestamptz,device_key text,planning_role_override text
      );
      INSERT INTO energy_optimisation_devices VALUES
        ('${heater}','${home}','${customer}','{"room_key":"alpha"}',NULL,'heater','controllable'),
        ('${monitoring}','${home}','${customer}','{"room_key":"alpha"}',NULL,'other-clock','base_load'),
        ('${passive}','${home}','${customer}','{"room_key":"spare"}',NULL,'passive','base_load'),
        ('${spare}','${home}','${customer}','{"room_key":"spare"}',NULL,'unrelated','base_load');
      CREATE TABLE private.energy_room_passive_heat_sources(home_id uuid,customer_id uuid,room_key text,device_id uuid);
      INSERT INTO private.energy_room_passive_heat_sources VALUES('${home}','${customer}','alpha','${passive}');
      CREATE TABLE energy_optimisation_device_slots(id int PRIMARY KEY,home_id uuid,customer_id uuid,device_id uuid,start_ts timestamptz);
      CREATE TABLE energy_optimisation_actual_slots(id int PRIMARY KEY,home_id uuid,start_ts timestamptz);
      CREATE TABLE energy_optimisation_pool_slots(LIKE energy_optimisation_actual_slots INCLUDING ALL);
      CREATE TABLE energy_optimisation_plan_runs(id int PRIMARY KEY,home_id uuid,issued_at timestamptz);
      CREATE TABLE energy_optimisation_forecast_runs(LIKE energy_optimisation_plan_runs INCLUDING ALL);
      INSERT INTO energy_optimisation_actual_slots VALUES(1,'${home}','2020-02-01');
      INSERT INTO energy_optimisation_forecast_runs VALUES(1,'${home}','2020-02-01');
      CREATE TABLE energy_room_profiles(home_id uuid PRIMARY KEY,rooms jsonb);
      INSERT INTO energy_room_profiles VALUES('${home}','{"alpha":{"source_key":"receiver"},"peer":{"source_key":"neighbor"}}');
      CREATE TABLE energy_room_probe_slots(home_id uuid,room_key text,source_key text,start_ts timestamptz,
        PRIMARY KEY(home_id,room_key,source_key,start_ts));
    `);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261118220500_room_fit_progress.sql"));
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119042000_hold_room_fit_inputs_during_retention.sql"));
    await db.exec(`
      INSERT INTO energy_heating_observations(home_id,customer_id,room_key,source_revision,start_ts,duration_s) VALUES
        ('${home}','${customer}','alpha','a','2020-02-01 00:00Z',3600),
        ('${home}','${customer}','alpha','b','2020-02-01 00:00Z',900),
        ('${home}','${customer}','alpha','prefix','2020-01-31 23:45Z',900),
        ('${home}','${customer}','beta','a','2020-02-01 00:45Z',900),
        ('${home}','${customer}','alpha','a','2020-02-01 01:00Z',900),
        ('${home}','${customer}','spare','a','2020-02-01 00:00Z',900),
        ('${otherHome}','${otherCustomer}','alpha','a','2020-02-01 00:00Z',900);
      INSERT INTO energy_heating_probe_observations VALUES
        ('${home}','${customer}','2020-01-31 23:45Z',900,'[]'),
        ('${home}','${customer}','2020-02-01 00:15Z',900,'[]'),
        ('${home}','${customer}','2020-02-01 00:45Z',900,'[]'),
        ('${home}','${customer}','2020-02-01 01:15Z',900,'[]'),
        ('${home}','${customer}','2020-01-20 00:00Z',900,'[]'),
        ('${otherHome}','${otherCustomer}','2020-02-01 00:00Z',900,'[]');
      INSERT INTO energy_optimisation_device_slots VALUES
        (1,'${home}','${customer}','${heater}','2020-02-01 00:00Z'),
        (2,'${home}','${customer}','${monitoring}','2020-02-01 00:00Z'),
        (3,'${home}','${customer}','${passive}','2020-02-01 00:00Z'),
        (4,'${home}','${customer}','${spare}','2020-02-01 00:00Z'),
        (5,'${home}','${customer}','${heater}','2020-02-01 01:00Z'),
        (6,'${home}','${customer}','${heater}','2020-01-31 23:45Z'),
        (7,'${home}','${customer}','${passive}','2020-01-31 23:45Z');
      INSERT INTO energy_room_probe_slots VALUES
        ('${home}','alpha','receiver','2020-02-01 00:00Z'),
        ('${home}','alpha','former','2020-01-15 00:00Z'),
        ('${home}','alpha','former','2020-01-14 00:00Z'),
        ('${home}','peer','neighbor','2020-02-01 00:00Z'),
        ('${home}','peer','neighbor','2020-01-31 23:45Z'),
        ('${home}','peer','another','2020-02-01 00:00Z'),
        ('${home}','peer','neighbor','2020-02-01 01:00Z');
    `);
    const snapshot = (roomKey: string, from_at: string, to_at: string, reference: unknown = null, pinnedFloor = from_at) => JSON.stringify({
      version: 1,
      capture: { version: 1, homeId: home, customerId: customer, roomKey, pinnedFloor, window: { from_at, to_at }, reference },
    });
    const aMetadata = snapshot("alpha", "2020-02-01T00:00Z", "2020-02-01T01:00Z", {
      passive_heat: { device_key: "passive" },
      doorway_exchange: { source: "receiver", peers: [{ key: "peer", source: "neighbor" }] },
    }, "2020-01-31T23:00Z");
    const bMetadata = snapshot("beta", "2020-02-01T00:30Z", "2020-02-01T01:30Z");
    const checkpointSql = "SELECT checkpoint_energy_room_fit($1,1,1,1,-1,$2::jsonb,'AA==',NULL) AS saved";
    await db.transaction(async tx => {
      assertEquals((await tx.query(checkpointSql, [alpha, aMetadata])).rows, [{ saved: true }]);
      assertEquals((await tx.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'")).rows,
        [{ n: 1 }], "the real fenced first checkpoint serializes with age pruning until it commits");
    });
    assertEquals((await db.query(checkpointSql, [beta, bMetadata])).rows, [{ saved: true }]);
    // Checkpoint releases its lease, but both fixed held intervals still apply.
    assertEquals((await db.query("SELECT lease_until FROM private.energy_learning_jobs")).rows,
      [{ lease_until: null }, { lease_until: null }]);
    const prune = async (id: string, tenant: string) => {
      await db.query("SELECT record_energy_heating_observations($1,$2,'[]'::jsonb)", [id, tenant]);
      await db.query("SELECT record_energy_heating_probe_observations($1,$2,'[]'::jsonb)", [id, tenant]);
      await db.query("SELECT prune_energy_optimisation_data($1)", [id]);
      await db.exec("SELECT private.prune_expired_room_probe_history()");
    };
    await prune(home, customer);
    await prune(otherHome, otherCustomer);
    const native = async () => (await db.query(
      "SELECT room_key,source_revision FROM energy_heating_observations ORDER BY room_key,source_revision")).rows;
    const probeTimes = async () => (await db.query(
      "SELECT to_char(start_ts,'HH24:MI') AS at FROM energy_heating_probe_observations ORDER BY start_ts")).rows;
    assertEquals(await native(), [{ room_key: "alpha", source_revision: "a" },
      { room_key: "alpha", source_revision: "b" }, { room_key: "alpha", source_revision: "prefix" },
      { room_key: "beta", source_revision: "a" }]);
    assertEquals(await probeTimes(), [{ at: "23:45" }, { at: "00:15" }, { at: "00:45" }, { at: "01:15" }]);
    assertEquals((await db.query("SELECT id FROM energy_optimisation_device_slots ORDER BY id")).rows,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }], "the discovery prefix holds mapped meters and excludes unused passive energy");
    assertEquals((await db.query("SELECT room_key,source_key FROM energy_room_probe_slots ORDER BY room_key,source_key")).rows,
      [{ room_key: "alpha", source_key: "former" }, { room_key: "alpha", source_key: "receiver" }, { room_key: "peer", source_key: "neighbor" }]);
    assertEquals((await db.query("SELECT * FROM private.energy_weather_heating_withdrawals")).rows, []);
    assertEquals((await db.query("SELECT * FROM energy_optimisation_actual_slots")).rows, []);
    assertEquals((await db.query("SELECT * FROM energy_optimisation_forecast_runs")).rows, []);

    // The retention hold cannot turn a correction into an ignored write.
    await db.exec("UPDATE energy_heating_observations SET room_temperature_c=22 WHERE room_key='alpha'");
    assertEquals((await db.query("SELECT DISTINCT room_temperature_c FROM energy_heating_observations WHERE room_key='alpha'")).rows,
      [{ room_temperature_c: 22 }]);
    await db.query("UPDATE private.energy_learning_jobs SET lease_until=now()+interval '1 minute' WHERE id=$1", [alpha]);
    assertEquals((await db.query("SELECT reset_energy_room_fit($1,1,1,1,0) AS reset", [alpha])).rows, [{ reset: true }]);
    await prune(home, customer);
    assertEquals(await native(), [{ room_key: "beta", source_revision: "a" }]);
    assertEquals(await probeTimes(), [{ at: "00:45" }, { at: "01:15" }]);
    assertEquals((await db.query("SELECT * FROM energy_room_probe_slots")).rows, []);
    assertEquals((await db.query("SELECT * FROM energy_optimisation_device_slots")).rows, []);

    await db.query("UPDATE private.energy_room_fit_progress SET cells=to_jsonb(array_fill('{}'::jsonb,ARRAY[18])) WHERE job_id=$1", [beta]);
    await db.query("UPDATE private.energy_learning_jobs SET lease_until=now()+interval '1 minute' WHERE id=$1", [beta]);
    assertEquals((await db.query("SELECT complete_energy_room_fit($1,1,1,1,18,'{}') AS completed", [beta])).rows, [{ completed: true }]);
    await prune(home, customer);
    assertEquals(await native(), []);
    assertEquals(await probeTimes(), []);

    const insertExpiredAlpha = async () => await db.query(
      "INSERT INTO energy_heating_observations(home_id,customer_id,room_key,source_revision,start_ts,duration_s) VALUES($1,$2,'alpha','a','2020-02-01',900)", [home, customer]);
    const renewAlpha = async () => await db.query(
      "UPDATE private.energy_learning_jobs SET lease_until=now()+interval '1 minute' WHERE id=$1", [alpha]);
    await insertExpiredAlpha();
    await renewAlpha();
    const wrongTenant = aMetadata.replace(customer, otherCustomer);
    assertEquals((await db.query(checkpointSql, [alpha, wrongTenant])).rows, [{ saved: true }]);
    await prune(home, customer);
    assertEquals(await native(), [], "a different customer in scratch metadata cannot hold the owner's observations");
    await renewAlpha();
    assertEquals((await db.query("SELECT reset_energy_room_fit($1,1,1,1,0) AS reset", [alpha])).rows, [{ reset: true }]);

    await insertExpiredAlpha();
    await renewAlpha();
    assertEquals((await db.query(checkpointSql, [alpha, aMetadata])).rows, [{ saved: true }]);
    await db.query("UPDATE private.energy_learning_jobs SET generation=2 WHERE id=$1", [alpha]);
    await prune(home, customer);
    assertEquals(await native(), [], "normal generation invalidation releases the expired evidence");
    assert((await db.query<{ ok: boolean }>(
      "SELECT bool_and(model='{}'::jsonb AND model_revision=1) AS ok FROM energy_optimisation_zone_models")).rows[0].ok);
  } finally {
    await db.close();
  }
});
