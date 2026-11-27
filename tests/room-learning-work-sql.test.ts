// The owners, immutable capture bytes and cursor are independently synthetic.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connectedDatabase } from "./helpers/connected-room-sql.ts";
import { home, other } from "./helpers/room-fit-sql.ts";
import { encodeRoomResponseFitCapture, decodeRoomResponseFitCapture } from "../supabase/functions/_shared/device-model-learning/room-band-fit-capture.ts";

const manifest = {
  protocol: 2, progress_version: 6, learner_version: "room-learner:0382f7765b9e279c",
  capture_revision: "response_native_peers_v1", semantic_digest: "a".repeat(64),
};
const worker = { ...manifest, runtime: "synthetic-v8" };
const implementation = "chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1";

async function setup() {
  const db = await connectedDatabase();
  for (const name of ["20261123160000_measured_room_response", "20261123170000_state_carrying_room_forecasts",
    "20261126151000_connected_room_publication", "20261126151100_connected_room_fit_progress",
    "20261126220000_room_learning_work"]) {
    await db.exec(await Deno.readTextFile(`supabase/migrations/${name}.sql`));
  }
  await db.query("UPDATE private.energy_learning_jobs SET input=jsonb_build_object('learner_version',$1::text),pending=true,wake_after=now(),lease_until=NULL", [manifest.learner_version]);
  return db;
}

Deno.test("compatible release preserves frozen owner and old physical lease, incompatible release fences once across stale callers", async () => {
  const db = await setup();
  const value = async (sql: string, ...args: unknown[]) => (await db.query<{ v: unknown }>(`SELECT ${sql} AS v`, args)).rows[0].v;
  try {
    const id = await value("(SELECT id FROM private.energy_learning_jobs WHERE home_id=$1)", home);
    const old = await value("claim_energy_device_learning($1)", id) as { generation: number; fence: number };
    assert(old);
    const binding = await value("get_energy_room_heating_context($1,'room')->>'binding'", home);
    await db.query(`INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,capture,adaptive_cursor,metadata)
      VALUES($1,$2,1,decode('0123ff','hex'),37,$3)`, [id, old.generation, JSON.stringify({ version: 6, runtime: worker.runtime,
      learner_version: manifest.learner_version, capture: { implementation, binding }, heat_state: { stage: "static", row: 31 } })]);
    const saved = () => value("(SELECT to_jsonb(j)||jsonb_build_object('progress',to_jsonb(p)) FROM private.energy_learning_jobs j JOIN private.energy_room_fit_progress p ON p.job_id=j.id WHERE j.id=$1)", id);
    const before = await saved();
    assertEquals(await value("prepare_energy_learning_release(1,$1)", manifest), true);
    assertEquals(await value("activate_energy_learning_release(1,$1)", { ...worker, semantic_digest: "b".repeat(64) }), false);
    assertEquals(await value("activate_energy_learning_release(1,$1)", worker), true);
    assertEquals(await saved(), before);
    assertEquals(await value("claim_energy_device_learning($1)", id), null);
    assertEquals(await value("(SELECT count(*)::integer FROM private.energy_learning_tickets WHERE home_id=$1)", home), 0);
    await db.query("SELECT private.resume_energy_room_fit($1)", [id]);
    assertEquals(await value("release_energy_room_learning_lane($1,$2,$3)", id, old.generation, old.fence), true);
    assertEquals(await value("claim_energy_learning_work($1,$2)", id, { ...worker, runtime: "other-v8" }), null);
    await db.query("UPDATE private.energy_learning_tickets SET queued_at=now()-interval '2 seconds' WHERE job_id=$1", [id]);
    const claim = await value("claim_energy_learning_work($1,$2)", id, worker) as { work_class: string; queue_ms: number; generation: number; fence: number; room_fit_progress: { cursor: number } };
    assertEquals(claim.work_class, "numerical");
    assert(Number.isInteger(claim.queue_ms) && claim.queue_ms >= 2000);
    assertEquals(claim.generation, old.generation);
    assertEquals(claim.room_fit_progress.cursor, 37);
    assertEquals(await value("claim_energy_learning_work($1,$2)", id, worker), null);
    assertEquals(await value("release_energy_learning_work($1,$2,$3)", id, claim.generation, old.fence), false);
    assertEquals(await value("prepare_energy_learning_release(2,$1)", manifest), true);
    assertEquals(await value("activate_energy_learning_release(2,$1)", worker), true);
    assertEquals(await value("(SELECT generation::integer FROM private.energy_learning_jobs WHERE id=$1)", id), old.generation);
    const newer = { ...manifest, semantic_digest: "c".repeat(64), learner_version: "room-learner:0123456789abcdef" };
    const newWorker = { ...newer, runtime: worker.runtime };
    assertEquals(await value("prepare_energy_learning_release(3,$1)", newer), true);
    assertEquals(await value("activate_energy_learning_release(3,$1)", newWorker), true);
    assertEquals(await value("activate_energy_learning_release(3,$1)", newWorker), true);
    assertEquals(await value("activate_energy_learning_release(2,$1)", worker), false);
    assertEquals(await value("prepare_energy_learning_release(2,$1)", manifest), false);
    assertEquals(await value("reset_energy_room_fit($1,$2,$3,1,37)", id, claim.generation, claim.fence), false);
    assertEquals(await value("claim_energy_learning_work($1,$2)", id, worker), null);
    assertEquals(await value("request_energy_stale_room_refits($1,$2)", home, manifest.learner_version), 0);
    await value("request_energy_device_learning($1,$1,$2)", home, [{ kind: "room", key: "room", input: { learner_version: manifest.learner_version } }]);
    assertEquals(await value("(SELECT generation::integer FROM private.energy_learning_jobs WHERE id=$1)", id), old.generation + 1);
    assertEquals(await value("(SELECT input->>'learner_version' FROM private.energy_learning_jobs WHERE id=$1)", id), newer.learner_version);
    assertEquals(await value("(SELECT count(*)::integer FROM private.energy_room_fit_progress WHERE job_id=$1)", id), 0);
    assertEquals(await value("release_energy_learning_work($1,$2,$3)", id, claim.generation, claim.fence), true);
    assertEquals(await value("release_energy_learning_work($1,$2,$3)", id, claim.generation, claim.fence), false);
    assertEquals(await value("has_function_privilege('service_role','public.activate_energy_learning_release(bigint,jsonb)','execute')"), true);
    assertEquals(await value("has_function_privilege('authenticated','public.activate_energy_learning_release(bigint,jsonb)','execute')"), false);
  } finally { await db.close(); }
});

Deno.test("project tickets bound queued and active owners and serialize heavy work per home", async () => {
  const db = await setup();
  try {
    await db.query("DELETE FROM private.energy_learning_jobs WHERE home_id=$1", [other]);
    const owners = ["room", "observed", "extra"];
    await db.query(`INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
      SELECT $1,$1,'room',key,jsonb_build_object('learner_version',$2::text) FROM unnest($3::text[]) key`,
      [home, manifest.learner_version, owners.slice(1)]);
    const tickets = async () => (await db.query<{ id: string; work_class: string; owner_key: string }>(
      "SELECT j.id,t.work_class,j.owner_key FROM private.energy_learning_tickets t JOIN private.energy_learning_jobs j ON j.id=t.job_id ORDER BY t.slot")).rows;
    await db.query("SELECT prepare_energy_learning_release(1,$1)", [manifest]);
    await db.query("SELECT activate_energy_learning_release(1,$1)", [worker]);
    assertEquals((await tickets()).length, 1);
    const source = (await tickets())[0];
    assertEquals(source.work_class, "source");
    await db.query("UPDATE private.energy_learning_tickets SET expires_at=now()-interval '1 second'");
    await db.query("SELECT private.refill_energy_learning_work()");
    assertEquals((await tickets()).length, 1);
    // Simulate two independently frozen owners and leave a third needing history.
    await db.query("DELETE FROM private.energy_learning_tickets");
    await db.query(`INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture)
       SELECT j.id,j.generation,coalesce(m.model_revision,0),jsonb_build_object('version',6,'capture',jsonb_build_object(
       'implementation',$2::text,'binding',c.binding)),decode('33','hex') FROM private.energy_learning_jobs j
       JOIN private.energy_room_heating_contexts($1) c ON c.room_key=j.owner_key
       LEFT JOIN energy_optimisation_zone_models m ON m.home_id=j.home_id AND m.room_key=j.owner_key WHERE j.home_id=$1`, [home, implementation]);
    await db.query("UPDATE private.energy_learning_jobs SET wake_after=now()+interval '10 minutes' WHERE owner_key='extra'");
    await db.query("UPDATE private.energy_learning_dispatch SET capacity=1");
    await db.query("SELECT private.refill_energy_learning_work()");
    assertEquals((await tickets()).length, 1);
    await db.query("UPDATE private.energy_learning_dispatch SET capacity=2");
    await db.query("SELECT private.refill_energy_learning_work()");
    const pair = await tickets();
    assertEquals(pair.map(t => t.work_class), ["numerical", "numerical"]);
    const wakes = async () => (await db.query("SELECT count(*) FROM net.wakes")).rows;
    const before = await wakes();
    await db.query("SELECT private.sweep_energy_learning_jobs()");
    assertEquals(await wakes(), before);
    const receipts: { fence: number; generation: number; ticket: number }[] = [];
    for (const t of pair) {
      const receipt = (await db.query<{ v: { fence: number; generation: number; ticket: number } }>(
        "SELECT claim_energy_learning_work($1,$2) AS v", [t.id, worker])).rows[0].v;
      assert(receipt);
      receipts.push(receipt);
    }
    const observer = (await db.query<{ bytes: string; cursor: number }>(`SELECT encode(p.capture,'hex') AS bytes,p.adaptive_cursor AS cursor
      FROM private.energy_room_fit_progress p JOIN private.energy_learning_jobs j ON j.id=p.job_id WHERE j.owner_key='observed'`)).rows[0];
    assertEquals(observer, { bytes: "33", cursor: 0 });
    assert(receipts[0].ticket !== receipts[1].ticket);
    await db.query("UPDATE private.energy_room_fit_progress SET metadata=jsonb_set(metadata,'{heat_state}','{\"stage\":\"complete\"}')");
    await db.query("UPDATE private.energy_learning_jobs SET lease_until=NULL,wake_after=now()");
    for (let i=0;i<pair.length;i++) await db.query("SELECT release_energy_learning_work($1,$2,$3)", [pair[i].id,receipts[i].generation,receipts[i].fence]);
    assertEquals((await tickets()).length, 1);
    assert(["source", "finalization"].includes((await tickets())[0].work_class));
  } finally { await db.close(); }
});

Deno.test("expired claims cannot release replacements and invalid numerical bindings yield to source admission", async () => {
  const db = await setup();
  try {
    await db.query("DELETE FROM private.energy_learning_jobs WHERE home_id=$1", [other]);
    const id = (await db.query<{ id: string }>("SELECT id FROM private.energy_learning_jobs")).rows[0].id;
    await db.query(`INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture)
      SELECT id,generation,1,$1,decode('fe','hex') FROM private.energy_learning_jobs`,
      [JSON.stringify({ version: 6, capture: { implementation, binding: "synthetic-superseded-binding" } })]);
    await db.query("SELECT prepare_energy_learning_release(1,$1)", [manifest]);
    await db.query("SELECT activate_energy_learning_release(1,$1)", [worker]);
    const claim = async () => (await db.query<{ v: { work_class: string; generation: number; fence: number } | null }>(
      "SELECT claim_energy_learning_work($1,$2) AS v", [id, worker])).rows[0].v;
    assertEquals(await claim(), null);
    const source = await claim();
    assert(source);
    assertEquals(source.work_class, "source");
    await db.query("UPDATE private.energy_learning_jobs SET lease_until=now()-interval '1 second',wake_after=now()");
    await db.query("UPDATE private.energy_learning_tickets SET expires_at=now()-interval '1 second'");
    await db.query("SELECT private.sweep_energy_learning_jobs()");
    const replacement = await claim();
    assert(replacement);
    assertEquals(replacement.generation, source.generation);
    assertEquals(replacement.fence, source.fence + 1);
    assertEquals((await db.query<{ v: boolean }>("SELECT release_energy_learning_work($1,$2,$3) AS v",
      [id, source.generation, source.fence])).rows[0].v, false);
    // Revocation fences publication immediately; the obsolete worker still
    // owns its physical slot until its finally releases that exact tuple.
    await db.query("UPDATE private.energy_learning_jobs SET generation=generation+1,fence=fence+1,lease_until=NULL,wake_after=now() WHERE id=$1", [id]);
    assertEquals((await db.query<{ v: boolean }>("SELECT release_energy_learning_work($1,$2,$3) AS v",
      [id, replacement.generation, replacement.fence])).rows[0].v, true);
    const nextGeneration = await claim();
    assert(nextGeneration);
    assertEquals(nextGeneration.generation, replacement.generation+1);
    for (const fence of [replacement.fence, nextGeneration.fence]) {
      assertEquals((await db.query<{ v: boolean }>("SELECT release_energy_learning_work($1,$2,$3) AS v",
        [id, replacement.generation, fence])).rows[0].v, false);
    }
    assertEquals((await db.query<{ fence: number }>("SELECT fence FROM private.energy_learning_tickets WHERE job_id=$1",
      [id])).rows[0].fence, nextGeneration.fence);
    const device = (await db.query<{ id: string }>(`INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
      VALUES($1,$1,'device','synthetic-meter','{}') RETURNING id`, [home])).rows[0].id;
    assertEquals((await db.query<{ v: string }>("SELECT claim_energy_device_learning($1)->>'owner_kind' AS v", [device])).rows[0].v, "device");
    await db.query("UPDATE private.energy_learning_jobs SET lease_until=NULL WHERE id=$1", [device]);
    assertEquals((await db.query<{ v: string }>("SELECT claim_energy_learning_work($1,$2)->>'work_class' AS v",
      [device, worker])).rows[0].v, "device");
  } finally { await db.close(); }
});

Deno.test("history admissions overlap across homes and with frozen numerical work in the same home", async () => {
  const db = await setup();
  try {
    await db.query("SELECT prepare_energy_learning_release(1,$1)", [manifest]);
    await db.query("SELECT activate_energy_learning_release(1,$1)", [worker]);
    const tickets = async () => (await db.query<{ home_id: string; work_class: string }>(
      "SELECT home_id,work_class FROM private.energy_learning_tickets ORDER BY home_id,work_class")).rows;
    assertEquals(await tickets(), [{ home_id: home, work_class: "source" }, { home_id: other, work_class: "source" }]);
    await db.query("DELETE FROM private.energy_learning_tickets");
    await db.query("UPDATE private.energy_learning_jobs SET wake_after=now()+interval '1 day' WHERE home_id=$1", [other]);
    await db.query(`INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input,room_last_started_at)
      VALUES($1,$1,'room','observed',jsonb_build_object('learner_version',$2::text),now())`, [home, manifest.learner_version]);
    await db.query(`INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture)
      SELECT j.id,j.generation,0,jsonb_build_object('version',6,'capture',jsonb_build_object('implementation',$2::text,
      'binding',c.binding)),decode('e8','hex') FROM private.energy_learning_jobs j JOIN private.energy_room_heating_contexts($1) c
      ON c.room_key=j.owner_key WHERE j.home_id=$1 AND j.owner_key='observed'`, [home, implementation]);
    await db.query("SELECT private.refill_energy_learning_work()");
    assertEquals(await tickets(), [{ home_id: home, work_class: "numerical" }, { home_id: home, work_class: "source" }]);
    // Both homes now have work. Give home B a more recent start than either
    // home A job so least-recent-owner alone would give both slots to A.
    await db.query("DELETE FROM private.energy_learning_tickets");
    await db.query("UPDATE private.energy_learning_jobs SET wake_after=now(),room_last_started_at=now() WHERE home_id=$1", [other]);
    await db.query("SELECT private.refill_energy_learning_work()");
    assertEquals(await tickets(), [{ home_id: home, work_class: "source" }, { home_id: other, work_class: "source" }]);
  } finally { await db.close(); }
});

Deno.test("only deployment service role can read the configured learning worker credential", async () => {
  const db = await setup();
  try {
    await db.exec(await Deno.readTextFile("supabase/migrations/20261126221000_learning_worker_capability_token.sql"));
    const roles = (await db.query<{ role: string; allowed: boolean }>(`SELECT role,
      has_function_privilege(role,'public.get_energy_learning_worker_token()','execute') AS allowed
      FROM (VALUES ('anon'),('authenticated'),('service_role')) AS roles(role) ORDER BY role`)).rows;
    assertEquals(roles, [{ role: "anon", allowed: false }, { role: "authenticated", allowed: false }, { role: "service_role", allowed: true }]);
    await db.exec("RESET ROLE; SET ROLE service_role");
    const verified = (await db.query<{ ok: boolean }>("SELECT public.verify_energy_learning_token(public.get_energy_learning_worker_token()) AS ok")).rows[0];
    assert(verified.ok);
    await db.exec("RESET ROLE; SET ROLE room_migration; UPDATE private.energy_learning_credentials SET function_url=NULL");
    await assertRejects(() => db.query("SELECT public.get_energy_learning_worker_token()"), Error, "query returned no rows");
  } finally { await db.close(); }
});

Deno.test("a live pre-upgrade fit resumes with one fenced replica and its native window and loads the accepted reference only for an unidentified result", async () => {
  const db = await setup();
  const value = async <T>(sql: string, ...args: unknown[]) => (await db.query<{ v: T }>(`SELECT ${sql} AS v`, args)).rows[0].v;
  const upgraded = { ...worker, protocol: 3 };
  type Lane = { index: number; row: number; blob: string; done: boolean };
  type Receipt = { fence: number; generation: number; work_class: string; room_fit_progress: {
    cursor: number; base_revision: number; capture_base64?: string;
    metadata?: { capture: { library: { reference?: unknown }; acceptedReference?: unknown }; heat_state: { stage: string } };
    process?: { kind: string; replica: Lane; replicas: Lane[]; priors: unknown; model: unknown;
      window: { base64: string; sha256: string; from_at: string; row_from: number; total_rows: number } };
  } };
  try {
    // This historical fixture projects only a subset of the production model columns.
    await db.exec("ALTER TABLE public.energy_optimisation_zone_models ADD COLUMN room_name text");
    await db.exec(await Deno.readTextFile("supabase/migrations/20261127100000_minimal_room_fit_work.sql"));
    await db.query("DELETE FROM private.energy_learning_jobs WHERE home_id=$1", [other]);
    const id = await value<string>("(SELECT id FROM private.energy_learning_jobs WHERE home_id=$1)", home);
    const binding = await value<string>("get_energy_room_heating_context($1,'room')->>'binding'", home);
    const prior = { model: { gain_c_per_wh: .002 }, synthetic_original_spelling: "preserve" };
    await db.query("UPDATE public.energy_optimisation_zone_models SET heating_bands=$2 WHERE home_id=$1",
      [home, { binding, reference: prior }]);
    const owner = await value<{ model: { model_revision: number; heating_bands: { reference: unknown } }; context: { binding: string } }>(
      "capture_energy_room_learning_context($1,'room')", home);
    const revision = owner.model.model_revision;
    assertEquals(owner.model.heating_bands.reference, prior);
    assertEquals(owner.context.binding, binding);
    assertEquals(await value("capture_energy_room_learning_context($1,'missing')", home), { model: null, context: null });
    const rows = Array.from({ length: 168 }, (_, i) => ({
      start_ms: i * 900_000, duration_s: 900 as const, heat_w: i === 20 ? null : 100,
      room_c: i === 167 ? null : 19 + i / 100, outdoor_c: 5, house_c: null, cooling: false, solar_w_per_m2: null,
      peer_c: { synthetic: i === 37 ? null : 21 + i / 70 },
    }));
    const from = new Date(0).toISOString();
    const bytes = await encodeRoomResponseFitCapture(rows, from);
    // Existing protocol 2 has no persisted row geometry. It also kept the
    // prior twice. The compatible handover must retain its forty earned turns.
    const envelope = { version: 6, runtime: worker.runtime, learner_version: worker.learner_version,
      row_count: rows.length, sha256: bytes.sha256, heat_state: { version: 1, stage: "adaptive" },
      capture: { implementation, binding, fromAt: from, acceptedReference: prior,
        library: { binding, reference: prior }, connected: { observedOnly: false, peerKeys: ["synthetic"] } } };
    await db.query(`INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,adaptive_cursor,metadata,capture)
      SELECT id,generation,$2,40,$3,decode($4,'base64') FROM private.energy_learning_jobs WHERE id=$1`, [id, revision, envelope, bytes.base64]);
    const claim = (w = upgraded) => value<Receipt | null>("claim_energy_learning_work($1,$2)", id, w);
    const release = (r: Receipt) => value("release_energy_learning_work($1,$2,$3)", id, r.generation, r.fence);
    assertEquals(await value("prepare_energy_learning_release(1,$1)", manifest), true);
    assertEquals(await value("activate_energy_learning_release(1,$1)", worker), true);
    const legacy = (await claim(worker))!;
    assertEquals(legacy.room_fit_progress.metadata!.capture.acceptedReference, prior);
    assertEquals(await value("prepare_energy_learning_release(2,$1)", { ...manifest, protocol: 3 }), true);
    assertEquals(await value("activate_energy_learning_release(2,$1)", upgraded), true);
    assertEquals(await claim(), null);
    const state = { version: 1, stage: "posterior" };
    assertEquals(await value("checkpoint_energy_room_adaptive_fit($1,$2,$3,$4,40,$5,$6)",
      id, legacy.generation, legacy.fence, revision, envelope.heat_state, state), true);
    assertEquals(await release(legacy), true);
    assertEquals(await claim(worker), null);
    let receipt = (await claim())!;
    assertEquals(receipt.generation, legacy.generation);
    assertEquals(receipt.room_fit_progress.cursor, 41);
    assertEquals(receipt.room_fit_progress.capture_base64, bytes.base64);
    assertEquals(receipt.room_fit_progress.metadata!.capture.library.reference, undefined);
    assertEquals(receipt.room_fit_progress.metadata!.capture.acceptedReference, undefined);
    const write = (r: Receipt, turn: unknown, cursor = r.room_fit_progress.cursor) =>
      value("checkpoint_energy_room_fit_turn($1,$2,$3,$4,$5,$6)", id, r.generation, r.fence, revision, cursor, turn);
    const advance = async (turn: unknown) => {
      assertEquals(await write(receipt, turn), true);
      // Lost replies and superseded leases cannot append a duplicate.
      assertEquals(await write(receipt, turn), false);
      assertEquals(await release(receipt), true);
      const next = (await claim())!;
      assertEquals(next.room_fit_progress.cursor, receipt.room_fit_progress.cursor + 1);
      receipt = next;
    };
    await advance({ kind: "optimizer", state: { version: 1, stage: "full" } });
    const lanes = [0, 1, 2, 3].map(index => ({ index, row: index === 3 ? 34 : rows.length,
      done: index !== 3, blob: btoa(`synthetic lane ${index}`) }));
    const shared = { result: { response: { family: "synthetic" } }, priors: { revision: "synthetic" }, numerical_failures: 1 };
    const invalidLanes = lanes.map(lane => lane.index === 3 ? { ...lane, row: rows.length, done: false } : lane);
    await assertRejects(() => write(receipt, { kind: "start_process", replicas: invalidLanes, shared }), Error, "Invalid initial room fit replica");
    assertEquals(await value("(SELECT count(*)::int FROM private.energy_room_fit_replicas WHERE job_id=$1)", id), 0);
    await advance({ kind: "start_process", replicas: lanes, shared });
    const siblings = () => value("(SELECT jsonb_agg(ctid::text ORDER BY replica) FROM private.energy_room_fit_replicas WHERE job_id=$1 AND replica<3)", id);
    const unchangedSiblings = await siblings();
    const shard = receipt.room_fit_progress.process!;
    assertEquals(Object.keys(receipt.room_fit_progress).sort(), ["base_revision", "cursor", "process"]);
    assertEquals(Object.keys(shard).sort(), ["kind", "model", "priors", "replica", "window"]);
    assertEquals(shard.replica, lanes[3]);
    assertEquals(shard.priors, shared.priors);
    assertEquals(shard.model, shared.result.response);
    assertEquals(shard.window.row_from, 34);
    assertEquals(shard.window.total_rows, rows.length);
    const decodeWindow = (w: typeof shard.window) => decodeRoomResponseFitCapture(w.base64, w.from_at, w.sha256);
    assertEquals(await decodeWindow(shard.window), rows.slice(34, 162));
    assertEquals(await write(receipt, { kind: "replica", replica: { ...lanes[3], index: 0 } }), false);
    assertEquals(await write(receipt, { kind: "replica", replica: { ...lanes[3], row: 33 } }), false);
    assertEquals(await write(receipt, { kind: "replica", replica: { ...lanes[3], row: 162 } }, 41), false);
    assertEquals(await write(receipt, { kind: "replica", replica: { ...lanes[3], row: 163 } }), false);
    const partial = { ...lanes[3], blob: btoa("synthetic mid-row carry") };
    await advance({ kind: "replica", replica: partial });
    assertEquals(receipt.room_fit_progress.process!.replica, partial);
    await advance({ kind: "replica", replica: { ...partial, row: 162 } });
    assertEquals(await decodeWindow(receipt.room_fit_progress.process!.window), rows.slice(162));
    await assertRejects(() => write(receipt, { kind: "replica", replica: { ...partial, row: rows.length, done: false } }),
      Error, "Invalid room fit replica progress");
    const completed = { ...partial, row: rows.length, done: true };
    await advance({ kind: "replica", replica: completed });
    assertEquals(await siblings(), unchangedSiblings);
    assertEquals(receipt.work_class, "finalization");
    assertEquals(receipt.room_fit_progress.process!.kind, "finish");
    assertEquals(receipt.room_fit_progress.process!.replicas, [...lanes.slice(0, 3), completed]);
    assertEquals(receipt.room_fit_progress.metadata!.capture.library.reference, undefined);
    assertEquals(receipt.room_fit_progress.metadata!.capture.acceptedReference, undefined);
    assertEquals(receipt.room_fit_progress.capture_base64, bytes.base64);
    assertEquals(await value("has_function_privilege('authenticated','public.checkpoint_energy_room_fit_turn(uuid,bigint,bigint,bigint,integer,jsonb)','execute')"), false);
    assertEquals(await value("has_function_privilege('anon','public.capture_energy_room_learning_context(uuid,text)','execute')"), false);
    assertEquals(await value("has_table_privilege('service_role','private.energy_room_fit_replicas','select')"), false);
    await db.query("UPDATE private.energy_learning_jobs SET pending=false WHERE id=$1", [id]);
    assertEquals(await value("(SELECT count(*)::int FROM private.energy_room_fit_replicas WHERE job_id=$1)", id), 0);

    // A fresh unidentified fit keeps the exact accepted JSON, including fields
    // a normalized model reader need not retain. This final turn alone needs it.
    await release(receipt);
    await db.query("UPDATE private.energy_learning_jobs SET pending=true,lease_until=NULL,wake_after=now() WHERE id=$1", [id]);
    const initial = { ...envelope, heat_state: state, has_accepted_reference: true,
      capture: { implementation, binding, fromAt: from, library: { binding }, connected: envelope.capture.connected } };
    await db.query(`INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,adaptive_cursor,metadata,capture)
      SELECT id,generation,$2,0,$3,decode($4,'base64') FROM private.energy_learning_jobs WHERE id=$1`, [id, revision, initial, bytes.base64]);
    await db.query("SELECT private.refill_energy_learning_work()");
    receipt = (await claim())!;
    await advance({ kind: "result", result: { response: null, model: null, issues: ["synthetic"], learning: {} } });
    assertEquals(receipt.room_fit_progress.process!.kind, "result");
    assertEquals(receipt.room_fit_progress.metadata!.capture.library.reference, prior);
    assertEquals(receipt.room_fit_progress.metadata!.capture.acceptedReference, undefined);
  } finally { await db.close(); }
});
