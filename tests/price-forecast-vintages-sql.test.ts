import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assert, assertEquals, assertRejects } from "@std/assert";

const home = "11111111-1111-4111-8111-111111111111";
const first = "21111111-1111-4111-8111-111111111111";
const second = "31111111-1111-4111-8111-111111111111";
const failed = "41111111-1111-4111-8111-111111111111";
interface Context {
  known_at: string;
  datasets: Record<string, { latest_attempt_id: string | null; latest_data_id: string | null }>;
}
async function setup() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA private; CREATE SCHEMA cron; CREATE SCHEMA net;
    CREATE TABLE homes(id uuid PRIMARY KEY); INSERT INTO homes VALUES('${home}');
    CREATE TABLE cron.schedules(name text PRIMARY KEY,schedule text,command text);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$
      INSERT INTO cron.schedules VALUES($1,$2,$3) ON CONFLICT(name) DO UPDATE SET schedule=$2,command=$3; SELECT 1; $$;
    CREATE TABLE net.requests(url text,headers jsonb,body jsonb,timeout_milliseconds int);
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) RETURNS bigint LANGUAGE sql AS $$
      INSERT INTO net.requests VALUES($1,$2,$3,$4); SELECT 1::bigint; $$;`);
  await db.exec(await Deno.readTextFile("supabase/migrations/20261022180000_test_market_forecast_vintages.sql"));
  return db;
}
async function context(db: PGlite): Promise<Context | null> {
  return (await db.query<{ value: Context | null }>("SELECT read_test_price_forecast_context() value")).rows[0].value;
}
async function observation(db: PGlite, id: string, status: string, sourceCreatedAt = "2026-10-22T10:00:00Z", dataset = "wind_day_ahead") {
  await db.query(`INSERT INTO energy_market_forecast_observations
    (id,dataset,zone,requested_from,requested_to,requested_at,resolved_at,result)
    VALUES($1,$3,'SE3','2026-10-22T00:00:00Z','2026-10-26T00:00:00Z',
      '2026-10-22T11:00:00Z','2026-10-22T11:00:02Z',$2)`, [id, { status, createdAt: sourceCreatedAt }, dataset]);
}
function generation(marketContext: Context) {
  return { id: "51111111-1111-4111-8111-111111111111", home_id: home,
    generated_at: "2026-10-22T11:15:02Z", model_as_of: "2026-10-22T11:00:00Z",
    timezone: "Europe/Stockholm", zone: "SE3", algorithm: "test-model",
    market_context: marketContext, inputs: { wind_days: [{ day: "2026-10-23", mean_speed_m_s: 8 }] },
    outlook: { shadowImportSekPerKwh: [1.5] } };
}
async function record(db: PGlite, value: ReturnType<typeof generation>) {
  await db.query("SELECT record_test_price_forecast_generation($1)", [value]);
}

Deno.test("market archive migration is inert, TEST-bound and private until explicitly enabled", async () => {
  const db = await setup();
  try {
    assertEquals(await context(db), null);
    assertEquals((await db.query("SELECT * FROM cron.schedules")).rows, []);
    await db.exec("SELECT private.request_test_market_archive()");
    assertEquals((await db.query("SELECT * FROM net.requests")).rows, []);
    await db.exec("SELECT private.enable_test_market_archive(); SELECT private.enable_test_market_archive();");
    const config = (await db.query<{ token: string; function_url: string }>("SELECT token::text,function_url FROM private.test_market_archive_config")).rows[0];
    assertEquals(config.function_url, "https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive");
    assertEquals((await db.query("SELECT name,schedule FROM cron.schedules")).rows,
      [{ name: "test-energy-market-forecast-archive", schedule: "7 * * * *" }]);
    await assertRejects(() => db.exec("UPDATE private.test_market_archive_config SET function_url='https://oosxndduqzhvrorgogaw.supabase.co/functions/v1/energy-market-archive'"), Error, "check constraint");
    await db.exec("SELECT private.request_test_market_archive()");
    const requests = (await db.query<{ url: string; headers: Record<string, string> }>("SELECT url,headers FROM net.requests")).rows;
    assertEquals(requests[0].url, config.function_url);
    assertEquals(requests[0].headers["x-energy-market-archive-token"], config.token);
    assertEquals((await db.query<{ value: boolean }>("SELECT verify_test_market_archive_token($1) value", [config.token])).rows[0].value, true);
    assertEquals((await db.query<{ value: boolean }>("SELECT verify_test_market_archive_token('wrong') value")).rows[0].value, false);
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(() => db.exec("SELECT private.enable_test_market_archive()"), Error, "permission denied");
      await assertRejects(() => db.exec("SELECT * FROM private.test_market_archive_config"), Error, "permission denied");
      if (role !== "service_role") {
        await assertRejects(() => db.exec("SELECT read_test_price_forecast_context()"), Error, "permission denied");
        await assertRejects(() => db.exec("SELECT * FROM energy_market_forecast_observations"), Error, "permission denied");
      }
      await db.exec("RESET ROLE");
    }
  } finally { await db.close(); }
});

Deno.test("price generations retain pinned local observations, missing outcomes and immutable evidence", async () => {
  const db = await setup();
  try {
    await db.exec("SELECT private.enable_test_market_archive(); SET ROLE service_role;");
    const empty = (await context(db))!;
    assertEquals(empty.datasets.load_day_ahead, { latest_attempt_id: null, latest_data_id: null });
    await observation(db, first, "data", "2026-10-25T10:00:00Z");
    const pinned = (await context(db))!;
    assertEquals(pinned.datasets.wind_day_ahead, { latest_attempt_id: first, latest_data_id: first });
    // A later collection with an older provider creation time is locally newer.
    // It arrives after the producer pins evidence, before its async archive write.
    await observation(db, "71111111-1111-4111-8111-111111111111", "data", "2026-10-25T10:00:00Z");
    assertEquals((await db.query("SELECT id FROM energy_market_forecast_observations")).rows.length, 2);
    await observation(db, second, "data", "2026-10-21T10:00:00Z");
    await observation(db, "91111111-1111-4111-8111-111111111111", "transport_error");
    await observation(db, "a1111111-1111-4111-8111-111111111111", "parse_error");
    await observation(db, failed, "provider_error");
    await observation(db, "81111111-1111-4111-8111-111111111111", "no_data", "2026-10-22T10:00:00Z", "load_week_ahead");
    const latest = (await context(db))!;
    assertEquals(latest.datasets.load_week_ahead, {
      latest_attempt_id: "81111111-1111-4111-8111-111111111111", latest_data_id: null,
    });
    assertEquals(latest.datasets.wind_day_ahead, { latest_attempt_id: failed, latest_data_id: second });
    const value = generation(pinned);
    await record(db, value);
    await record(db, value);
    const rows = (await db.query<{ market_context: Context; generated_at: Date; model_as_of: Date; recorded_at: Date }>("SELECT * FROM energy_price_forecast_generations")).rows;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].market_context.datasets.wind_day_ahead.latest_data_id, first);
    assertEquals(rows[0].market_context.datasets.load_day_ahead.latest_data_id, null);
    assert(rows[0].generated_at.getTime() !== rows[0].model_as_of.getTime());
    assert(rows[0].recorded_at.getTime() !== rows[0].generated_at.getTime());
    await assertRejects(() => record(db, { ...value, outlook: { shadowImportSekPerKwh: [0.1] } }), Error, "different evidence");
    const wrongDataset = structuredClone(value);
    wrongDataset.id = "61111111-1111-4111-8111-111111111111";
    wrongDataset.market_context.datasets.load_day_ahead.latest_attempt_id = first;
    await assertRejects(() => record(db, wrongDataset), Error, "does not match dataset or outcome");
    const failedData = structuredClone(wrongDataset);
    failedData.market_context = structuredClone(latest);
    failedData.market_context.datasets.wind_day_ahead.latest_data_id = failed;
    await assertRejects(() => record(db, failedData), Error, "does not match dataset or outcome");
    for (const table of ["energy_market_forecast_observations", "energy_price_forecast_generations"]) {
      await assertRejects(() => db.exec(`UPDATE ${table} SET recorded_at=now()`), Error, "permission denied");
      await assertRejects(() => db.exec(`DELETE FROM ${table}`), Error, "permission denied");
    }
  } finally { await db.close(); }
});
