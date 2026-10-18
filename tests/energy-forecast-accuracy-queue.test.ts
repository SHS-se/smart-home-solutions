import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assert, assertEquals } from "jsr:@std/assert@1";

const PLANNED = "11111111-1111-4111-8111-111111111111";
const UNPLANNED = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "33333333-3333-4333-8333-333333333333";

async function database() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA private; CREATE SCHEMA net;
    CREATE TABLE net.posts(url text, body jsonb);
    CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) RETURNS bigint
      LANGUAGE sql AS $$ INSERT INTO net.posts VALUES(url, body); SELECT 1::bigint $$;
    CREATE TABLE public.energy_optimisation_current(home_id uuid PRIMARY KEY, customer_id uuid, plan_id uuid, plan jsonb);
    INSERT INTO public.energy_optimisation_current VALUES
      ('${PLANNED}','${CUSTOMER}',gen_random_uuid(),'{"timezone":"Europe/Stockholm"}'),
      ('${UNPLANNED}','${CUSTOMER}',NULL,NULL);
    CREATE TABLE public.energy_forecast_records(home_id uuid, plan_id uuid, published_at timestamptz DEFAULT clock_timestamp(), horizon_end timestamptz);
    CREATE TABLE public.energy_forecast_accuracy_reports(home_id uuid, scheduled_at timestamptz);
    CREATE TABLE public.energy_optimisation_actual_slots(id serial, home_id uuid, start_ts timestamptz, total_load_kwh numeric, UNIQUE(home_id,start_ts));
    CREATE TABLE public.energy_optimisation_device_slots(home_id uuid, start_ts timestamptz, energy_kwh numeric);
    CREATE TABLE public.energy_optimisation_price_slots(home_id uuid, start_ts timestamptz, import_price_sek_per_kwh numeric);
    CREATE TABLE private.energy_accuracy_credentials(singleton boolean PRIMARY KEY DEFAULT true, token text, function_url text);
    INSERT INTO private.energy_accuracy_credentials VALUES(true,'token','https://example.supabase.co/functions/v1/energy-forecast-accuracy');
    CREATE TABLE private.energy_accuracy_jobs(home_id uuid, customer_id uuid, scheduled_at timestamptz, timezone text NOT NULL,
      fence bigint NOT NULL DEFAULT 0, lease_until timestamptz, finished_at timestamptz, last_error text, PRIMARY KEY(home_id,scheduled_at));
    CREATE FUNCTION private.energy_accuracy_due(p_now timestamptz,p_timezone text) RETURNS timestamptz LANGUAGE sql AS $$ SELECT p_now $$;
    CREATE FUNCTION private.sweep_energy_accuracy() RETURNS void LANGUAGE sql AS $$ SELECT $$;
  `);
  await db.exec(await Deno.readTextFile("supabase/migrations/20261018204000_event_driven_forecast_accuracy.sql"));
  return db;
}

const jobs = async (db: PGlite) => (await db.query<{ home_id: string; scheduled_at: Date; timezone: string }>(
  "SELECT home_id, scheduled_at, timezone FROM private.energy_accuracy_jobs ORDER BY scheduled_at",
)).rows;

Deno.test("accuracy inputs queue one job per home at the end of their five-minute bucket", async () => {
  const db = await database();
  try {
    // The migration queues every planned home once; homes without a plan wait for one.
    const seeded = await jobs(db);
    assertEquals(seeded.map(job => [job.home_id, job.timezone]), [[PLANNED, "Europe/Stockholm"]]);
    const due = seeded[0].scheduled_at.getTime();
    assertEquals(due % 300_000, 0);
    assert(due > Date.now() && due <= Date.now() + 300_000);

    for (const home of [PLANNED, UNPLANNED]) {
      await db.exec(`
        INSERT INTO public.energy_optimisation_actual_slots(home_id,start_ts,total_load_kwh)
          SELECT '${home}', '2026-10-18'::timestamptz + i * interval '15 minutes', 1 FROM generate_series(0,95) i;
        INSERT INTO public.energy_optimisation_actual_slots(home_id,start_ts,total_load_kwh)
          VALUES('${home}','2026-10-18',2) ON CONFLICT(home_id,start_ts) DO UPDATE SET total_load_kwh=EXCLUDED.total_load_kwh;
        UPDATE public.energy_optimisation_actual_slots SET total_load_kwh=3 WHERE home_id='${home}';
        INSERT INTO public.energy_optimisation_device_slots VALUES('${home}','2026-10-18',0.5);
        INSERT INTO public.energy_optimisation_price_slots VALUES('${home}','2026-10-19',1.2);
        INSERT INTO public.energy_forecast_records(home_id,plan_id,horizon_end) VALUES('${home}',gen_random_uuid(),'2026-10-25');
      `);
    }
    const queued = await jobs(db);
    assert(queued.every(job => job.home_id === PLANNED), "a home without a plan is never queued");
    // One job per bucket; a second only if the test itself crossed into the next bucket.
    const buckets = new Set(queued.map(job => job.scheduled_at.getTime()));
    assertEquals(queued.length, buckets.size);
    assert(queued.length === 1 || Math.floor(Date.now() / 300_000) * 300_000 + 300_000 > due,
      "a busy bucket still queues one job");
  } finally {
    await db.close();
  }
});

Deno.test("a failed accuracy queue never fails the write that caused it", async () => {
  const db = await database();
  try {
    await db.exec("ALTER TABLE private.energy_accuracy_jobs RENAME TO energy_accuracy_jobs_away");
    await db.exec(`INSERT INTO public.energy_optimisation_price_slots VALUES('${PLANNED}','2026-10-19',1.2)`);
    assertEquals((await db.query("SELECT 1 FROM public.energy_optimisation_price_slots")).rows.length, 1);
  } finally {
    await db.close();
  }
});

Deno.test("the sweep posts only jobs whose bucket has closed and keeps two days of reports", async () => {
  const db = await database();
  try {
    await db.exec(`
      DELETE FROM private.energy_accuracy_jobs;
      INSERT INTO private.energy_accuracy_jobs(home_id,customer_id,scheduled_at,timezone) VALUES
        ('${PLANNED}','${CUSTOMER}',date_bin('5 minutes',clock_timestamp(),timestamptz '2000-01-01'),'Europe/Stockholm'),
        ('${PLANNED}','${CUSTOMER}',date_bin('5 minutes',clock_timestamp(),timestamptz '2000-01-01')+interval '5 minutes','Europe/Stockholm');
      INSERT INTO public.energy_forecast_accuracy_reports VALUES
        ('${PLANNED}',clock_timestamp()-interval '3 days'),('${PLANNED}',clock_timestamp()-interval '1 day');
    `);
    await db.exec("SELECT private.sweep_energy_accuracy()");
    const posts = (await db.query<{ body: { scheduled_at: string } }>("SELECT body FROM net.posts")).rows;
    assertEquals(posts.length, 1);
    assert(Date.parse(posts[0].body.scheduled_at) <= Date.now());
    assertEquals((await db.query("SELECT 1 FROM public.energy_forecast_accuracy_reports")).rows.length, 1);
    assertEquals((await db.query("SELECT 1 FROM pg_proc WHERE proname='energy_accuracy_due'")).rows.length, 0);
  } finally {
    await db.close();
  }
});
