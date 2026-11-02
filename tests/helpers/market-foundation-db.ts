import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
const UUID = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
export async function marketFoundationDb() {
  const db = new PGlite();
  await db.exec(
    `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA private; CREATE SCHEMA cron; CREATE SCHEMA net; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION is_staff(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE TABLE homes(id uuid PRIMARY KEY,name text); INSERT INTO homes VALUES('${
      UUID(99)
    }','Synthetic home');
    CREATE TABLE energy_optimisation_price_slots(home_id uuid,start_ts timestamptz,import_price_sek_per_kwh numeric NOT NULL,export_price_sek_per_kwh numeric NOT NULL DEFAULT 0,source text NOT NULL DEFAULT 'synthetic',received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(home_id,start_ts));
    CREATE TABLE cron.job(jobid integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text UNIQUE,schedule text,command text);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$ INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) ON CONFLICT(jobname) DO UPDATE SET schedule=$2,command=$3 RETURNING jobid $$;
    CREATE FUNCTION cron.unschedule(integer) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobid=$1 RETURNING true $$;
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;`,
  );
  for (
    const migration of [
      "20261022180000_test_market_forecast_vintages",
      "20261022190000_test_medium_range_weather",
      "20261022210000_test_generation_mix",
      "20261022211000_test_generation_validation_permissions",
      "20261022220000_test_hydro_nuclear_forecasts",
      "20261022230000_test_paired_price_experiment",
      "20261022233000_test_price_pair_comparison_ui",
      "20261026100000_test_price_residual_correction",
      "20261101110000_test_price_residual_v2",
    ]
  ) {
    await db.exec(
      await Deno.readTextFile(`supabase/migrations/${migration}.sql`),
    );
  }
  return db;
}
