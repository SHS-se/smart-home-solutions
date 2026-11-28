// All owners, captures and opaque packets below are independently synthetic.
import { assert, assertEquals } from "@std/assert";
import { learningDispatchFixture } from "./helpers/learning-dispatch-sql.ts";
import { home } from "./helpers/room-fit-sql.ts";
import { encodeRoomResponseFitCapture } from "../supabase/functions/_shared/device-model-learning/room-band-fit-capture.ts";

type Fixture = Awaited<ReturnType<typeof learningDispatchFixture>>;
type Claim = NonNullable<Awaited<ReturnType<Fixture["claim"]>>>;
async function replicas(protocol = 5, keepOther = false) {
  const f = await learningDispatchFixture(protocol);
  await f.db.query("DELETE FROM private.energy_learning_tickets");
  if (!keepOther) await f.db.query("DELETE FROM private.energy_learning_jobs WHERE owner_key<>'room'");
  const id = await f.value<string>("(SELECT id FROM private.energy_learning_jobs WHERE home_id=$1 AND owner_key='room')", home);
  const from = "2026-01-01T00:00:00.000Z";
  const capture = await encodeRoomResponseFitCapture([0, 1].map(i => ({ start_ms: Date.parse(from) + i * 900_000,
    room_c: 20, outdoor_c: 3, house_c: 19, solar_w_per_m2: 0, heat_w: null, cooling: null })), from);
  await f.db.query(`UPDATE private.energy_room_fit_progress SET capture=decode($2,'base64'),metadata=metadata||$3::jsonb,
    adaptive_product='{"kind":"start_process","shared":{"result":{"response":{}},"priors":{}}}' WHERE job_id=$1`,
    [id, capture.base64, JSON.stringify({ header_bytes: capture.header_bytes, row_bytes: capture.row_bytes, row_count: 2,
      sha256: capture.sha256, heat_state: { stage: "process_posterior" } })]);
  await f.db.query(`INSERT INTO private.energy_room_fit_replicas(job_id,replica,row_cursor,done,checkpoint)
    SELECT $1,n,0,false,decode('0102','hex') FROM generate_series(0,3) n`, [id]);
  await f.db.query("SELECT private.refill_energy_learning_work()");
  assert(await f.claimRun());
  const deliveries = await f.take();
  const claims = await Promise.all(deliveries.map(d => f.claim(d)));
  assert(claims.every(c => c !== null));
  const checkpoint = (c: Claim, row = 0, blob = "AwQ=") => {
    assert(c.replica_delivery); const d = c.replica_delivery;
    return f.value<boolean>("checkpoint_energy_room_fit_replica($1,$2,$3,$4,$5,$6,$7,$8)", id, c.generation, c.fence,
      d.revision, d.delivery_id, d.process_epoch, d.sequence,
      { kind: "replica", replica: { index: c.room_fit_progress.process!.replica.index, row, done: row === 2, blob } });
  };
  const release = (c: Claim) => f.value<boolean>("release_energy_learning_delivery($1,$2,$3,$4)", id, c.generation, c.fence, c.delivery_id);
  return { ...f, id, deliveries, claims: claims as Claim[], checkpoint, release };
}

Deno.test("two replica deliveries share no job lease, preserve same-row carries and reject stale replies", async () => {
  const f = await replicas();
  try {
    assertEquals(f.claims.length, 2);
    assertEquals(f.claims.map(c => c.room_fit_progress.process!.replica.index), [0, 1]);
    assertEquals(f.claims[0].fence, f.claims[1].fence);
    assertEquals(await f.value("(SELECT lease_until FROM private.energy_learning_jobs WHERE id=$1)", f.id), null);
    assertEquals(await f.value("claim_energy_learning_work($1,$2)", f.id, f.worker), null);
    assertEquals(await f.claim(f.deliveries[0]), null);
    assertEquals(await f.take(), []);
    assert(await f.checkpoint(f.claims[1]));
    assert(await f.checkpoint(f.claims[0]));
    assertEquals(await f.checkpoint(f.claims[0], 0, "BQY="), false);
    assertEquals(await f.value("(SELECT adaptive_cursor FROM private.energy_room_fit_progress WHERE job_id=$1)", f.id), 17);
    assertEquals(await f.value("(SELECT array_agg(sequence::integer ORDER BY replica) FROM private.energy_room_fit_replicas WHERE job_id=$1)", f.id), [1, 1, 0, 0]);
    assertEquals(await f.value("release_energy_learning_work($1,$2,$3)", f.id, f.claims[0].generation, f.claims[0].fence), false);
    assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_learning_tickets)"), 2);
    const d = f.claims[0].replica_delivery!;
    assertEquals(await f.value("fail_energy_room_fit_replica($1,$2,$3,$4,$5,$6,$7,'lost checkpoint reply')", f.id,
      f.claims[0].generation, f.claims[0].fence, d.revision, d.delivery_id, d.process_epoch, d.sequence), false);
    assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_room_fit_replicas WHERE last_error IS NOT NULL)"), 0);
  } finally { await f.db.close(); }
});

Deno.test("terminal recovery and late finally affect only the exact replica delivery", async () => {
  const f = await replicas();
  try {
    const [a, b] = f.claims;
    assertEquals(await f.value("recover_terminated_energy_learning_work($1,$2,546)", await f.run(), a.delivery_id), true);
    assertEquals(await f.release(a), false);
    assertEquals(await f.checkpoint(a), false);
    assert(await f.checkpoint(b));
    const next = await f.take(); assertEquals(next.length, 1);
    const c = await f.claim(next[0]); assert(c);
    assertEquals(c.fence, b.fence);
    assert(c.delivery_id !== a.delivery_id);
    assertEquals(await f.release(a), false);
    assert(await f.checkpoint(c));
    assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_learning_tickets)"), 2);
  } finally { await f.db.close(); }
});

Deno.test("replica failure backs off one stream and an expired delivery cannot write or fail", async () => {
  const f = await replicas();
  try {
    const [a, b] = f.claims, d = a.replica_delivery!;
    assertEquals(await f.value("fail_energy_room_fit_replica($1,$2,$3,$4,$5,$6,$7,'synthetic outage')", f.id,
      a.generation, a.fence, d.revision, d.delivery_id, d.process_epoch, d.sequence), true);
    assert(await f.checkpoint(b));
    assertEquals(await f.value("(SELECT last_error FROM private.energy_learning_jobs WHERE id=$1)", f.id), "synthetic outage");
    assert(await f.release(a));
    const next = await f.take(); assertEquals(next.length, 1);
    const c = await f.claim(next[0]); assert(c); assertEquals(c.room_fit_progress.process!.replica.index, 2);
    await f.db.query("UPDATE private.energy_learning_tickets SET expires_at=now()-interval '1 second' WHERE delivery_id=$1", [c.delivery_id]);
    assertEquals(await f.checkpoint(c), false);
    const e = c.replica_delivery!;
    assertEquals(await f.value("fail_energy_room_fit_replica($1,$2,$3,$4,$5,$6,$7,'expired')", f.id,
      c.generation, c.fence, e.revision, e.delivery_id, e.process_epoch, e.sequence), false);
    assertEquals(await f.value("(SELECT last_error FROM private.energy_room_fit_replicas WHERE job_id=$1 AND replica=0)", f.id), "synthetic outage");
  } finally { await f.db.close(); }
});

Deno.test("the final replica barrier advances once and publication waits for both physical releases", async () => {
  const f = await replicas();
  try {
    // The other two streams have independently finished previously.
    await f.db.query("UPDATE private.energy_room_fit_replicas SET row_cursor=2,done=true WHERE job_id=$1 AND replica IN (2,3)", [f.id]);
    assert(await f.checkpoint(f.claims[0], 2));
    assertEquals(await f.value("(SELECT metadata#>>'{heat_state,stage}' FROM private.energy_room_fit_progress WHERE job_id=$1)", f.id), "process_posterior");
    assert(await f.checkpoint(f.claims[1], 2));
    assertEquals(await f.value("(SELECT adaptive_cursor FROM private.energy_room_fit_progress WHERE job_id=$1)", f.id), 18);
    assertEquals(await f.checkpoint(f.claims[1], 2), false);
    assertEquals(await f.take(), []);
    assert(await f.release(f.claims[0])); assertEquals(await f.take(), []);
    assert(await f.release(f.claims[1]));
    const final = await f.take(); assertEquals(final.length, 1);
    const owner = await f.claim(final[0]); assert(owner);
    assertEquals(owner.replica_delivery, undefined);
    assertEquals(owner.room_fit_progress.cursor, 18);
    assert(owner.fence > f.claims[0].fence);
    assertEquals(await f.release(f.claims[1]), false);
    assertEquals(await f.value("(SELECT work_class FROM private.energy_learning_tickets WHERE job_id=$1)", f.id), "finalization");
  } finally { await f.db.close(); }
});

Deno.test("distinct eligible rooms get capacity before a second replica and generation changes retain physical reservations", async () => {
  const f = await replicas(5, true);
  try {
    assertEquals(new Set(f.deliveries.map(d => d.job_id)).size, 2);
    const a = f.claims.find(c => c.replica_delivery)!; assert(a);
    await f.db.query("UPDATE private.energy_learning_jobs SET generation=generation+1,fence=fence+1 WHERE id=$1", [f.id]);
    assertEquals(await f.checkpoint(a), false);
    assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_learning_tickets WHERE job_id=$1)", f.id), 1);
    assert(await f.release(a));
    assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_learning_tickets)"), 2);
  } finally { await f.db.close(); }
});

Deno.test("compatible protocol4 handoff drains its physical owner and retains every earned replica byte", async () => {
  const f = await replicas(4);
  try {
    const old = f.claims[0]; assertEquals(f.claims.length, 1);
    const worker = { ...f.worker, protocol: 5 }, manifest = { ...f.manifest, protocol: 5 };
    assertEquals(await f.value("prepare_energy_learning_release(2,$1)", manifest), true);
    assertEquals(await f.value("activate_energy_learning_release(2,$1)", worker), true);
    const checkpoint = { kind: "replica", replica: { index: 0, row: 1, done: false, blob: "BQY=" } };
    assertEquals(await f.value("checkpoint_energy_room_fit_turn($1,$2,$3,$4,17,$5)", f.id, old.generation, old.fence, old.room_fit_progress.base_revision, checkpoint), true);
    assertEquals(await f.take(), []);
    assertEquals(await f.value("release_energy_learning_work($1,$2,$3)", f.id, old.generation, old.fence), true);
    const next = await f.take(); assertEquals(next.length, 2);
    const c = await f.value<Claim>("claim_energy_learning_request($1,$2,$3,$4)", f.id, worker, f.token, next[0].delivery_id);
    assert(c.replica_delivery); assertEquals(c.generation, old.generation);
    assertEquals(c.room_fit_progress.process!.replica.row, 1);
    assertEquals(await f.value("(SELECT encode(checkpoint,'hex') FROM private.energy_room_fit_replicas WHERE job_id=$1 AND replica=0)", f.id), "0506");
    assertEquals(await f.value("checkpoint_energy_room_fit_turn($1,$2,$3,$4,18,$5)", f.id, old.generation, old.fence, old.room_fit_progress.base_revision, checkpoint), false);
    await f.value("fail_energy_device_learning($1,$2,$3,'late legacy failure')", f.id, old.generation, old.fence);
    assertEquals(await f.value("(SELECT last_error FROM private.energy_learning_jobs WHERE id=$1)", f.id), null);
    assertEquals(await f.value("prepare_energy_learning_release(3,$1)", f.manifest), true);
    assertEquals(await f.value("activate_energy_learning_release(3,$1)", f.worker), false);
  } finally { await f.db.close(); }
});

Deno.test("changed model revision and corrupted derived state revoke replica writes without dropping physical reservations", async () => {
  for (const corruption of [false, true]) {
    const f = await replicas();
    try {
      const [a, b] = f.claims, d = a.replica_delivery!;
      if (corruption) {
        assertEquals(await f.value("reset_energy_room_fit_replica($1,$2,$3,$4,$5,$6,$7)", f.id,
          a.generation, a.fence, d.revision, d.delivery_id, d.process_epoch, d.sequence), true);
        assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_room_fit_progress WHERE job_id=$1)", f.id), 0);
      } else {
        await f.db.query("UPDATE public.energy_optimisation_zone_models SET model_revision=model_revision+1 WHERE home_id=$1 AND room_key='room'", [home]);
      }
      assertEquals(await f.checkpoint(a), false);
      assertEquals(await f.checkpoint(b), false);
      assertEquals(await f.value("(SELECT count(*)::integer FROM private.energy_learning_tickets)"), 2);
      assert(await f.release(a)); assert(await f.release(b));
      assertEquals(await f.value("has_function_privilege('authenticated','public.checkpoint_energy_room_fit_replica(uuid,bigint,bigint,bigint,uuid,uuid,bigint,jsonb)','execute')"), false);
      assertEquals(await f.value("has_function_privilege('service_role','private.owns_energy_room_fit_replica(uuid,bigint,bigint,bigint,uuid,uuid,bigint)','execute')"), false);
    } finally { await f.db.close(); }
  }
});
