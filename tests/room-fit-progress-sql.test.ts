import { learnRoomResponse, ROOM_RESPONSE_CELL_COUNT } from "../supabase/functions/_shared/device-learning/room/response-learning.ts";
// Independently generated synthetic jobs/captures; no household observations.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { HEAT_LAG_GRID_H } from "../supabase/functions/_shared/device-learning/room/fit.ts";
import { parseRoomBandFitCells, ROOM_BAND_FIT_CELL_COUNT } from "../supabase/functions/_shared/device-learning/room/mean-observations.ts";

import { finalizeStoredRoomBand, ROOM_WINDOW_IMPLEMENTATION, type RoomBandMetadata } from "../supabase/functions/_shared/device-model-learning/room.ts";
import { syntheticRoomPlant } from "../supabase/functions/_shared/device-learning/room/native-mean.fixture.ts";

const home = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const metadata = { implementation: "synthetic-v1", binding: "synthetic-binding", digest: "synthetic-digest" };
const capture = btoa("synthetic-derived-intervals".repeat(12));
interface Claim {
  id: string; generation: number; fence: number;
  room_history_to: string | null;
  room_window_visits?: { binding: string; implementation: string; windows: Record<string, string> } | null;
  room_fit_progress: { metadata: object; cursor: number; cells: unknown[]; base_revision: number } | null;
}
async function database(admission = true, visits = true, horizon = true, runPolicy = false) {
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
      gain_c_per_wh numeric,cooling_constant_per_h numeric DEFAULT .05,background_gain_c_per_h numeric DEFAULT 0,
      sample_count integer NOT NULL DEFAULT 0 CHECK(sample_count>=0),last_attempted_at timestamptz,last_fit_attempt jsonb,heating_bands jsonb,
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
  const originalZoneSchema = await Deno.readTextFile("supabase/migrations/20260812140000_add_thermal_zone_models.sql");
  const rejection = originalZoneSchema.slice(originalZoneSchema.indexOf("rejection_reason text CHECK"),
    originalZoneSchema.indexOf("  gain_c_per_wh numeric")).trim().replace(/,$/, "");
  const completeness = originalZoneSchema.slice(originalZoneSchema.indexOf("CONSTRAINT energy_optimisation_zone_model_complete CHECK"),
    originalZoneSchema.indexOf("\n);"));
  await db.exec(`ALTER TABLE energy_optimisation_zone_models ADD COLUMN ${rejection};
    ALTER TABLE energy_optimisation_zone_models ADD ${completeness};`);
  await db.exec(await Deno.readTextFile("supabase/migrations/20261026001000_device_learning_lifecycle.sql"));
  // Exercise the deployed normal publisher, including its source-binding check,
  // without constructing unrelated electrical/planner migration dependencies.
  const publication = await Deno.readTextFile("supabase/migrations/20261118120000_version_heating_bands.sql");
  const start = publication.indexOf("CREATE OR REPLACE FUNCTION public.publish_energy_device_learning(");
  await db.exec(publication.slice(start, publication.indexOf("END; $$;", start) + "END; $$;".length));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261118220500_room_fit_progress.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261120002000_room_heat_fit_iterations.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261120003000_continue_pending_room_windows.sql"));
  if (admission) await db.exec(await Deno.readTextFile("supabase/migrations/20261119011000_room_learning_admission.sql"));
  if (visits) await db.exec(await Deno.readTextFile("supabase/migrations/20261119022000_room_window_visits.sql"));
  if (horizon) await db.exec(await Deno.readTextFile("supabase/migrations/20261120004000_bound_room_learning_traversals.sql"));
  if (runPolicy) await db.exec(await Deno.readTextFile("supabase/migrations/20261122110000_bounded_room_run_calibration.sql"));
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
async function checkpoint(db: PGlite, j: Claim, cursor: number, revision = 1, initialMetadata: object = metadata) {
  return (await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) AS ok",
    [j.id, j.generation, j.fence, revision, cursor, cursor === -1 ? JSON.stringify(initialMetadata) : null,
      cursor === -1 ? capture : null, cursor === -1 ? null : JSON.stringify({ lag_h: HEAT_LAG_GRID_H[Math.floor(cursor % 18 / 2)],
        partition: cursor % 2 ? "full" : "training", additional_heat: { finite: null, equilibrium: null, integrator: null },
        fits: { finite: null, equilibrium: null, integrator: null } })])).rows[0].ok;
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

Deno.test("current run calibration persists a private bounded ledger with one fenced 36-cell publication", async () => {
  assertEquals(ROOM_RESPONSE_CELL_COUNT,36,"SQL scratch bound matches the production response stages");
  const db = await database(true, true, true, true);
  try {
    let j = await claim(db);
    const captured = { ...metadata, capture: { window: { window_key: "-10" } } };
    assertEquals(await checkpoint(db, j, -1, 1, captured), true);
    await release(db, j); j = await claim(db);
    for (let cursor = 0; cursor < 36; cursor++) {
      assertEquals(await checkpoint(db, j, cursor), true);
      await release(db, j); j = await claim(db);
    }
    const evidence = { policy: "recent_independent_runs_v1", retained_runs: 3, fitted_runs: 3,
      runs: [0, 1, 2].map(id => ({ id: `synthetic-event-${id}`, disposition: "fitted" })) };
    const patch = { home_id: home, customer_id: home, room_key: "room", trained: true, gain_c_per_wh: .003,
      heating_bands: { binding: "synthetic-binding", active: [{ band_c: -10, revision: "synthetic-new",
        learning_evidence: { run_calibration: { policy: evidence.policy, retained_runs: 3, fitted_runs: 3 } } }] } };
    const publish = (ledger: unknown, fence = j.fence) => db.query<{ ok: boolean }>(
      "SELECT complete_energy_room_fit($1,$2,$3,1,36,$4::jsonb,$5::jsonb) AS ok",
      [j.id,j.generation,fence,JSON.stringify(patch),JSON.stringify(ledger)]);
    await assertRejects(() => publish({ ...evidence, fitted_runs: 2, runs: evidence.runs.slice(0, 2), retained_runs: 2 }),
      Error, "three to ten distinct events");
    await assertRejects(() => publish({ ...evidence, runs: evidence.runs.map(() => evidence.runs[0]) }),
      Error, "three to ten distinct events");
    assertEquals(await scratchCount(db), 1, "invalid evidence cannot change accepted models or discard scratch");
    await assertRejects(() => publish(null), Error, "must match its fitted run evidence");
    await assertRejects(() => publish({ ...evidence, observed_runs: 8 }), Error, "must match its fitted run evidence");
    assertEquals((await publish(evidence, j.fence - 1)).rows[0].ok, false);
    assertEquals((await publish(evidence)).rows[0].ok, true);
    assertEquals((await publish(evidence)).rows[0].ok, false, "a lost completion reply cannot duplicate the ledger");
    assertEquals(await scratchCount(db), 0);
    const ledger = (await db.query<{ evidence: unknown; model_revision: number; scope_key: string }>(
      "SELECT evidence,model_revision,scope_key FROM private.energy_room_run_ledgers")).rows;
    assertEquals(ledger, [{ evidence, model_revision: 2, scope_key: "-10" }]);
    assertEquals((await db.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('service_role','private.energy_room_run_ledgers','SELECT') AS allowed")).rows[0].allowed, false);
    const model = (await db.query<{ heating_bands: unknown }>(
      "SELECT heating_bands FROM energy_optimisation_zone_models WHERE home_id=$1",[home])).rows[0];
    assertEquals(model.heating_bands, patch.heating_bands, "detailed run traces do not enlarge the planning model");
  } finally { await db.close(); }
});

const syntheticCell = (cursor: number) => ({ lag_h: HEAT_LAG_GRID_H[Math.floor(cursor % 18 / 2)],
  partition: cursor % 2 ? "full" : "training",
  additional_heat: { finite: null, equilibrium: null, integrator: null }, fits: { finite: null, equilibrium: null, integrator: null } });
async function batch(db: PGlite, j: Claim, cursor: number, count: number, expected: unknown = null, state: unknown = null,
  cells: unknown = Array.from({ length: count }, (_, i) => syntheticCell(cursor + i)), revision = 1) {
  return (await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit_cells($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) AS ok",
    [j.id, j.generation, j.fence, revision, cursor, expected === null ? null : JSON.stringify(expected),
      JSON.stringify(cells), state === null ? null : JSON.stringify(state)])).rows[0].ok;
}
async function stored(db: PGlite, j: Claim) {
  return (await db.query<{ cursor: number; state: unknown; capture: string }>(`SELECT jsonb_array_length(cells) AS cursor,
    metadata->'heat_state' AS state,replace(encode(capture,'base64'),E'\\n','') AS capture
    FROM private.energy_room_fit_progress WHERE job_id=$1`, [j.id])).rows[0];
}

Deno.test("batched room fit commits are fenced compare-and-append writes ending in the normal 36-cell publication", async () => {
  const db = await database(true, true, true, true);
  try {
    await db.exec(await Deno.readTextFile("supabase/migrations/20261122160000_batch_room_fit_cells.sql"));
    const before = (await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id")).rows;
    let j = await claim(db);
    const captured = { ...metadata, version: 2, capture: { version: 1, window: { window_key: "-10" } } };
    assertEquals(await checkpoint(db, j, -1, 1, captured), true);
    assertEquals(await batch(db, j, 0, 2), false, "the capture commit released the lease");
    await release(db, j); j = await claim(db);
    await db.exec("TRUNCATE net.wakes");

    // Invalid inputs are rejected without touching scratch.
    for (const [cursor, count, cells, state, message] of [
      [0, 0, "{}", null, "Invalid room fit cells"],
      [0, 0, [], null, "Invalid room fit cells"],
      [0, 1, [1], null, "Invalid room fit cells"],
      [30, 7, undefined, null, "Invalid room fit cells"],
      [0, 2, undefined, { version: 2, index: 3 }, "Invalid room response iteration"],
      [0, 2, undefined, { version: 1, index: 2 }, "Invalid room response iteration"],
      [0, 36, undefined, { version: 2, index: 0 }, "Invalid room response iteration"],
    ] as const) {
      await assertRejects(() => batch(db, j, cursor, count, null, state, cells), Error, message);
    }
    assertEquals((await stored(db, j)).cursor, 0);

    // Stale generation, fence or revision commits nothing and keeps the lease.
    assertEquals(await batch(db, { ...j, generation: j.generation + 1 }, 0, 3), false);
    assertEquals(await batch(db, { ...j, fence: j.fence - 1 }, 0, 3), false);
    assertEquals(await batch(db, j, 1, 3), false, "a skipped prefix cannot append");
    assertEquals(await batch(db, j, 0, 3, { version: 2, index: 0, stale: true }), false, "a mismatched partial state cannot append");
    assertEquals((await stored(db, j)).cursor, 0);

    // Three cells plus partial state of the fourth, in one write.
    const partial = { version: 2, index: 3, iteration: 1 };
    assertEquals(await batch(db, j, 0, 3, null, partial), true);
    assertEquals(await stored(db, j), { cursor: 3, state: partial, capture }, "capture is immutable across batches");
    assertEquals(await batch(db, j, 0, 3, null, partial), false, "a lost reply cannot append the same batch twice");
    assertEquals(await load(db, j), null, "each commit relinquishes the publication lease");
    assertEquals(await release(db, j), true);
    j = await claim(db);
    assertEquals(j.room_fit_progress?.cursor, 3);
    assertEquals((j.room_fit_progress?.metadata as { heat_state: unknown }).heat_state, partial);

    // A state-only iteration compares the stored state; a stale state is refused.
    const next = { ...partial, iteration: 2 };
    assertEquals(await batch(db, j, 3, 0, null, next), false);
    assertEquals(await batch(db, j, 3, 0, partial, next), true);
    await release(db, j); j = await claim(db);

    // Finish the partial cell and cross into stage two in one fenced write.
    assertEquals(await batch(db, j, 3, 17, next), true);
    assertEquals(await stored(db, j), { cursor: 20, state: null, capture }, "a completed cell clears only its partial state");
    await release(db, j); j = await claim(db);
    assertEquals(parseRoomBandFitCells(j.room_fit_progress!.cells.slice(0, 18)), j.room_fit_progress!.cells.slice(0, 18));
    assertEquals((await db.query<{ ok: boolean }>("SELECT complete_energy_room_fit($1,$2,$3,1,20,'{}'::jsonb,NULL) AS ok",
      [j.id, j.generation, j.fence])).rows[0].ok, false, "an incomplete prefix cannot publish");
    assertEquals(await batch(db, j, 20, 16), true);
    await release(db, j); j = await claim(db);
    assertEquals(j.room_fit_progress?.cursor, 36);
    await assertRejects(() => batch(db, j, 36, 0, null, { version: 2, index: 0 }), Error, "Invalid room response iteration");
    await assertRejects(() => batch(db, j, 36, 1), Error, "Invalid room fit cells");
    assertEquals((await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id")).rows, before,
      "batched numerical work never changes accepted models or revisions");

    // The normal publisher still requires all 36 cells and run evidence.
    const evidence = { policy: "recent_independent_runs_v1", retained_runs: 3, fitted_runs: 3,
      runs: [0, 1, 2].map(id => ({ id: `synthetic-event-${id}`, disposition: "fitted" })) };
    const patch = { home_id: home, customer_id: home, room_key: "room", trained: true, gain_c_per_wh: .003,
      heating_bands: { binding: "synthetic-binding", active: [{ band_c: -10, revision: "synthetic-batched",
        learning_evidence: { run_calibration: { policy: evidence.policy, retained_runs: 3, fitted_runs: 3 } } }] } };
    assertEquals((await db.query<{ ok: boolean }>("SELECT complete_energy_room_fit($1,$2,$3,1,36,$4::jsonb,$5::jsonb) AS ok",
      [j.id, j.generation, j.fence, JSON.stringify(patch), JSON.stringify(evidence)])).rows[0].ok, true);
    assertEquals(await scratchCount(db), 0);
    assertEquals(await batch(db, j, 0, 1), false, "a finished job cannot accept late cells");
    await release(db, j);

    // A changed accepted revision invalidates in-flight scratch for a batch too.
    let peer = await claim(db, other);
    assertEquals(await checkpoint(db, peer, -1, 1, captured), true);
    await release(db, peer); peer = await claim(db, other);
    assertEquals(peer.room_fit_progress?.cursor, 0);
    await db.query("UPDATE energy_optimisation_zone_models SET gain_c_per_wh=.0041 WHERE home_id=$1", [other]);
    assertEquals(await batch(db, peer, 0, 2), false);
    assertEquals(await scratchCount(db), 0, "the obsolete revision's scratch is discarded, not extended");
    await release(db, peer);
    for (const role of ["anon", "authenticated"]) {
      assertEquals((await db.query<{ allowed: boolean }>(
        `SELECT has_function_privilege('${role}','public.checkpoint_energy_room_fit_cells(uuid,bigint,bigint,bigint,integer,jsonb,jsonb,jsonb)','EXECUTE') AS allowed`)).rows[0].allowed, false);
    }
    assertEquals((await db.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('service_role','public.checkpoint_energy_room_fit_cells(uuid,bigint,bigint,bigint,integer,jsonb,jsonb,jsonb)','EXECUTE') AS allowed")).rows[0].allowed, true);
  } finally { await db.close(); }
});

Deno.test("batched and previous single-step commits interoperate on the same staged row during a deploy", async () => {
  const db = await database(true, true, true, true);
  try {
    await db.exec(await Deno.readTextFile("supabase/migrations/20261122160000_batch_room_fit_cells.sql"));
    let j = await claim(db);
    assertEquals(await checkpoint(db, j, -1), true);
    await release(db, j); j = await claim(db);
    // A previous worker records one cell and a partial iteration...
    assertEquals(await checkpoint(db, j, 0), true);
    await release(db, j); j = await claim(db);
    const partial = { version: 2, index: 1, iteration: 1 };
    assertEquals((await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_heat_iteration($1,$2,$3,1,1,NULL,$4::jsonb) AS ok",
      [j.id, j.generation, j.fence, JSON.stringify(partial)])).rows[0].ok, true);
    await release(db, j); j = await claim(db);
    // ...and the batched worker resumes from exactly that prefix and state.
    assertEquals(await batch(db, j, 1, 4, partial), true);
    await release(db, j); j = await claim(db);
    assertEquals(await checkpoint(db, j, 5), true, "a previous worker can continue a batched prefix");
    assertEquals((await stored(db, j)).cursor, 6);
  } finally { await db.close(); }
});

Deno.test("a newly deployed run policy requests one normal refit without repeatedly restarting its owner", async () => {
  const db = await database(true,true,true,true);
  try {
    await db.query("UPDATE private.energy_learning_jobs SET pending=false WHERE home_id=$1",[home]);
    await db.query("UPDATE energy_optimisation_zone_models SET last_attempted_at=now(),heating_bands=$2::jsonb WHERE home_id=$1",
      [home,JSON.stringify({ binding: "synthetic-binding", reference_revision: "retained-reference" })]);
    const owners = [{kind:"room",key:"room",input:{}}];
    const request = () => db.query<{n:number}>("SELECT request_energy_device_learning($1,$1,$2::jsonb) AS n",[home,JSON.stringify(owners)]);
    assertEquals((await request()).rows[0].n,1);
    assertEquals((await request()).rows[0].n,0,"the pending owner keeps its generation and bounded traversal");
  } finally { await db.close(); }
});

Deno.test("a general equilibrium response clears dynamic fields without admitting incomplete models", async () => {
  const db = await database(true, true, true, true);
  try {
    await assertRejects(() => db.query("UPDATE energy_optimisation_zone_models SET gain_c_per_wh=NULL,cooling_constant_per_h=NULL WHERE home_id=$1", [home]), Error, "energy_optimisation_zone_model_complete");
    const library = { reference: { model: { response_family: "equilibrium", heater_c_per_w: .003, outdoor_share: .1, offset_c: 0 } } };
    await db.query("UPDATE energy_optimisation_zone_models SET gain_c_per_wh=NULL,cooling_constant_per_h=NULL,heating_bands=$2::jsonb WHERE home_id=$1", [home,JSON.stringify(library)]);
    await assertRejects(() => db.query("UPDATE energy_optimisation_zone_models SET heating_bands=heating_bands#-'{reference,model,heater_c_per_w}' WHERE home_id=$1", [home]), Error, "energy_optimisation_zone_model_complete");
  } finally { await db.close(); }
});

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

const visitMetadata = (window = "25", binding = "synthetic-binding", implementation = "synthetic-v1", attemptedAt = "2026-01-01T00:00:00Z") =>
  ({ version: 1, capture: { binding, implementation, window: { window_key: window }, attemptedAt } });

Deno.test("window visits survive superseded scratch without marking evidence complete or changing models", async () => {
  const db = await database();
  try {
    const accepted = (await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id")).rows;
    let j = await claim(db);
    assertEquals(j.room_window_visits, null);
    assertEquals(await checkpoint(db, j, -1, 1, visitMetadata()), true);
    await release(db, j); j = await claim(db);
    const first = j.room_window_visits!;
    assertEquals(first.binding, "synthetic-binding");
    assertEquals(first.implementation, "synthetic-v1");
    assertEquals(Object.keys(first.windows), ["25"]);
    assert(Number.isFinite(Date.parse(first.windows["25"])));
    assertEquals(await reset(db, j, 0), true);
    await release(db, j); j = await claim(db);
    assertEquals(j.room_fit_progress, null);
    assertEquals(j.room_window_visits, first, "a changed capture cannot become an unvisited window again");
    const oldToken = j;
    assertEquals(await checkpoint(db, j, -1, 1, visitMetadata("-10")), true);
    await release(db, j); j = await claim(db);
    assertEquals(Object.keys(j.room_window_visits!.windows).sort(), ["-10", "25"]);
    assertEquals(j.room_window_visits!.windows["25"], first.windows["25"]);
    assertEquals(await checkpoint(db, oldToken, -1, 1, visitMetadata("unowned")), false);
    const visits = j.room_window_visits;
    await db.query(`UPDATE private.energy_learning_jobs SET generation=generation+1,fence=fence+1,
      input='{"changed":true}',lease_until=NULL,wake_after=now() WHERE id=$1`, [j.id]);
    await release(db, j); j = await claim(db);
    assertEquals(j.room_fit_progress, null);
    assertEquals(j.room_window_visits, visits, "generation/input invalidation clears only numerical scratch");
    assertEquals(await checkpoint(db, j, -1, 1, visitMetadata("0", "synthetic-new-binding")), true);
    await release(db, j); j = await claim(db);
    assertEquals(j.room_window_visits!.binding, "synthetic-new-binding");
    assertEquals(Object.keys(j.room_window_visits!.windows), ["0"]);
    assertEquals(await reset(db, j, 0), true);
    await release(db, j); j = await claim(db);
    assertEquals(await checkpoint(db, j, -1, 1, visitMetadata("5", "synthetic-new-binding", "synthetic-v2")), true);
    await release(db, j); j = await claim(db);
    assertEquals(j.room_window_visits!.implementation, "synthetic-v2");
    assertEquals(Object.keys(j.room_window_visits!.windows), ["5"]);
    const otherClaim = await claim(db, other);
    assertEquals(otherClaim.room_window_visits, null);
    const pool = await claim(db, home, "pool");
    assertEquals(pool.room_window_visits, null);
    assertEquals(await checkpoint(db, pool, -1, 1, visitMetadata()), false);
    assertEquals((await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id")).rows, accepted);
    await db.exec("SET ROLE service_role");
    await assertRejects(() => db.query("SELECT room_window_visits FROM private.energy_learning_jobs"), Error, "permission denied");
  } finally { await db.close(); }
});

Deno.test("window visit migration adopts recognizable captures with safe timestamp handling", async () => {
  const db = await database(true, false);
  try {
    const j = await claim(db), peer = await claim(db, other);
    assertEquals(await checkpoint(db, j, -1, 1, visitMetadata()), true);
    assertEquals(await checkpoint(db, peer, -1, 1, visitMetadata("-5", "synthetic-other", "synthetic-v1", "invalid timestamp")), true);
    await release(db, j); await release(db, peer);
    const before = (await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id")).rows;
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119022000_room_window_visits.sql"));
    const first = await claim(db), second = await claim(db, other);
    assertEquals(Date.parse(first.room_window_visits!.windows["25"]), Date.parse("2026-01-01T00:00:00Z"));
    assert(Number.isFinite(Date.parse(second.room_window_visits!.windows["-5"])));
    assertEquals(first.room_fit_progress?.cursor, 0);
    assertEquals(second.room_fit_progress?.cursor, 0);
    assertEquals((await db.query("SELECT * FROM energy_optimisation_zone_models ORDER BY home_id")).rows, before);
  } finally { await db.close(); }
});

Deno.test("independent band publication preserves the general model SQL domain and completeness", async () => {
  const db = await database();
  try {
    await db.query(`UPDATE energy_optimisation_zone_models SET trained=false,rejection_reason='insufficient_heating',
      sample_count=37,gain_c_per_wh=NULL,cooling_constant_per_h=NULL WHERE home_id=$1`, [home]);
    // This is the actual SQL domain: an independent response diagnostic is
    // not one of the general scalar model's rejection reasons.
    await assertRejects(() => db.query("UPDATE energy_optimisation_zone_models SET rejection_reason='response_unresolved' WHERE home_id=$1", [home]), Error, "check constraint");
    await assertRejects(() => db.query("UPDATE energy_optimisation_zone_models SET trained=true WHERE home_id=$1", [home]), Error, "check constraint");
    const before = (await db.query<Record<string, unknown>>("SELECT model_revision,sample_count,rejection_reason,trained,gain_c_per_wh,cooling_constant_per_h FROM energy_optimisation_zone_models WHERE home_id=$1", [home])).rows[0];
    let j = await claim(db);
    const revision = Number(before.model_revision);
    assertEquals(await checkpoint(db, j, -1, revision), true);
    await release(db, j); j = await claim(db);
    for (let cursor=0;cursor<18;cursor++) {
      assertEquals(await checkpoint(db, j, cursor, revision), true);
      await release(db, j); j = await claim(db);
    }
    const rows = syntheticRoomPlant([3600],240).rows;
    const from = new Date(rows[0].start_ms).toISOString(), to = new Date(rows.at(-1)!.start_ms+3_600_000).toISOString();
    const library = { binding:"synthetic-binding", since:from, reference_revision:null, active:[], candidates:[], attempted:{} };
    const work: RoomBandMetadata = { version:1, implementation:ROOM_WINDOW_IMPLEMENTATION, homeId:home, customerId:home, roomKey:"room",
      binding:library.binding, baseRevision:revision, attemptedAt:to, pinnedFloor:from,
      window:{window_key:"-10",band_c:-10,from_at:from,to_at:to,fingerprint:"synthetic-observations",evidence_updated_at:to},
      library, progressLibrary:library, reference:null, ratedPowerW:500,lastAt:new Date(rows.at(-1)!.start_ms).toISOString(), sourceFreshness:null };
    const fit = learnRoomResponse(rows, () => true, 500);
    assert(fit.result.ok, "independent synthetic plant produces an accepted finite band");
    const model = finalizeStoredRoomBand(work,rows,fit);
    assertEquals((await db.query<{ ok: boolean }>("SELECT complete_energy_room_fit($1,$2,$3,$4,18,$5::jsonb) AS ok",
      [j.id,j.generation,j.fence,revision,JSON.stringify(model)])).rows[0].ok,true);
    await release(db,j);
    const after = (await db.query<{ model_revision:number;sample_count:number;rejection_reason:string;trained:boolean;gain_c_per_wh:null;cooling_constant_per_h:null;heating_bands:{active:unknown[];diagnostics:Record<string,unknown>};last_fit_attempt:{status:string} }>(
      "SELECT * FROM energy_optimisation_zone_models WHERE home_id=$1",[home])).rows[0];
    assertEquals(after.model_revision,revision+1);
    for (const key of ["sample_count","rejection_reason","trained","gain_c_per_wh","cooling_constant_per_h"] as const) assertEquals(after[key],before[key]);
    assertEquals(after.heating_bands.active.length,1);
    assert(after.heating_bands.diagnostics["-10"]);
    assertEquals(after.last_fit_attempt.status,"general_unidentified");
    assertEquals(await scratchCount(db),0);
  } finally { await db.close(); }
});


Deno.test("additional heat iterations are fenced, compare their old state and preserve immutable capture", async () => {
  const db = await database(false, false);
  try {
    let j = await claim(db);
    assertEquals(await checkpoint(db, j, -1), true);
    j = await claim(db);
    const step = async (old: unknown, next: unknown) => (await db.query<{ ok: boolean }>(
      "SELECT checkpoint_energy_room_heat_iteration($1,$2,$3,1,0,$4::jsonb,$5::jsonb) AS ok",
      [j.id,j.generation,j.fence,old === null ? null : JSON.stringify(old),JSON.stringify(next)])).rows[0].ok;
    const first = { version: 2, index: 0, iteration: 1 };
    assertEquals(await step(null, first), true);
    j = await claim(db);
    assertEquals(await load(db, j), capture);
    assertEquals(await step(null, first), false, "lost reply cannot apply an iteration twice");
    const next = { ...first, iteration: 2 };
    assertEquals(await step(first, next), true);
    j = await claim(db);
    assertEquals(await checkpoint(db, j, 0), true);
    const saved = (await db.query<{ state: unknown }>("SELECT metadata->'heat_state' AS state FROM private.energy_room_fit_progress WHERE job_id=$1",[j.id])).rows[0];
    assertEquals(saved.state, null, "completed cell clears only numerical scratch");
    assertEquals(await complete(db,j,1), false, "partial inference cannot publish a band");
  } finally { await db.close(); }
});


Deno.test("a completed band automatically continues remaining room windows and stops when the traversal is drained", async () => {
  const db = await database(false, false);
  try {
    let j = await claim(db);
    const historyTo = j.room_history_to;
    assert(historyTo);
    assertEquals(await checkpoint(db,j,-1), true);
    for (let cursor=0;cursor<ROOM_BAND_FIT_CELL_COUNT;cursor++) { j=await claim(db); assertEquals(await checkpoint(db,j,cursor),true); }
    j=await claim(db);
    assertEquals(await complete(db,j,18,{ heating_bands: { binding: "synthetic-binding", active: [], pending_windows: 2 } }),true);
    assertEquals(await scratchCount(db),0,"completed numerical input is cleared before a new window");
    const continuing=(await db.query<{ pending:boolean;lease_until:string|null;finished_at:string|null }>(
      "SELECT pending,lease_until,finished_at FROM private.energy_learning_jobs WHERE id=$1",[j.id])).rows[0];
    assertEquals(continuing,{pending:true,lease_until:null,finished_at:null});
    j=await claim(db);
    assert(j,"continuation is claimable without a planning request");
    assertEquals(j.room_history_to, historyTo, "band publication cannot slide the generation's observation horizon");
    assertEquals(j.room_fit_progress,null);
    const done=await db.query<{ ok:boolean }>("SELECT publish_energy_device_learning($1,$2,$3,2,$4::jsonb) AS ok",[
      j.id,j.generation,j.fence,JSON.stringify({home_id:home,customer_id:home,room_key:"room",heating_bands:{binding:"synthetic-binding",active:[],pending_windows:0,
        window_solar_pending:{"5":true},window_solar_retry_at:{"5":"2099-01-01T00:00:00Z"}}})]);
    assertEquals(done.rows[0].ok,true);
    assertEquals((await db.query("SELECT pending FROM private.energy_learning_jobs WHERE id=$1",[j.id])).rows,[{pending:false}]);
    assertEquals(await claim(db),null,"a drained traversal with a deferred solar retry must not restart itself");
  } finally { await db.close(); }
});

for (const invalidTimestamp of ["not-a-date", "2025-01-02T00:00:00+99:00", "2025-01-01T00:00:00 Foo/Bar"]) Deno.test(`room horizon rollout preserves staged work with malformed scratch ${invalidTimestamp}`, async () => {
  const db = await database(true, true, false);
  try {
    const j = await claim(db);
    const staged = { capture: { attemptedAt: "2025-01-02T00:00:00Z", window: { to_at: "2025-01-02T00:15:00Z" } } };
    assertEquals(await checkpoint(db, j, -1, 1, staged), true);
    const invalid = await claim(db, other);
    assertEquals(await checkpoint(db, invalid, -1, 1, { capture: { attemptedAt: invalidTimestamp, window: { to_at: "infinity" } } }), true);
    const before = (await db.query("SELECT generation,fence,input FROM private.energy_learning_jobs WHERE id=$1", [j.id])).rows;
    const scratch = (await db.query("SELECT * FROM private.energy_room_fit_progress WHERE job_id=$1", [j.id])).rows;
    await db.exec(await Deno.readTextFile("supabase/migrations/20261120004000_bound_room_learning_traversals.sql"));
    assertEquals((await db.query("SELECT generation,fence,input FROM private.energy_learning_jobs WHERE id=$1", [j.id])).rows, before);
    assertEquals((await db.query("SELECT * FROM private.energy_room_fit_progress WHERE job_id=$1", [j.id])).rows, scratch);
    const horizon = async () => (await db.query<{ at: string }>("SELECT room_history_to::text AS at FROM private.energy_learning_jobs WHERE id=$1", [j.id])).rows[0].at;
    assertEquals(Date.parse(await horizon()), Date.parse(staged.capture.window.to_at));
    assert((await db.query<{ finite: boolean }>("SELECT isfinite(room_history_to) AS finite FROM private.energy_learning_jobs WHERE id=$1",
      [invalid.id])).rows[0].finite, "unrecognizable disposable timestamps cannot break deployment");
    await db.query("UPDATE private.energy_learning_jobs SET room_history_to='2099-01-01',fence=fence+1,lease_until=NULL,wake_after=now() WHERE id=$1", [j.id]);
    assertEquals(Date.parse(await horizon()), Date.parse(staged.capture.window.to_at), "retry/claim clocks and direct assignments cannot move the ceiling");
    await db.query("UPDATE private.energy_learning_jobs SET generation=generation+1,input=$2::jsonb WHERE id=$1",
      [j.id, JSON.stringify({ synthetic_source_change: true })]);
    assert(Date.parse(await horizon()) > Date.parse(staged.capture.window.to_at));
    assertEquals((await db.query("SELECT room_history_to FROM private.energy_learning_jobs WHERE owner_kind='pool'")).rows, [{ room_history_to: null }]);
    assertEquals((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('authenticated','private.capture_room_learning_horizon()','EXECUTE') AS allowed")).rows[0].allowed, false);
  } finally { await db.close(); }
});

Deno.test("continuation cannot revive a removed owner or another source binding", async () => {
  const db = await database(false, false);
  try {
    await db.exec(`UPDATE energy_optimisation_zone_models SET heating_bands='{"binding":"retired-source","pending_windows":3}' WHERE home_id='${home}';
      UPDATE private.energy_learning_jobs SET pending=false,lease_until=NULL,finished_at=now() WHERE home_id='${home}' AND owner_kind='room';`);
    assertEquals((await db.query("SELECT pending FROM private.energy_learning_jobs WHERE home_id=$1 AND owner_kind='room'",[home])).rows,[{pending:false}]);
    await db.exec(`UPDATE energy_optimisation_zone_models SET heating_bands='{"binding":"synthetic-binding","pending_windows":3}' WHERE home_id='${home}';
      UPDATE private.energy_learning_jobs SET pending=true WHERE home_id='${home}' AND owner_kind='room';
      UPDATE private.energy_learning_jobs SET pending=false,last_error='Learning owner removed',finished_at=now() WHERE home_id='${home}' AND owner_kind='room';`);
    assertEquals((await db.query("SELECT pending FROM private.energy_learning_jobs WHERE home_id=$1 AND owner_kind='room'",[home])).rows,[{pending:false}]);
  } finally { await db.close(); }
});

Deno.test("band continuation waits for the held home lane, then release or expiry wakes it without a planning request", async () => {
  const db=await database();
  try {
    let j=await claim(db);
    await db.exec("TRUNCATE net.wakes");
    const published=await db.query<{ok:boolean}>("SELECT publish_energy_device_learning($1,$2,$3,1,$4::jsonb) AS ok",[
      j.id,j.generation,j.fence,JSON.stringify({home_id:home,customer_id:home,room_key:"room",
        heating_bands:{binding:"synthetic-binding",active:[],pending_windows:1}})]);
    assertEquals(published.rows[0].ok,true);
    assertEquals(await claim(db),null,"the completed invocation still owns home admission");
    assertEquals((await db.query("SELECT * FROM net.wakes")).rows,[],"publication cannot start a second room inside its own reservation");
    assertEquals(await release(db,j),true);
    assertEquals((await db.query<{n:number}>("SELECT count(*)::int AS n FROM net.wakes WHERE body->>'job_id'=$1",[j.id])).rows[0].n,1);
    j=await claim(db); assert(j);
    // A killed continuation cannot require a user click to resume either.
    await db.query("UPDATE private.energy_room_learning_lanes SET lease_until=now()-interval '1 second' WHERE job_id=$1",[j.id]);
    await db.query("UPDATE private.energy_learning_jobs SET lease_until=now()-interval '1 second',wake_after=now() WHERE id=$1",[j.id]);
    await db.exec("TRUNCATE net.wakes; SELECT private.sweep_energy_learning_jobs()");
    assertEquals((await db.query<{n:number}>("SELECT count(*)::int AS n FROM net.wakes WHERE body->>'job_id'=$1",[j.id])).rows[0].n,1);
    assert(await claim(db),"the sweeper recovers a terminated continuation");
  } finally { await db.close(); }
});
