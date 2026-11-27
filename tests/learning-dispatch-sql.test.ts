// Independently synthetic owners, bytes and delivery responses; no household data.
import { assert, assertEquals } from "@std/assert";
import { connectedDatabase } from "./helpers/connected-room-sql.ts";
import { home, other } from "./helpers/room-fit-sql.ts";
import { roomLearningWorkerCapabilities } from "../supabase/functions/_shared/room-learning-worker-capabilities.ts";

async function fixture(protocol = 4) {
  const db = await connectedDatabase();
  await db.exec(`RESET ROLE; ALTER TABLE public.energy_optimisation_zone_models ADD COLUMN room_name text;
    CREATE TABLE net._http_response(id bigint PRIMARY KEY,status_code integer,content text,timed_out boolean,error_msg text,created timestamptz DEFAULT now());
    CREATE SEQUENCE net.synthetic_request;
    ALTER TABLE net.wakes ADD COLUMN id bigint DEFAULT nextval('net.synthetic_request');
    CREATE OR REPLACE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)
      RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.wakes(body) VALUES($3) RETURNING id $$;`);
  for (const migration of ["20261123160000_measured_room_response", "20261123170000_state_carrying_room_forecasts",
    "20261126151000_connected_room_publication", "20261126151100_connected_room_fit_progress", "20261126220000_room_learning_work",
    "20261127100000_minimal_room_fit_work", "20261127223000_bound_room_learning_dispatch"]) {
    await db.exec(await Deno.readTextFile(`supabase/migrations/${migration}.sql`));
  }
  const { runtime: _runtime, ...manifest } = { ...roomLearningWorkerCapabilities(), protocol };
  const worker = { ...manifest, runtime: "synthetic-runtime" };
  await db.query("DELETE FROM private.energy_learning_jobs WHERE home_id=$1", [other]);
  await db.query(`UPDATE private.energy_learning_jobs SET input=jsonb_build_object('learner_version',$1::text),pending=true,
    wake_after=now(),lease_until=NULL`, [worker.learner_version]);
  await db.query(`INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
    VALUES($1,$1,'room','observed',jsonb_build_object('learner_version',$2::text))`, [home, worker.learner_version]);
  await db.query(`INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture,adaptive_cursor)
    SELECT j.id,j.generation,coalesce(m.model_revision,0),jsonb_build_object('version',6,'runtime',$2::text,
      'learner_version',$3::text,'has_accepted_reference',false,'row_count',1,
      'capture',jsonb_build_object('implementation',$4::text,'binding',c.binding,'connected',jsonb_build_object('observedOnly',true)),
      'heat_state',jsonb_build_object('version',1,'stage','static')),decode('010203','hex'),17
    FROM private.energy_learning_jobs j JOIN private.energy_room_heating_contexts($1) c ON c.room_key=j.owner_key
    LEFT JOIN public.energy_optimisation_zone_models m ON m.home_id=j.home_id AND m.room_key=j.owner_key`,
    [home, worker.runtime, worker.learner_version,
      "chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1"]);
  const value = async <T>(sql: string, ...args: unknown[]) => (await db.query<{ v: T }>(`SELECT ${sql} AS v`, args)).rows[0].v;
  const token = await value<string>("(SELECT token FROM private.energy_learning_credentials)");
  await value("prepare_energy_learning_release(1,$1)", manifest);
  await value("activate_energy_learning_release(1,$1)", worker);
  type Delivery = { job_id: string; delivery_id: string };
  const run = () => value<number>("(SELECT run_fence FROM private.energy_learning_dispatch)");
  const claimRun = async () => value("claim_energy_learning_dispatch($1,$2,$3)", await run(), worker, token);
  const take = async () => value<Delivery[]>("take_energy_learning_dispatch_work($1,2)", await run());
  const claim = (d: Delivery) => value<{ generation: number; fence: number; room_fit_progress: { cursor: number } } | null>(
    "claim_energy_learning_request($1,$2,$3,$4)", d.job_id, worker, token, d.delivery_id);
  return { db, value, token, worker, manifest, run, claimRun, take, claim };
}

Deno.test("one dispatcher wake carries two fair deliveries and duplicate or unauthorized wakes never claim", async () => {
  const f = await fixture();
  try {
    assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_learning_tickets)"), 2);
    assertEquals(await f.value("(SELECT count(*)::integer FROM net.wakes WHERE body ? 'run_fence')"), 1);
    assertEquals(await f.value("claim_energy_learning_dispatch($1,$2,'invalid')", await f.run(), f.worker), false);
    assert(await f.claimRun());
    assertEquals(await f.claimRun(), null);
    const group = await f.take();
    assertEquals(group.length, 2);
    assertEquals(await f.take(), []);
    assertEquals(await f.value("claim_energy_learning_request($1,$2,'invalid',$3)", group[0].job_id, f.worker, group[0].delivery_id), false);
    const owner = await f.claim(group[0]); assert(owner);
    assertEquals(owner.room_fit_progress.cursor, 17);
    assertEquals(await f.claim(group[0]), null);
    assertEquals(await f.value("(SELECT count(*)::integer FROM net.wakes)"), 1);
  } finally { await f.db.close(); }
});

Deno.test("terminal child 546 recovers saved progress immediately and fences late delivery and finally", async () => {
  const f = await fixture();
  try {
    await f.claimRun(); const [delivery] = await f.take(); const owner = await f.claim(delivery); assert(owner);
    await f.db.query("UPDATE private.energy_room_fit_progress SET adaptive_cursor=18 WHERE job_id=$1", [delivery.job_id]);
    await f.db.query("SELECT private.resume_energy_room_fit($1)", [delivery.job_id]);
    assertEquals(await f.value("recover_terminated_energy_learning_work($1,$2,504)", await f.run(), delivery.delivery_id), false);
    assertEquals(await f.value("recover_terminated_energy_learning_work($1,$2,546)", await f.run(), delivery.delivery_id), true);
    assertEquals(await f.value("recover_terminated_energy_learning_work($1,$2,546)", await f.run(), delivery.delivery_id), false);
    assertEquals(await f.value("(SELECT adaptive_cursor FROM private.energy_room_fit_progress WHERE job_id=$1)", delivery.job_id), 18);
    assertEquals(await f.claim(delivery), null);
    assertEquals(await f.value("release_energy_learning_work($1,$2,$3)", delivery.job_id, owner.generation, owner.fence), false);
    assertEquals(await f.value("private.owns_energy_room_fit($1,$2,$3,1)", delivery.job_id, owner.generation, owner.fence), false);
  } finally { await f.db.close(); }
});

Deno.test("expired root retains assigned children; old root cannot take or finish its replacement", async () => {
  const f = await fixture();
  try {
    await f.claimRun(); const [delivery] = await f.take(); const owner = await f.claim(delivery); assert(owner);
    const oldRun = await f.run();
    await f.db.query("UPDATE private.energy_learning_dispatch SET run_until=now()-interval '1 second'");
    await f.db.query("SELECT private.refill_energy_learning_work()");
    assertEquals(await f.value("(SELECT fence FROM private.energy_learning_tickets WHERE delivery_id=$1)", delivery.delivery_id), owner.fence);
    assertEquals(await f.take(), null);
    // Release a queued, known-unsent sibling so a replacement root has work.
    await f.db.query("UPDATE private.energy_learning_tickets SET dispatch_fence=NULL WHERE fence IS NULL");
    await f.db.query("SELECT private.refill_energy_learning_work()");
    assert((await f.run()) > oldRun);
    assertEquals(await f.value("finish_energy_learning_dispatch($1)", oldRun), false);
    assertEquals(await f.value("claim_energy_learning_dispatch($1,$2,$3)", oldRun, f.worker, f.token), null);
    assert(await f.claimRun());
    assertEquals((await f.take()).length, 1);
  } finally { await f.db.close(); }
});

Deno.test("known unsent deliveries can be returned; publication followed by a kill is never reopened", async () => {
  const f = await fixture();
  try {
    await f.claimRun(); const group = await f.take();
    await f.value("return_unsent_energy_learning_work($1,$2)", await f.run(), group.map(d => d.delivery_id));
    assertEquals(await f.take(), group);
    const owner = await f.claim(group[0]); assert(owner);
    await f.db.query("UPDATE private.energy_learning_jobs SET pending=false,lease_until=NULL,finished_at=now() WHERE id=$1", [group[0].job_id]);
    assertEquals(await f.value("recover_terminated_energy_learning_work($1,$2,546)", await f.run(), group[0].delivery_id), true);
    assertEquals(await f.value("(SELECT pending FROM private.energy_learning_jobs WHERE id=$1)", group[0].job_id), false);
  } finally { await f.db.close(); }
});

Deno.test("legacy pg_net terminal responses recover by immutable request ID; ambiguous timeout keeps reservation", async () => {
  const f = await fixture(3);
  try {
    const ticket = (await f.db.query<{ delivery_id: string; request_id: number }>("SELECT delivery_id,request_id FROM private.energy_learning_tickets LIMIT 1")).rows[0];
    assert(ticket.request_id > 0);
    await f.db.query("INSERT INTO net._http_response(id,timed_out) VALUES($1,true)", [ticket.request_id]);
    await f.db.query("SELECT private.refill_energy_learning_work()");
    assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_learning_tickets WHERE delivery_id=$1)", ticket.delivery_id), 1);
    await f.db.query("UPDATE net._http_response SET status_code=546,timed_out=false WHERE id=$1", [ticket.request_id]);
    await f.db.query("SELECT private.refill_energy_learning_work()");
    assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_learning_tickets WHERE delivery_id=$1)", ticket.delivery_id), 0);
  } finally { await f.db.close(); }
});

Deno.test("a completed queued root response requeues promptly without revoking assigned children", async () => {
  const f = await fixture();
  try {
    const oldRun = await f.run();
    await f.db.query(`INSERT INTO net._http_response(id,status_code,timed_out)
      SELECT run_request_id,200,false FROM private.energy_learning_dispatch`);
    await f.db.query("SELECT private.refill_energy_learning_work()");
    assert((await f.run()) > oldRun);
    assert(await f.claimRun());
    assertEquals((await f.take()).length, 2);
  } finally { await f.db.close(); }
});
Deno.test("durable terminal delivery observations survive until the observer can recover them", async () => {
  const f = await fixture();
  try {
    await f.claimRun(); const [d] = await f.take(); const owner = await f.claim(d); assert(owner);
    await f.db.query("UPDATE private.energy_learning_tickets SET terminal_status=546 WHERE delivery_id=$1", [d.delivery_id]);
    await f.db.query("SELECT private.refill_energy_learning_work()");
    assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_learning_tickets WHERE delivery_id=$1)", d.delivery_id), 0);
    assertEquals(await f.value("(SELECT adaptive_cursor FROM private.energy_room_fit_progress WHERE job_id=$1)", d.job_id), 17);
  } finally { await f.db.close(); }
});
