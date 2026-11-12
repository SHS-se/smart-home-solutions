// Independently generated synthetic owners; no captured household inputs.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ROOM_EXCHANGE_FAMILY } from "../supabase/functions/_shared/device-learning/room/mean-observations.ts";
import { WEATHER_HEATING_METHOD } from "../supabase/functions/_shared/planner/weather-heating.ts";
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
    CREATE TABLE energy_optimisation_devices(id uuid PRIMARY KEY,home_id uuid,customer_id uuid,
      device_key text,planning_role_override text,retired_at timestamptz,UNIQUE(id,home_id,customer_id));
    CREATE TABLE energy_optimisation_device_slots(device_id uuid,home_id uuid,customer_id uuid,
      start_ts timestamptz,energy_kwh numeric);
    ALTER TABLE energy_optimisation_device_slots ADD COLUMN quality jsonb;
    CREATE TABLE energy_optimisation_outdoor_slots(home_id uuid,customer_id uuid,start_ts timestamptz,temperature_c numeric);
    CREATE TABLE energy_optimisation_zone_models(
      home_id uuid,customer_id uuid,room_key text,room_name text,trained boolean,last_attempted_at timestamptz,
      last_fit_attempt jsonb,gain_c_per_wh numeric,sample_count integer DEFAULT 0,
      PRIMARY KEY(home_id,room_key),CHECK(NOT trained OR gain_c_per_wh IS NOT NULL));
    CREATE TABLE energy_optimisation_pool_model(home_id uuid PRIMARY KEY,customer_id uuid,last_attempted_at timestamptz,
      heat_pump_epoch_start timestamptz,last_fit_attempt jsonb,rated_cop numeric,loss_kw_per_k numeric,
      rejection text,hardware jsonb,sample_count integer DEFAULT 0,operating_points jsonb);
    CREATE TABLE energy_optimisation_device_operating_points(home_id uuid,customer_id uuid,device_key text,fitted_at timestamptz,
      operating_points jsonb,last_attempted_at timestamptz,last_fit_attempt jsonb,model_revision bigint NOT NULL DEFAULT 1,
      PRIMARY KEY(home_id,device_key));
  `);
  await db.exec(await Deno.readTextFile("supabase/migrations/20261026001000_device_learning_lifecycle.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261026003000_preserve_pool_learning_due_cadence.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261104150000_learn_joint_room_heat_exchange.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261108120200_learn_variable_power_devices.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261109110000_learn_monitored_room_heat.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261112150000_learn_weather_heating_draw.sql"));
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
    last_fit_attempt: { learning: { method, family: ROOM_EXCHANGE_FAMILY }, issues: [] } };
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
      last_fit_attempt: { learning: { method, family: ROOM_EXCHANGE_FAMILY }, issues: ["insufficient_samples"] } }));
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
    // Measured operating points are the fit's own output and publish with it.
    await db.exec("UPDATE energy_optimisation_pool_model SET last_attempted_at=NULL");
    await request(db, "pool", "pool"); const refit = await claim(db, "pool");
    const points = { method: "pool_operating_points_v1", points: [{ settings: { "synthetic-heat-pump": 12 }, cop: 4 }] };
    const revision = (await db.query<{ model_revision: number }>("SELECT model_revision FROM energy_optimisation_pool_model")).rows[0].model_revision;
    assert(await publish(db, refit, revision, { home_id: home, customer_id: home, operating_points: points,
      last_attempted_at: new Date().toISOString(), last_fit_attempt: { issues: [] } }));
    assertEquals((await db.query<{ operating_points: object; hardware: object }>("SELECT operating_points,hardware FROM energy_optimisation_pool_model")).rows[0],
      { operating_points: points, hardware: { compressor_w: 3600 } });
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

Deno.test("joint exchange triggers one room refit and preserves cadence after a failed attempt", async () => {
  const db = await database();
  try {
    const row = fitted();
    await db.query(`INSERT INTO energy_optimisation_zone_models(home_id,customer_id,room_key,trained,gain_c_per_wh,last_attempted_at,last_fit_attempt)
      VALUES($1,$1,'synthetic-room',true,.002,now(),$2::jsonb)`, [home, { learning: { method }, issues: [] }]);
    assertEquals(await request(db), 1, "old exchange family is due despite a recent fit");
    assertEquals(await request(db), 0, "identical telemetry cannot continually restart learning");
    const job = await claim(db);
    assert(await publish(db, job, 1, { ...row, trained: false, gain_c_per_wh: null,
      last_fit_attempt: { learning: { method, family: ROOM_EXCHANGE_FAMILY }, issues: ["singular"] } }));
    assertEquals(await request(db), 0, "an unidentified joint split waits for the normal daily retry");
    const stored = (await db.query<{ trained: boolean; gain_c_per_wh: string }>("SELECT trained,gain_c_per_wh FROM energy_optimisation_zone_models")).rows[0];
    assertEquals(stored.trained, true);
    assertEquals(Number(stored.gain_c_per_wh), .002);
    await db.exec("UPDATE energy_optimisation_zone_models SET last_attempted_at=now()-interval '25 hours'");
    assertEquals(await request(db), 1);
  } finally { await db.close(); }
});

Deno.test("a variable-power device learns on its own cadence and publishes only its own operating points", async () => {
  const db = await database();
  try {
    const owner = (key: string) => JSON.stringify([{ kind: "device", key, input: {} }]);
    const ask = async (key: string) => (await db.query<{ n: number }>("SELECT request_energy_device_learning($1,$1,$2::jsonb) n", [home, owner(key)])).rows[0].n;
    assertEquals(await ask("synthetic-charger"), 1);
    assertEquals(await ask("synthetic-charger"), 0);
    await assertRejects(() => db.query("SELECT request_energy_device_learning($1,$1,$2::jsonb)", [home,
      JSON.stringify([{ kind: "device", key: "", input: {} }])]), Error, "Invalid learning owner");
    const j = await claim(db, "synthetic-charger");
    const points = { method: "operating_points_v1", points: [{ settings: { "synthetic-charger": 16 }, electric_w: { "synthetic-charger": 11040 } }] };
    const row = { home_id: home, customer_id: home, device_key: "synthetic-charger", operating_points: points,
      last_attempted_at: new Date().toISOString(), last_fit_attempt: { learning: { method: "device_operating_points_v1" }, issues: [] } };
    await assertRejects(() => publish(db, j, 0, { ...row, device_key: "another-device" }), Error, "owner boundary");
    await assertRejects(() => publish(db, j, 0, { ...row, hardware: {} }), Error, "owner boundary");
    assert(await publish(db, j, 0, row));
    const bundle = (await db.query<{ m: { devices: { device_key: string; operating_points: object; model_revision: number }[] } }>(
      "SELECT capture_energy_device_models($1) m", [home])).rows[0].m;
    assertEquals(bundle.devices.map(d => [d.device_key, d.operating_points, d.model_revision]), [["synthetic-charger", points, 1]]);
    // Fitted today: not due again until tomorrow.
    assertEquals(await ask("synthetic-charger"), 0);
  } finally { await db.close(); }
});

Deno.test("weather learning groups only matched heating quarters and fences a replaced binding", async () => {
  const db = await database();
  const meter = "22222222-2222-4222-8222-222222222222";
  const key = "synthetic-heat-pump";
  const ask = async (binding: string) => (await db.query<{ n: number }>(
    "SELECT request_energy_device_learning($1,$1,$2::jsonb) n", [home,
      [{ kind: "device", key, input: { weather_heating_binding: binding } }]])).rows[0].n;
  try {
    await db.query("INSERT INTO energy_optimisation_devices VALUES($1,$2,$2,$3,'controllable',NULL)", [meter, home, key]);
    await db.query(`INSERT INTO energy_optimisation_device_slots VALUES
      ($1,$2,$2,'2026-01-01T00:00:00Z',.25,'{"weather_heating_binding":"a"}'),
      ($1,$2,$2,'2026-01-01T00:15:00Z',.50,'{"weather_heating_binding":"a"}'),
      ($1,$2,$2,'2026-01-01T00:30:00Z',1.00,'{"weather_heating_binding":"b"}'),
      ($1,$2,$2,'2026-01-01T00:45:00Z',1.00,NULL),
      ($1,$2,$2,'2026-01-01T01:00:00Z',1.00,'{"weather_heating_binding":"a"}')`, [meter, home]);
    await db.query(`INSERT INTO energy_optimisation_outdoor_slots VALUES
      ($1,$1,'2026-01-01T00:00:00Z',-4.5),($1,$1,'2026-01-01T00:15:00Z',-4.25),
      ($1,$1,'2026-01-01T00:30:00Z',-4.5),($1,$1,'2026-01-01T00:45:00Z',-4.5),
      ($1,$2,'2026-01-01T01:00:00Z',-4.5)`, [home, meter]);
    const evidence = await db.query<{ days: unknown }>(
      "SELECT get_energy_weather_heating_days($1,$1,$2,'a','2026-01-01','2026-01-02') days", [home, key]);
    assertEquals(evidence.rows[0].days, [{ day: "2026-01-01", hours: .5, outdoor_c: -4.375, watts: 1500 }]);

    assertEquals(await ask("a"), 1);
    const initial = await claim(db, key);
    const row = { home_id: home, customer_id: home, device_key: key,
      operating_points: { method: WEATHER_HEATING_METHOD, binding: "a", points: [] },
      last_attempted_at: new Date().toISOString(), last_fit_attempt: { learning: { method: WEATHER_HEATING_METHOD } } };
    assert(await publish(db, initial, 0, row));
    assertEquals(await ask("a"), 0);
    assertEquals(await ask("b"), 1);
    const replaced = await claim(db, key);
    assertEquals(await ask("a"), 1);
    assertEquals(await publish(db, replaced, 1, row), false);
  } finally { await db.close(); }
});

Deno.test("passive room evidence is isolated by home and requires an active Monitoring meter", async () => {
  const db = await database();
  try {
    const meter = "22222222-2222-4222-8222-222222222222";
    const model = { device_key: "synthetic-appliance", direct_c_per_wh: .001, delayed_c_per_wh: .002, lag_h: .5 };
    await db.query("INSERT INTO energy_optimisation_devices VALUES($1,$2,$2,'synthetic-appliance','base_load',NULL)", [meter, home]);
    await db.query("INSERT INTO private.energy_room_passive_heat_sources VALUES($1,$1,'synthetic-room',$2)", [home, meter]);
    await db.query(`INSERT INTO energy_optimisation_device_slots VALUES
      ($1,$2,$2,'2026-01-01T00:00:00Z',.125),($1,$2,$2,'2026-01-01T00:15:00Z',0)`, [meter, home]);
    const read = (key = "synthetic-room", owner = home) => db.query(
      "SELECT * FROM get_energy_room_passive_heat($1,$2,ARRAY[$3],'2026-01-01T00:00:00Z','2026-01-01T01:00:00Z')", [owner, home, key]);
    assertEquals((await read()).rows, [{ room_key: "synthetic-room", device_key: "synthetic-appliance",
      quarters: [[Date.UTC(2026, 0, 1), 500], [Date.UTC(2026, 0, 1, 0, 15), 0]] }]);
    assertEquals((await read("other-room")).rows, []);
    assertEquals((await read("synthetic-room", meter)).rows, []);
    await request(db);
    assert(await publish(db, await claim(db), 0, { ...fitted(), passive_heat: model }));
    assertEquals((await db.query("SELECT passive_heat FROM energy_optimisation_zone_models")).rows, [{ passive_heat: model }]);
    await db.exec("UPDATE energy_optimisation_devices SET planning_role_override='controllable'");
    assertEquals((await read()).rows, []);
    await db.exec("UPDATE energy_optimisation_devices SET planning_role_override='base_load', retired_at=now()");
    assertEquals((await read()).rows, []);
  } finally { await db.close(); }
});
