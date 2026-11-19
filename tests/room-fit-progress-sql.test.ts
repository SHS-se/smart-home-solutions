// Independently generated synthetic jobs/captures; no household observations.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals, assertRejects } from "@std/assert";
import { HEAT_LAG_GRID_H } from "../supabase/functions/_shared/device-learning/room/fit.ts";
import { parseRoomBandFitCells, ROOM_BAND_FIT_CELL_COUNT } from "../supabase/functions/_shared/device-learning/room/mean-observations.ts";

const home = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const metadata = { implementation: "synthetic-v1", binding: "synthetic-binding", digest: "synthetic-digest" };
const capture = btoa("synthetic-derived-intervals".repeat(12));
interface Claim {
  id: string; generation: number; fence: number;
  room_fit_progress: { metadata: object; cursor: number; cells: unknown[]; base_revision: number } | null;
}
async function database(admission = true) {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA private; CREATE SCHEMA net; CREATE SCHEMA cron; CREATE SCHEMA extensions;
    CREATE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(repeat('ab',$1),'hex') $$;
    CREATE TABLE homes(id uuid PRIMARY KEY,customer_id uuid); CREATE TABLE customers(id uuid PRIMARY KEY);
    INSERT INTO homes VALUES('${home}','${home}'),('${other}','${other}');
    INSERT INTO customers VALUES('${home}'),('${other}');
    CREATE FUNCTION energy_home_matches_customer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT FROM homes WHERE id=$1 AND customer_id=$2) $$;
    CREATE TABLE net.wakes(body jsonb);
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$
      INSERT INTO net.wakes VALUES($3); SELECT 1::bigint; $$;
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE TABLE energy_optimisation_zone_models(home_id uuid,customer_id uuid,room_key text,trained boolean,
      gain_c_per_wh numeric,last_attempted_at timestamptz,last_fit_attempt jsonb,heating_bands jsonb,
      PRIMARY KEY(home_id,room_key));
    CREATE TABLE energy_optimisation_pool_model(home_id uuid PRIMARY KEY,customer_id uuid,last_attempted_at timestamptz,
      heat_pump_epoch_start timestamptz,last_fit_attempt jsonb,rated_cop numeric);
    CREATE TABLE energy_optimisation_device_operating_points(home_id uuid,device_key text,model_revision bigint,
      PRIMARY KEY(home_id,device_key));
    CREATE TABLE private.synthetic_bindings(home_id uuid,room_key text,binding text);
    INSERT INTO private.synthetic_bindings VALUES('${home}','room','synthetic-binding'),('${other}','room','synthetic-other');
    CREATE FUNCTION private.energy_room_heating_contexts(uuid) RETURNS TABLE(room_key text,binding text) LANGUAGE sql AS $$
      SELECT room_key,binding FROM private.synthetic_bindings WHERE home_id=$1 $$;
  `);
  await db.exec(await Deno.readTextFile("supabase/migrations/20261026001000_device_learning_lifecycle.sql"));
  // Exercise the deployed normal publisher, including its source-binding check,
  // without constructing unrelated electrical/planner migration dependencies.
  const publication = await Deno.readTextFile("supabase/migrations/20261118120000_version_heating_bands.sql");
  const start = publication.indexOf("CREATE OR REPLACE FUNCTION public.publish_energy_device_learning(");
  await db.exec(publication.slice(start, publication.indexOf("END; $$;", start) + "END; $$;".length));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261118220500_room_fit_progress.sql"));
  if (admission) await db.exec(await Deno.readTextFile("supabase/migrations/20261119011000_room_learning_admission.sql"));
  // The deployed lifecycle also admits device owners.
  await db.exec("ALTER TABLE private.energy_learning_jobs DROP CONSTRAINT energy_learning_jobs_owner_kind_check; ALTER TABLE private.energy_learning_jobs ADD CHECK(owner_kind IN ('room','pool','device'))");
  await db.exec(`SELECT configure_energy_device_learning('https://example.supabase.co');
    INSERT INTO energy_optimisation_zone_models(home_id,customer_id,room_key,trained,gain_c_per_wh)
      VALUES('${home}','${home}','room',true,.002),('${other}','${other}','room',true,.004);
    INSERT INTO energy_optimisation_pool_model(home_id,customer_id,rated_cop) VALUES('${home}','${home}',4);
    INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
      VALUES('${home}','${home}','room','room','{}'),('${other}','${other}','room','room','{}'),
      ('${home}','${home}','pool','pool','{}');`);
  return db;
}
async function claim(db: PGlite, owner = home, kind = "room", key = kind === "room" ? "room" : kind) {
  return (await db.query<{ value: Claim | null }>(
    "SELECT claim_energy_device_learning(id) AS value FROM private.energy_learning_jobs WHERE home_id=$1 AND owner_kind=$2 AND owner_key=$3",
    [owner, kind, key])).rows[0].value!;
}
async function release(db: PGlite, j: Claim) {
  return (await db.query<{ ok: boolean }>("SELECT release_energy_room_learning_lane($1,$2,$3) AS ok",
    [j.id,j.generation,j.fence])).rows[0].ok;
}
async function checkpoint(db: PGlite, j: Claim, cursor: number, revision = 1) {
  return (await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) AS ok",
    [j.id, j.generation, j.fence, revision, cursor, cursor === -1 ? JSON.stringify(metadata) : null,
      cursor === -1 ? capture : null, cursor === -1 ? null : JSON.stringify({ lag_h: HEAT_LAG_GRID_H[Math.floor(cursor / 2)],
        partition: cursor % 2 ? "full" : "training", fits: { finite: null, equilibrium: null, integrator: null } })])).rows[0].ok;
}
async function load(db: PGlite, j: Claim, revision = 1) {
  return (await db.query<{ value: string | null }>("SELECT load_energy_room_fit_capture($1,$2,$3,$4) AS value",
    [j.id, j.generation, j.fence, revision])).rows[0].value;
}
async function reset(db: PGlite, j: Claim, cursor: number, revision = 1) {
  return (await db.query<{ ok: boolean }>("SELECT reset_energy_room_fit($1,$2,$3,$4,$5) AS ok",
    [j.id, j.generation, j.fence, revision, cursor])).rows[0].ok;
}
async function complete(db: PGlite, j: Claim, cursor = 18, patch: object = {}, revision = 1) {
  return (await db.query<{ ok: boolean }>("SELECT complete_energy_room_fit($1,$2,$3,$4,$5,$6::jsonb) AS ok",
    [j.id, j.generation, j.fence, revision, cursor, JSON.stringify({ home_id: home, customer_id: home, room_key: "room",
      trained: true, gain_c_per_wh: .003, heating_bands: { binding: "synthetic-binding", active: [{ revision: "synthetic-band-v2" }] }, ...patch })])).rows[0].ok;
}
async function scratchCount(db: PGlite) {
  return (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM private.energy_room_fit_progress")).rows[0].count;
}

Deno.test("room fit checkpoints preserve immutable input and ordered prefix until one atomic normal publication", async () => {
  const db = await database();
  try {
    assertEquals(ROOM_BAND_FIT_CELL_COUNT, 18, "SQL prefix bound follows the production cell grid");
    const before = (await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id")).rows;
    let j = await claim(db);
    assertEquals(j.room_fit_progress, null);
    assertEquals(await checkpoint(db, j, -1), true);
    assertEquals(await checkpoint(db, j, -1), false, "lost initial reply cannot replace a stored capture");
    assertEquals(await load(db, j), null, "checkpoint relinquishes the publication lease");
    assertEquals(await claim(db), null, "the invocation retains admission until its finally release");
    assertEquals(await release(db, j), true);
    j = await claim(db);
    assertEquals(j.room_fit_progress, { metadata, cells: [], cursor: 0, base_revision: 1 });
    assertEquals(Object.hasOwn(j.room_fit_progress!, "capture"), false);
    assertEquals(await load(db, j), capture);
    assertEquals(await checkpoint(db, j, 1), false, "skipped prefix is rejected");
    assertEquals(await complete(db, j, 0), false);
    for (let cursor = 0; cursor < 18; cursor++) {
      assertEquals(j.room_fit_progress?.cursor, cursor);
      assertEquals(await checkpoint(db, j, cursor), true);
      assertEquals(await checkpoint(db, j, cursor), false, "duplicate/lost cell reply cannot append twice");
      const priorFence = j;
      assertEquals(await release(db, j), true);
      j = await claim(db);
      assertEquals(await checkpoint(db, priorFence, cursor + 1), false);
      assertEquals(await load(db, j), capture);
    }
    assertEquals(j.room_fit_progress?.cells.length, 18);
    assertEquals(parseRoomBandFitCells(j.room_fit_progress?.cells), j.room_fit_progress?.cells);
    assertEquals((await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id")).rows, before,
      "partial numerical work never changes accepted model data or revisions");
    await assertRejects(() => complete(db, j, 18, { home_id: other }), Error, "Learning publication crosses owner boundary");
    assertEquals(await scratchCount(db), 1, "failed final publication rolls back scratch deletion");
    assertEquals(await complete(db, j), true);
    assertEquals(await release(db, j), true);
    assertEquals(await scratchCount(db), 0);
    assertEquals(await complete(db, j), false, "lost completion reply cannot publish twice");
    const after = (await db.query<Record<string, unknown>>("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id")).rows;
    assertEquals(after[1], before[1]);
    assertEquals(after[0].model_revision, 2);
    assertEquals(Number(after[0].gain_c_per_wh), .003);
    assertEquals((await db.query("SELECT rated_cop::int AS cop,model_revision FROM energy_optimisation_pool_model")).rows,
      [{ cop: 4, model_revision: 1 }]);
    assertEquals((await db.query("SELECT count(*)::int AS count FROM net.wakes")).rows, [{ count: 19 }]);
    assertEquals((await db.query("SELECT pending,lease_until FROM private.energy_learning_jobs WHERE id=$1", [j.id])).rows,
      [{ pending: false, lease_until: null }]);
  } finally { await db.close(); }
});

Deno.test("room fit scratch is fenced, revocable and isolated across owner changes and retries", async () => {
  const db = await database();
  try {
    let j = await claim(db);
    assertEquals(await checkpoint(db, j, -1), true);
    assertEquals(await release(db, j), true);
    j = await claim(db);
    assertEquals(await checkpoint(db, { ...j, generation: j.generation + 1 }, 0), false);
    assertEquals(await checkpoint(db, { ...j, fence: j.fence - 1 }, 0), false);
    const otherClaim = await claim(db, other);
    assertEquals(await load(db, otherClaim), null);
    assertEquals(await load(db, { ...j, id: otherClaim.id }), null);
    assertEquals(await checkpoint(db, await claim(db, home, "pool"), -1), false);
    await db.query("UPDATE private.energy_learning_jobs SET lease_until=now()-interval '1 second',wake_after=now()-interval '1 second' WHERE id=$1", [j.id]);
    await db.query("UPDATE private.energy_room_learning_lanes SET lease_until=now()-interval '1 second' WHERE job_id=$1", [j.id]);
    assertEquals(await load(db, j), null);
    assertEquals(await checkpoint(db, j, 0), false);
    const expired = j; j = await claim(db);
    assertEquals(j.room_fit_progress?.cursor, 0);
    assertEquals(await reset(db, expired, 0), false);
    await db.query("SELECT fail_energy_device_learning($1,$2,$3,'Synthetic retry')", [j.id, j.generation, j.fence]);
    assertEquals(await scratchCount(db), 1, "transient failures keep the prefix");
    assertEquals(await release(db, j), true);
    assertEquals(await claim(db), null, "an immediate notification cannot bypass retry readiness");
    await db.query("UPDATE private.energy_learning_jobs SET wake_after=now()-interval '1 second' WHERE id=$1", [j.id]);
    j = await claim(db);
    assertEquals(await reset(db, j, 1), false);
    assertEquals(await reset(db, j, 0), true);
    assertEquals(await release(db, j), true);
    j = await claim(db);
    assertEquals(j.room_fit_progress, null);
    assertEquals(await checkpoint(db, j, -1), true);
    await db.query("UPDATE private.energy_learning_jobs SET input=input||'{\"location\":null}',generation=generation+1 WHERE id=$1", [j.id]);
    assertEquals(await scratchCount(db), 0);
    assertEquals(await claim(db), null, "input revocation does not free a still-running invocation");
    assertEquals(await release(db, j), true);
    j = await claim(db);
    assertEquals(await checkpoint(db, j, -1), true);
    // Identical ordinary input does not erase progress or restart a cell.
    await db.query("UPDATE private.energy_learning_jobs SET input=input WHERE id=$1", [j.id]);
    assertEquals(await scratchCount(db), 1);
    assertEquals(await release(db, j), true);
    j = await claim(db);
    await db.query("UPDATE energy_optimisation_zone_models SET gain_c_per_wh=.0021 WHERE home_id=$1", [home]);
    assertEquals(await load(db, j), null, "changed accepted revision invalidates incomplete scratch");
    assertEquals(await scratchCount(db), 0);
    assertEquals(await reset(db, j, -1, 2), true, "fresh current revision can release the obsolete stage");
    assertEquals(await release(db, j), true);
    j = await claim(db);
    assertEquals(await checkpoint(db, j, -1, 2), true);
    // An owner disappearing uses the normal complete-owner-set request path.
    await db.query("SELECT request_energy_device_learning($1,$1,'[]'::jsonb)", [home]);
    assertEquals(await scratchCount(db), 0);
    assertEquals(await claim(db), null);
    assertEquals(await release(db, j), true, "a removed owner can release only its old reservation");
    assertEquals(await checkpoint(db, j, 0, 2), false);
    assertEquals((await db.query("SELECT gain_c_per_wh::text AS gain,model_revision FROM energy_optimisation_zone_models WHERE home_id=$1", [home])).rows,
      [{ gain: "0.0021", model_revision: 2 }]);
    await db.exec("SET ROLE service_role");
    await assertRejects(() => db.query("SELECT capture FROM private.energy_room_fit_progress"), Error, "permission denied");
    await db.exec("RESET ROLE; SET ROLE anon");
    await assertRejects(() => load(db, otherClaim), Error, "permission denied");
  } finally { await db.close(); }
});

Deno.test("room admission rotates staged work and preserves reservations through revocation and expiry", async () => {
  const db = await database();
  try {
    await db.exec(`INSERT INTO energy_optimisation_zone_models(home_id,customer_id,room_key,trained,gain_c_per_wh)
      VALUES('${home}','${home}','second',true,.003);
      INSERT INTO private.synthetic_bindings VALUES('${home}','second','synthetic-binding');
      INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input,wake_after)
      VALUES('${home}','${home}','room','second','{}',now()+interval '1 hour'),
        ('${home}','${home}','device','device','{}',now());`);
    const models = (await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id,room_key")).rows;
    let first = await claim(db);
    assertEquals(await claim(db), null, "duplicate notification cannot obtain a second invocation");
    assertEquals((await claim(db, other)).id === first.id, false, "another home has its own lane");
    const pool = await claim(db, home, "pool"), device = await claim(db, home, "device");
    assertEquals(Boolean(pool.id && device.id), true, "room admission does not stop pool or device owners");
    assertEquals(await release(db, pool), false, "a non-room token cannot release room admission");
    await db.query("UPDATE private.energy_learning_jobs SET wake_after=now()-interval '400 days' WHERE home_id=$1 AND owner_key='second'", [home]);
    assertEquals(await claim(db, home, "room", "second"), null);
    assertEquals(await checkpoint(db, first, -1), true);
    assertEquals(await claim(db, home, "room", "second"), null, "checkpoint retains admission until finally");
    assertEquals(await release(db, first), true);
    assertEquals(await claim(db), null, "the immediately requeued room cannot jump ahead of a waiting room");
    let second = await claim(db, home, "room", "second");
    assertEquals(Boolean(second.id), true, "a long-ready job is not rejected for its age");
    assertEquals(await release(db, first), false, "a duplicated finally cannot clear a different room's reservation");
    assertEquals((await db.query("SELECT job_id FROM private.energy_room_learning_lanes WHERE home_id=$1", [home])).rows,
      [{ job_id: second.id }]);
    assertEquals(await checkpoint(db, second, -1), true);
    assertEquals(await release(db, second), true);
    first = await claim(db);
    assertEquals(first.room_fit_progress?.cursor, 0, "waiting preserves the immutable capture and prefix");

    // Normal request invalidation fences publication but cannot assert that
    // the previous HTTP invocation has stopped reading the database already.
    await db.query(`UPDATE private.energy_learning_jobs SET input='{"changed":true}',
      generation=generation+1,fence=fence+1,lease_until=NULL,wake_after=now() WHERE id=$1`, [first.id]);
    assertEquals(await claim(db), null);
    assertEquals(await claim(db, home, "room", "second"), null);
    assertEquals(await release(db, first), true, "the old token can release its own reservation after generation changes");
    second = await claim(db, home, "room", "second");
    assertEquals(second.room_fit_progress?.cursor, 0);
    await db.query(`UPDATE private.energy_learning_jobs SET pending=false,generation=generation+1,
      fence=fence+1,lease_until=NULL,last_error='Learning owner removed' WHERE id=$1`, [second.id]);
    assertEquals(await claim(db), null, "owner removal also retains the unfinished invocation's reservation");
    assertEquals(await release(db, first), false);
    assertEquals(await release(db, second), true);
    first = await claim(db);
    assertEquals(first.room_fit_progress, null, "input invalidation still clears obsolete scratch");

    // No finally after a killed worker: both ordinary lease and lane expire.
    const abandoned = first;
    await db.query(`UPDATE private.energy_learning_jobs SET lease_until=now()-interval '1 day',
      wake_after=now()-interval '400 days' WHERE id=$1`, [first.id]);
    await db.query("UPDATE private.energy_room_learning_lanes SET lease_until=now()-interval '1 day' WHERE job_id=$1", [first.id]);
    first = await claim(db);
    assertEquals(first.fence > abandoned.fence, true);
    assertEquals(await release(db, abandoned), false, "an expired invocation cannot release the new same-job token");
    await db.query("SELECT fail_energy_device_learning($1,$2,$3,'Synthetic retry')", [first.id, first.generation, first.fence]);
    assertEquals(await release(db, first), true);
    assertEquals(await claim(db), null, "finally does not bypass the ordinary retry backoff");
    const wakes = (await db.query("SELECT count(*)::int AS n FROM net.wakes")).rows;
    await db.exec("SELECT private.sweep_energy_learning_jobs()");
    assertEquals((await db.query("SELECT count(*)::int AS n FROM net.wakes")).rows, wakes);
    await db.query("UPDATE private.energy_learning_jobs SET wake_after=now()-interval '1 day' WHERE id=$1", [first.id]);
    const readiness = (await db.query("SELECT wake_after FROM private.energy_learning_jobs WHERE id=$1", [first.id])).rows;
    await db.exec("SELECT private.sweep_energy_learning_jobs()");
    assertEquals((await db.query("SELECT wake_after FROM private.energy_learning_jobs WHERE id=$1", [first.id])).rows, readiness,
      "a room sweep must not move readiness into the future before its claim");
    first = await claim(db);
    assertEquals(Boolean(first.id), true);
    assertEquals((await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id,room_key")).rows, models,
      "admission, retries and release never change accepted models");
    await db.exec("SET ROLE service_role");
    await assertRejects(() => db.query("SELECT * FROM private.energy_room_learning_lanes"), Error, "permission denied");
    assertEquals(await release(db, first), true);
    await db.exec("RESET ROLE; SET ROLE anon");
    await assertRejects(() => release(db, first), Error, "permission denied");
  } finally { await db.close(); }
});

Deno.test("room admission adopts an existing invocation and the sweeper wakes one fair room per home", async () => {
  const db = await database(false);
  try {
    const beforeMigration = await claim(db);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119011000_room_learning_admission.sql"));
    assertEquals((await db.query("SELECT job_id,generation,fence FROM private.energy_room_learning_lanes WHERE home_id=$1", [home])).rows,
      [{ job_id: beforeMigration.id, generation: beforeMigration.generation, fence: beforeMigration.fence }]);
    assertEquals(await claim(db), null);
    await db.query("UPDATE private.energy_learning_jobs SET pending=false,generation=generation+1,fence=fence+1,lease_until=NULL WHERE id=$1", [beforeMigration.id]);
    assertEquals(await release(db, beforeMigration), true, "deployment does not prevent the original reservation from releasing");
    await db.exec(`INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
      VALUES('${home}','${home}','room','second','{}'),('${home}','${home}','room','third','{}');
      TRUNCATE net.wakes;`);
    const next = (await db.query<{ id: string }>("SELECT private.next_energy_room_learning_job($1) AS id", [home])).rows[0].id;
    await db.exec("SELECT private.sweep_energy_learning_jobs()");
    const notified = (await db.query<{ id: string; kind: string; owner: string }>(`SELECT j.id,j.owner_kind AS kind,j.home_id AS owner
      FROM net.wakes w JOIN private.energy_learning_jobs j ON j.id=(w.body->>'job_id')::uuid`)).rows;
    assertEquals(notified.filter(row => row.kind === "room" && row.owner === home).map(row => row.id), [next]);
    assertEquals(notified.filter(row => row.kind === "room" && row.owner === other).length, 1);
    assertEquals(notified.filter(row => row.kind === "pool").length, 1, "the existing non-room sweep remains active");
    assertEquals((await db.query("SELECT wake_after>now() AS throttled FROM private.energy_learning_jobs WHERE owner_kind='pool'")).rows,
      [{ throttled: true }], "non-room notification throttling is unchanged");
  } finally { await db.close(); }
});
