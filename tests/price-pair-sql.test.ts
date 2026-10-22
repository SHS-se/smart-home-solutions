import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals, assertRejects } from "@std/assert";

const HOME = "11111111-1111-4111-8111-111111111111";
const MIX = "21111111-1111-4111-8111-111111111111";
const OTHER_MIX = "31111111-1111-4111-8111-111111111111";
const START = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 5 * 86_400_000;
const migration = "supabase/migrations/20261022230000_test_paired_price_experiment.sql";
async function setup() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA private; CREATE SCHEMA cron; CREATE SCHEMA net;
    CREATE TABLE homes(id uuid PRIMARY KEY); INSERT INTO homes VALUES('${HOME}');
    CREATE TABLE private.test_market_archive_config(singleton boolean PRIMARY KEY,token uuid NOT NULL,function_url text NOT NULL);
    INSERT INTO private.test_market_archive_config VALUES(true,gen_random_uuid(),'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive');
    CREATE TABLE energy_optimisation_price_slots(home_id uuid,start_ts timestamptz,import_price_sek_per_kwh numeric NOT NULL,export_price_sek_per_kwh numeric NOT NULL DEFAULT 0,source text NOT NULL DEFAULT 'integration',received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(home_id,start_ts));
    CREATE TABLE energy_generation_forecast_runs(id uuid PRIMARY KEY,zone text,origin timestamptz,algorithm text,source_refs jsonb,forecast jsonb,recorded_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE cron.jobs(name text PRIMARY KEY,schedule text,command text);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$INSERT INTO cron.jobs VALUES($1,$2,$3) ON CONFLICT(name) DO UPDATE SET schedule=$2,command=$3;SELECT 1;$$;
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$SELECT 1::bigint;$$;`);
  await db.exec(await Deno.readTextFile(migration));
  return db;
}
async function enable(db: PGlite) { await db.query("SELECT private.enable_test_price_experiment($1)", [HOME]); }
async function price(db: PGlite, start: number, value: number) {
  await db.query("INSERT INTO energy_optimisation_price_slots(home_id,start_ts,import_price_sek_per_kwh,received_at) VALUES($1,$2,$3,'2000-01-01T00:00Z') ON CONFLICT(home_id,start_ts) DO UPDATE SET import_price_sek_per_kwh=excluded.import_price_sek_per_kwh,received_at=excluded.received_at", [HOME, new Date(start).toISOString(), value]);
}
async function mix(db: PGlite, id = MIX, start = START) {
  await db.query("INSERT INTO energy_generation_forecast_runs(id,zone,origin,algorithm,source_refs,forecast) VALUES($1,'SE3',now(),'se3-generation-analog-v2',$2,$3)", [id,
    { generation_actual: "41111111-1111-4111-8111-111111111111" },
    { algorithm: "se3-generation-analog-v2", zone: "SE3", origin: new Date().toISOString(), hours: Array.from({ length: 72 }, (_, i) => ({ start: new Date(start + i * 3_600_000).toISOString(), byPsr: {} })) }]);
}
interface Reservation { id: string; status: string; context: { prices: unknown[]; priceCutoff: number } }
async function begin(db: PGlite) { return (await db.query<{ value: Reservation | null }>("SELECT begin_test_price_pair() value")).rows[0].value; }
function output(start = START) {
  return { status: "paired", fit: {}, targets: Array.from({ length: 288 }, (_, i) => ({ start: new Date(start + i * 900_000).toISOString(), reduced: 2 as number | null, full: 1.5 as number | null, reason: null as string | null })) };
}
async function complete(db: PGlite, id: string, forecast: ReturnType<typeof output>) {
  return (await db.query<{ value: { eligible_count: number; status: string } }>("SELECT complete_test_price_pair($1,$2) value", [id, forecast])).rows[0].value;
}

Deno.test("paired-price migration is dormant and RPC-only until the explicit TEST home is enabled", async () => {
  const db = await setup();
  try {
    assertEquals(await begin(db), null);
    await price(db, START, 1.25);
    assertEquals((await db.query("SELECT * FROM energy_test_price_observations")).rows.length, 0);
    assertEquals((await db.query("SELECT * FROM cron.jobs")).rows.length, 0);
    await enable(db); await enable(db);
    const rows = (await db.query<{ event: string; original: boolean }>("SELECT event,recorded_at>source_received_at original FROM energy_test_price_observations")).rows;
    assertEquals(rows, [{ event: "initial_seed", original: true }]);
    assertEquals((await db.query("SELECT schedule FROM cron.jobs")).rows, [{ schedule: "27 * * * *" }]);
    const privileges = (await db.query("SELECT has_table_privilege('service_role','energy_test_price_pairs','INSERT') writable,has_table_privilege('authenticated','energy_test_price_pair_outcomes','SELECT') readable,has_function_privilege('authenticated','begin_test_price_pair()','EXECUTE') executable")).rows;
    assertEquals(privileges, [{ writable: false, readable: false, executable: false }]);
    await assertRejects(() => db.query("INSERT INTO energy_optimisation_price_slots(home_id,start_ts,import_price_sek_per_kwh) VALUES($1,$2,'NaN')", [HOME, new Date(START + 900_000).toISOString()]), Error, "check constraint");
  } finally { await db.close(); }
});

Deno.test("paired-price context stays frozen and completed targets automatically score latest immutable truth", async () => {
  const db = await setup();
  try {
    await enable(db); await price(db, START, 1.25); await mix(db);
    const reserved = (await begin(db))!;
    await price(db, START + 900_000, 1.4); await mix(db, OTHER_MIX);
    assertEquals(await begin(db), reserved); // A newer mix does not orphan pending work.
    const forecast = output();
    assertEquals((await complete(db, reserved.id, forecast)).eligible_count, 286);
    assertEquals((await complete(db, reserved.id, forecast)).eligible_count, 286);
    const conflict = output(); conflict.targets[0].reduced = 99;
    await assertRejects(() => complete(db, reserved.id, conflict), Error, "Conflicting completed");
    await price(db, START + 1_800_000, 1.25); await price(db, START + 1_800_000, 1.25);
    assertEquals((await db.query("SELECT count(*)::int count FROM energy_test_price_observations WHERE start_ts=$1", [new Date(START + 1_800_000).toISOString()])).rows, [{ count: 1 }]);
    assertEquals((await db.query("SELECT reduced_error::float8 reduced,full_error::float8 full FROM energy_test_price_pair_outcomes")).rows, [{ reduced: 0.75, full: 0.25 }]);
    await price(db, START + 1_800_000, 1.5);
    assertEquals((await db.query("SELECT reduced_error::float8 reduced,full_error::float8 full FROM energy_test_price_pair_outcomes")).rows, [{ reduced: 0.5, full: 0 }]);
    assertEquals((await db.query("SELECT reduced_mae::float8 reduced,full_mae::float8 full FROM energy_test_price_pair_scores")).rows, [{ reduced: 0.5, full: 0 }]);
    await assertRejects(() => db.exec("UPDATE energy_test_price_observations SET import_price_sek_per_kwh=9"), Error, "immutable");
    await assertRejects(() => db.exec('UPDATE energy_test_price_targets SET "full"=9'), Error, "immutable");
    await assertRejects(() => db.exec("UPDATE energy_test_price_pairs SET status='unavailable' WHERE status='paired'"), Error, "immutable");
    assertEquals((await begin(db))!.context.prices.length, 3);
    const report = (await db.query<{ value: { pair_count: number; scores: unknown[] } }>("SELECT read_test_price_pair_report() value")).rows[0].value;
    assertEquals(report.pair_count, 2); assertEquals(report.scores.length, 1);
  } finally { await db.close(); }
});

Deno.test("paired-price missing arms and elapsed targets stay ineligible and malformed retries cannot complete", async () => {
  const db = await setup();
  try {
    await enable(db); const past = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000; await mix(db, MIX, past);
    const reserved = (await begin(db))!;
    const duplicate = output(past); duplicate.targets[1].start = duplicate.targets[0].start;
    await assertRejects(() => complete(db, reserved.id, duplicate), Error, "duplicates");
    const partial = output(past); partial.targets[287].full = null; partial.targets[287].reason = "missing_generation_forecast";
    const result = await complete(db, reserved.id, partial);
    assertEquals(result.eligible_count <= 283, true);
    assertEquals((await db.query("SELECT eligible,eligibility_reason FROM energy_test_price_targets WHERE start_ts=$1", [partial.targets[287].start])).rows, [{ eligible: false, eligibility_reason: "unavailable" }]);
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await assertRejects(() => begin(db), Error, "READ COMMITTED");
    await db.exec("ROLLBACK");
  } finally { await db.close(); }
});
