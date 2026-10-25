// Independently generated synthetic activity; no household captures.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals } from "jsr:@std/assert@1";

const home = "11111111-1111-4111-8111-111111111111";
Deno.test("planning activity preserves separate morning and afternoon hourly receipts", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA private; CREATE SCHEMA cron; CREATE SCHEMA test_clock;
      CREATE TABLE homes(id uuid PRIMARY KEY); CREATE TABLE customers(id uuid PRIMARY KEY);
      INSERT INTO homes VALUES('${home}'); INSERT INTO customers VALUES('${home}');
      CREATE FUNCTION energy_home_matches_customer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT $1=$2$$;
      CREATE FUNCTION can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
      CREATE TABLE energy_replan_events(id uuid,home_id uuid,customer_id uuid,request_id uuid,job_id uuid,
        plan_id uuid,details jsonb,event text,source text,reason jsonb,occurred_at timestamptz,sequence bigint);
      CREATE TABLE energy_optimisation_plan_runs(id uuid,summary jsonb);
      CREATE TABLE energy_optimisation_current(home_id uuid,customer_id uuid,ha_runtime jsonb);
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$SELECT 1$$;
      CREATE FUNCTION test_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS
        $$SELECT current_setting('test.activity_at')::timestamptz$$;
    `);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261024210000_curated_planning_log.sql"));
    await db.exec(await Deno.readTextFile("supabase/migrations/20261026004000_use_24_hour_planning_log_buckets.sql"));
    // Substitute only the clock in this isolated database; execute the real
    // admission, key construction, deduplication and count merge SQL unchanged.
    await db.exec(`ALTER FUNCTION public.record_energy_planning_activity(uuid,uuid,jsonb)
      SET search_path=public,private,test_clock,pg_catalog`);
    for (const [at, receipt, actuals] of [
      ["2026-01-02T01:10:00Z", "morning-first", 2],
      ["2026-01-02T01:40:00Z", "morning-second", 3],
      ["2026-01-02T13:10:00Z", "afternoon-first", 7],
      ["2026-01-02T13:10:00Z", "afternoon-first", 7],
    ] as const) {
      await db.query("SELECT set_config('test.activity_at',$1,false)", [at]);
      await db.query("SELECT record_energy_planning_activity($1,$1,$2::jsonb)", [home,
        JSON.stringify({ receipt_id: receipt, source: "home_assistant", counts: { actuals } })]);
    }
    const rows = (await db.query<{ event_key: string; occurrences: number; details: { counts: { actuals: number }; receipt_ids: string[] };
      first_at: string; last_at: string }>(`SELECT event_key,occurrences::integer,details,
        to_char(occurred_at AT TIME ZONE 'UTC','HH24:MI') first_at,
        to_char(last_seen_at AT TIME ZONE 'UTC','HH24:MI') last_at
      FROM energy_planning_log ORDER BY sequence DESC`)).rows;
    assertEquals(rows, [
      { event_key: "exchange:2026-01-02-13", occurrences: 1,
        details: { counts: { actuals: 7 }, receipt_ids: ["afternoon-first"] }, first_at: "13:10", last_at: "13:10" },
      { event_key: "exchange:2026-01-02-01", occurrences: 2,
        details: { counts: { actuals: 5 }, receipt_ids: ["morning-first", "morning-second"] }, first_at: "01:10", last_at: "01:40" },
    ]);
    // At a synthetic review time three days later, the afternoon receipt is
    // still inside the 72-hour feed even though morning receipts have expired.
    const recent = (await db.query<{ event_key: string }>(`SELECT event_key FROM energy_planning_log
      WHERE occurred_at >= '2026-01-05T12:00:00Z'::timestamptz - interval '72 hours'`)).rows;
    assertEquals(recent, [{ event_key: "exchange:2026-01-02-13" }]);
  } finally { await db.close(); }
});
