// Independently generated synthetic jobs, pool entries and responses; no household observations.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assert, assertEquals, assertRejects } from "@std/assert";

const home = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const capture = btoa("synthetic-derived-intervals".repeat(12));

async function database() {
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
    "20261123100000_shared_room_response"]) {
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
interface Claim { id: string; generation: number; fence: number }
const claim = async (db: PGlite, owner = home) => (await db.query<{ value: Claim }>(
  "SELECT claim_energy_device_learning(id) AS value FROM private.energy_learning_jobs WHERE home_id=$1 AND owner_kind='room'",
  [owner])).rows[0].value;
/** The worker releases its home admission after every request. */
const release = async (db: PGlite, j: Claim) => await db.query("SELECT release_energy_room_learning_lane($1,$2,$3)", [j.id, j.generation, j.fence]);
/** After a completion (or a failed one) the next ordinary request queues the room again. */
async function handBack(db: PGlite, j: Claim) {
  await release(db, j);
  await db.query("UPDATE private.energy_learning_jobs SET pending=true,lease_until=NULL,wake_after=now(),finished_at=NULL WHERE id=$1", [j.id]);
}
const revision = async (db: PGlite, owner = home) => Number((await db.query<{ r: number }>(
  "SELECT model_revision AS r FROM energy_optimisation_zone_models WHERE home_id=$1", [owner])).rows[0].r);
async function harvest(db: PGlite, j: Claim, window: string, runs: string[], sha = `sha-${window}`, rev?: number) {
  return (await db.query<{ ok: boolean }>(
    "SELECT save_energy_room_run_harvest($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,500,null) AS ok",
    [j.id, j.generation, j.fence, rev ?? await revision(db), window, Number(window) || 0, "2026-01-01T00:00:00Z",
      runs.length ? capture : null, runs.length ? sha : null, runs.length ? 12 : 0, JSON.stringify(runs), runs.length + 1])).rows[0].ok;
}
const pool = async (db: PGlite) => (await db.query<{ window_key: string; sha256: string; binding: string }>(
  "SELECT window_key,sha256,binding FROM private.energy_room_run_pool ORDER BY window_key")).rows;

/** Stage a complete 36-cell shared capture under the current job, as the worker does. */
async function stageShared(db: PGlite, poolRefs: { window_key: string; sha256: string }[]) {
  let j = await claim(db);
  const rev = await revision(db);
  assertEquals((await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit($1,$2,$3,$4,-1,$5::jsonb,$6,null) AS ok",
    [j.id, j.generation, j.fence, rev, JSON.stringify({ version: 3, capture: { window: { window_key: "shared" }, pool: poolRefs } }), capture])).rows[0].ok, true);
  for (let cursor = 0; cursor < 36; cursor += 6) {
    await release(db, j);
    j = await claim(db);
    const cells = Array.from({ length: 6 }, (_, i) => ({ index: (cursor + i) % 18, synthetic: true }));
    assertEquals((await db.query<{ ok: boolean }>(
      "SELECT checkpoint_energy_room_fit_cells($1,$2,$3,$4,$5,null,$6::jsonb,null) AS ok",
      [j.id, j.generation, j.fence, rev, cursor, JSON.stringify(cells)])).rows[0].ok, true);
  }
  await release(db, j);
  return { j: await claim(db), rev };
}
function sharedModel(rev: string | null, refs: { window_key: string; sha256: string }[], status: "fitted" | "unidentified" = "fitted") {
  const runs = ["a", "b", "c", "d"].map((id, i) => ({ id, disposition: i < 3 ? "fitted" : "provisional" }));
  const summary = { policy: "seasonal_independent_runs_v1", minimum_runs: 3, maximum_runs: 24, observed_runs: 4,
    retained_runs: 4, fitted_runs: 3, suspect_runs: 0, provisional_runs: 1, oldest_run_at: null, newest_run_at: null };
  const ledger = { ...summary, runs, assessed_against: rev };
  const shared_attempt = { implementation: "synthetic", pool: refs, attempted_at: "2026-01-02T00:00:00Z", status };
  const model = { home_id: home, customer_id: home, room_key: "room", last_attempted_at: "2026-01-02T00:00:00Z",
    ...(rev ? { trained: true, gain_c_per_wh: .003 } : {}),
    heating_bands: rev ? { binding: "synthetic-binding", since: "2025-01-01T00:00:00Z", reference_revision: rev,
      reference: { scope: { kind: "shared" }, model: { gain_c_per_wh: .003, cooling_constant_per_h: .05, background_gain_c_per_h: 0 },
        learning_evidence: { run_calibration: summary } }, active: [], candidates: [], attempted: {}, shared_attempt }
      : { binding: "synthetic-binding", since: "2025-01-01T00:00:00Z", reference_revision: null, active: [], candidates: [],
        attempted: {}, shared_attempt } };
  return { model, ledger };
}
const complete = async (db: PGlite, j: Claim, rev: number, model: object, ledger: object | null) =>
  (await db.query<{ ok: boolean }>("SELECT complete_energy_room_fit($1,$2,$3,$4,36,$5::jsonb,$6::jsonb) AS ok",
    [j.id, j.generation, j.fence, rev, JSON.stringify(model), ledger === null ? null : JSON.stringify(ledger)])).rows[0].ok;
const ledgers = async (db: PGlite) => (await db.query<{ scope_key: string }>(
  "SELECT scope_key FROM private.energy_room_run_ledgers WHERE home_id=$1 ORDER BY scope_key", [home])).rows.map(row => row.scope_key);

Deno.test("harvests are fenced, idempotent, survive retention and are pruned only for another binding", async () => {
  const db = await database();
  try {
    const j = await claim(db);
    assertEquals(await harvest(db, j, "-10", ["r1", "r2"]), true);
    assertEquals(await harvest(db, j, "-10", ["r1", "r2"]), true, "a retried harvest writes the same entry");
    assertEquals(await harvest(db, j, "0", ["r3"]), true);
    assertEquals((await pool(db)).map(row => row.window_key), ["-10", "0"]);
    assertEquals(await harvest(db, { ...j, fence: j.fence + 1 }, "5", ["r4"]), false, "a stale fence writes nothing");
    assertEquals(await harvest(db, j, "5", ["r4"], "sha-5", 99), false, "a superseded model revision writes nothing");
    assertEquals(await harvest(db, j, "0", []), true, "a band with no complete run holds no entry");
    assertEquals((await pool(db)).map(row => row.window_key), ["-10"]);
    await assertRejects(() => harvest(db, j, "5", Array.from({ length: 25 }, (_, i) => `r${i}`)), Error, "Invalid room run harvest");
    const loaded = (await db.query<{ value: { window_key: string; capture: string; row_count: number }[] }>(
      "SELECT load_energy_room_run_pool($1,$1,'room','synthetic-binding') AS value", [home])).rows[0].value;
    assertEquals(loaded.map(entry => [entry.window_key, entry.capture, entry.row_count]), [["-10", capture, 12]]);
    // A new heating source makes earlier harvests another plant's evidence.
    await db.query("UPDATE private.synthetic_bindings SET binding='replaced-heater' WHERE home_id=$1", [home]);
    assertEquals(await harvest(db, j, "5", ["r5"]), true);
    assertEquals((await pool(db)).map(row => [row.window_key, row.binding]), [["5", "replaced-heater"]]);
  } finally { await db.close(); }
});

Deno.test("a shared response publishes only over its exact pool, replaces the bands and owns one assessed ledger", async () => {
  const db = await database();
  try {
    const j0 = await claim(db);
    await harvest(db, j0, "-10", ["a", "b"]); await harvest(db, j0, "0", ["c", "d"]);
    // The worker's bookkeeping publication and continuation trigger hand the job back.
    await release(db, j0);
    await db.query("SELECT private.resume_energy_room_fit($1)", [j0.id]);
    await db.query(`INSERT INTO private.energy_room_run_ledgers(home_id,customer_id,room_key,scope_key,model_revision,job_id,generation,evidence)
      VALUES($1,$1,'room','-10',1,$2,1,'{"runs":[]}'),($1,$1,'room','general',1,$2,1,'{"runs":[]}')`, [home, j0.id]);
    const refs = [{ window_key: "-10", sha256: "sha--10" }, { window_key: "0", sha256: "sha-0" }];
    // A stale pool (a harvest landed after capture) is not published and discards the scratch.
    let { j, rev } = await stageShared(db, refs);
    const stale = sharedModel("33333333-3333-4333-8333-333333333333", [refs[0]]);
    assertEquals(await complete(db, j, rev, stale.model, stale.ledger), false);
    await handBack(db, j);
    assertEquals((await db.query("SELECT 1 FROM private.energy_room_fit_progress")).rows.length, 0);
    // A shared publication must replace the bands and carry its own assessment.
    ({ j, rev } = await stageShared(db, refs));
    const wrong = sharedModel("33333333-3333-4333-8333-333333333333", refs);
    await assertRejects(() => complete(db, j, rev, wrong.model, { ...wrong.ledger, assessed_against: "other" }), Error, "carry its own assessment");
    await db.query("DELETE FROM private.energy_room_fit_progress");
    await handBack(db, j);
    ({ j, rev } = await stageShared(db, refs));
    const published = sharedModel("33333333-3333-4333-8333-333333333333", refs);
    assertEquals(await complete(db, j, rev, published.model, published.ledger), true);
    await handBack(db, j);
    const row = (await db.query<{ heating_bands: { reference: { scope: { kind: string } }; active: unknown[] }; gain_c_per_wh: string }>(
      "SELECT heating_bands,gain_c_per_wh FROM energy_optimisation_zone_models WHERE home_id=$1", [home])).rows[0];
    assertEquals(row.heating_bands.reference.scope.kind, "shared");
    assertEquals(row.heating_bands.active, []);
    assertEquals(await ledgers(db), ["shared"], "legacy band and general ledgers are retired by the shared response");
    // A failed refit keeps the accepted response; its ledger is the latest attempt only.
    ({ j, rev } = await stageShared(db, refs));
    const failed = sharedModel(null, refs, "unidentified");
    const accepted = { ...failed.model, heating_bands: { ...published.model.heating_bands, shared_attempt: failed.model.heating_bands.shared_attempt } };
    assertEquals(await complete(db, j, rev, accepted, { ...failed.ledger, fitted_runs: 0, provisional_runs: 4,
      runs: failed.ledger.runs.map(run => ({ ...run, disposition: "provisional" })) }), true);
    assertEquals(await ledgers(db), ["attempt", "shared"]);
  } finally { await db.close(); }
});

Deno.test("a library from before the shared response is due on its next request, and the evidence read pairs response with ledger", async () => {
  const db = await database();
  try {
    await db.query(`UPDATE energy_optimisation_zone_models SET last_attempted_at=now(),
      heating_bands='{"binding":"synthetic-binding","calibration_policy":"recent_independent_runs_v1","reference_revision":"legacy"}'
      WHERE home_id=$1`, [home]);
    await db.query("UPDATE private.energy_learning_jobs SET pending=false WHERE home_id=$1", [home]);
    const queued = (await db.query<{ n: number }>(
      `SELECT request_energy_device_learning($1,$1,'[{"kind":"room","key":"room","input":{}}]'::jsonb) AS n`, [home])).rows[0].n;
    assertEquals(queued, 1);
    await db.query(`UPDATE energy_optimisation_zone_models SET heating_bands=heating_bands||'{"calibration_policy":"seasonal_independent_runs_v1"}'
      WHERE home_id=$1`, [home]);
    await db.query("UPDATE private.energy_learning_jobs SET pending=false WHERE home_id=$1", [home]);
    assertEquals((await db.query<{ n: number }>(
      `SELECT request_energy_device_learning($1,$1,'[{"kind":"room","key":"room","input":{}}]'::jsonb) AS n`, [home])).rows[0].n, 0,
      "a recent shared attempt waits for the daily cadence");
    const view = async () => (await db.query<{ v: { response: unknown; ledgers: unknown[] } }>(
      "SELECT get_energy_room_response_evidence($1,'room') AS v", [home])).rows[0].v;
    assertEquals((await view()).response, null, "a legacy reference is not presented as the shared response");
    await db.query(`UPDATE energy_optimisation_zone_models SET heating_bands=heating_bands||
      '{"reference_revision":"r1","reference":{"scope":{"kind":"shared"},"model":{"gain_c_per_wh":0.002}}}' WHERE home_id=$1`, [home]);
    assert((await view()).response);
    await assertRejects(() => db.query("SELECT get_energy_room_response_evidence($1,'room')", [other]), Error, "access denied");
  } finally { await db.close(); }
});
