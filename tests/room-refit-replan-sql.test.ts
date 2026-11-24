// Independent synthetic rooms and replans: no household observations are used.
import { assertEquals, assertRejects } from "@std/assert";
import type { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { chronologicalRoomDatabase } from "./helpers/chronological-room-sql.ts";
import { home, other } from "./helpers/room-fit-sql.ts";

const implementation = "chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1";
async function database() {
  const db = await chronologicalRoomDatabase();
  await db.exec(`CREATE TABLE public.energy_optimisation_current(home_id uuid PRIMARY KEY,replan_request_id uuid,
      replan_completed_request_id uuid,replan_error text,replan_requested_at timestamptz);
    CREATE TABLE private.energy_planning_jobs(id uuid DEFAULT gen_random_uuid(),home_id uuid,state text,context json);`);
  for (const file of ["20261123160000_measured_room_response", "20261123170000_state_carrying_room_forecasts",
    "20261124100000_separate_measured_run_flags", "20261124120000_refit_rooms_for_changed_learner"]) {
    await db.exec(await Deno.readTextFile(`supabase/migrations/${file}.sql`));
  }
  // An accepted, current-method fit made by an earlier learner, attempted just now.
  await db.query(`UPDATE energy_optimisation_zone_models SET last_attempted_at=now(),heating_bands=$2::jsonb WHERE home_id=$1`,
    [home, JSON.stringify({ binding: "synthetic-binding", calibration_policy: "measured_room_runs_v1", reference_revision: "accepted",
      shared_attempt: { implementation, learner_version: "room-learner:old", status: "fitted" } })]);
  await db.exec("UPDATE private.energy_learning_jobs SET pending=false,finished_at=now()");
  return db;
}
const owners = (version: string) => JSON.stringify([{ kind: "room", key: "room", input: { location: null, learner_version: version } }]);
const request = async (db: PGlite, version: string) => (await db.query<{ n: number }>(
  "SELECT request_energy_device_learning($1,$1,$2) AS n", [home, owners(version)])).rows[0].n;
const job = async (db: PGlite) => (await db.query<{ pending: boolean; input: { learner_version?: string } }>(
  "SELECT pending,input FROM private.energy_learning_jobs WHERE home_id=$1 AND owner_kind='room'", [home])).rows[0];
const finish = (db: PGlite) => db.exec("UPDATE private.energy_learning_jobs SET pending=false,finished_at=now()");
const progress = async (db: PGlite, owner = home) => (await db.query<{ p: { request_id?: string; stage: string; refitting_rooms: number } }>(
  "SELECT get_energy_replan_progress($1) AS p", [owner])).rows[0].p;
const held = async (db: PGlite) => (await db.query<{ h: boolean }>("SELECT energy_replan_held_for_refit($1) AS h", [home])).rows[0].h;
const replan = (db: PGlite, minutesAgo = 0) => db.query(`INSERT INTO energy_optimisation_current(home_id,replan_request_id,replan_requested_at)
  VALUES($1,'33333333-3333-4333-8333-333333333333',now()-make_interval(mins=>$2)) ON CONFLICT(home_id) DO UPDATE
  SET replan_request_id=EXCLUDED.replan_request_id,replan_requested_at=EXCLUDED.replan_requested_at,replan_completed_request_id=NULL,replan_error=NULL`,
  [home, minutesAgo]);

Deno.test("an upload refits a room whose fit was made by another learner, and only then", async () => {
  const db = await database(); try {
    assertEquals(await request(db, "room-learner:old"), 0, "the same learner waits for the ordinary cadence");
    assertEquals(await request(db, "room-learner:new"), 1);
    assertEquals((await job(db)).input.learner_version, "room-learner:new");
  } finally { await db.close(); }
});

Deno.test("a replan queues refits for rooms fitted by another learner, once", async () => {
  const db = await database(); try {
    const stale = async (version: string) => (await db.query<{ n: number }>(
      "SELECT request_energy_stale_room_refits($1,$2) AS n", [home, version])).rows[0].n;
    assertEquals(await stale("room-learner:old"), 0);
    assertEquals(await stale("room-learner:new"), 1);
    const queued = await job(db);
    assertEquals([queued.pending, queued.input.learner_version], [true, "room-learner:new"]);
    assertEquals(await stale("room-learner:new"), 0, "a refit already queued for this learner is not restarted");
    await assertRejects(() => db.query("SELECT request_energy_stale_room_refits($1,'')", [home]), Error, "learner version");
  } finally { await db.close(); }
});

Deno.test("a requested replan is held from the house while rooms refit, for at most twenty minutes", async () => {
  const db = await database(); try {
    assertEquals(await held(db), false, "no replan, nothing to hold");
    await replan(db);
    assertEquals(await held(db), false, "no refit, the house answers at once");
    assertEquals((await progress(db)).stage, "measuring");
    await request(db, "room-learner:new");
    assertEquals(await held(db), true);
    assertEquals(await progress(db), { request_id: "33333333-3333-4333-8333-333333333333", stage: "refitting", refitting_rooms: 1 });
    await db.exec("UPDATE private.energy_learning_jobs SET last_error='synthetic failure'");
    assertEquals(await held(db), false, "a failing refit never holds the replan");
    await db.exec("UPDATE private.energy_learning_jobs SET last_error=NULL");
    await replan(db, 21);
    assertEquals(await held(db), false, "the hold ends after twenty minutes");
    await replan(db);
    await finish(db);
    assertEquals(await held(db), false);
    await db.query(`INSERT INTO private.energy_planning_jobs(home_id,state,context)
      VALUES($1,'pending',json_build_object('replan_request_id','33333333-3333-4333-8333-333333333333'))`, [home]);
    assertEquals((await progress(db)).stage, "planning");
    await db.query("UPDATE energy_optimisation_current SET replan_completed_request_id=replan_request_id WHERE home_id=$1", [home]);
    assertEquals((await progress(db)).stage, "idle");
    await replan(db);
    await db.query("UPDATE energy_optimisation_current SET replan_error='synthetic' WHERE home_id=$1", [home]);
    assertEquals((await progress(db)).stage, "failed");
    await assertRejects(() => progress(db, other), Error, "access denied");
  } finally { await db.close(); }
});
