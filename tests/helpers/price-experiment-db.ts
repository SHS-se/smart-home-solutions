import { PGlite } from "npm:@electric-sql/pglite@0.3.14";

export async function priceExperimentDb(home: string) {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA private; CREATE SCHEMA cron; CREATE SCHEMA net;
    CREATE TABLE homes(id uuid PRIMARY KEY,name text DEFAULT 'TEST home'); INSERT INTO homes(id) VALUES('${home}');
    CREATE TABLE private.test_market_archive_config(singleton boolean PRIMARY KEY,token uuid NOT NULL,function_url text NOT NULL);
    INSERT INTO private.test_market_archive_config VALUES(true,gen_random_uuid(),'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive');
    CREATE TABLE energy_optimisation_price_slots(home_id uuid,start_ts timestamptz,import_price_sek_per_kwh numeric NOT NULL,export_price_sek_per_kwh numeric NOT NULL DEFAULT 0,source text NOT NULL DEFAULT 'integration',received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(home_id,start_ts));
    CREATE TABLE energy_generation_forecast_runs(id uuid PRIMARY KEY,zone text,origin timestamptz,algorithm text,source_refs jsonb,forecast jsonb,recorded_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE energy_price_forecast_generations(id uuid PRIMARY KEY,home_id uuid,generated_at timestamptz,model_as_of timestamptz,timezone text,algorithm text,market_context jsonb,inputs jsonb,outlook jsonb,recorded_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE energy_market_forecast_observations(id uuid PRIMARY KEY,sequence bigint GENERATED ALWAYS AS IDENTITY,dataset text,result jsonb,recorded_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE cron.jobs(name text PRIMARY KEY,schedule text,command text);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$INSERT INTO cron.jobs VALUES($1,$2,$3) ON CONFLICT(name) DO UPDATE SET schedule=$2,command=$3;SELECT 1;$$;
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$SELECT 1::bigint;$$;`);
  await db.exec(await Deno.readTextFile('supabase/migrations/20261022230000_test_paired_price_experiment.sql'));
  await db.exec(`CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION public.is_staff(uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT $1='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid$$;`);
  await db.exec(await Deno.readTextFile('supabase/migrations/20261022233000_test_price_pair_comparison_ui.sql'));
  return db;
}
