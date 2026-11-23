// Synthetic room ownership, claim and publication schema for database contracts.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";

export const home = "11111111-1111-4111-8111-111111111111";
export const other = "22222222-2222-4222-8222-222222222222";


export async function database() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA private; CREATE SCHEMA net; CREATE SCHEMA cron; CREATE SCHEMA extensions;
    CREATE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(repeat('ab',$1),'hex') $$;
    CREATE TABLE homes(id uuid PRIMARY KEY,customer_id uuid); CREATE TABLE customers(id uuid PRIMARY KEY);
    INSERT INTO homes VALUES('${home}','${home}'),('${other}','${other}');
    INSERT INTO customers VALUES('${home}'),('${other}');
    CREATE FUNCTION energy_home_matches_customer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT FROM homes WHERE id=$1 AND customer_id=$2) $$;
    CREATE FUNCTION can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${home}'::uuid $$;
    CREATE TABLE net.wakes(body jsonb);
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$
      INSERT INTO net.wakes VALUES($3); SELECT 1::bigint; $$;
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE TABLE energy_optimisation_zone_models(home_id uuid,customer_id uuid,room_key text,trained boolean,
      gain_c_per_wh numeric,cooling_constant_per_h numeric DEFAULT .05,background_gain_c_per_h numeric DEFAULT 0,
      sample_count integer NOT NULL DEFAULT 0 CHECK(sample_count>=0),last_attempted_at timestamptz,last_fit_attempt jsonb,heating_bands jsonb,
      PRIMARY KEY(home_id,room_key));
    CREATE TABLE energy_optimisation_pool_model(home_id uuid PRIMARY KEY,customer_id uuid,last_attempted_at timestamptz,
      heat_pump_epoch_start timestamptz,last_fit_attempt jsonb,rated_cop numeric);
    CREATE TABLE energy_optimisation_device_operating_points(home_id uuid,device_key text,model_revision bigint,
      last_attempted_at timestamptz,last_fit_attempt jsonb,operating_points jsonb,PRIMARY KEY(home_id,device_key));
    CREATE TABLE private.synthetic_bindings(home_id uuid,room_key text,binding text);
    INSERT INTO private.synthetic_bindings VALUES('${home}','room','synthetic-binding'),('${other}','room','synthetic-other');
    CREATE FUNCTION private.energy_room_heating_contexts(uuid) RETURNS TABLE(room_key text,binding text) LANGUAGE sql AS $$
      SELECT room_key,binding FROM private.synthetic_bindings WHERE home_id=$1 $$;
  `);
  const originalZoneSchema = await Deno.readTextFile("supabase/migrations/20260812140000_add_thermal_zone_models.sql");
  const rejection = originalZoneSchema.slice(originalZoneSchema.indexOf("rejection_reason text CHECK"),
    originalZoneSchema.indexOf("  gain_c_per_wh numeric")).trim().replace(/,$/, "");
  const completeness = originalZoneSchema.slice(originalZoneSchema.indexOf("CONSTRAINT energy_optimisation_zone_model_complete CHECK"),
    originalZoneSchema.indexOf("\n);"));
  await db.exec(`ALTER TABLE energy_optimisation_zone_models ADD COLUMN ${rejection};
    ALTER TABLE energy_optimisation_zone_models ADD ${completeness};`);
  await db.exec(await Deno.readTextFile("supabase/migrations/20261026001000_device_learning_lifecycle.sql"));
  const publication = await Deno.readTextFile("supabase/migrations/20261118120000_version_heating_bands.sql");
  const start = publication.indexOf("CREATE OR REPLACE FUNCTION public.publish_energy_device_learning(");
  await db.exec(publication.slice(start, publication.indexOf("END; $$;", start) + "END; $$;".length));
  for (const file of ["20261118220500_room_fit_progress", "20261120002000_room_heat_fit_iterations",
    "20261120003000_continue_pending_room_windows", "20261119011000_room_learning_admission",
    "20261119022000_room_window_visits", "20261120004000_bound_room_learning_traversals",
    "20261122110000_bounded_room_run_calibration", "20261122160000_batch_room_fit_cells",
    "20261123100000_shared_room_response", "20261123120000_drop_ten_run_ledger_limit"]) {
    await db.exec(await Deno.readTextFile(`supabase/migrations/${file}.sql`));
  }
  await db.exec("ALTER TABLE private.energy_learning_jobs DROP CONSTRAINT energy_learning_jobs_owner_kind_check; ALTER TABLE private.energy_learning_jobs ADD CHECK(owner_kind IN ('room','pool','device'))");
  await db.exec(`SELECT configure_energy_device_learning('https://example.supabase.co');
    INSERT INTO energy_optimisation_zone_models(home_id,customer_id,room_key,trained,gain_c_per_wh)
      VALUES('${home}','${home}','room',true,.002),('${other}','${other}','room',true,.004);
    INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
      VALUES('${home}','${home}','room','room','{}'),('${other}','${other}','room','room','{}');`);
  return db;
}
export interface Claim { id: string; generation: number; fence: number }
export const claim = async (db: PGlite, owner = home) => (await db.query<{ value: Claim }>(
  "SELECT claim_energy_device_learning(id) AS value FROM private.energy_learning_jobs WHERE home_id=$1 AND owner_kind='room'",
  [owner])).rows[0].value;
/** The worker releases its home admission after every request. */
export const release = async (db: PGlite, j: Claim) => await db.query("SELECT release_energy_room_learning_lane($1,$2,$3)", [j.id, j.generation, j.fence]);
/** After a completion (or a failed one) the next ordinary request queues the room again. */
export async function handBack(db: PGlite, j: Claim) {
  await release(db, j);
  await db.query("UPDATE private.energy_learning_jobs SET pending=true,lease_until=NULL,wake_after=now(),finished_at=NULL WHERE id=$1", [j.id]);
}
export const revision = async (db: PGlite, owner = home) => Number((await db.query<{ r: number }>(
  "SELECT model_revision AS r FROM energy_optimisation_zone_models WHERE home_id=$1", [owner])).rows[0].r);
