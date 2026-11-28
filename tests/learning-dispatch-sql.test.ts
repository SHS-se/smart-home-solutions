// Independently synthetic owners, bytes and delivery responses; no household data.
import { assert, assertEquals } from "@std/assert";
import { learningDispatchFixture as fixture } from "./helpers/learning-dispatch-sql.ts";


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
    const primary = await f.value<string>("(SELECT function_url FROM private.energy_learning_credentials)");
    assertEquals(group.map(d => d.worker_url), [primary, primary + "-peer"]);
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
