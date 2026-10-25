// Independently generated synthetic owners; no captured household inputs.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
const home = "11111111-1111-4111-8111-111111111111";
const method = "interval_mean_transition_holdout_v1";
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA private; CREATE SCHEMA net; CREATE SCHEMA cron; CREATE SCHEMA extensions;
    CREATE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(repeat('ab',$1),'hex') $$;
    CREATE TABLE homes(id uuid PRIMARY KEY); CREATE TABLE customers(id uuid PRIMARY KEY);
    INSERT INTO homes VALUES('${home}'); INSERT INTO customers VALUES('${home}');
    CREATE FUNCTION energy_home_matches_customer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT $1=$2$$;
    CREATE TABLE net.wakes(url text,headers jsonb,body jsonb,timeout_milliseconds integer);
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$
      INSERT INTO net.wakes VALUES($1,$2,$3,$4); SELECT 1::bigint; $$;
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE TABLE energy_optimisation_zone_models(
      home_id uuid,customer_id uuid,room_key text,room_name text,trained boolean,last_attempted_at timestamptz,
      last_fit_attempt jsonb,gain_c_per_wh numeric,sample_count integer DEFAULT 0,
      PRIMARY KEY(home_id,room_key),CHECK(NOT trained OR gain_c_per_wh IS NOT NULL));
    CREATE TABLE energy_optimisation_pool_model(home_id uuid PRIMARY KEY,customer_id uuid,last_attempted_at timestamptz,
      heat_pump_epoch_start timestamptz,last_fit_attempt jsonb,rated_cop numeric,loss_kw_per_k numeric,
      rejection text,hardware jsonb,sample_count integer DEFAULT 0);
  `);
  await db.exec(await Deno.readTextFile("supabase/migrations/20261026001000_device_learning_lifecycle.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261026003000_preserve_pool_learning_due_cadence.sql"));
  await db.exec("SELECT configure_energy_device_learning('https://example.supabase.co')");
  return db;
}
async function request(db: PGlite, key = "synthetic-room", kind = "room") {
  return (await db.query<{ n: number }>("SELECT request_energy_device_learning($1,$1,$2::jsonb) n", [home,
    JSON.stringify([
      ...(key === "second-room" ? [{ kind: "room", key: "synthetic-room", input: { location: null } }] : []),
      { kind, key, input: { location: null } },
    ])])).rows[0].n;
}
interface Claim { id: string; generation: number; fence: number }
async function claim(db: PGlite, key = "synthetic-room") {
  return (await db.query<{ j: Claim }>("SELECT claim_energy_device_learning(id) j FROM private.energy_learning_jobs WHERE owner_key=$1", [key])).rows[0].j;
}
async function publish(db: PGlite, j: Claim, revision: number, row: object) {
  return (await db.query<{ ok: boolean }>("SELECT publish_energy_device_learning($1,$2,$3,$4,$5::jsonb) ok",
    [j.id, j.generation, j.fence, revision, JSON.stringify(row)])).rows[0].ok;
}
function fitted(key = "synthetic-room") {
  return { home_id: home, customer_id: home, room_key: key, room_name: "Synthetic room", trained: true,
    gain_c_per_wh: .002, sample_count: 300, last_attempted_at: new Date().toISOString(),
    last_fit_attempt: { learning: { method }, issues: [] } };
}
Deno.test("learning coalesces each owner and captures model revisions atomically", async () => {
  const db = await database();
  try {
    assertEquals(await request(db), 1);
    assertEquals(await request(db), 0);
    assertEquals(await request(db, "second-room"), 1);
    const j = await claim(db);
    assertEquals(await claim(db), null);
    assertEquals(await publish(db, j, 0, fitted()), true);
    assertEquals(await request(db, "second-room"), 0);
    const bundle = (await db.query<{ b: { rooms: { model_revision: number; gain_c_per_wh: number }[]; pool: null } }>(
      "SELECT capture_energy_device_models($1) b", [home])).rows[0].b;
    assertEquals(bundle.rooms.length, 1);
    assertEquals(bundle.rooms[0].model_revision, 1);
    assertEquals(bundle.rooms[0].gain_c_per_wh, .002);
    assertEquals(bundle.pool, null);
    assert((await claim(db, "second-room")).id !== j.id);
    const wakes = (await db.query<{ url: string }>("SELECT url FROM net.wakes")).rows;
    assertEquals(wakes.length, 2);
    assert(wakes.every(w => w.url.endsWith("/energy-device-learning")));
  } finally { await db.close(); }
});
Deno.test("learning expires leases, rejects old fences and preserves the last usable room model", async () => {
  const db = await database();
  try {
    await request(db); const old = await claim(db);
    await db.exec("UPDATE private.energy_learning_jobs SET lease_until=now()-interval '1 second',wake_after=now()-interval '1 second'");
    await db.exec("SELECT private.sweep_energy_learning_jobs()");
    const active = await claim(db);
    assertEquals(await publish(db, old, 0, fitted()), false);
    assert(await publish(db, active, 0, fitted()));
    await db.exec("UPDATE energy_optimisation_zone_models SET last_attempted_at=now()-interval '2 days'");
    assertEquals(await request(db), 1);
    const next = await claim(db);
    assertEquals(next.generation, 2);
    assert(await publish(db, next, 2, { ...fitted(), trained: false, gain_c_per_wh: null,
      last_fit_attempt: { learning: { method }, issues: ["insufficient_samples"] } }));
    const row = (await db.query<{ trained: boolean; gain_c_per_wh: string; model_revision: number }>("SELECT * FROM energy_optimisation_zone_models")).rows[0];
    assertEquals(row.trained, true); assertEquals(Number(row.gain_c_per_wh), .002); assertEquals(row.model_revision, 3);
    assertEquals(await request(db), 0);
  } finally { await db.close(); }
});
Deno.test("learning cannot overwrite newer calibration or cross electrical ownership", async () => {
  const db = await database();
  try {
    await db.query("INSERT INTO energy_optimisation_pool_model(home_id,customer_id,hardware,rated_cop) VALUES($1,$1,$2,4)", [home, { compressor_w: 3600 }]);
    await request(db, "pool", "pool"); const j = await claim(db, "pool");
    await assertRejects(() => publish(db, j, 1, { home_id: home, customer_id: home, hardware: { compressor_w: 1200 } }), Error, "owner boundary");
    assert(await publish(db, j, 1, { home_id: home, customer_id: home, rated_cop: 5,
      last_attempted_at: new Date().toISOString(), last_fit_attempt: { issues: [] } }));
    assertEquals((await db.query<{ hardware: object }>("SELECT hardware FROM energy_optimisation_pool_model")).rows[0].hardware, { compressor_w: 3600 });
    await request(db); const room = await claim(db);
    await db.query("INSERT INTO energy_optimisation_zone_models(home_id,customer_id,room_key,trained,gain_c_per_wh) VALUES($1,$1,'synthetic-room',true,.003)", [home]);
    assertEquals(await publish(db, room, 0, fitted()), false);
    const next = await claim(db); assert(next.fence > room.fence);
    await db.query("SELECT fail_energy_device_learning($1,$2,$3,'transport failed')", [next.id, next.generation, next.fence]);
    const state = (await db.query<{ pending: boolean; last_error: string }>("SELECT pending,last_error FROM private.energy_learning_jobs WHERE id=$1", [next.id])).rows[0];
    assertEquals(state, { pending: true, last_error: "transport failed" });
    assertEquals((await db.query<{ last_attempted_at: null }>("SELECT last_attempted_at FROM energy_optimisation_zone_models")).rows[0].last_attempted_at, null);
    const grants = (await db.query<{ allowed: boolean }>("SELECT has_function_privilege('authenticated','public.capture_energy_device_models(uuid)','EXECUTE') allowed")).rows[0];
    assertEquals(grants.allowed, false);
  } finally { await db.close(); }
});
Deno.test("changed owner context supersedes an in-flight fit without telemetry starving learning", async () => {
  const db = await database();
  try {
    await request(db); const old = await claim(db);
    assertEquals(await request(db), 0);
    assertEquals((await db.query<{ n: number }>("SELECT request_energy_device_learning($1,$1,$2::jsonb) n", [home,
      JSON.stringify([{ kind: "room", key: "synthetic-room", input: { location: { latitude: 60, longitude: 18 } } }])])).rows[0].n, 1);
    assertEquals(await publish(db, old, 0, fitted()), false);
    const next = await claim(db);
    assert(next.generation > old.generation); assert(next.fence > old.fence);
    assert(await publish(db, next, 0, fitted()));
  } finally { await db.close(); }
});
Deno.test("removing an owner fences its running fit and stops retrying without deleting calibration", async () => {
  const db = await database();
  try {
    await request(db); const old = await claim(db);
    await db.query("SELECT request_energy_device_learning($1,$1,'[]'::jsonb)", [home]);
    assertEquals(await publish(db, old, 0, fitted()), false);
    assertEquals(await claim(db), null);
    assertEquals(await request(db), 1);
    const resumed = await claim(db);
    assert(resumed.generation > old.generation);
    assert(await publish(db, resumed, 0, fitted()));
    await db.query("SELECT request_energy_device_learning($1,$1,'[]'::jsonb)", [home]);
    assertEquals((await db.query("SELECT * FROM energy_optimisation_zone_models")).rows.length, 1);
  } finally { await db.close(); }
});

Deno.test("pool learning keeps the daily cadence when a fresh model has no hardware epoch", async () => {
  const db = await database();
  try {
    const cases = [
      { name: "fresh model, absent epoch", attempted: "now()-interval '1 hour'", epoch: "NULL", method: "pool_interval_mean_v1", due: 0 },
      { name: "fresh model, older epoch", attempted: "now()-interval '1 hour'", epoch: "now()-interval '2 hours'", method: "pool_interval_mean_v1", due: 0 },
      { name: "hardware changed after fit", attempted: "now()-interval '1 hour'", epoch: "now()", method: "pool_interval_mean_v1", due: 1 },
      { name: "daily fit is due", attempted: "now()-interval '25 hours'", epoch: "NULL", method: "pool_interval_mean_v1", due: 1 },
      { name: "no prior attempt", attempted: "NULL", epoch: "NULL", method: "pool_interval_mean_v1", due: 1 },
      { name: "learning method changed", attempted: "now()-interval '1 hour'", epoch: "NULL", method: "prior_method", due: 1 },
    ];
    for (const scenario of cases) {
      await db.exec("DELETE FROM private.energy_learning_jobs; DELETE FROM net.wakes; DELETE FROM energy_optimisation_pool_model");
      await db.query(`INSERT INTO energy_optimisation_pool_model(home_id,customer_id,last_attempted_at,heat_pump_epoch_start,last_fit_attempt)
        VALUES($1,$1,${scenario.attempted},${scenario.epoch},$2::jsonb)`,
      [home, JSON.stringify({ learning: { method: scenario.method } })]);
      assertEquals(await request(db, "pool", "pool"), scenario.due, scenario.name);
      assertEquals(await request(db, "pool", "pool"), 0, `${scenario.name}: identical input coalesces`);
      assertEquals((await db.query("SELECT * FROM net.wakes")).rows.length, scenario.due, scenario.name);
    }
    await db.exec("DELETE FROM private.energy_learning_jobs; DELETE FROM energy_optimisation_pool_model");
    assertEquals(await request(db, "pool", "pool"), 1, "missing model still schedules a first fit");
  } finally { await db.close(); }
});
