// Independently generated synthetic schema for chronological room SQL contracts.
import { database } from "./room-fit-sql.ts";

export async function chronologicalRoomDatabase() {
  const db = await database();
  await db.exec(`CREATE TABLE energy_heating_observations(home_id uuid,room_key text,start_ts timestamptz,
    duration_s integer,source_revision text,customer_id uuid,source_key text,device_statistics jsonb,room_temperature_c numeric,
    outdoor_temperature_c numeric,house_temperature_c numeric,solar_w_per_m2 numeric,device_energy_kwh jsonb,
    heater_energy_limits_w jsonb,cooling boolean,source text,PRIMARY KEY(home_id,room_key,start_ts,duration_s));
    CREATE TABLE energy_heating_probe_observations(home_id uuid,start_ts timestamptz,duration_s integer,customer_id uuid,
      probes jsonb,probe_fingerprint text GENERATED ALWAYS AS (md5(probes::text)) STORED);
    CREATE TABLE energy_optimisation_thermal_slots(home_id uuid,room_key text,start_ts timestamptz,customer_id uuid,
      room_temperature_c numeric,cooling_duty numeric);
    CREATE TABLE energy_optimisation_outdoor_slots(home_id uuid,start_ts timestamptz,customer_id uuid,temperature_c numeric,solar_w_per_m2 numeric);
    CREATE TABLE energy_optimisation_house_slots(home_id uuid,start_ts timestamptz,customer_id uuid,temperature_c numeric);
    CREATE TABLE energy_optimisation_devices(home_id uuid,id uuid PRIMARY KEY,device_key text,statistic_id text,category text,
      active_power_w numeric,first_seen_at timestamptz,mapping_summary jsonb,control_type_override text,mapping_status text,
      mapped_control_type text,retired_at timestamptz,planning_role_override text);
    CREATE TABLE energy_optimisation_device_slots(home_id uuid,device_id uuid,start_ts timestamptz,customer_id uuid,energy_kwh numeric);
    ALTER TABLE energy_optimisation_zone_models ADD COLUMN training_from timestamptz, ADD COLUMN training_to timestamptz;
    CREATE TABLE private.energy_heating_history_sources(home_id uuid,valid_from timestamptz,valid_to timestamptz,basis text);
    ALTER TABLE private.energy_heating_history_sources ADD COLUMN room_key text DEFAULT 'room',
      ADD COLUMN observed_source_key text DEFAULT 'old',ADD COLUMN target_source_key text DEFAULT 'new',
      ADD COLUMN target_device_statistics jsonb DEFAULT '{}',ADD COLUMN observed_device_statistics jsonb DEFAULT '{}';
    CREATE TABLE energy_room_profiles(home_id uuid,rooms jsonb,connections jsonb);
    CREATE TABLE energy_room_probe_slots(home_id uuid,room_key text,source_key text,start_ts timestamptz);
    ALTER TABLE energy_optimisation_devices ADD COLUMN customer_id uuid;
    ALTER TABLE energy_optimisation_device_slots ADD COLUMN id uuid DEFAULT gen_random_uuid();
    CREATE TABLE private.energy_room_passive_heat_sources(home_id uuid,customer_id uuid,room_key text,device_id uuid);`);
  const native = await Deno.readTextFile("supabase/migrations/20261118190000_native_heating_observations.sql");
  await db.exec(native.slice(native.indexOf("CREATE FUNCTION private.energy_heating_observation_sources("),
    native.indexOf("-- Explicit historical source assignments")));
  await db.exec(native.slice(native.indexOf("CREATE TABLE private.energy_heating_source_revisions"),
    native.indexOf("CREATE FUNCTION public.get_energy_heating_history_sources")));
  const bounded = await Deno.readTextFile("supabase/migrations/20261119001500_bound_room_history_reads.sql");
  await db.exec(bounded.slice(bounded.indexOf("CREATE OR REPLACE FUNCTION private.energy_heating_source_fingerprint"),
    bounded.indexOf("INSERT INTO private.energy_heating_source_revisions")));
  const reliability = await Deno.readTextFile("supabase/migrations/20261119143000_exclude_reviewed_unreliable_heating_meters.sql");
  await db.exec(reliability.slice(0, reliability.indexOf("CREATE OR REPLACE FUNCTION private.energy_room_thermal_intervals")));
  const retention = await Deno.readTextFile("supabase/migrations/20261119042000_hold_room_fit_inputs_during_retention.sql");
  await db.exec(retention.slice(0, retention.indexOf("SELECT cron.schedule")));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261120001000_room_operation_facts.sql"));
  // Hosted migrations own application objects without PostgreSQL superuser rights.
  await db.exec(`CREATE ROLE room_migration NOSUPERUSER;
    DO $$ DECLARE obj record; BEGIN
      FOR obj IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','private','net','cron','extensions') AND c.relkind IN ('r','p') LOOP
        EXECUTE format('ALTER TABLE %I.%I OWNER TO room_migration',obj.nspname,obj.relname);
      END LOOP;
      FOR obj IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','private','net','cron','extensions') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO room_migration',obj.signature);
      END LOOP;
      FOR obj IN SELECT nspname FROM pg_namespace WHERE nspname IN ('public','private','net','cron','extensions') LOOP
        EXECUTE format('ALTER SCHEMA %I OWNER TO room_migration',obj.nspname);
      END LOOP;
    END; $$; SET ROLE room_migration`);
  await db.exec(await Deno.readTextFile("supabase/migrations/20261123130000_chronological_room_evidence.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261123140000_exclude_inventory_estimates_from_room_evidence.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261123150000_room_fit_snapshot_publication.sql"));
  await db.exec("UPDATE private.energy_learning_jobs SET wake_after=now()");
  return db;
}
