import { captureRulesPlanningInput } from "../supabase/functions/_shared/rules-planning-capture.ts";
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { dispatchedEvSnapshot, rulesFixtureInput } from '../scripts/generate-ha-plan-fixture.ts';
import { generateRulesPlan, prepareRulesPlanningInput, type PublishedCommandReference } from '../supabase/functions/_shared/rules-planner.ts';
import { resolveRulePolicy } from '../supabase/functions/_shared/planner-wasm/rule-policy.ts';

const home = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const snapshot = '33333333-3333-4333-8333-333333333333';
const manual = '44444444-4444-4444-8444-444444444444';
const nextManual = '55555555-5555-4555-8555-555555555555';
const plan = '66666666-6666-4666-8666-666666666666';
const migration = (name: string) => Deno.readTextFile(`supabase/migrations/${name}.sql`);
type Receipt = { job_id: string; state: string; pending: boolean; source_hash: string;
  snapshot_id: string; plan_id?: string; plan?: unknown; detail?: string; code?: string; exchange?: unknown };
type Claim = { id: string; fence: number; step: number; phase: string;
  input: { devices: Record<string, number> }; context: { exchange?: unknown }; continuation: unknown;
  deadline_at: string };

async function database(restore = true) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE homes(id uuid PRIMARY KEY); CREATE TABLE customers(id uuid PRIMARY KEY);
    CREATE FUNCTION energy_home_matches_customer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1=$2 $$;
    INSERT INTO homes VALUES('${home}'),('${other}'); INSERT INTO customers VALUES('${home}'),('${other}');
    CREATE SCHEMA extensions;
    CREATE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(repeat('ab',$1),'hex') $$;
    CREATE SCHEMA net;
    CREATE TABLE net.wakes(id bigint GENERATED ALWAYS AS IDENTITY, url text, headers jsonb, body jsonb, timeout_milliseconds integer);
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE plpgsql AS $$
      DECLARE n bigint; BEGIN INSERT INTO net.wakes(url,headers,body,timeout_milliseconds)
        VALUES($1,$2,$3,$4) RETURNING id INTO n; RETURN n; END; $$;
    CREATE SCHEMA cron;
    CREATE TABLE cron.schedules(name text, schedule text, command text);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$
      INSERT INTO cron.schedules VALUES($1,$2,$3); SELECT 1; $$;
  `);
  const initial = await migration('20260810120000_add_quarter_hour_energy_optimisation');
  for (const name of ['energy_optimisation_current', 'energy_optimisation_plan_runs']) {
    const start = initial.indexOf(`CREATE TABLE public.${name} (`);
    await db.exec(initial.slice(start, initial.indexOf('\n);', start) + 3));
  }
  await db.exec(await migration('20260820160000_add_energy_plan_acknowledgements'));
  await db.exec(await migration('20260907120000_queue_energy_replans'));
  await db.exec(await migration('20260909120100_fixed_energy_plans'));
  await db.exec(`ALTER TABLE energy_optimisation_current ADD COLUMN ha_runtime jsonb, ADD COLUMN battery_projection jsonb;`);
  const recommendations = await migration('20260923103000_replan_recommendations');
  await db.exec(recommendations.slice(0, recommendations.indexOf('CREATE FUNCTION public.energy_value_change_recommendation')));
  await db.exec(await migration('20260924121500_store_energy_plan_jsonb'));
  await db.exec(await migration('20260924160000_streamline_energy_plan_storage'));
  // PGlite has no lz4 codec. All schema/RPC/cron statements execute unchanged;
  // the same storage-only exclusion exists in energy-plan-storage.test.ts.
  const jobsMigration = await migration('20261006120000_durable_energy_planning_jobs');
  await db.exec(jobsMigration.replace(/^ALTER TABLE private\.energy_planning_(jobs|parts) ALTER COLUMN \w+ SET COMPRESSION lz4;$/gm, ''));
  await db.exec(await migration('20261006150000_lease_safe_energy_planning_claims'));
  if (restore) {
    await db.exec(await migration('20261006170000_restore_two_function_energy_planning'));
    await db.exec(await migration('20261006190000_use_planning_request_deadline_message'));
  }
  else await db.exec("UPDATE private.energy_planning_credentials SET function_url='https://example.supabase.co/functions/v1/energy-optimisation-planning-worker'");
  return db;
}

async function rpc<T>(db: PGlite, name: string, value: unknown): Promise<T> {
  return (await db.query<{ value: T }>(`SELECT ${name}($1::json) AS value`, [JSON.stringify(value)])).rows[0].value;
}
async function claim(db: PGlite, job: string): Promise<Claim | null> {
  return (await db.query<{ value: Claim | null }>('SELECT claim_energy_planning_job($1) AS value', [job])).rows[0].value;
}
async function read(db: PGlite, job: string, homeId = home): Promise<Receipt | null> {
  return (await db.query<{ value: Receipt | null }>('SELECT read_energy_planning_job($1,$2) AS value', [homeId, job])).rows[0].value;
}
function submission(snapshotId = snapshot, context: Record<string, unknown> = {}) {
  const frozenContext: Record<string, unknown> = { request_id: 'request-1', integration_version: 'test', fixed_revision: 0,
    observed_replan_request_id: null, replan_request_id: null, ...context };
  return { home_id: home, customer_id: home, snapshot_id: snapshotId, source_hash: 'a'.repeat(64), protocol: 1, deadline_at: new Date(Date.now()+10_000).toISOString(),
    input: { devices: { z_device: 4, a_device: 5, middle: 6 } },
    context: frozenContext };
}
function currentRow() {
  return { home_id: home, customer_id: home, snapshot_id: snapshot, plan_id: plan,
    generation_request_id: 'request-1', plan_schema_version: 9,
    ha_ack_status: 'pending', ha_acknowledged_at: null, ha_integration_version: 'test',
    ha_ack_request_id: null, ha_ack_error: null, input_hash: 'a'.repeat(64),
    captured_at: '2026-10-06T08:30:00Z', issued_at: '2026-10-06T08:31:00Z',
    valid_until: '2026-10-09T08:30:00Z', binding_until: '2026-10-06T08:45:00Z',
    status: 'ready', model_version: 'test', snapshot: { slots: [] },
    plan: { mode: 'live', plan_id: plan, payload: [1, 2, 3] },
    fixed_plan_generation_revision: 0, replan_error: null, battery_projection: { values: [1, 2] },
    updated_at: '2026-10-06T08:31:00Z' };
}
function runRow() {
  const row = currentRow();
  return { ...row, id: row.plan_id, summary: { total: 3 }, validation_errors: [] };
}
async function insertCurrent(db: PGlite) {
  const row = currentRow();
  await db.query('SELECT store_energy_optimisation_current($1::jsonb)', [JSON.stringify({ ...row,
    snapshot_id: other, plan_id: other, plan: { mode: 'live', plan_id: other } })]);
}

Deno.test('two-function receipts are service-only and preserve ordered input with one exclusive claim', async () => {
  const db = await database();
  try {
    const args = submission(snapshot, { exchange: { watermarks: { z: 1, a: 2 } } });
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(() => rpc(db, 'accept_energy_planning_job', args), Error, 'permission denied');
      await assertRejects(() => claim(db, snapshot), Error, 'permission denied');
      await assertRejects(() => read(db, snapshot), Error, 'permission denied');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    assertEquals((await rpc<Receipt>(db, 'accept_energy_planning_job', args)).job_id, accepted.job_id);
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', { ...args, source_hash: 'different' }), Error, 'identity reused');
    assertEquals(await read(db, accepted.job_id, other), null);
    const owned = (await claim(db, accepted.job_id))!;
    assertEquals(Object.keys(owned.input.devices), ['z_device','a_device','middle']);
    assertEquals(await claim(db, accepted.job_id), null);
    assertEquals(Date.parse(owned.deadline_at), Date.parse(args.deadline_at));
    await db.exec('RESET ROLE');
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM net.wakes')).rows[0].n, 0);
    assertEquals((await db.query<{ n: number }>("SELECT count(*)::int n FROM pg_proc WHERE proname IN ('commit_energy_planning_step','claim_energy_planning_step','wake_energy_planning_job')")).rows[0].n, 0);
  } finally { await db.close(); }
});

Deno.test('expired and interrupted owners fail terminally without restarting computation', async () => {
  const db = await database();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1', [manual]);
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', submission(snapshot, { observed_replan_request_id: manual }));
    const owned = (await claim(db, accepted.job_id))!;
    await db.query("UPDATE private.energy_planning_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [owned.id]);
    await db.exec('SELECT private.sweep_energy_planning_jobs()');
    assertEquals((await read(db, owned.id))?.code, 'planning_deadline_exceeded');
    assertEquals(await claim(db, owned.id), null);
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', { job_id: owned.id, fence: owned.fence, current: currentRow(),run:runRow() })).state, 'failed');
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM net.wakes')).rows[0].n,0);
    assertEquals((await db.query<{ id: string }>('SELECT plan_id id FROM energy_optimisation_current')).rows[0].id,other);
    assertEquals((await db.query<{ error: string }>('SELECT replan_error error FROM energy_optimisation_current')).rows[0].error, 'Replanning exceeded its request deadline.');
    const expired = await rpc<Receipt>(db, 'accept_energy_planning_job', { ...submission(other, { observed_replan_request_id:manual }), deadline_at: new Date(Date.now()-1).toISOString() });
    assertEquals(expired.code,'planning_deadline_exceeded');
  } finally { await db.close(); }
});

Deno.test('received-order supersession protects newer manual and fixed requests', async () => {
  const db = await database();
  try {
    await insertCurrent(db);
    const first = await rpc<Receipt>(db,'accept_energy_planning_job',submission());
    const oldClaim = (await claim(db,first.job_id))!;
    const next = await rpc<Receipt>(db,'accept_energy_planning_job',{ ...submission(other),input:{ captured_at:'2000-01-01',devices:{} } });
    assertEquals((await read(db,first.job_id))?.state,'superseded');
    assertEquals(await rpc(db,'publish_energy_planning_job',{ job_id:oldClaim.id,fence:oldClaim.fence,current:currentRow(),run:runRow() }),null);
    const nextClaim = (await claim(db,next.job_id))!;
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1',[manual]);
    assertEquals(await rpc(db,'fail_energy_planning_job',{ job_id:nextClaim.id,fence:nextClaim.fence,code:'old',detail:'old error' }),null);
    assertEquals((await read(db,next.job_id))?.state,'superseded');
    await assertRejects(() => rpc(db,'accept_energy_planning_job',submission(plan)),Error,'changed during preparation');
    const fixed = await rpc<Receipt>(db,'accept_energy_planning_job',submission(plan,{observed_replan_request_id:manual}));
    const fixedClaim = (await claim(db,fixed.job_id))!;
    await db.exec('UPDATE energy_optimisation_current SET fixed_plan_revision=1');
    assertEquals(await rpc(db,'fail_energy_planning_job',{job_id:fixedClaim.id,fence:fixedClaim.fence,code:'old',detail:'old error'}),null);
  } finally { await db.close(); }
});

Deno.test('atomic publication waits for matching HA acceptance before completing the manual request', async () => {
  const db = await database();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1,ha_runtime=$2',[manual,{running:true}]);
    const accepted = await rpc<Receipt>(db,'accept_energy_planning_job',submission(snapshot,{observed_replan_request_id:manual}));
    const owned = (await claim(db,accepted.job_id))!;
    const publish = {job_id:owned.id,fence:owned.fence,current:currentRow(),run:runRow()};
    await assertRejects(() => rpc(db,'publish_energy_planning_job',{...publish,run:{...runRow(),status:'invalid'}}),Error,'check constraint');
    assertEquals((await db.query<{id:string}>('SELECT plan_id id FROM energy_optimisation_current')).rows[0].id,other);
    assertEquals((await db.query<{n:number}>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n,0);
    assertEquals((await rpc<Receipt>(db,'publish_energy_planning_job',publish)).state,'published');
    assertEquals((await read(db,owned.id))?.plan,currentRow().plan,'Exact receipt recovers a lost publication response');
    assertEquals(await rpc(db,'publish_energy_planning_job',publish),null);
    assertEquals((await db.query<{id:string|null}>('SELECT replan_completed_request_id id FROM energy_optimisation_current')).rows[0].id,null);
    const acknowledge = (id:string,status:string,error:unknown=null) => db.query('SELECT acknowledge_energy_optimisation_plan($1,$2,$3,9::smallint,$4,now(),$5,$6,$7)',[home,id,snapshot,status,'test','ack',error]);
    await acknowledge(other,'accepted');
    assertEquals((await db.query<{id:string|null}>('SELECT replan_completed_request_id id FROM energy_optimisation_current')).rows[0].id,null);
    await acknowledge(plan,'accepted');
    const state = (await db.query<{id:string;runtime:unknown}>('SELECT replan_completed_request_id id,ha_runtime runtime FROM energy_optimisation_current')).rows[0];
    assertEquals(state.id,manual);assertEquals(state.runtime,{running:true});
  } finally { await db.close(); }
});

for (const write of ['run write','receipt write']) {
Deno.test(`a deadline crossed during ${write} rolls back current, run and receipt together`, async () => {
  const db = await database();
  try {
    await insertCurrent(db);
    const accepted = await rpc<Receipt>(db,'accept_energy_planning_job',submission());
    const owned = (await claim(db,accepted.job_id))!;
    // Burn a bounded interval inside the transaction AFTER the current write.
    // This distinguishes the final deadline guard from the admission guard.
    await db.exec(`CREATE FUNCTION delay_run_write() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE until_time timestamptz:=clock_timestamp()+interval '150 milliseconds';
      BEGIN WHILE clock_timestamp()<until_time LOOP NULL; END LOOP; RETURN NEW; END $$;
      CREATE TRIGGER delay_run_write ${write === 'run write' ? 'BEFORE INSERT ON energy_optimisation_plan_runs' : "BEFORE UPDATE OF state ON private.energy_planning_jobs"}
      FOR EACH ROW ${write === 'receipt write' ? "WHEN (NEW.state='published')" : ''} EXECUTE FUNCTION delay_run_write();`);
    await db.query("UPDATE private.energy_planning_jobs SET deadline_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[owned.id]);
    await rpc(db,'publish_energy_planning_job',{job_id:owned.id,fence:owned.fence,current:currentRow(),run:runRow()});
    assertEquals((await db.query<{id:string}>('SELECT plan_id id FROM energy_optimisation_current')).rows[0].id,other);
    assertEquals((await db.query<{n:number}>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n,0);
    assertEquals((await read(db,owned.id))?.state,'failed');
  } finally { await db.close(); }
});

}

Deno.test('migration terminalizes the active legacy job and its matching website request', async () => {
  const db = await database(false);
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1',[manual]);
    const accepted = await rpc<Receipt>(db,'accept_energy_planning_job',submission(snapshot,{observed_replan_request_id:manual}));
    await db.exec(await migration('20261006170000_restore_two_function_energy_planning'));
    assertEquals((await read(db,accepted.job_id))?.code,'planner_upgraded');
    const current = (await db.query<{id:string;error:string}>('SELECT plan_id id,replan_error error FROM energy_optimisation_current')).rows[0];
    assertEquals(current.id,other);assert(current.error.includes('Request a new replan'));
  } finally { await db.close(); }
});

const resumeMigration = '20261006203500_resume_planning_across_bounded_exchanges';
async function applyResume(db: PGlite) {
  await db.exec((await migration(resumeMigration)).replace(
    /^ALTER TABLE private\.energy_planning_(jobs|parts) ALTER COLUMN \w+ SET COMPRESSION lz4;$/gm, ''));
}
async function durableDatabase() {
  const db = await database();
  await applyResume(db);
  return db;
}
type BatchClaim = { id: string; fence: number; steps: number; phase: string; home_id: string };
async function batchClaim(db: PGlite, job: string, homeId = home): Promise<BatchClaim | null> {
  return (await db.query<{ value: BatchClaim | null }>(
    'SELECT claim_energy_planning_batch($1,$2) AS value', [homeId, job])).rows[0].value;
}
async function batchLoad(db: PGlite, owner: BatchClaim, homeId = home) {
  return (await db.query<{ value: {
    input: { devices: Record<string, number> };
    continuation: { completed: Record<string, unknown>[]; rankings: Record<string, unknown>[];
      checkpoint: Record<string, unknown> | null; ranking_checkpoint: Record<string, unknown> | null };
  } | null }>('SELECT load_energy_planning_batch($1,$2,$3) AS value', [homeId, owner.id, owner.fence])).rows[0].value;
}
function batchWrite(owner: BatchClaim, patch: Record<string, unknown> = {}) {
  return { job_id: owner.id, home_id: home, fence: owner.fence, steps: owner.steps,
    calls: 2, phase: 'solving', completed: [], rankings: [], continuation: {}, ...patch };
}

Deno.test('durable batches preserve JSON order, append exactly once and allow late unreclaimed checkpoints', async () => {
  const db = await durableDatabase();
  try {
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', submission());
    const owner = (await batchClaim(db, accepted.job_id))!;
    assertEquals(await batchClaim(db, owner.id), null);
    const loaded = (await batchLoad(db, owner))!;
    assertEquals(Object.keys(loaded.input.devices), ['z_device', 'a_device', 'middle']);
    assertEquals(loaded.continuation.completed, []);
    assertEquals(loaded.continuation.checkpoint, null);
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=clock_timestamp()-interval '1 second',created_at=now()-interval '2 days' WHERE id=$1", [owner.id]);
    await db.exec('SELECT private.sweep_energy_planning_jobs()');
    assertEquals((await read(db, owner.id))?.state, 'pending', 'elapsed job time cannot discard healthy work');
    const first = batchWrite(owner, { completed: [{ z: 1, a: 2 }], rankings: [{ y: 3, b: 4 }],
      continuation: { checkpoint: { z_cursor: 5, a_cursor: 6 }, ranking_checkpoint: { x: 7, b: 8 } } });
    assertEquals((await rpc<Receipt>(db, 'commit_energy_planning_batch', first)).state, 'pending');
    assertEquals(await rpc(db, 'commit_energy_planning_batch', first), null, 'lost-reply retry cannot append twice');
    const second = (await batchClaim(db, owner.id))!;
    assertEquals(second.steps, 2);
    const resumed = (await batchLoad(db, second))!.continuation;
    assertEquals(Object.keys(resumed.completed[0]), ['z', 'a']);
    assertEquals(Object.keys(resumed.checkpoint!), ['z_cursor', 'a_cursor']);
    assertEquals(Object.keys(resumed.ranking_checkpoint!), ['x', 'b']);
    await rpc(db, 'commit_energy_planning_batch', batchWrite(second, {
      completed: [{ q: 9, c: 10 }], rankings: [{ w: 11, d: 12 }], continuation: { checkpoint: { position: 13 } },
    }));
    const third = (await batchClaim(db, owner.id))!;
    assertEquals(third.steps, 4);
    assertEquals((await batchLoad(db, third))!.continuation.completed, [{ z: 1, a: 2 }, { q: 9, c: 10 }]);
    assertEquals((await batchLoad(db, third))!.continuation.rankings, [{ y: 3, b: 4 }, { w: 11, d: 12 }]);
  } finally { await db.close(); }
});

Deno.test('durable lease takeover fences stale load, checkpoint, failure and publication', async () => {
  const db = await durableDatabase();
  try {
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', submission());
    const old = (await batchClaim(db, accepted.job_id))!;
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id]);
    const next = (await batchClaim(db, old.id))!;
    assert(next.fence > old.fence);
    assertEquals(await batchLoad(db, old), null);
    assertEquals(await rpc(db, 'commit_energy_planning_batch', batchWrite(old)), null);
    assertEquals(await rpc(db, 'fail_energy_planning_job', { ...batchWrite(old), code: 'stale', detail: 'stale owner' }), null);
    assertEquals(await rpc(db, 'publish_energy_planning_job', { ...batchWrite(old), current: currentRow(), run: runRow() }), null);
    assertEquals((await read(db, old.id))?.state, 'pending');
    await rpc(db, 'commit_energy_planning_batch', batchWrite(next, { phase: 'assembling', calls: 1 }));
    const assembler = (await batchClaim(db, old.id))!;
    assertEquals(assembler.phase, 'assembling');
    assertEquals(await rpc(db, 'publish_energy_planning_job', { ...batchWrite(next), current: currentRow(), run: runRow() }), null);
    assertEquals((await read(db, old.id))?.state, 'pending');
  } finally { await db.close(); }
});

Deno.test('durable publication is atomic, idempotent and completes only on exact HA acknowledgement', async () => {
  const db = await durableDatabase();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1,ha_runtime=$2', [manual, { running: true }]);
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', submission(snapshot, { observed_replan_request_id: manual }));
    const solver = (await batchClaim(db, accepted.job_id))!;
    await rpc(db, 'commit_energy_planning_batch', batchWrite(solver, { phase: 'assembling' }));
    const assembler = (await batchClaim(db, solver.id))!;
    const publish = { ...batchWrite(assembler), current: currentRow(), run: runRow() };
    await assertRejects(() => rpc(db, 'publish_energy_planning_job', {
      ...publish, run: { ...runRow(), status: 'invalid' },
    }), Error, 'check constraint');
    assertEquals((await read(db, solver.id))?.state, 'pending');
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n, 0);
    const published = await rpc<Receipt>(db, 'publish_energy_planning_job', publish);
    assertEquals(published.state, 'published');
    assertEquals(published.plan, undefined, 'normal publication receipt avoids a full plan download');
    assertEquals((await read(db, solver.id))?.plan, currentRow().plan, 'lost publication response recovers the stored exact plan');
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', publish)).state, 'published');
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n, 1);
    const completed = async () => (await db.query<{ id: string | null }>('SELECT replan_completed_request_id id FROM energy_optimisation_current')).rows[0].id;
    const acknowledge = (planId: string, snapshotId: string) => db.query(
      'SELECT acknowledge_energy_optimisation_plan($1,$2,$3,9::smallint,$4,now(),$5,$6,$7)',
      [home, planId, snapshotId, 'accepted', 'test', 'ack', null]);
    assertEquals(await completed(), null);
    await acknowledge(other, snapshot);
    assertEquals(await completed(), null);
    await acknowledge(plan, other);
    assertEquals(await completed(), null);
    await acknowledge(plan, snapshot);
    assertEquals(await completed(), manual);
    assertEquals((await db.query<{ runtime: unknown }>('SELECT ha_runtime runtime FROM energy_optimisation_current')).rows[0].runtime, { running: true });
  } finally { await db.close(); }
});

Deno.test('durable batch RPCs are service-only and enforce home isolation', async () => {
  const db = await durableDatabase();
  try {
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', submission());
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(() => batchClaim(db, accepted.job_id), Error, 'permission denied');
      await assertRejects(() => batchLoad(db, { id: accepted.job_id, fence: 0, steps: 0, phase: 'solving', home_id: home }), Error, 'permission denied');
      await assertRejects(() => rpc(db, 'commit_energy_planning_batch', { job_id: accepted.job_id }), Error, 'permission denied');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    assertEquals(await batchClaim(db, accepted.job_id, other), null);
    const owner = (await batchClaim(db, accepted.job_id))!;
    assertEquals(await batchLoad(db, owner, other), null);
    assertEquals(await rpc(db, 'commit_energy_planning_batch', { ...batchWrite(owner), home_id: other }), null);
    assertEquals(await rpc(db, 'publish_energy_planning_job', { ...batchWrite(owner), home_id: other }), null);
    assertEquals(await rpc(db, 'fail_energy_planning_job', { ...batchWrite(owner), home_id: other }), null);
    await assertRejects(() => db.query('SELECT * FROM private.energy_planning_parts'), Error, 'permission denied');
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});

Deno.test('durable migration terminalizes legacy manual work without replacing existing controls', async () => {
  const db = await database();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1,ha_runtime=$2', [manual, { running: true }]);
    const old = await rpc<Receipt>(db, 'accept_energy_planning_job', submission(snapshot, { observed_replan_request_id: manual }));
    await claim(db, old.job_id);
    await applyResume(db);
    assertEquals((await read(db, old.job_id))?.code, 'planner_upgraded');
    const row = (await db.query<{ id: string; runtime: unknown; error: string }>('SELECT plan_id id,ha_runtime runtime,replan_error error FROM energy_optimisation_current')).rows[0];
    assertEquals(row.id, other);
    assertEquals(row.runtime, { running: true });
    assert(row.error.includes('Request a new replan'));
    assertEquals(await batchClaim(db, old.job_id), null);
  } finally { await db.close(); }
});

Deno.test('durable head, manual and fixed revisions supersede stale batches without changing controls', async () => {
  const db = await durableDatabase();
  try {
    await insertCurrent(db);
    const old = await rpc<Receipt>(db, 'accept_energy_planning_job', submission());
    const oldOwner = (await batchClaim(db, old.job_id))!;
    const newer = await rpc<Receipt>(db, 'accept_energy_planning_job', submission(other));
    assertEquals(await rpc(db, 'commit_energy_planning_batch', batchWrite(oldOwner)), null);
    assertEquals((await read(db, old.job_id))?.state, 'superseded');
    const manualOwner = (await batchClaim(db, newer.job_id))!;
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1', [manual]);
    assertEquals(await rpc(db, 'commit_energy_planning_batch', batchWrite(manualOwner)), null);
    assertEquals((await read(db, newer.job_id))?.state, 'superseded');
    const fixed = await rpc<Receipt>(db, 'accept_energy_planning_job', submission(plan, { observed_replan_request_id: manual }));
    const fixedOwner = (await batchClaim(db, fixed.job_id))!;
    await db.exec('UPDATE energy_optimisation_current SET fixed_plan_revision=1');
    assertEquals(await rpc(db, 'fail_energy_planning_job', { ...batchWrite(fixedOwner), code: 'stale', detail: 'older fixed revision' }), null);
    assertEquals((await read(db, fixed.job_id))?.state, 'superseded');
    assertEquals((await db.query<{ id: string; error: string | null }>('SELECT plan_id id,replan_error error FROM energy_optimisation_current')).rows[0],
      { id: other, error: null });
  } finally { await db.close(); }
});

const oneShotMigration = '20261008140000_one_shot_rules_planning';
async function oneShotDatabase() {
  const db = await durableDatabase();
  await db.exec(await migration(oneShotMigration));
  await db.exec(await migration('20261008144000_complete_test_rule_publications'));
  await db.exec(await migration('20261014110000_preserve_committed_hot_water_power'));
  await db.exec(await migration('20261014220000_hot_water_opportunity_ledger'));
  return db;
}
type AttemptClaim = { id: string; home_id: string; customer_id: string; snapshot_id: string; protocol: number; fence: number };
async function attemptClaim(db: PGlite, job: string, homeId = home): Promise<AttemptClaim | null> {
  return (await db.query<{ value: AttemptClaim | null }>(
    'SELECT claim_energy_planning_attempt($1,$2) AS value', [homeId, job])).rows[0].value;
}
async function attemptLoad(db: PGlite, owner: Pick<AttemptClaim, 'id' | 'fence'>, homeId = home) {
  return (await db.query<{ value: { input: { devices: Record<string, number> }; context: Record<string, unknown> } | null }>(
    'SELECT load_energy_planning_attempt($1,$2,$3) AS value', [homeId, owner.id, owner.fence])).rows[0].value;
}
function rulesSubmission(snapshotId = snapshot, context: Record<string, unknown> = {}) {
  return { ...submission(snapshotId, { reference_plan_id: null, ...context }), protocol: 9 };
}
const attemptIdentity = (owner: AttemptClaim) => ({ job_id: owner.id, home_id: owner.home_id, fence: owner.fence });

Deno.test('protocol 9 uses service-only home-scoped exclusive attempts with no continuation ledger', async () => {
  const db = await oneShotDatabase();
  try {
    const args = rulesSubmission();
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', { ...args, protocol: 8 }), Error, 'Incomplete planning job');
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(() => rpc(db, 'accept_energy_planning_job', args), Error, 'permission denied');
      await assertRejects(() => attemptClaim(db, snapshot), Error, 'permission denied');
      await assertRejects(() => attemptLoad(db, { id: snapshot, fence: 0 }), Error, 'permission denied');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    assertEquals((await rpc<Receipt>(db, 'accept_energy_planning_job', args)).job_id, accepted.job_id);
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', { ...args, source_hash: 'changed' }), Error, 'identity reused');
    assertEquals(await attemptClaim(db, accepted.job_id, other), null);
    const owners = await Promise.all([attemptClaim(db, accepted.job_id), attemptClaim(db, accepted.job_id)]);
    assertEquals(owners.filter(Boolean).length, 1);
    const owner = owners.find((value): value is AttemptClaim => value !== null)!;
    assertEquals(owner.protocol, 9);
    assertEquals(Object.keys(owner).sort(), ['customer_id', 'fence', 'home_id', 'id', 'protocol', 'snapshot_id']);
    assertEquals(await attemptLoad(db, owner, other), null);
    const loaded = await attemptLoad(db, owner);
    assert(loaded);
    assertEquals(Object.keys(loaded).sort(), ['context', 'input']);
    assertEquals(Object.keys(loaded.input.devices), ['z_device', 'a_device', 'middle']);
    assertEquals(await rpc(db, 'publish_energy_planning_job', { ...attemptIdentity(owner), home_id: other }), null);
    assertEquals(await rpc(db, 'fail_energy_planning_job', { ...attemptIdentity(owner), home_id: other }), null);
    await db.exec('RESET ROLE');
    assertEquals((await db.query<{ parts: string | null }>("SELECT to_regclass('private.energy_planning_parts')::text parts")).rows[0].parts, null);
    assertEquals((await db.query<{ n: number }>("SELECT count(*)::int n FROM pg_proc WHERE proname IN ('claim_energy_planning_batch','load_energy_planning_batch','commit_energy_planning_batch')")).rows[0].n, 0);
    assertEquals((await db.query<{ n: number }>("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='private' AND table_name='energy_planning_jobs' AND column_name IN ('phase','steps','continuation','deadline_at')")).rows[0].n, 0);
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM net.wakes')).rows[0].n, 0);
  } finally { await db.close(); }
});

Deno.test('protocol 9 takeover fences stale loads and writes while an unreclaimed expired owner may publish', async () => {
  const db = await oneShotDatabase();
  try {
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', rulesSubmission());
    const old = (await attemptClaim(db, accepted.job_id))!;
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=clock_timestamp()-interval '1 second',created_at=now()-interval '2 days' WHERE id=$1", [old.id]);
    await db.exec('SELECT private.sweep_energy_planning_jobs()');
    assertEquals((await read(db, old.id))?.state, 'pending');
    const next = (await attemptClaim(db, old.id))!;
    assert(next.fence > old.fence);
    assertEquals(await attemptLoad(db, old), null);
    assertEquals(await rpc(db, 'fail_energy_planning_job', { ...attemptIdentity(old), code: 'stale', detail: 'old owner' }), null);
    assertEquals(await rpc(db, 'publish_energy_planning_job', { ...attemptIdentity(old), current: currentRow(), run: runRow() }), null);
    assertEquals((await read(db, old.id))?.state, 'pending');
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [next.id]);
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', { ...attemptIdentity(next), current: currentRow(), run: runRow() })).state, 'published');
    assertEquals(await attemptClaim(db, next.id), null);
  } finally { await db.close(); }
});

Deno.test('protocol 9 guards the exact published reference at admission and publication', async () => {
  const db = await oneShotDatabase();
  try {
    await insertCurrent(db);
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', rulesSubmission()), Error, 'changed during preparation');
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', rulesSubmission(snapshot, { reference_plan_id: other }));
    const owner = (await attemptClaim(db, accepted.job_id))!;
    // A different current plan invalidates prepared commitments even when the
    // fixed revision, manual request and admitted head have not changed.
    await db.query('UPDATE energy_optimisation_current SET plan_id=$1', [nextManual]);
    assertEquals(await attemptLoad(db, owner), null);
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', { ...attemptIdentity(owner), current: currentRow(), run: runRow() })).state, 'superseded');
    assertEquals((await read(db, owner.id))?.state, 'superseded');
    assertEquals((await db.query<{ id: string; error: string | null }>('SELECT plan_id id,replan_error error FROM energy_optimisation_current')).rows[0], { id: nextManual, error: null });
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n, 0);
  } finally { await db.close(); }
});

Deno.test('protocol 9 direct publication is atomic, recovers lost replies and requires exact HA acknowledgement', async () => {
  const db = await oneShotDatabase();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1,ha_runtime=$2', [manual, { running: true }]);
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', rulesSubmission(snapshot, { reference_plan_id: other,
      observed_replan_request_id: manual, replan_request_id: manual, completion_basis: 'home_assistant_ack' }));
    const owner = (await attemptClaim(db, accepted.job_id))!;
    const publication = { ...attemptIdentity(owner), current: currentRow(), run: runRow() };
    await assertRejects(() => rpc(db, 'publish_energy_planning_job', { ...publication, current: { ...currentRow(), snapshot_id: other } }), Error, 'identity mismatch');
    await assertRejects(() => rpc(db, 'publish_energy_planning_job', { ...publication, run: { ...runRow(), status: 'invalid' } }), Error, 'check constraint');
    assertEquals((await read(db, owner.id))?.state, 'pending');
    assertEquals((await db.query<{ id: string }>('SELECT plan_id id FROM energy_optimisation_current')).rows[0].id, other);
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n, 0);
    const published = await rpc<Receipt>(db, 'publish_energy_planning_job', publication);
    assertEquals(published.state, 'published');
    assertEquals(published.plan, undefined);
    const recovered = await read(db, owner.id);
    assertEquals(recovered?.plan, currentRow().plan, 'Authoritative receipt supplies the exact plan after a lost write response');
    assertEquals(recovered?.plan_id, plan);
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', publication)).state, 'published');
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n, 1);
    const completed = async () => (await db.query<{ id: string | null }>('SELECT replan_completed_request_id id FROM energy_optimisation_current')).rows[0].id;
    const acknowledge = (planId: string, snapshotId: string) => db.query(
      'SELECT acknowledge_energy_optimisation_plan($1,$2,$3,9::smallint,$4,now(),$5,$6,$7)',
      [home, planId, snapshotId, 'accepted', 'test', 'ack', null]);
    assertEquals(await completed(), null);
    await acknowledge(other, snapshot);
    await acknowledge(plan, other);
    assertEquals(await completed(), null);
    await acknowledge(plan, snapshot);
    assertEquals(await completed(), manual);
    assertEquals((await db.query<{ runtime: unknown }>('SELECT ha_runtime runtime FROM energy_optimisation_current')).rows[0].runtime, { running: true });
  } finally { await db.close(); }
});

Deno.test('protocol 9 migration retires pending ledgers and fixed bookings while preserving current commands', async () => {
  const db = await durableDatabase();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1,ha_runtime=$2,fixed_plan=$3',
      [manual, { running: true }, { id: plan, starts_at: '2026-10-08T08:00:00Z', ends_at: '2026-10-08T09:00:00Z', slots: [] }]);
    const old = await rpc<Receipt>(db, 'accept_energy_planning_job', submission(snapshot, { observed_replan_request_id: manual }));
    await batchClaim(db, old.job_id);
    await db.exec(await migration(oneShotMigration));
    assertEquals((await read(db, old.job_id))?.code, 'planner_upgraded');
    assertEquals(await attemptClaim(db, old.job_id), null);
    const row = (await db.query<{ id: string; runtime: unknown; error: string; fixed_plan: unknown; revision: number }>(
      'SELECT plan_id id,ha_runtime runtime,replan_error error,fixed_plan,fixed_plan_revision revision FROM energy_optimisation_current')).rows[0];
    assertEquals(row.id, other);
    assertEquals(row.runtime, { running: true });
    assertEquals(row.fixed_plan, null);
    assertEquals(row.revision, 1);
    assert(row.error.includes('Request a new replan'));
  } finally { await db.close(); }
});

Deno.test('protocol 9 command references preserve pending-ack native commands and exact EV ranges', async () => {
  const db = await oneShotDatabase();
  try {
    await insertCurrent(db);
    const slot = { start: '2026-10-08T08:00:00Z', pool_w: 1200, pool_command_w: 3764,
      ev_target_current_a: 8, ev_min_current_a: 5, ev_max_current_a: 16, boiler_permitted: false, boiler_expected_w: 0, boiler_battery_allowed: false,
      battery_command: { schema_version: 3, operation: 'hold', charge_limit_w: 3000, discharge_limit_w: 0,
        allow_grid_charge: false, allow_battery_export: false },
      device_commands: { pool: { type: 'switch_schedule', on_seconds: 900 } } };
    await db.query('UPDATE energy_optimisation_current SET plan=$1,ha_ack_status=$2',
      [{ status: 'ready', hot_water_permissions: ['2026-10-08T06:00:00Z'], plans: { priority: { slots: [slot] } } }, 'pending']);
    const reference = (await db.query<{ value: { reference_plan_id: string; published_commands: unknown } }>(
      'SELECT get_energy_replan_state($1) value', [home])).rows[0].value;
    assertEquals(reference.reference_plan_id, other);
    assertEquals(reference.published_commands, { plan_id: other, hot_water_permissions: ['2026-10-08T06:00:00Z'], slots: [slot] });
    assertEquals((await db.query<{ value: unknown }>('SELECT get_energy_replan_state($1) value', [other])).rows[0].value, null);
  } finally { await db.close(); }
});

Deno.test('database command references support real replanning with and without hot water', async () => {
  const db = await oneShotDatabase();
  try {
    await insertCurrent(db);
    for (const boiler of [false, true]) {
      const s = dispatchedEvSnapshot();
      s.slots = s.slots.slice(0, 8);
      s.captured_at = s.slots[0].start;
      s.capabilities.boiler = boiler;
      s.comfort = { ev: { target_km: 300 } };
      if (boiler) s.services.push({ id: 'water', device: 'boiler', priority: 1, required_kwh: 1,
        earliest_start: s.slots[0].start, deadline: new Date(Date.parse(s.slots.at(-1)!.start) + 900_000).toISOString(),
        control: { type: 'duty_cycle', rated_power_w: 2000, expected_power_w_by_slot: s.slots.map(() => 500) } });
      const prepare = (reference: PublishedCommandReference | null) => prepareRulesPlanningInput({ snapshot: s, now: s.captured_at,
        resolved_price_outlook: { shaped: true, observed_days: 1, effective_days: 1, level_sek_per_kwh: 1.5,
          shadow_import_sek_per_kwh: s.slots.map(() => 1.5) } }, reference, resolveRulePolicy());
      const first = generateRulesPlan(prepare(null)).plan;
      // Permitted throughout, the thermostat replaces each quarter's water as it is drawn.
      assertEquals(first.plans.priority.slots.map(slot => slot.boiler_expected_w),
        s.slots.map(() => boiler ? 500 : 0));
      await db.query('UPDATE energy_optimisation_current SET plan=$1', [first]);
      const state = (await db.query<{ value: { published_commands: PublishedCommandReference } }>(
        'SELECT get_energy_replan_state($1) value', [home])).rows[0].value;
      s.captured_at = new Date(Date.parse(s.captured_at) + 7 * 60_000).toISOString();
      const prepared = prepare(state.published_commands);
      // Exercise the same JSON boundary as the remote worker, then the real Wasm solver.
      const replanned = generateRulesPlan(JSON.parse(JSON.stringify(prepared))).plan;
      assert(prepared.problem.slots.every(slot => Number.isFinite(slot.base_w)));
      assertEquals(replanned.status, 'ready');
      assertEquals(replanned.plans.priority.slots.slice(0, 5).map(slot => slot.boiler_expected_w),
        first.plans.priority.slots.slice(0, 5).map(slot => slot.boiler_expected_w));
      assertEquals(replanned.plans.priority.slots.slice(0, 5).map(slot => slot.boiler_permitted),
        first.plans.priority.slots.slice(0, 5).map(slot => slot.boiler_permitted));
    }
  } finally { await db.close(); }
});

Deno.test('planner upgrade releases an unacknowledged legacy request without pretending HA accepted it', async () => {
  const db = await durableDatabase();
  try {
    await insertCurrent(db);
    await db.exec(`UPDATE energy_optimisation_current SET model_version='marginal-value-planner-v51',
      replan_request_id='${manual}',replan_completed_request_id=NULL,ha_ack_status='pending',replan_error=NULL`);
    await db.exec(await migration('20261008143000_release_legacy_replan_requests'));
    const row = (await db.query<{replan_error:string;ha_ack_status:string;replan_completed_request_id:string|null}>(
      'SELECT replan_error,ha_ack_status,replan_completed_request_id FROM energy_optimisation_current')).rows[0];
    assertEquals(row, {replan_error:'Planner changed. Request a new replan.',ha_ack_status:'pending',replan_completed_request_id:null});
  } finally { await db.close(); }
});

Deno.test('publication completion is atomic and recoverable without fabricating an HA acknowledgement', async () => {
  const db = await oneShotDatabase();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1,replan_error=$2,ha_runtime=$3',
      [manual, 'previous error', { running: true }]);
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', rulesSubmission(snapshot, {
      reference_plan_id: other, observed_replan_request_id: manual, replan_request_id: manual, completion_basis: 'publication',
    }));
    const owner = (await attemptClaim(db, accepted.job_id))!;
    const publication = { ...attemptIdentity(owner), current: currentRow(), run: runRow() };
    // Fail at the completion write, after current, run and receipt were written.
    // None of them may become visible independently of request completion.
    await db.exec(`CREATE FUNCTION reject_request_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'completion write failed'; END $$;
      CREATE TRIGGER reject_request_completion BEFORE UPDATE OF replan_completed_request_id
      ON energy_optimisation_current FOR EACH ROW EXECUTE FUNCTION reject_request_completion();`);
    await assertRejects(() => rpc(db, 'publish_energy_planning_job', publication), Error, 'completion write failed');
    assertEquals((await read(db, owner.id))?.state, 'pending');
    assertEquals((await db.query<{ plan_id: string; replan_error: string; replan_completed_request_id: string | null }>(
      'SELECT plan_id,replan_error,replan_completed_request_id FROM energy_optimisation_current')).rows[0],
      { plan_id: other, replan_error: 'previous error', replan_completed_request_id: null });
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n, 0);
    await db.exec('DROP TRIGGER reject_request_completion ON energy_optimisation_current');
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', publication)).state, 'published');
    assertEquals((await read(db, owner.id))?.plan, currentRow().plan, 'A lost publication reply is recovered from the same durable receipt');
    const row = (await db.query<{ plan_id: string; snapshot_id: string; replan_completed_request_id: string;
      replan_error: string | null; ha_runtime: unknown }>(
      'SELECT plan_id,snapshot_id,replan_completed_request_id,replan_error,ha_runtime FROM energy_optimisation_current')).rows[0];
    assertEquals(row, { plan_id: plan, snapshot_id: snapshot, replan_completed_request_id: manual,
      replan_error: null, ha_runtime: { running: true } });
    for (const table of ['energy_optimisation_current', 'energy_optimisation_plan_runs']) {
      const acknowledgement = (await db.query(`SELECT ha_ack_status,ha_acknowledged_at,ha_ack_request_id,ha_ack_error FROM ${table}`)).rows[0];
      assertEquals(acknowledgement, { ha_ack_status: 'pending', ha_acknowledged_at: null, ha_ack_request_id: null, ha_ack_error: null });
    }
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1', [nextManual]);
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', publication)).state, 'published');
    assertEquals((await db.query<{ id: string }>('SELECT replan_completed_request_id id FROM energy_optimisation_current')).rows[0].id, manual,
      'Replaying a terminal receipt cannot complete a newer manual request');
  } finally { await db.close(); }
});

for (const status of ['incomplete', 'infeasible']) {
  Deno.test(`publication completion does not complete a ${status} plan`, async () => {
    const db = await oneShotDatabase();
    try {
      await insertCurrent(db);
      await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1', [manual]);
      const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', rulesSubmission(snapshot, {
        reference_plan_id: other, observed_replan_request_id: manual, replan_request_id: manual, completion_basis: 'publication',
      }));
      const owner = (await attemptClaim(db, accepted.job_id))!;
      assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', { ...attemptIdentity(owner),
        current: { ...currentRow(), status }, run: { ...runRow(), status } })).state, 'published');
      assertEquals((await db.query<{ id: string | null; ha_ack_status: string }>(
        'SELECT replan_completed_request_id id,ha_ack_status FROM energy_optimisation_current')).rows[0],
        { id: null, ha_ack_status: 'pending' });
    } finally { await db.close(); }
  });
}

Deno.test('publication completion requires an explicit matching manual request and rejects a changed request', async () => {
  const db = await oneShotDatabase();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1', [manual]);
    const context = { reference_plan_id: other, observed_replan_request_id: manual, completion_basis: 'publication' };
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', rulesSubmission(snapshot,
      { ...context, replan_request_id: nextManual })), Error, 'changed during preparation');
    // Observing an outstanding request is not evidence that this capture was
    // made for it: a scheduled price refresh cannot complete the manual ask.
    const automatic = await rpc<Receipt>(db, 'accept_energy_planning_job', rulesSubmission(snapshot, context));
    const automaticOwner = (await attemptClaim(db, automatic.job_id))!;
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', {
      ...attemptIdentity(automaticOwner), current: currentRow(), run: runRow(),
    })).state, 'published');
    assertEquals((await db.query<{ id: string | null }>('SELECT replan_completed_request_id id FROM energy_optimisation_current')).rows[0].id, null);
    const requested = await rpc<Receipt>(db, 'accept_energy_planning_job', rulesSubmission(other,
      { ...context, reference_plan_id: plan, replan_request_id: manual }));
    const requestedOwner = (await attemptClaim(db, requested.job_id))!;
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1', [nextManual]);
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', {
      ...attemptIdentity(requestedOwner), current: { ...currentRow(), snapshot_id: other }, run: { ...runRow(), snapshot_id: other },
    })).state, 'superseded');
    assertEquals((await db.query<{ request: string; completed: string | null; snapshot_id: string }>(
      'SELECT replan_request_id request,replan_completed_request_id completed,snapshot_id FROM energy_optimisation_current')).rows[0],
      { request: nextManual, completed: null, snapshot_id: snapshot });
  } finally { await db.close(); }
});

const executionMigration = '20261023121000_scoped_execution_replans';
Deno.test('retained pool reference carries its accepted target and explicit no-instruction intervals', async () => {
  const db = await oneShotDatabase();
  try {
    await db.exec(await migration('20261026006000_pool_retained_target'));
    const pool = { planning_basis: 'empirical', stop_temperature_c: 30 };
    const slots = [{ start: '2026-10-25T01:00:00Z', pool_permitted: false, pool_command_w: 0 },
      { start: '2026-10-25T01:15:00Z', pool_permitted: null }];
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)', [JSON.stringify({ ...currentRow(),
      plan: { status: 'ready', pool, plans: { priority: { slots } } } })]);
    await db.exec('GRANT SELECT ON energy_optimisation_current TO service_role; SET ROLE service_role');
    const state = (await db.query<{ value: { published_commands: PublishedCommandReference } }>(
      'SELECT get_energy_replan_state($1) value', [home])).rows[0].value;
    assertEquals(state.published_commands.pool_stop_temperature_c, 30);
    assertEquals(state.published_commands.pool_planning_basis, 'empirical');
    assertEquals(state.published_commands.slots.map(q => q.pool_permitted), [false, null]);
    assertEquals(state.published_commands.slots.map(q => q.pool_command_w), [0, null]);
    await db.exec('RESET ROLE; SET ROLE authenticated');
    await assertRejects(() => db.query('SELECT get_energy_replan_state($1)', [home]), Error, 'permission denied');
  } finally { await db.close(); }
});

Deno.test('forced execution receipts are immutable, home scoped and require the exact HA-accepted reference', async () => {
  const db = await oneShotDatabase();
  try {
    await db.exec(await migration(executionMigration));
    const published = { ...currentRow(), plan: { ...currentRow().plan, status: 'ready' } };
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)', [JSON.stringify(published)]);
    const execution = { request_id: manual, accepted_plan_id: plan, observed_at: '2026-10-23T12:00:00Z',
      changes: [{ owner: '$ev', status: 'temporarily_absent', cause: 'cable_disconnected', blocked_intervals: [{ start: '2026-10-23T12:00:00Z', end: '2026-10-23T12:15:00Z' }] }] };
    const args = { ...rulesSubmission(nextManual, { reference_plan_id: plan, execution_replan: execution }),
      input: { devices: {}, execution_replan: execution } };
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', args), Error, 'exact HA-accepted');
    await db.exec("UPDATE energy_optimisation_current SET ha_ack_status='accepted',ha_acknowledged_at=now()");
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', { ...args, context: { ...args.context, execution_replan: { ...execution, accepted_plan_id: other } } }), Error, 'exact HA-accepted');
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', { ...args, input: { execution_replan: { ...execution, changes: [] } } }), Error, 'exact HA-accepted');
    const receipt = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    assertEquals((await rpc<Receipt>(db, 'accept_energy_planning_job', args)).job_id, receipt.job_id);
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', { ...args, snapshot_id: other, source_hash: 'changed body' }), Error, 'Execution request identity reused');
    const recovered = await db.query<{ value: Receipt }>('SELECT read_execution_planning_job($1,$2) value', [home, manual]);
    assertEquals(recovered.rows[0].value.job_id, receipt.job_id);
    assertEquals(recovered.rows[0].value.source_hash, args.source_hash);
    assertEquals((await db.query<{ value: unknown }>('SELECT read_execution_planning_job($1,$2) value', [other, manual])).rows[0].value, null);
    const loaded = await attemptLoad(db, (await attemptClaim(db, receipt.job_id))!);
    assertEquals(loaded!.context.execution_replan, execution);
    assertEquals(loaded!.input, args.input);
  } finally { await db.close(); }
});

Deno.test('execution reference preserves battery instructions, physical scope and HA acknowledgement', async () => {
  const db = await oneShotDatabase();
  try {
    await db.exec(await migration(executionMigration));
    const instruction = { kind: 'grid_charge', charge_ac_w: 2000 };
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)', [JSON.stringify({ ...currentRow(),
      snapshot: { operating_scope: { modes: { $ev: 'controlling' } }, execution_availability: [] },
      plan: { status: 'ready', plans: { priority: { slots: [{ start: '2026-10-23T12:00:00Z', battery_instruction: instruction }] } } } })]);
    const state = (await db.query<{ value: { ha_ack_status: string; published_commands: { slots: Array<{ battery_instruction: unknown }>; operating_scope: unknown; execution_availability: unknown } } }>('SELECT get_energy_replan_state($1) value', [home])).rows[0].value;
    assertEquals(state.ha_ack_status, 'pending');
    assertEquals(state.published_commands.slots[0].battery_instruction, instruction);
    assertEquals(state.published_commands.operating_scope, { modes: { $ev: 'controlling' } });
    assertEquals(state.published_commands.execution_availability, []);
  } finally { await db.close(); }
});

Deno.test('real planner preparation freezes the execution envelope accepted by the durable admission RPC', async () => {
  const db = await oneShotDatabase();
  try {
    await db.exec(await migration(executionMigration));
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)', [JSON.stringify(currentRow())]);
    await db.exec("UPDATE energy_optimisation_current SET ha_ack_status='accepted',ha_acknowledged_at=now()");
    const capture = dispatchedEvSnapshot();
    capture.captured_at = capture.slots[0].start;
    capture.comfort = { ev: { target_km: 300 } };
    const source = capture.slots[0].start;
    const execution = { request_id: manual, accepted_plan_id: plan, observed_at: capture.captured_at,
      changes: [{ owner: '$ev', status: 'temporarily_absent' as const, cause: 'cable_disconnected',
        blocked_intervals: [{ start: source, end: new Date(Date.parse(source) + 900_000).toISOString() }] }] };
    const reference: PublishedCommandReference = { plan_id: plan, slots: capture.slots.map(slot => ({ start: slot.start,
      pool_w: 0, pool_command_w: 0, ev_target_current_a: 6, ev_min_current_a: 0, ev_max_current_a: 16,
      boiler_permitted: false, boiler_expected_w: 0 })) };
    const prepared = prepareRulesPlanningInput({ snapshot: capture, now: capture.captured_at, execution_replan: execution,
      resolved_price_outlook: rulesFixtureInput(capture).price_outlook }, reference, resolveRulePolicy());
    assertEquals(prepared.execution_replan, execution);
    const args = { ...rulesSubmission(nextManual, { reference_plan_id: plan, execution_replan: execution }), input: prepared };
    const receipt = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    assertEquals(receipt.state, 'pending');
    const loaded = await attemptLoad(db, (await attemptClaim(db, receipt.job_id))!);
    assertEquals(loaded!.context.execution_replan, execution);
    const frozen = (await db.query<{ input: { execution_replan: unknown } }>(
      'SELECT input FROM private.energy_planning_jobs WHERE id=$1', [receipt.job_id])).rows[0].input;
    assertEquals(frozen.execution_replan, execution);
  } finally { await db.close(); }
});


async function auditedDatabase() {
  const db = await oneShotDatabase();
  await db.exec(await migration(executionMigration));
  await db.exec(`CREATE FUNCTION can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql AS
    $$ SELECT $1=NULLIF(current_setting('test.customer',true),'')::uuid $$;`);
  await db.exec(await migration('20261024183000_audit_planning_triggers'));
  return db;
}
type AuditEvent = { event: string; source: string; forced: boolean; actor_id: string | null;
  reason: Record<string, unknown>; job_id: string | null; plan_id: string | null; details: Record<string, unknown> };
const auditEvents = async (db: PGlite) => (await db.query<AuditEvent>(
  'SELECT * FROM energy_replan_events ORDER BY sequence')).rows;

Deno.test('planning audit attributes explicit requests and records publication separately from exact HA acceptance', async () => {
  const db = await auditedDatabase();
  try {
    await insertCurrent(db);
    const origin = { source: 'portal', reason: 'manual_replan_button', actor_id: home };
    const queue = async () => (await db.query<{id:string}>(
      'SELECT request_energy_optimisation_replan($1,$2) id', [home, origin])).rows[0].id;
    const id = await queue();
    assertEquals(await queue(), id);
    assertEquals((await auditEvents(db)).length, 1);
    const args = rulesSubmission(snapshot, { reference_plan_id: other, observed_replan_request_id: id,
      replan_request_id: id, completion_basis: 'home_assistant_ack' });
    const receipt = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    await rpc(db, 'accept_energy_planning_job', args);
    const owner = (await attemptClaim(db, receipt.job_id))!;
    const loaded = await attemptLoad(db, owner);
    assertEquals(loaded!.context.planning_trigger, {source:'portal', forced:true, actor_id:home, reason:origin});
    const publish = { ...attemptIdentity(owner), current: currentRow(), run: runRow() };
    await assertRejects(() => rpc(db, 'publish_energy_planning_job', { ...publish, run: {...runRow(),status:'invalid'} }), Error, 'check constraint');
    assertEquals((await auditEvents(db)).map(e=>e.event), ['requested','admitted','solving']);
    await rpc(db, 'publish_energy_planning_job', publish);
    await rpc(db, 'publish_energy_planning_job', publish);
    assertEquals((await auditEvents(db)).map(e=>e.event), ['requested','admitted','solving','published']);
    await db.query('SELECT acknowledge_energy_optimisation_plan($1,$2,$3,9::smallint,$4,now(),$5,$6,$7)',
      [home, plan, snapshot, 'accepted', 'test', 'audit-ack', null]);
    const events = await auditEvents(db);
    assertEquals(events.map(e=>e.event), ['requested','admitted','solving','published','accepted']);
    for (const e of events) { assertEquals(e.reason, origin); assertEquals(e.actor_id, home); }
    assertEquals(events.at(-1)!.plan_id, plan);
    // Retiring the large solve input cannot erase the audit.
    await db.query('DELETE FROM private.energy_planning_jobs WHERE id=$1', [receipt.job_id]);
    assertEquals((await auditEvents(db)).length, 5);
    await db.exec(`SET ROLE authenticated; SET test.customer='${other}'`);
    assertEquals(await auditEvents(db), []);
    await db.exec(`SET test.customer='${home}'`);
    assertEquals((await auditEvents(db)).length, 5);
    await assertRejects(()=>db.exec('DELETE FROM energy_replan_events'), Error, 'permission denied');
  } finally { await db.close(); }
});

Deno.test('execution audit preserves quantitative evidence through retry, failure and supersession', async () => {
  const db = await auditedDatabase();
  try {
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)', [JSON.stringify(currentRow())]);
    await db.exec("UPDATE energy_optimisation_current SET ha_ack_status='accepted',ha_acknowledged_at=now()");
    const evidence = { request_id: manual, accepted_plan_id: plan, observed_at: '2026-10-24T10:00:00Z', changes: [
      {owner:'$battery',status:'plan_deviation',cause:'battery_energy_shortfall',magnitude:0.225,persistence_ms:120000,
       affected_intervals:[{start:'2026-10-24T10:00:00Z',end:'2026-10-24T10:15:00Z'}]}] };
    const args = { ...rulesSubmission(other,{reference_plan_id:plan, execution_replan:evidence}), input:{execution_replan:evidence} };
    const receipt = await rpc<Receipt>(db,'accept_energy_planning_job',args);
    await rpc(db,'accept_energy_planning_job',args);
    const owner = (await attemptClaim(db,receipt.job_id))!;
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",[owner.id]);
    const retry = (await attemptClaim(db,receipt.job_id))!;
    await rpc(db,'fail_energy_planning_job',{...attemptIdentity(retry),code:'solver_error',detail:'Cannot solve'});
    const events = await auditEvents(db);
    assertEquals(events.map(e=>e.event),['admitted','solving','solving','failed']);
    for (const e of events) { assertEquals(e.reason,evidence); assertEquals(e.source,'execution'); assert(e.forced); }
    assertEquals(events.at(-1)!.details.detail,'Cannot solve');
    // An unrelated normal price release has its own provenance and is not a forced replan.
    const normal = await rpc<Receipt>(db,'accept_energy_planning_job',rulesSubmission(snapshot,{reference_plan_id:plan,
      planning_trigger:{source:'price_release',forced:false,reason:{code:'new_published_prices'}}}));
    await db.query("UPDATE private.energy_planning_jobs SET state='superseded' WHERE id=$1",[normal.job_id]);
    const last=(await auditEvents(db)).at(-1)!;
    assertEquals(last.event,'superseded'); assertEquals(last.source,'price_release'); assertEquals(last.forced,false);
  } finally { await db.close(); }
});

Deno.test('configuration and fixed schedule requests are attributed; pre-solve errors are durable', async () => {
  const db = await auditedDatabase();
  try {
    await insertCurrent(db);
    await db.query('SELECT request_energy_optimisation_replan($1,$2)',[home,
      {source:'integration',reason:'controller_source_selected',client:{version:'test'}}]);
    await db.exec("UPDATE energy_optimisation_current SET replan_error='Missing required inputs'");
    assertEquals((await auditEvents(db)).map(e=>[e.event,e.reason.reason]),
      [['requested','controller_source_selected'],['request_failed','controller_source_selected']]);
    await db.query('SELECT set_fixed_energy_plan($1,0,$2,NULL)',[home,other]);
    const fixed=(await auditEvents(db)).at(-1)!;
    assertEquals(fixed.source,'fixed_schedule'); assertEquals(fixed.reason.reason,'fixed_schedule_changed');
    await db.exec('SET ROLE anon');
    await assertRejects(()=>auditEvents(db),Error,'permission denied');
  } finally {await db.close();}
});

Deno.test('audit migration lets an already admitted job finish while retaining honest historical attribution', async () => {
  const db=await oneShotDatabase();
  try {
    const receipt=await rpc<Receipt>(db,'accept_energy_planning_job',rulesSubmission());
    await db.exec(`CREATE FUNCTION can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$`);
    await db.exec(await migration('20261024183000_audit_planning_triggers'));
    const owner=(await attemptClaim(db,receipt.job_id))!;
    await rpc(db,'fail_energy_planning_job',{...attemptIdentity(owner),code:'test',detail:'test failure'});
    const rows=await auditEvents(db);
    assertEquals(rows.map(e=>e.event),['solving','failed']);
    assertEquals(rows[0].source,'unknown');
    assertEquals(rows[0].reason,{code:'job_predates_audit'});
    await assertRejects(()=>rpc(db,'accept_energy_planning_job',rulesSubmission(other)),Error,'explicit audit reason');
  } finally {await db.close();}
});

async function loggedDatabase() {
  const db = await auditedDatabase();
  await db.exec(await migration('20261024210000_curated_planning_log'));
  return db;
}
type LogEntry = {sequence:number;kind:string;state:string;severity:string;reason:Record<string,unknown>;
  details:{counts?:Record<string,number>;calculation_ms?:number};occurrences:number};
const logEntries = async (db:PGlite) => (await db.query<LogEntry>('SELECT * FROM energy_planning_log ORDER BY sequence DESC')).rows;

Deno.test('readable log collapses a complete replan lifecycle, preserving trigger and long calculation duration', async () => {
  const db=await loggedDatabase();
  try {
    await insertCurrent(db);
    const origin={source:'portal',reason:'manual_replan_button',actor_id:home};
    const id=(await db.query<{id:string}>('SELECT request_energy_optimisation_replan($1,$2) id',[home,origin])).rows[0].id;
    const accepted=await rpc<Receipt>(db,'accept_energy_planning_job',rulesSubmission(snapshot,{reference_plan_id:other,
      observed_replan_request_id:id,replan_request_id:id,completion_basis:'home_assistant_ack'}));
    const owner=(await attemptClaim(db,accepted.job_id))!;
    // Completion is still recent activity when a durable job outlives the log window.
    await db.exec("UPDATE energy_planning_log SET occurred_at=now()-interval '73 hours'");
    await rpc(db,'publish_energy_planning_job',{...attemptIdentity(owner),current:currentRow(),
      run:{...runRow(),summary:{calculation_ms:42000}}});
    await db.query('SELECT acknowledge_energy_optimisation_plan($1,$2,$3,9::smallint,$4,now(),$5,$6,$7)',
      [home,plan,snapshot,'accepted','test','log-ack',null]);
    const rows=await logEntries(db);
    assertEquals(rows.length,1);
    assertEquals(rows[0].state,'accepted');
    assertEquals(rows[0].reason,origin);
    assertEquals(rows[0].details.calculation_ms,42000);
    assert(rows[0].sequence>1,'a newly completed old job gets a fresh position in recent history');
    assertEquals((await auditEvents(db)).length,5,'condensing the readable log never removes audit evidence');
  } finally {await db.close();}
});

Deno.test('readable log groups 96 uploads and repeated warnings, deduplicates retries and enforces 72-hour ownership and retention', async () => {
  const db=await loggedDatabase();
  try {
    const activity=(id:string)=>({receipt_id:id,source:'home_assistant',counts:{actuals:8,thermal:12},
      warnings:[{code:'sensor_unavailable',scope:'pool',severity:'warning',message:'Pool sensor unavailable',consequence:'Forecast needs attention'}]});
    const send=(id:string)=>db.query('SELECT record_energy_planning_activity($1,$2,$3)',[home,home,activity(id)]);
    // One hour bucket, one warning bucket, even for a busy backfill session.
    for(let i=0;i<96;i++) await send('upload-'+i);
    await send('upload-95');
    const rows=await logEntries(db);
    assertEquals(rows.length,2);
    const exchange=rows.find(r=>r.kind==='exchange')!;
    assertEquals(exchange.occurrences,96);
    assertEquals(exchange.details.counts,{actuals:768,thermal:1152});
    assertEquals(rows.find(r=>r.kind==='warning')!.occurrences,96);
    await db.exec(`SET ROLE authenticated; SET test.customer='${other}'`);
    assertEquals(await logEntries(db),[]);
    await db.exec(`SET test.customer='${home}'`);
    assertEquals((await logEntries(db)).length,2);
    await assertRejects(()=>send('forbidden'),Error,'permission denied');
    await assertRejects(()=>db.exec('DELETE FROM energy_planning_log'),Error,'permission denied');
    await db.exec('RESET ROLE');
    await db.exec("UPDATE energy_planning_log SET occurred_at=now()-interval '72 hours 1 second'");
    await db.exec(`SET ROLE authenticated; SET test.customer='${home}'`);
    assertEquals(await logEntries(db),[],'expired rows are hidden even before cleanup runs');
    await db.exec('RESET ROLE');
    await db.exec('SELECT private.prune_energy_planning_log()');
    assertEquals(await logEntries(db),[]);
    assertEquals((await db.query<{n:number}>("SELECT count(*)::int n FROM cron.schedules WHERE name='prune-energy-planning-log'")).rows[0].n,1);
    await assertRejects(()=>db.query('SELECT record_energy_planning_activity($1,$2,$3)',[home,home,
      {receipt_id:'bad',source:'home_assistant',counts:{actuals:-1}}]),Error,'nonnegative integers');
  } finally {await db.close();}
});

Deno.test('healthy HA heartbeats are silent and unchanged runtime problems do not flood the log', async () => {
  const db=await loggedDatabase();
  try {
    await insertCurrent(db);
    for(let i=0;i<10;i++) await db.query('UPDATE energy_optimisation_current SET ha_runtime=$1',[
      {state:'ready',last_error:null,reason:'Ready',observed_at:String(i)}]);
    assertEquals(await logEntries(db),[]);
    for(let i=0;i<10;i++) await db.query('UPDATE energy_optimisation_current SET ha_runtime=$1',[
      {state:'invalid',last_error:'Plan could not be read',reason:'Invalid plan',observed_at:String(i)}]);
    const rows=await logEntries(db);
    assertEquals(rows.length,1);
    assertEquals(rows[0].occurrences,1);
    assertEquals(rows[0].severity,'error');
    assertEquals(rows[0].reason.message,'Plan could not be read');
    for(let i=0;i<5;i++) await db.query('UPDATE energy_optimisation_current SET ha_runtime=$1',[
      {state:'invalid',last_error:'Plan could not be read [request_id='+i+']',reason:'Invalid plan'}]);
    assertEquals((await logEntries(db)).length,1,'request identities do not manufacture distinct error entries');
    await db.query('UPDATE energy_optimisation_current SET ha_runtime=$1',[
      {state:'invalid',last_error:'Required grid sensor unavailable',reason:'Missing reading'}]);
    assertEquals((await logEntries(db)).length,2,'different problems retain separate explanations');
  } finally {await db.close();}
});

Deno.test('protocol 10 persists an unsolved capture and retains exact execution evidence fencing', async () => {
  const db = await oneShotDatabase();
  try {
    await db.exec(await migration(executionMigration));
    await db.exec(await migration('20261026001500_capture_before_planning_workers'));
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)', [JSON.stringify(currentRow())]);
    await db.exec("UPDATE energy_optimisation_current SET ha_ack_status='accepted',ha_acknowledged_at=now()");
    const raw = dispatchedEvSnapshot();
    raw.captured_at = raw.slots[0].start;
    const execution = { request_id: manual, accepted_plan_id: plan, observed_at: raw.captured_at,
      changes: [{ owner: '$ev', status: 'temporarily_absent' as const, cause: 'cable_disconnected',
        blocked_intervals: [{ start: raw.captured_at, end: new Date(Date.parse(raw.captured_at) + 900_000).toISOString() }] }] };
    const reference: PublishedCommandReference = { plan_id: plan, slots: [] };
    const captured = captureRulesPlanningInput({ snapshot: raw, now: raw.captured_at, execution_replan: execution,
      resolved_price_outlook: rulesFixtureInput(raw).price_outlook }, reference, resolveRulePolicy());
    const args = { ...rulesSubmission(nextManual, { reference_plan_id: plan, execution_replan: execution }),
      protocol: 10, input: captured };
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', { ...args, protocol: 9 }), Error, 'Incomplete planning job');
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', { ...args,
      input: { ...captured, execution_replan: null } }), Error, 'exact HA-accepted');
    const receipt = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    assertEquals((await rpc<Receipt>(db, 'accept_energy_planning_job', args)).job_id, receipt.job_id);
    const claim = (await attemptClaim(db, receipt.job_id))!;
    assertEquals(claim.protocol, 10);
    const loaded = await attemptLoad(db, claim);
    assertEquals(loaded!.input, JSON.parse(JSON.stringify(captured)));
    assertEquals('problem' in loaded!.input, false);
    assertEquals('rooms' in loaded!.input, false);
    assertEquals(loaded!.context.execution_replan, execution);
    assertEquals(await attemptLoad(db, { ...claim, fence: claim.fence + 1 }), null);
  } finally { await db.close(); }
});

const retryMigration = '20261029120000_retry_planning_attempts_and_recapture';
async function retryDatabase() {
  // Production attempt/publication, execution, audit and curated-log definitions,
  // followed by the current capture protocol and compact reference owner fields.
  const db = await loggedDatabase();
  for (const name of ['20261025003000_pool_commitment_basis', '20261026001500_capture_before_planning_workers',
    '20261026006000_pool_retained_target', retryMigration]) await db.exec(await migration(name));
  return db;
}
const capturedSubmission = (id = snapshot, context: Record<string, unknown> = {}) => ({ ...rulesSubmission(id, {planning_trigger: {source:"initial_plan",forced:false,reason:{code:"synthetic_initial"}}, ...context}), protocol: 10 });
const recapture = async (db: PGlite, job: string, requestId: string | null = null, execution: unknown = null, homeId = home) =>
  (await db.query<{value: Record<string, unknown>}>(
    'SELECT read_energy_planning_recapture($1,$2,$3,$4::jsonb) value', [homeId,job,requestId,JSON.stringify(execution)])).rows[0].value;

Deno.test('recoverable attempts pace durable retries, keep captures immutable and fence every late result', async () => {
  const db = await retryDatabase();
  try {
    const args = capturedSubmission();
    const accepted = await rpc<Receipt>(db,'accept_energy_planning_job',args);
    const first = (await attemptClaim(db,accepted.job_id))!;
    const original = await attemptLoad(db,first);
    const retry = {...attemptIdentity(first),code:'planning_deadline_exceeded',detail:'Synthetic worker timeout'};
    const pending = await rpc<Receipt & {retry_after_ms:number;last_error:{code:string}}>(db,'retry_energy_planning_attempt',retry);
    assertEquals(pending.state,'pending');
    assert(pending.retry_after_ms >= 4000 && pending.retry_after_ms <= 5000);
    assertEquals(pending.last_error.code,'planning_deadline_exceeded');
    assertEquals(await attemptClaim(db,first.id),null,'Due time is enforced in storage, not merely suggested to HA');
    assertEquals(await rpc(db,'retry_energy_planning_attempt',retry),null,'A lost reply cannot schedule the same failure twice');
    assertEquals(await rpc(db,'fail_energy_planning_job',{...retry,code:'late_failure'}),null);
    await db.query("UPDATE private.energy_planning_jobs SET wake_after=clock_timestamp()-interval '1 second' WHERE id=$1",[first.id]);
    const second = (await attemptClaim(db,first.id))!;
    assert(second.fence > first.fence);
    assertEquals((await attemptLoad(db,second))!.input,args.input);
    assertEquals((await attemptLoad(db,second))!.context,original!.context);
    assertEquals(await rpc(db,'retry_energy_planning_attempt',retry),null,'Old attempt cannot delay its successor');
    assertEquals(await rpc(db,'publish_energy_planning_job',{...attemptIdentity(first),current:currentRow(),run:runRow()}),null);
    // A process can die without issuing a retry result. Its expired lease is reclaimable.
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[second.id]);
    const third = (await attemptClaim(db,second.id))!;
    assert(third.fence > second.fence);
    const published = await rpc<Receipt>(db,'publish_energy_planning_job',{...attemptIdentity(third),current:currentRow(),run:runRow()});
    assertEquals(published.state,'published');
    assertEquals((await read(db,third.id))!.plan,currentRow().plan,'A lost commit reply recovers exact committed output');
    assertEquals((await rpc<Receipt>(db,'retry_energy_planning_attempt',retry)).state,'published');
    assertEquals((await db.query<{n:number}>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n,1);
  } finally { await db.close(); }
});

Deno.test('retry failure cannot move another home or a superseded head and service access stays closed', async () => {
  const db = await retryDatabase();
  try {
    const original = await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission());
    const owner = (await attemptClaim(db,original.job_id))!;
    const failure={...attemptIdentity(owner),code:'planning_failed',detail:'Synthetic outage'};
    assertEquals(await rpc(db,'retry_energy_planning_attempt',{...failure,home_id:other}),null);
    for(const role of ['anon','authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(()=>rpc(db,'retry_energy_planning_attempt',failure),Error,'permission denied');
      await assertRejects(()=>recapture(db,owner.id),Error,'permission denied');
      await db.exec('RESET ROLE');
    }
    const replacement = await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission(other));
    assertEquals((await rpc<Receipt>(db,'retry_energy_planning_attempt',failure)).state,'superseded');
    assert((await attemptClaim(db,replacement.job_id)) !== null);
  } finally {await db.close();}
});

Deno.test('upgraded captures grant one current same-purpose replacement and retries recover its receipt', async () => {
  const db = await retryDatabase();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1',[manual]);
    const context={reference_plan_id:other,observed_replan_request_id:manual,replan_request_id:manual};
    const old=await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission(snapshot,context));
    const owner=(await attemptClaim(db,old.job_id))!;
    const retired=await rpc<Receipt & {recapture:{replaces_job_id:string}}>(db,'fail_energy_planning_job',{
      ...attemptIdentity(owner),code:'planner_upgraded',detail:'Fresh capture required'});
    assertEquals(retired.recapture,{replaces_job_id:old.job_id});
    assertEquals((await recapture(db,old.job_id,manual)).replan_request_id,manual);
    await assertRejects(()=>recapture(db,old.job_id,nextManual),Error,'different purpose');
    await assertRejects(()=>recapture(db,old.job_id,manual,null,other),Error,'different purpose');
    const replacement=capturedSubmission(nextManual,{...context,replaces_job_id:old.job_id});
    const fresh=await rpc<Receipt>(db,'accept_energy_planning_job',replacement);
    assert(fresh.job_id!==old.job_id);
    assertEquals((await rpc<Receipt>(db,'accept_energy_planning_job',replacement)).job_id,fresh.job_id,
      'A lost replacement response deduplicates before rechecking now-spent authority');
    assertEquals((await read(db,old.job_id) as Receipt & {recapture:null}).recapture,null);
    await assertRejects(()=>recapture(db,old.job_id,manual),Error,'no longer current');
    await assertRejects(()=>rpc(db,'accept_energy_planning_job',capturedSubmission(plan,{...context,replaces_job_id:old.job_id})),Error,'no longer current');
    assertEquals((await db.query<{error:string|null}>('SELECT replan_error error FROM energy_optimisation_current')).rows[0].error,null);
  } finally {await db.close();}
});

Deno.test('recapture rechecks manual/reference authority inside admission and refuses terminal-error tickets', async () => {
  const db=await retryDatabase();
  try {
    await insertCurrent(db);
    const context={reference_plan_id:other};
    const old=await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission(snapshot,context));
    const owner=(await attemptClaim(db,old.job_id))!;
    await rpc(db,'fail_energy_planning_job',{...attemptIdentity(owner),code:'invalid_snapshot',detail:'Synthetic invalid input'});
    await assertRejects(()=>recapture(db,old.job_id),Error,'no longer current');
    // A later genuine upgrade grants a new purpose, but a fixed edit revokes it.
    const newer=await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission(nextManual,context));
    const claimed=(await attemptClaim(db,newer.job_id))!;
    await rpc(db,'fail_energy_planning_job',{...attemptIdentity(claimed),code:'planner_upgraded',detail:'Upgrade'});
    await recapture(db,newer.job_id);
    await db.exec('UPDATE energy_optimisation_current SET fixed_plan_revision=1');
    await assertRejects(()=>rpc(db,'accept_energy_planning_job',capturedSubmission(plan,{...context,fixed_revision:1,replaces_job_id:newer.job_id})),Error,'no longer current');
  } finally {await db.close();}
});

Deno.test('repeated transient attempts keep paced work alive without a maximum attempt count', async () => {
  const db=await retryDatabase();
  try {
    const job=await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission());
    await db.query('UPDATE private.energy_planning_jobs SET retry_count=100000 WHERE id=$1',[job.job_id]);
    const owner=(await attemptClaim(db,job.job_id))!;
    const pending=await rpc<Receipt & {retry_after_ms:number}>(db,'retry_energy_planning_attempt',{
      ...attemptIdentity(owner),code:'planning_failed',detail:'Synthetic persistent outage'});
    assertEquals(pending.state,'pending');
    assert(pending.retry_after_ms>59000 && pending.retry_after_ms<=60000);
    assertEquals((await db.query<{count:number}>('SELECT retry_count::int count FROM private.energy_planning_jobs')).rows[0].count,100001);
  } finally {await db.close();}
});

Deno.test('execution recapture keeps the accepted reference while current evidence replaces an obsolete fault', async () => {
  const db=await retryDatabase();
  try {
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)',[JSON.stringify(currentRow())]);
    await db.exec("UPDATE energy_optimisation_current SET ha_ack_status='accepted',ha_acknowledged_at=now()");
    const execution={request_id:manual,accepted_plan_id:plan,observed_at:'2026-10-29T10:00:00Z',
      changes:[{owner:'$ev',status:'faulted',cause:'synthetic unavailable',blocked_intervals:[]}]};
    const context={reference_plan_id:plan,execution_replan:execution};
    const args={...capturedSubmission(snapshot,context),input:{execution_replan:execution}};
    const old=await rpc<Receipt>(db,'accept_energy_planning_job',args);
    const owner=(await attemptClaim(db,old.job_id))!;
    await rpc(db,'fail_energy_planning_job',{...attemptIdentity(owner),code:'planner_upgraded',detail:'Upgrade'});
    const recovered={...execution,request_id:nextManual,changes:[{...execution.changes[0],status:'recovered'}]};
    await recapture(db,old.job_id,null,recovered);
    await assertRejects(()=>recapture(db,old.job_id,null,{...recovered,accepted_plan_id:other}),Error,'different purpose');
    await assertRejects(()=>recapture(db,old.job_id,null,null),Error,'different purpose');
    const fresh=await rpc<Receipt>(db,'accept_energy_planning_job',{
      ...capturedSubmission(nextManual,{...context,replaces_job_id:old.job_id,execution_replan:recovered}),
      input:{execution_replan:recovered}});
    const claimed=(await attemptClaim(db,fresh.job_id))!;
    assertEquals((await attemptLoad(db,claimed))!.context.execution_replan,recovered);
  } finally {await db.close();}
});

Deno.test('ended capture horizons authorize only a still-current same-home purpose with a fresh immutable snapshot', async () => {
  const db = await retryDatabase();
  try {
    const oldArgs = capturedSubmission();
    const old = await rpc<Receipt>(db,'accept_energy_planning_job',oldArgs);
    const owner = (await attemptClaim(db,old.job_id))!;
    const ended = await rpc<Receipt & {recapture:{replaces_job_id:string}}>(db,'fail_energy_planning_job',{
      ...attemptIdentity(owner),code:'capture_horizon_ended',detail:'The actual captured final slot has ended'});
    assertEquals(ended.recapture,{replaces_job_id:old.job_id});
    await recapture(db,old.job_id);
    await assertRejects(()=>recapture(db,old.job_id,null,null,other),Error,'no longer current');
    await assertRejects(()=>recapture(db,old.job_id,manual),Error,'different purpose');
    const freshArgs = capturedSubmission(nextManual,{replaces_job_id:old.job_id});
    const fresh = await rpc<Receipt>(db,'accept_energy_planning_job',freshArgs);
    assert(fresh.job_id !== old.job_id);
    const freshOwner = (await attemptClaim(db,fresh.job_id))!;
    assertEquals((await attemptLoad(db,freshOwner))!.input,freshArgs.input);
    assertEquals((await rpc<Receipt>(db,'accept_energy_planning_job',freshArgs)).job_id,fresh.job_id,
      'Lost fresh-capture reply remains idempotent');
    await assertRejects(()=>recapture(db,old.job_id),Error,'no longer current');
    assertEquals((await read(db,old.job_id) as Receipt & {recapture:null}).recapture,null);
  } finally {await db.close();}
});

const ownershipMigration='20261030120000_accepted_command_ownership';
async function ownershipDatabase() {
  const db=await retryDatabase();
  await db.exec('ALTER TABLE energy_optimisation_current ADD COLUMN ha_runtime_received_at timestamptz');
  await db.exec(await migration(ownershipMigration));
  return db;
}
const acceptedState=async(db:PGlite)=>(await db.query<{value:{reference_plan_id:string|null;accepted_reference_revision:number;accepted_commands:{state:string;household:Record<string,unknown>|null;battery:Record<string,unknown>|null}}}>('SELECT get_energy_replan_state($1) value',[home])).rows[0].value;
async function publishOwnership(db:PGlite,id:string,snapshotId:string,end:string,battery=true) {
  const state=await acceptedState(db);
  const args=capturedSubmission(snapshotId,{reference_plan_id:state?.reference_plan_id??null,accepted_reference_revision:state?.accepted_reference_revision??0});
  const receipt=await rpc<Receipt>(db,'accept_energy_planning_job',args);
  const owned=(await attemptClaim(db,receipt.job_id))!;
  const current={...currentRow(),plan_id:id,snapshot_id:snapshotId,plan_schema_version:10,
    snapshot:{slot_minutes:15,operating_scope:{modes:{$ev:'controlling',$battery:'controlling'}},slots:[{start:end}]},
    plan:{status:'ready',plan_id:id,plans:{priority:{slots:[{start:end,ev_target_current_a:6,pool_permitted:false,pool_w:0,device_commands:{},battery_command:{operation:'grid_charge',charge_limit_w:1000,discharge_limit_w:0}}]}},
      ...(battery?{battery_execution:{id:`contract-${id}`,scope_revision:'synthetic-scope',generation:owned.fence}}:{})}};
  const run={...runRow(),id,snapshot_id:snapshotId,plan_schema_version:10};
  assertEquals((await rpc<Receipt>(db,'publish_energy_planning_job',{...attemptIdentity(owned),current,run})).state,'published');
  return {id,snapshotId,receipt,owned,current,run};
}
async function acknowledgeOwnership(db:PGlite,id:string,snapshotId:string,outcome='accepted',homeId=home) {
  return (await db.query<{value:boolean}>(`SELECT acknowledge_energy_optimisation_plan($1,$2,$3,10::smallint,$4,clock_timestamp(),'synthetic','ack',$5::jsonb) value`,
    [homeId,id,snapshotId,outcome,outcome==='rejected'?JSON.stringify({code:'synthetic_rejected',message:'synthetic'}):null])).rows[0].value;
}
Deno.test('accepted ownership preserves longer Q through P and exact late ACK facts never regress it',async()=>{
  const db=await ownershipDatabase();
  try {
    await publishOwnership(db,plan,snapshot,'2099-01-01T12:00:00Z');
    assertEquals((await acceptedState(db)).accepted_commands.household,null);
    await publishOwnership(db,other,manual,'2099-01-01T10:00:00Z');
    assert(await acknowledgeOwnership(db,other,manual,'rejected'));
    assert(await acknowledgeOwnership(db,plan,snapshot)); // Q ACK arrives after P publication.
    let state=await acceptedState(db);
    assertEquals(state.reference_plan_id,other);
    assertEquals(state.accepted_commands.household?.plan_id,plan);
    const revision=state.accepted_reference_revision;
    assert(await acknowledgeOwnership(db,plan,snapshot,'rejected'));
    assert(await acknowledgeOwnership(db,plan,snapshot));
    assertEquals((await acceptedState(db)).accepted_reference_revision,revision);
    assert(await acknowledgeOwnership(db,other,manual)); // rejection does not latch out later acceptance.
    assert(await acknowledgeOwnership(db,other,manual,'rejected'));
    assert(await acknowledgeOwnership(db,plan,snapshot)); // stale acceptance cannot roll back P.
    state=await acceptedState(db);
    assertEquals(state.accepted_commands.household?.plan_id,other);
    assertEquals((await db.query<{s:string}>("SELECT ha_ack_status s FROM energy_optimisation_current")).rows[0].s,'accepted');
    assertEquals((await db.query<{n:number}>("SELECT count(*)::int n FROM private.energy_command_publications WHERE accepted_at IS NOT NULL AND rejected_at IS NOT NULL")).rows[0].n,2);
    assertEquals(await acknowledgeOwnership(db,plan,manual),false);
    assertEquals(await acknowledgeOwnership(db,plan,snapshot,'accepted',other),false);
  }finally{await db.close();}
});
Deno.test('independent battery acceptance fences immutable captured work before publication and grants recapture',async()=>{
  const db=await ownershipDatabase();
  try{
    const q=await publishOwnership(db,plan,snapshot,'2099-01-01T12:00:00Z');
    await acknowledgeOwnership(db,plan,snapshot);
    const state=await acceptedState(db);
    const args=capturedSubmission(manual,{reference_plan_id:plan,accepted_reference_revision:state.accepted_reference_revision});
    const receipt=await rpc<Receipt>(db,'accept_energy_planning_job',args);
    const owned=(await attemptClaim(db,receipt.job_id))!;
    const runtime={observed_at:'2000-01-01T00:00:00Z',battery_plan:{accepted:{plan_id:plan,contract_id:`contract-${plan}`,scope_revision:'synthetic-scope',generation:q.owned.fence}}};
    await db.query("UPDATE energy_optimisation_current SET ha_runtime='{"+'"observed_at":"2099-01-01T00:00:00Z"'+"}'::jsonb");
    assertEquals((await db.query<{v:boolean}>('SELECT report_energy_runtime($1,$2::jsonb) v',[home,JSON.stringify(runtime)])).rows[0].v,false);
    assertEquals((await acceptedState(db)).accepted_commands.battery?.plan_id,plan); // ownership precedes diagnostic clock filter.
    const failed=await rpc<Receipt>(db,'publish_energy_planning_job',{...attemptIdentity(owned),current:q.current,run:q.run});
    assertEquals(failed.code,'accepted_reference_changed');
    assertEquals((await recapture(db,receipt.job_id)).accepted_reference_revision,state.accepted_reference_revision);
    assertEquals((await db.query<{n:number}>('SELECT count(*)::int n FROM private.energy_command_publications')).rows[0].n,1);
    await assertRejects(()=>rpc(db,'accept_energy_planning_job',capturedSubmission(other,{reference_plan_id:plan,accepted_reference_revision:state.accepted_reference_revision})),Error,'ownership changed');
  }finally{await db.close();}
});
Deno.test('command projection retention trims only ended inactive candidates and keeps durable accepted copies',async()=>{
  const db=await ownershipDatabase();
  try{
    await publishOwnership(db,plan,snapshot,'2000-01-01T00:00:00Z');
    await acknowledgeOwnership(db,plan,snapshot);
    await publishOwnership(db,other,manual,'2000-01-01T00:00:00Z');
    await publishOwnership(db,nextManual,nextManual,'2099-01-01T00:00:00Z');
    await db.exec('SELECT private.prune_energy_command_publications()');
    const rows=(await db.query<{plan_id:string;n:number}>('SELECT plan_id,jsonb_array_length(commands->\'slots\') n FROM private.energy_command_publications')).rows;
    assertEquals(rows.find(r=>r.plan_id===plan)?.n,1);
    assertEquals(rows.find(r=>r.plan_id===other)?.n,0);
    assertEquals(rows.find(r=>r.plan_id===nextManual)?.n,1);
    assertEquals(((await acceptedState(db)).accepted_commands.household?.slots as unknown[]).length,1);
    assert(await acknowledgeOwnership(db,other,manual)); // exact identity survives payload cleanup.
  }finally{await db.close();}
});
Deno.test('ownership cutover backfills exact current ACK and independent battery and recaptures legacy jobs',async()=>{
  const db=await retryDatabase();
  try{
    await db.exec('ALTER TABLE energy_optimisation_current ADD COLUMN ha_runtime_received_at timestamptz');
    const c={...currentRow(),plan_schema_version:10,ha_ack_status:'accepted',ha_acknowledged_at:'2026-10-01T00:00:00Z',
      snapshot:{slot_minutes:15},plan:{plan_id:plan,status:'ready',plans:{priority:{slots:[{start:'2099-01-01T00:00:00Z'}]}},battery_execution:{id:'synthetic-contract',scope_revision:'scope',generation:3}}};
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)',[JSON.stringify(c)]);
    await db.query('UPDATE energy_optimisation_current SET ha_runtime=$1::jsonb',[JSON.stringify({battery_plan:{accepted:{plan_id:plan,contract_id:'synthetic-contract',scope_revision:'scope',generation:3}}})]);
    const job=await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission(other,{reference_plan_id:plan}));
    await db.exec(await migration(ownershipMigration));
    const state=await acceptedState(db);
    assertEquals(state.accepted_commands.state,'ready');assertEquals(state.accepted_commands.household?.plan_id,plan);assertEquals(state.accepted_commands.battery?.plan_id,plan);
    assertEquals((await read(db,job.job_id))?.code,'accepted_reference_changed');
    await recapture(db,job.job_id);
  }finally{await db.close();}
});
Deno.test('ownership migration never invents acceptance for a mirror and unknown runtime cannot block it',async()=>{
  const db=await retryDatabase();
  try{
    await db.exec('ALTER TABLE energy_optimisation_current ADD COLUMN ha_runtime_received_at timestamptz');
    const accepted=await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission(snapshot,{completion_basis:'publication'}));
    const owned=(await attemptClaim(db,accepted.job_id))!;
    await rpc(db,'publish_energy_planning_job',{...attemptIdentity(owned),current:currentRow(),run:runRow()});
    // Synthetic historical ACK summary lacks commands; it cannot establish a mirror's current native ownership.
    await db.exec(`INSERT INTO energy_optimisation_plan_runs(id,home_id,customer_id,snapshot_id,input_hash,issued_at,status,model_version,summary,validation_errors,plan_schema_version,ha_ack_status,ha_acknowledged_at)
      SELECT '${other}',home_id,customer_id,'${other}',input_hash,issued_at,status,model_version,summary,validation_errors,plan_schema_version,'accepted',clock_timestamp()
      FROM energy_optimisation_plan_runs WHERE id='${plan}'`);
    const runtime={observed_at:'2099-01-01T00:00:00Z',battery_plan:{accepted:{plan_id:other,contract_id:'foreign-contract',scope_revision:'foreign-scope',generation:9}}};
    await db.query('UPDATE energy_optimisation_current SET ha_runtime=$1::jsonb',[JSON.stringify(runtime)]);
    await db.exec(await migration(ownershipMigration));
    assertEquals((await acceptedState(db)).accepted_commands,{state:'ready',household:null,battery:null});
    await db.query('SELECT report_energy_runtime($1,$2::jsonb)',[home,JSON.stringify({...runtime,observed_at:'2099-01-02T00:00:00Z'})]);
    assertEquals((await acceptedState(db)).accepted_reference_revision,0);
    const next=await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission(other,{reference_plan_id:plan,accepted_reference_revision:0,completion_basis:'publication'}));
    assertEquals(next.state,'pending');
  }finally{await db.close();}
});
Deno.test('ownership recapture receipt survives snapshot lookup and admits current accepted identity with original manual purpose',async()=>{
  const db=await ownershipDatabase();
  try{
    await publishOwnership(db,plan,snapshot,'2099-01-01T00:00:00Z');await acknowledgeOwnership(db,plan,snapshot);
    await publishOwnership(db,other,manual,'2099-01-01T00:00:00Z');
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1',[nextManual]);
    const state=await acceptedState(db);
    const oldEvidence={request_id:'77777777-7777-4777-8777-777777777777',accepted_plan_id:plan,observed_at:'2099-01-01T00:00:00Z',changes:[]};
    const args=capturedSubmission(home,{reference_plan_id:other,accepted_reference_revision:state.accepted_reference_revision,
      observed_replan_request_id:nextManual,replan_request_id:nextManual,execution_replan:oldEvidence});
    const job=await rpc<Receipt>(db,'accept_energy_planning_job',{...args,input:{...args.input,execution_replan:oldEvidence}});
    await acknowledgeOwnership(db,other,manual);
    assertEquals(await attemptClaim(db,job.job_id),null);
    const lookup=(await db.query<{v:Receipt&{recapture:{replaces_job_id:string}}}>('SELECT read_energy_planning_job($1,NULL,$2) v',[home,home])).rows[0].v;
    assertEquals(lookup.recapture,{replaces_job_id:job.job_id});
    const latestEvidence={...oldEvidence,request_id:'88888888-8888-4888-8888-888888888888',accepted_plan_id:other};
    await recapture(db,job.job_id,nextManual,latestEvidence);
    const newState=await acceptedState(db);
    const fresh=capturedSubmission(nextManual,{reference_plan_id:other,accepted_reference_revision:newState.accepted_reference_revision,
      observed_replan_request_id:nextManual,replan_request_id:nextManual,execution_replan:latestEvidence,replaces_job_id:job.job_id});
    assertEquals((await rpc<Receipt>(db,'accept_energy_planning_job',{...fresh,input:{...fresh.input,execution_replan:latestEvidence}})).state,'pending');
  }finally{await db.close();}
});
Deno.test('cutover current accepted publication outranks retained older jobs when its own job was pruned',async()=>{
  const db=await retryDatabase();
  try{
    await db.exec('ALTER TABLE energy_optimisation_current ADD COLUMN ha_runtime_received_at timestamptz');
    const old=await rpc<Receipt>(db,'accept_energy_planning_job',capturedSubmission(other));
    await db.query("UPDATE private.energy_planning_jobs SET state='published',revision=10,plan_id=$1 WHERE id=$2",[other,old.job_id]);
    await db.exec('UPDATE private.energy_planning_heads SET revision=11');
    const c={...currentRow(),ha_ack_status:'accepted',ha_acknowledged_at:'2026-10-01T00:00:00Z',
      snapshot:{slot_minutes:15},plan:{plan_id:plan,status:'ready',plans:{priority:{slots:[{start:'2099-01-01T00:00:00Z'}]}}}};
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)',[JSON.stringify(c)]);
    await db.query(`INSERT INTO energy_optimisation_plan_runs(id,home_id,customer_id,snapshot_id,input_hash,issued_at,status,model_version,summary,validation_errors,plan_schema_version,ha_ack_status,ha_acknowledged_at)
      VALUES($1,$2,$2,$1,repeat('a',64),now(),'ready','synthetic','{}','{}',9,'accepted',now())`,[other,home]);
    const captured=capturedSubmission(manual,{reference_plan_id:plan});
    await rpc(db,'accept_energy_planning_job',{...captured,input:{...captured.input,reference:{plan_id:other,slots:[{start:'2099-01-01T02:00:00Z'}]}}});
    await db.exec(await migration(ownershipMigration));
    assertEquals((await acceptedState(db)).accepted_commands.household?.plan_id,plan);
  }finally{await db.close();}
});
Deno.test('unprovable historical accepted commands remain explicit instead of silently unlocking holds',async()=>{
  const db=await retryDatabase();
  try{
    await db.exec('ALTER TABLE energy_optimisation_current ADD COLUMN ha_runtime_received_at timestamptz');
    await insertCurrent(db);
    await db.query(`INSERT INTO energy_optimisation_plan_runs(id,home_id,customer_id,snapshot_id,input_hash,issued_at,status,model_version,summary,validation_errors,plan_schema_version,ha_ack_status,ha_acknowledged_at)
      VALUES($1,$2,$2,$1,repeat('a',64),now(),'ready','synthetic','{}','{}',9,'accepted',now())`,[plan,home]);
    await db.exec(await migration(ownershipMigration));
    assertEquals((await acceptedState(db)).accepted_commands.state,'unresolved');
    await assertRejects(()=>rpc(db,'accept_energy_planning_job',capturedSubmission(snapshot,{reference_plan_id:other,accepted_reference_revision:0})),Error,'provenance is unresolved');
  }finally{await db.close();}
});

const batteryProvenanceMigration='20261030133000_restore_accepted_battery_provenance';
async function legacyIndependentBatteryDatabase(runtimeOverride:Record<string,unknown>={}) {
  const db=await retryDatabase();
  await db.exec('ALTER TABLE energy_optimisation_current ADD COLUMN ha_runtime_received_at timestamptz');
  const batterySnapshot={schema_version:10,slot_minutes:15,capabilities:{battery:true},battery:{capacity_kwh:10},
    operating_scope:{modes:{$battery:'controlling'}},
    battery_execution_feedback:{generation:4,scope_revision:'synthetic-shared-scope',source_receipt:7,previous_contract_id:null,objectives:[]}};
  const args=capturedSubmission(snapshot,{completion_basis:'home_assistant_ack'});
  const b=await rpc<Receipt>(db,'accept_energy_planning_job',{...args,input:{...args.input,snapshot:batterySnapshot}});
  const owned=(await attemptClaim(db,b.job_id))!;
  const slots=[{start:'2099-01-01T12:00:00Z',battery_command:{schema_version:3,operation:'grid_charge',charge_limit_w:1000,discharge_limit_w:0},device_commands:{},ev_target_current_a:0}];
  const bCurrent={...currentRow(),plan_schema_version:10,snapshot:batterySnapshot,
    plan:{status:'ready',plan_id:plan,plans:{priority:{slots}},battery_execution:{id:`${plan}:battery:4`,generation:4,scope_revision:'synthetic-shared-scope'}}};
  await rpc(db,'publish_energy_planning_job',{...attemptIdentity(owned),current:bCurrent,run:{...runRow(),plan_schema_version:10}});
  await acknowledgeOwnership(db,plan,snapshot);
  const oldReference=(await db.query<{v:{published_commands:Record<string,unknown>}}>('SELECT get_energy_replan_state($1) v',[home])).rows[0].v.published_commands;
  const pArgs=capturedSubmission(manual,{reference_plan_id:plan,completion_basis:'home_assistant_ack'});
  const p=await rpc<Receipt>(db,'accept_energy_planning_job',{...pArgs,input:{...pArgs.input,reference:oldReference,
    snapshot:{...batterySnapshot,battery_execution_feedback:{...batterySnapshot.battery_execution_feedback,generation:5,previous_contract_id:`${plan}:battery:4`}}}});
  const pOwned=(await attemptClaim(db,p.job_id))!;
  const pCurrent={...bCurrent,plan_id:other,snapshot_id:manual,plan:{...bCurrent.plan,plan_id:other,
    battery_execution:{id:`${other}:battery:5`,generation:5,scope_revision:'synthetic-shared-scope'}}};
  await rpc(db,'publish_energy_planning_job',{...attemptIdentity(pOwned),current:pCurrent,run:{...runRow(),id:other,snapshot_id:manual,plan_schema_version:10}});
  await acknowledgeOwnership(db,other,manual);
  await db.query('UPDATE energy_optimisation_current SET ha_runtime=$1::jsonb',[JSON.stringify({battery_plan:{accepted:{
    plan_id:plan,contract_id:`${plan}:battery:4`,scope_revision:'synthetic-shared-scope',generation:4,...runtimeOverride}}})]);
  await db.exec(await migration(ownershipMigration));
  return {db,b,p,oldReference};
}
Deno.test('forward repair recovers exact older battery provenance after household publication advanced before cutover',async()=>{
  const {db,b,oldReference}=await legacyIndependentBatteryDatabase();
  try{
    const before=await acceptedState(db);
    assertEquals(before.accepted_commands.state,'unresolved');
    assertEquals(before.accepted_commands.household?.plan_id,other);
    assertEquals(before.accepted_commands.battery,null);
    const frozen=(await db.query<{input:unknown}>('SELECT input FROM private.energy_planning_jobs WHERE id=$1',[b.job_id])).rows[0].input;
    await db.exec(await migration(batteryProvenanceMigration));
    const repaired=await acceptedState(db);
    assertEquals(repaired.reference_plan_id,other);
    assertEquals(repaired.accepted_commands.household,before.accepted_commands.household);
    assertEquals(repaired.accepted_commands.state,'ready');
    assertEquals(repaired.accepted_commands.battery?.plan_id,plan);
    assertEquals(repaired.accepted_commands.battery?.battery_contract,{id:`${plan}:battery:4`,generation:4,scope_revision:'synthetic-shared-scope'});
    assertEquals(repaired.accepted_commands.battery?.slots,oldReference.slots);
    assertEquals(repaired.accepted_reference_revision,before.accepted_reference_revision+1);
    assertEquals((await db.query<{input:unknown}>('SELECT input FROM private.energy_planning_jobs WHERE id=$1',[b.job_id])).rows[0].input,frozen);
    await db.exec(await migration(batteryProvenanceMigration));
    assertEquals(await acceptedState(db),repaired);
  }finally{await db.close();}
});
Deno.test('older battery repair requires all four exact identity fields and never guesses missing commands',async()=>{
  for(const mismatch of [{plan_id:nextManual},{contract_id:'not-server-issued'},{scope_revision:'different'},{generation:9}]) {
    const {db}=await legacyIndependentBatteryDatabase(mismatch);
    try{
      await db.exec(await migration(batteryProvenanceMigration));
      assertEquals((await acceptedState(db)).accepted_commands.battery,null);
      assertEquals((await acceptedState(db)).accepted_commands.state,'unresolved');
    }finally{await db.close();}
  }
  const {db,p}=await legacyIndependentBatteryDatabase();
  try{
    await db.query('DELETE FROM private.energy_command_publications WHERE home_id=$1 AND plan_id=$2',[home,plan]);
    await db.query("UPDATE private.energy_planning_jobs SET input=json_build_object('snapshot',input->'snapshot') WHERE id=$1",[p.job_id]);
    await db.exec(await migration(batteryProvenanceMigration));
    assertEquals((await acceptedState(db)).accepted_commands.battery,null);
    assertEquals((await acceptedState(db)).accepted_commands.state,'unresolved');
  }finally{await db.close();}
});

Deno.test('older battery repair accepts intentionally pruned ended slots but refuses future or unknown empty horizons',async()=>{
  for(const horizon of ['2000-01-01T00:00:00Z','2099-01-01T00:00:00Z',null]) {
    const {db,p}=await legacyIndependentBatteryDatabase();
    try{
      // The later capture has been pruned; the publication identity and its
      // deliberately empty retained projection are the remaining server proof.
      await db.query('DELETE FROM private.energy_planning_jobs WHERE id=$1',[p.job_id]);
      await db.query("UPDATE private.energy_command_publications SET commands=jsonb_set(commands,'{slots}','[]'),horizon_end=$3::timestamptz WHERE home_id=$1 AND plan_id=$2",[home,plan,horizon]);
      await db.exec(await migration(batteryProvenanceMigration));
      const state=await acceptedState(db);
      assertEquals(state.reference_plan_id,other);
      assertEquals(state.accepted_commands.household?.plan_id,other);
      if(horizon==='2000-01-01T00:00:00Z') {
        assertEquals(state.accepted_commands.state,'ready');
        assertEquals(state.accepted_commands.battery?.plan_id,plan);
        assertEquals(state.accepted_commands.battery?.slots,[]);
        assertEquals(state.accepted_commands.battery?.battery_contract,{id:`${plan}:battery:4`,generation:4,scope_revision:'synthetic-shared-scope'});
        assertEquals((await db.query<{h:string}>('SELECT horizon_end::text h FROM private.energy_command_publications WHERE home_id=$1 AND plan_id=$2',[home,plan])).rows[0].h,'2000-01-01 00:00:00+00');
      }else{
        assertEquals(state.accepted_commands.state,'unresolved');
        assertEquals(state.accepted_commands.battery,null);
      }
    }finally{await db.close();}
  }
});

Deno.test('an unclaimed job asks for its first poll at once; a leased or retried one keeps its paced wait', async () => {
  const db = await ownershipDatabase();
  try {
    await db.exec(await migration('20261111170000_start_admitted_planning_jobs_at_once'));
    const state = await acceptedState(db);
    const args = capturedSubmission(snapshot, {reference_plan_id: state?.reference_plan_id ?? null, accepted_reference_revision: state?.accepted_reference_revision ?? 0});
    const accepted = await rpc<Receipt & {retry_after_ms: number}>(db, 'accept_energy_planning_job', args);
    assertEquals(accepted.state, 'pending');
    assertEquals(accepted.retry_after_ms, 100, 'nothing is working on a fresh job, so the poll that starts it need not wait');
    assertEquals((await read(db, accepted.job_id) as Receipt & {retry_after_ms: number}).retry_after_ms, 100);
    const owned = (await attemptClaim(db, accepted.job_id))!;
    const leased = await read(db, accepted.job_id) as Receipt & {retry_after_ms: number};
    assert(leased.retry_after_ms > 1000 && leased.retry_after_ms <= 60000, 'a leased job is paced by its lease');
    const retried = await rpc<Receipt & {retry_after_ms: number}>(db, 'retry_energy_planning_attempt',
      {...attemptIdentity(owned), code: 'planning_deadline_exceeded', detail: 'Synthetic worker timeout'});
    assert(retried.retry_after_ms >= 1000, 'a retried job is paced by its retry time');
    await db.query("UPDATE private.energy_planning_jobs SET wake_after=clock_timestamp()-interval '1 second' WHERE id=$1", [accepted.job_id]);
    assertEquals((await read(db, accepted.job_id) as Receipt & {retry_after_ms: number}).retry_after_ms, 1000, 'never below a second once it has been claimed');
  } finally { await db.close(); }
});

Deno.test('completed connected execution input is archived atomically and survives admission pruning without changing admission', async () => {
  const db = await ownershipDatabase();
  try {
    await db.exec(await migration('20261126153000_archive_completed_planning_inputs'));
    const original = { model_version: 'synthetic-version', reference: null,
      snapshot: { slots: [], room_network_capture: { rooms: [{ key: 'synthetic-room' }] } } };
    const args = { ...capturedSubmission(snapshot, { model_version: 'synthetic-version', accepted_reference_revision: 0 }), input: original };
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    const owner = (await attemptClaim(db, accepted.job_id))!;
    const execution = { ...original, snapshot: { slots: [], room_network: { nodes: [{ key: 'synthetic-room',
      model: { incoming: [{ mean_log_per_h: -2, reversion_per_h: .02, stationary_variance: .4 }] },
      posterior: { through_ms: 123, temperature_c: 20, log_rates: [-1.8], covariance: [[.03]] } }] } } };
    const publication = { ...attemptIdentity(owner), current: { ...currentRow(), snapshot: execution.snapshot }, run: runRow(),
      execution_input: execution, runtime_version: 'synthetic-runtime' };
    await assertRejects(() => rpc(db, 'publish_energy_planning_job', { ...publication,
      execution_input: original }), Error, 'Completed planning input');
    await db.exec(`CREATE FUNCTION private.reject_execution_archive() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic archive failure'; END; $$;
      CREATE TRIGGER reject_archive BEFORE INSERT ON private.energy_planning_current_input
      FOR EACH ROW EXECUTE FUNCTION private.reject_execution_archive();`);
    await assertRejects(() => rpc(db, 'publish_energy_planning_job', publication), Error, 'synthetic archive failure');
    assertEquals((await read(db, owner.id))?.state, 'pending');
    assertEquals((await db.query('SELECT count(*)::integer AS n FROM energy_optimisation_plan_runs')).rows, [{ n: 0 }]);
    await db.exec('DROP TRIGGER reject_archive ON private.energy_planning_current_input');
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', publication)).state, 'published');
    assertEquals((await db.query<{ input: unknown }>('SELECT input FROM private.energy_planning_jobs WHERE id=$1', [owner.id])).rows[0].input, original);
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', { ...publication, execution_input: original })).state, 'published',
      'a lost publication reply cannot overwrite the completed execution input');
    const archived = async (scope = home) => (await db.query<{ value: unknown }>('SELECT get_energy_planning_current_input($1,$2) AS value', [scope, plan])).rows[0].value;
    assertEquals(await archived(other), null);
    assertEquals(await archived(), { input: execution, snapshot_hash: currentRow().input_hash,
      planner_version: 'synthetic-version', runtime_version: 'synthetic-runtime' });
    await db.query('DELETE FROM private.energy_planning_jobs WHERE id=$1', [owner.id]);
    assertEquals((await archived() as { input: unknown }).input, execution, 'run provenance survives short-lived job scratch');
    await db.exec('SET ROLE authenticated');
    await assertRejects(() => archived(), Error, 'permission denied');
    const portal = async (scope = home) => (await db.query<{ value: unknown }>(
      'SELECT get_energy_planning_replay($1,$2) AS value', [scope, plan])).rows[0].value;
    assertEquals(await portal(), null, 'no customer access discloses no captured inputs');
    await db.query("SELECT set_config('test.customer',$1,false)", [home]);
    assertEquals((await portal() as { input: unknown }).input, execution, 'owner downloads exact completed input after job pruning');
    assertEquals(await portal(other), null, 'home ID must match the archived run');
    await db.query("SELECT set_config('test.customer',$1,false)", [other]);
    assertEquals(await portal(), null, 'another customer cannot read the run');
    await assertRejects(() => db.query('SELECT * FROM private.energy_planning_current_input'), Error, 'permission denied');
    await db.exec('RESET ROLE');
    await db.exec('SET ROLE anon');
    await assertRejects(() => portal(), Error, 'permission denied');
    await db.exec('RESET ROLE');
    const currentOwnership = await acceptedState(db);
    const nextInput = { ...execution, snapshot: { ...execution.snapshot, snapshot_id: nextManual } };
    const nextAccepted = await rpc<Receipt>(db, 'accept_energy_planning_job', {
      ...capturedSubmission(nextManual, { model_version: 'synthetic-version', accepted_reference_revision: currentOwnership.accepted_reference_revision,
        reference_plan_id: currentOwnership.reference_plan_id }), input: nextInput,
    });
    const nextOwner = (await attemptClaim(db, nextAccepted.job_id))!;
    assertEquals((await rpc<Receipt>(db, 'publish_energy_planning_job', { ...attemptIdentity(nextOwner),
      current: { ...currentRow(), plan_id: other, snapshot_id: nextManual, snapshot: nextInput.snapshot },
      run: { ...runRow(), id: other, snapshot_id: nextManual }, execution_input: nextInput, runtime_version: 'synthetic-runtime' })).state, 'published');
    assertEquals(await archived(), null, 'superseded plans do not retain full execution payloads');
    assertEquals((await db.query('SELECT count(*)::integer AS n FROM private.energy_planning_current_input')).rows, [{ n: 1 }]);
    assertEquals((await db.query('SELECT count(*)::integer AS n FROM energy_optimisation_plan_runs')).rows, [{ n: 2 }],
      'existing historical summaries are retained independently');
  } finally { await db.close(); }
});

Deno.test('native execution checkpoints preserve frozen input and advance fenced room or work cursors across polls', async () => {
  const db = await ownershipDatabase();
  try {
    await db.exec(await migration('20261126153000_archive_completed_planning_inputs'));
    await db.exec(await migration('20261126153100_durable_connected_planning_execution'));
    const original = { model_version: 'synthetic-version', reference: null,
      snapshot: { snapshot_id: snapshot, room_network_capture: { rooms: [] } } };
    const args = { ...capturedSubmission(snapshot, { model_version: 'synthetic-version', accepted_reference_revision: 0 }), input: original };
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    let owner = (await attemptClaim(db, accepted.job_id))!;
    const execution = { ...original, snapshot: { snapshot_id: snapshot, room_network: { nodes: [],
      forecast: { revision: 'synthetic', seed: [1, 2], accuracy_revision: 'synthetic', replicates: 4, runtime: 'synthetic', wasm_sha256: 'synthetic' } } } };
    const state = (next_room: number, cursor?: number, runtime = 'synthetic-v8') => ({ revision: 'synthetic-execution-v1', runtime,
      progress: { stage: 'prepare', room_progress: { snapshot_id: snapshot, next_room,
        ...(cursor === undefined ? {} : { network_work: { revision: 'joint_ou_philox_v1', cursor, state: {} } }) } } });
    const load = async (scope = home, fence = owner.fence) => (await db.query<{ value: { cursor: number; input: unknown; state: unknown } | null }>(
      'SELECT load_energy_planning_execution($1,$2,$3) AS value', [scope, owner.id, fence])).rows[0].value;
    const checkpoint = async (cursor: number, next: unknown, input: unknown = execution, fence = owner.fence) => (await db.query<{ value: Receipt | null }>(
      'SELECT checkpoint_energy_planning_execution($1,$2,$3,$4,$5,$6) AS value',
      [home, owner.id, fence, cursor, JSON.stringify(input), JSON.stringify(next)])).rows[0].value;
    assertEquals(await load(other), null);
    assertEquals(await load(home, owner.fence + 1), null);
    assertEquals(await load(), { cursor: 0, input: null, state: null });
    assertEquals(await checkpoint(0, state(1), execution, owner.fence + 1), null);
    assertEquals((await checkpoint(0, state(1)))?.pending, true);
    assertEquals(await load(), null, 'checkpoint releases the lease');
    owner = (await attemptClaim(db, accepted.job_id))!;
    assertEquals(await load(), { cursor: 1, input: execution, state: state(1) });
    assertEquals(await checkpoint(0, state(2, 1)), null, 'duplicate response cannot advance twice');
    await assertRejects(() => checkpoint(1, state(2, 1), { ...execution, reference: { changed: true } }), Error, 'frozen');
    assertEquals((await checkpoint(1, state(2, 1)))?.pending, true);
    owner = (await attemptClaim(db, accepted.job_id))!;
    await assertRejects(() => checkpoint(2, state(2, 1)), Error, 'did not advance');
    assertEquals((await checkpoint(2, state(2, 2)))?.pending, true);
    owner = (await attemptClaim(db, accepted.job_id))!;
    assertEquals((await checkpoint(3, state(1, undefined, 'new-runtime')))?.pending, true, 'runtime change restarts derived native work');
    owner = (await attemptClaim(db, accepted.job_id))!;
    const prepared = { ...state(1, undefined, 'new-runtime'), progress: { stage: 'solve', prepared: {} } };
    const resolved = structuredClone(execution);
    Object.assign(resolved.snapshot.room_network.forecast, { trajectories: 128, replayed_paths: 256, replicate_trajectories: [32, 32, 32, 32] });
    const wrongSeed = structuredClone(resolved); wrongSeed.snapshot.room_network.forecast.seed = [3, 4];
    await assertRejects(() => checkpoint(4, prepared, wrongSeed), Error, 'frozen');
    const wrongPaths = structuredClone(resolved); wrongPaths.snapshot.room_network.forecast.replayed_paths = 127;
    await assertRejects(() => checkpoint(4, prepared, wrongPaths), Error, 'frozen');
    await assertRejects(() => checkpoint(4, prepared, { ...resolved, model_version: 'changed-model' }), Error, 'frozen');
    await assertRejects(() => checkpoint(4, prepared, { ...resolved, snapshot: { ...resolved.snapshot, changed_source: true } }), Error, 'frozen');
    assertEquals((await checkpoint(4, prepared, resolved))?.pending, true);
    owner = (await attemptClaim(db, accepted.job_id))!;
    assertEquals(await checkpoint(4, prepared, resolved), null, 'duplicate preparation cannot resolve counts twice');
    assertEquals((await load())!.input, resolved);
    await assertRejects(() => checkpoint(5, state(1, undefined, 'new-runtime'), resolved), Error, 'stage did not advance');
    assertEquals((await db.query<{ input: unknown }>('SELECT input FROM private.energy_planning_jobs WHERE id=$1', [owner.id])).rows[0].input, original);
    await db.exec('SET ROLE authenticated');
    await assertRejects(() => load(), Error, 'permission denied');
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});

Deno.test('completed source capture freezes native input before the first room and cannot repeat zero progress', async () => {
  const db = await ownershipDatabase();
  try {
    await db.exec(await migration('20261126153000_archive_completed_planning_inputs'));
    await db.exec(await migration('20261126153100_durable_connected_planning_execution'));
    const original = {model_version:'synthetic-version',snapshot:{snapshot_id:snapshot,room_network_capture:{rooms:[]}}};
    const accepted = await rpc<Receipt>(db,'accept_energy_planning_job',{
      ...capturedSubmission(snapshot,{model_version:'synthetic-version',accepted_reference_revision:0}),input:original,
    });
    let owner = (await attemptClaim(db,accepted.job_id))!;
    const input = {...original,snapshot:{snapshot_id:snapshot,room_network:{nodes:[]}}};
    const state = {revision:'synthetic-execution',runtime:'synthetic-runtime',progress:{stage:'prepare'}};
    const checkpoint = async (cursor:number,next:unknown) => (await db.query<{value:Receipt|null}>(
      'SELECT checkpoint_energy_planning_execution($1,$2,$3,$4,$5,$6) AS value',
      [home,owner.id,owner.fence,cursor,JSON.stringify(input),JSON.stringify(next)])).rows[0].value;
    assertEquals((await checkpoint(0,state))?.pending,true);
    owner=(await attemptClaim(db,accepted.job_id))!;
    assertEquals(await checkpoint(0,state),null,'duplicate completion cannot overwrite execution input');
    await assertRejects(()=>checkpoint(1,state),Error,'did not advance');
    const first={...state,progress:{stage:'prepare',room_progress:{snapshot_id:snapshot,next_room:1}}};
    assertEquals((await checkpoint(1,first))?.pending,true);
    assertEquals((await db.query<{input:unknown}>('SELECT input FROM private.energy_planning_jobs WHERE id=$1',[owner.id])).rows[0].input,original);
  } finally {await db.close();}
});

Deno.test('completed admission is frozen by reference with its exact JSON text and the claimed slice fence', async () => {
  const db = await ownershipDatabase();
  try {
    for (const name of ['20261126153000_archive_completed_planning_inputs','20261126153100_durable_connected_planning_execution']) {
      await db.exec(await migration(name));
    }
    await db.exec('CREATE TABLE private.energy_planning_room_source_blocks(job_id uuid); CREATE TABLE private.energy_planning_room_capture(job_id uuid);');
    await db.exec(await migration('20261126154000_owned_planning_forecast_replicas'));
    await db.exec(await migration('20261126160000_reuse_admitted_planning_input'));
    const proconfig = await db.query<{proname:string;proconfig:string[]}>(
      "SELECT proname,proconfig FROM pg_proc WHERE proname IN ('load_energy_owned_planning_stage','checkpoint_energy_owned_planning_stage','publish_energy_planning_job') ORDER BY proname");
    for (const row of proconfig.rows) assert(row.proconfig.includes('statement_timeout='+(row.proname==='publish_energy_planning_job'?'30s':'8s')));
    const match = async (a:string,b:string,omit:string[] = []) =>
      (await db.query<{ok:boolean}>('SELECT private.planning_json_matches($1::json,$2::json,$3::text[]) AS ok',[a,b,omit])).rows[0].ok;
    assert(await match('{"b":2,"a":0,"a":1.00}', '{"a":1e0,"b":2}'));
    assertEquals(await match('{"a":1,"a":2}', '{"a":1}'),false);
    assertEquals(await match('{}','{"x":null}'),false);
    assertEquals(await match('{}','{"x":{}}',['x','y']),false);
    assert(await match('{"x":{}}','{"x":{"y":null}}',['x','y']));
    const frozen = {model_version:'v',reference:null,snapshot:{snapshot_id:snapshot,room_network:{
      nodes:[{weight:1}],forecast:{seed:[1,2],replicates:2,policy:'unchanged'}}}};
    const counts = {trajectories:4,replayed_paths:8,replicate_trajectories:[2,2]};
    const resolve = async (next:unknown,source:unknown=frozen) =>
      (await db.query<{v:unknown}>('SELECT private.planning_resolve_forecast_counts($1,$2) AS v',[JSON.stringify(source),JSON.stringify(next)])).rows[0].v;
    for (const invalid of [{...counts,extra:0},{...counts,trajectories:4.5},{...counts,replayed_paths:3},
      {...counts,replicate_trajectories:[1,1]},{...counts,replicate_trajectories:[1.5,2.5]},{...counts,replicate_trajectories:[-1,5]}]) {
      await assertRejects(()=>resolve(invalid),Error,'Invalid forecast counts');
    }
    assertEquals(await resolve(null),frozen);
    const completed = {...frozen,snapshot:{...frozen.snapshot,room_network:{...frozen.snapshot.room_network,
      forecast:{...frozen.snapshot.room_network.forecast,...counts}}}};
    assertEquals(await resolve(counts),completed);
    await assertRejects(()=>resolve(counts,completed),Error,'Invalid forecast counts');
    const population = Array.from({length:1200},(_,i)=>({weight:i+1,peers:[1,2]}));
    const populationText = JSON.stringify(population);
    assert(await match(populationText,JSON.stringify(population,null,1)));
    population[population.length-1].peers.reverse();
    assertEquals(await match(populationText,JSON.stringify(population,null,1)),false);
    const version = 'synthetic-version';
    const input = `{ "snapshot": { "snapshot_id": "${snapshot}", "room_network": {"nodes":[{"value":1.2300e+2}]} }, "model_version": "${version}" }`;
    const admission = capturedSubmission(snapshot,{model_version:version,accepted_reference_revision:0});
    const receipt = (await db.query<{value:Receipt}>(
      `SELECT accept_energy_planning_job((left($1,-1)||', "input" : '||$2||'}')::json) AS value`,
      [JSON.stringify({...admission,input:undefined}),input])).rows[0].value;
    const owner = (await attemptClaim(db,receipt.job_id))!;
    const scope = [home,owner.id,owner.fence];
    const load = (await db.query<{value:{input:null;use_admitted_input:boolean;model_version:string;slice_fence:number}}>(
      'SELECT load_energy_owned_planning_stage($1,$2,$3,$4,$5) AS value',[...scope,'synthetic-revision','runtime'])).rows[0].value;
    assertEquals(load.input,null);
    assertEquals(load.use_admitted_input,true);
    assertEquals(load.model_version,version);
    const update = {phase:'prepare',use_admitted_input:true};
    const save = async (body:unknown, homeId=home, parent=owner.fence, slice=load.slice_fence, cursor=0) =>
      (await db.query<{value:{phase:string}|null}>('SELECT checkpoint_energy_owned_planning_stage($1,$2,$3,$4,$5,$6) AS value',
        [homeId,owner.id,parent,cursor,slice,JSON.stringify(body)])).rows[0].value;
    assertEquals(await save(update,other),null);
    assertEquals(await save(update,home,owner.fence+1),null);
    assertEquals(await save(update,home,owner.fence,load.slice_fence+1),null);
    assertEquals(await save(update,home,owner.fence,load.slice_fence,1),null);
    await assertRejects(()=>save({phase:'prepare',input:JSON.parse(input)}),Error,'Completed admission must use the stored planning input');
    await assertRejects(()=>save({...update,input:JSON.parse(input)}),Error,'Invalid use of admitted planning input');
    await assertRejects(()=>save({...update,use_admitted_input:null}),Error,'Invalid use of admitted planning input');
    assertEquals((await save(update))?.phase,'prepare');
    assertEquals(await save(update),null);
    assertEquals((await db.query<{input:string}>('SELECT input::text FROM private.energy_planning_execution WHERE job_id=$1',[owner.id])).rows[0].input,input);
    const premature = {...attemptIdentity(owner),current:{input_hash:'synthetic'},run:{},use_frozen_execution:true,runtime_version:'runtime'};
    assertEquals(await rpc(db,'publish_energy_planning_job',premature),null);
    await assertRejects(()=>rpc(db,'publish_energy_planning_job',{...premature,execution_input:{}}),Error,'Invalid frozen publication reference');
    await assertRejects(()=>rpc(db,'publish_energy_planning_job',{...premature,current:{snapshot:{}}}),Error,'Invalid frozen publication reference');
    // Simulate an already assembled job present when the seal migration is applied.
    await db.query("UPDATE private.energy_planning_runtime SET phase='ready',cursor=9 WHERE job_id=$1",[owner.id]);
    await db.query("UPDATE private.energy_planning_execution SET state=json_build_object('revision','synthetic-revision','runtime','runtime','progress',json_build_object('stage','solve')) WHERE job_id=$1",[owner.id]);
    await db.exec(await migration('20261126200000_seal_owned_planning_snapshots'));
    const value = async <T>(expression:string,args:unknown[]) =>
      (await db.query<{v:T}>(`SELECT ${expression} AS v`,args)).rows[0].v;
    const dispatch = () => value<{phase:string}>('private.owned_planning_dispatch($1)',[owner.id]);
    assertEquals((await dispatch()).phase,'seal');
    const getResult = () => value<{snapshot:unknown;snapshot_hash:string;input?:unknown}|null>('load_energy_owned_planning_result($1,$2,$3)',scope);
    assertEquals(await getResult(),null);
    const read = (args:unknown[]) => value('read_energy_owned_snapshot_for_hash($1,$2,$3,$4)',args);
    const exact = await read([...scope,9]);
    assertEquals(exact,JSON.parse(input).snapshot);
    const {sha256Hex} = await import('../supabase/functions/_shared/ha-device-auth.ts');
    const digest = await sha256Hex(JSON.stringify(exact));
    const seal = (args:unknown[]) => value<{phase:string}|null>('seal_energy_owned_planning_snapshot($1,$2,$3,$4,$5,$6,$7)',args);
    const valid = [...scope,9,'synthetic-revision','runtime',digest];
    for(const [index,invalid] of [[0,other],[2,null],[2,owner.fence+1],[3,8],[4,'wrong'],[5,'wrong']] as const) {
      const changed=[...valid]; changed[index]=invalid;
      assertEquals(await seal(changed),null);
    }
    assertEquals(await read([other,owner.id,owner.fence,9]),null);
    assertEquals(await read([home,owner.id,null,9]),null);
    await assertRejects(()=>seal([...valid.slice(0,-1),'invalid']),Error,'Invalid snapshot hash');
    assertEquals((await seal(valid))?.phase,'ready');
    assertEquals(await seal([...valid.slice(0,-1),'f'.repeat(64)]),null,'duplicate cannot replace digest');
    assertEquals(await read([...scope,9]),null);
    const sealed=await getResult();
    assertEquals(sealed?.snapshot,{snapshot_id:snapshot});
    assertEquals(sealed?.snapshot_hash,digest);
    assertEquals(sealed?.input,undefined);
    for(const [current,run] of [[digest,'f'.repeat(64)],['f'.repeat(64),digest]]) {
      assertEquals(await rpc(db,'publish_energy_planning_job',{...premature,current:{input_hash:current},run:{input_hash:run}}),null);
    }
    const capture = {model_version:version,snapshot:{snapshot_id:nextManual,room_network_capture:null}};
    const second = await rpc<Receipt>(db,'accept_energy_planning_job',{...capturedSubmission(nextManual,{model_version:version,accepted_reference_revision:0}),input:capture});
    const secondOwner = (await attemptClaim(db,second.job_id))!;
    const secondScope = [home,secondOwner.id,secondOwner.fence];
    const stored = (await db.query<{v:{input:unknown;use_admitted_input:boolean;slice_fence:number}}>(
      'SELECT load_energy_owned_planning_stage($1,$2,$3,$4,$5) AS v',[...secondScope,'synthetic-revision','runtime'])).rows[0].v;
    assertEquals(stored.use_admitted_input,false);
    assertEquals(stored.input,capture);
    await assertRejects(()=>db.query('SELECT checkpoint_energy_owned_planning_stage($1,$2,$3,0,$4,$5)',
      [...secondScope,stored.slice_fence,JSON.stringify(update)]),Error,'Invalid use of admitted planning input');
  } finally { await db.close(); }
});

Deno.test('owned forecast pages and replica writers retain exact authority, balanced barriers and terminal cleanup', async () => {
  // Independently synthetic catalog records; no household data or fitted model.
  const db = await ownershipDatabase();
  try {
    await db.exec(await migration('20261126153000_archive_completed_planning_inputs'));
    await db.exec(await migration('20261126153100_durable_connected_planning_execution'));
    await db.exec('CREATE TABLE private.energy_planning_room_source_blocks(job_id uuid); CREATE TABLE private.energy_planning_room_capture(job_id uuid);');
    await db.exec(await migration('20261126154000_owned_planning_forecast_replicas'));
    await db.exec(await migration('20261126160000_reuse_admitted_planning_input'));
    const original = { model_version: 'synthetic-version', reference: null, snapshot: { snapshot_id: snapshot,
      slots: [{ start: '2030-01-01T00:00:00Z' }], slot_minutes: 15, room_network_capture: { rooms: [] } } };
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', {
      ...capturedSubmission(snapshot, { model_version: 'synthetic-version', accepted_reference_revision: 0 }), input: original,
    });
    let owner = (await attemptClaim(db, accepted.job_id))!;
    type Dispatch = { phase: string; cursor: number; replicas: number[]; round: number };
    type Slice = { dispatch: Dispatch; slice_fence: number; cursor: number; identity: string; round: number; busy?: boolean };
    const sql = async <T>(query: string, args: unknown[] = []): Promise<T> =>
      (await db.query<{ value: T }>(`SELECT ${query} AS value`, args)).rows[0].value;
    const scope = () => [home, owner.id, owner.fence];
    const load = () => sql<Slice>('load_energy_owned_planning_stage($1,$2,$3,$4,$5)', [...scope(), 'synthetic-v3', 'synthetic-runtime']);
    const save = (s: Slice, update: unknown) => sql<Dispatch | null>('checkpoint_energy_owned_planning_stage($1,$2,$3,$4,$5,$6)',
      [...scope(), s.dispatch.cursor, s.slice_fence, JSON.stringify(update)]);
    const metadata = await sql<Record<string, unknown>>('load_energy_planning_metadata($1,$2,$3)', scope());
    assertEquals(metadata.connected, true); assertEquals(metadata.input, undefined);
    assertEquals(metadata.horizon_end, '2030-01-01T00:15:00+00:00');
    for (const role of ['anon','authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(()=>sql('load_energy_planning_metadata($1,$2,$3)',scope()),Error,'permission denied');
      await db.exec('RESET ROLE');
    }
    assertEquals(await sql('load_energy_planning_metadata($1,$2,$3)',[other,owner.id,owner.fence]),null);
    let s = await load();
    assertEquals((await load()).busy, true, 'duplicate request cannot claim the same stage');
    await assertRejects(()=>save(s,{phase:'prepare',use_admitted_input:true}),Error,'Invalid use of admitted planning input');
    const { room_network_capture: _pending, ...derivedSnapshot } = original.snapshot;
    const execution = { ...original, snapshot: derivedSnapshot };
    assertEquals((await save(s, { phase: 'prepare', input: execution }))?.phase, 'prepare');
    assertEquals(await save(s, { phase: 'prepare', input: execution }), null, 'lost reply cannot apply twice');
    s = await load();
    await save(s, { phase: 'catalog', identity: 'synthetic-identity', nodes: [btoa('{}')], header: btoa('{}'), context: btoa('{}') });
    s = await load();
    const records = ['{"value":"α"}', '{"value":2}'];
    const bytes = new TextEncoder().encode(records.join(''));
    const offsets = [0, new TextEncoder().encode(records[0]).length, bytes.length];
    await assertRejects(()=>save(s,{phase:'integrate',node:0,count:2,
      pages:[{first_record:0,count:2,offsets:[0,offsets[1]+1,bytes.length+1],bytes:btoa(String.fromCharCode(...bytes))}],
      header:btoa('{}'),replica_count:4,target:64}),Error,'Invalid catalog directory');
    await save(s, { phase: 'integrate', node: 0, count: 2,
      pages: [{ first_record: 0, count: 2, offsets, bytes: btoa(String.fromCharCode(...bytes)) }],
      header: btoa('{}'), replica_count: 4, target: 64 });
    const slices: Slice[] = [];
    for (let r = 0; r < 4; r++) slices.push(await sql<Slice>('claim_energy_forecast_replica($1,$2,$3,$4)', [...scope(), r]));
    assert(slices.every(p => p.slice_fence === 1), 'all four independent writers can be claimed together');
    await db.query("UPDATE private.energy_planning_jobs SET context=(context::jsonb||'{\"accepted_reference_revision\":1}'::jsonb)::json WHERE id=$1",[owner.id]);
    assertEquals(await sql('claim_energy_forecast_replica($1,$2,$3,$4)',[...scope(),0]),null,'accepted command ownership fences every child');
    await db.query("UPDATE private.energy_planning_jobs SET context=(context::jsonb||'{\"accepted_reference_revision\":0}'::jsonb)::json WHERE id=$1",[owner.id]);

    const selected = await sql<Array<{ node: number; index: number; json: string }>>('read_energy_forecast_records($1,$2,$3,$4,$5,$6,$7)',
      [...scope(), 0, slices[0].slice_fence, 'synthetic-identity', JSON.stringify([{ node: 0, index: 1 }, { node: 0, index: 0 }, { node: 0, index: 1 }])]);
    assertEquals(selected.sort((a, b) => a.index - b.index).map(p => p.json), records, 'exact UTF-8 records, deduplicated');
    await assertRejects(() => sql('read_energy_forecast_records($1,$2,$3,$4,$5,$6,$7)',
      [...scope(), 0, 1, 'synthetic-identity', '[{"node":0,"index":2}]']), Error, 'Missing forecast catalog');
    const finish = (r: number, fence = owner.fence) => sql<Dispatch | null>('checkpoint_energy_forecast_replica($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [home, owner.id, fence, r, slices[r].slice_fence, 0, 'synthetic-identity', slices[r].round, 1, 16, btoa('{}')]);
    assertEquals(await finish(0, owner.fence + 1), null);
    for (const r of [2, 0, 3]) await finish(r);
    assertEquals((await sql<Dispatch>('advance_energy_forecast_barrier($1,$2,$3)', scope())).phase, 'integrate');
    await finish(1);
    assertEquals(await finish(1), null);
    assertEquals((await sql<Dispatch>('advance_energy_forecast_barrier($1,$2,$3)', scope())).phase, 'qualify');
    s = await load();
    assertEquals((await save(s, { phase: 'integrate', target: 128, replica_count: 4 }))?.phase, 'integrate');
    const late = await sql<Slice>('claim_energy_forecast_replica($1,$2,$3,$4)', [...scope(), 0]);
    await sql('release_energy_owned_planning_attempt($1,$2,$3)', scope());
    assertEquals(await sql('checkpoint_energy_forecast_replica($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [...scope(), 0, late.slice_fence, 1, 'synthetic-identity', late.round, 2, 32, btoa('{}')]), null, 'released parent rejects late child');
    owner = (await attemptClaim(db, accepted.job_id))!;
    assert((await sql<Slice>('claim_energy_forecast_replica($1,$2,$3,$4)', [...scope(), 0])).slice_fence > late.slice_fence,
      'new owner can resume without waiting for old subordinate lease');
    const repair = (await load()).dispatch;
    assertEquals(await sql('reset_energy_owned_planning_runtime($1,$2,$3,$4,$5,$6)',
      [...scope(),repair.cursor,'wrong-identity','integrate']),false);
    assertEquals(await sql('reset_energy_owned_planning_runtime($1,$2,$3,$4,$5,$6)',
      [...scope(),repair.cursor,'synthetic-identity','integrate']),true);
    assertEquals(await sql('(SELECT input FROM private.energy_planning_jobs WHERE id=$1)',[owner.id]),original,
      'repair preserves immutable admission');
    assertEquals((await load()).dispatch.phase,'capture');
    await rpc(db,'retry_energy_planning_attempt',{...attemptIdentity(owner),code:'planning_worker_rate_limited',detail:'Synthetic provider limit',retry_after_ms:43_210});
    const remaining=await sql<number>('(SELECT extract(epoch FROM wake_after-clock_timestamp())*1000 FROM private.energy_planning_jobs WHERE id=$1)',[owner.id]);
    assert(remaining>42_000&&remaining<=43_210,'provider retry delay survives durable receipt scheduling');
    assertEquals(await attemptClaim(db,accepted.job_id),null);
    await db.query("UPDATE private.energy_planning_jobs SET wake_after=clock_timestamp()-interval '1 second' WHERE id=$1",[owner.id]);
    owner=(await attemptClaim(db,accepted.job_id))!;
    await rpc(db, 'fail_energy_planning_job', { ...attemptIdentity(owner), code: 'synthetic_terminal', detail: 'Synthetic terminal cleanup' });
    for (const table of ['energy_planning_runtime', 'energy_forecast_catalog_nodes', 'energy_forecast_catalog_pages', 'energy_forecast_replicas']) {
      assertEquals(await sql<number>(`(SELECT count(*)::integer FROM private.${table})`), 0);
    }
  } finally { await db.close(); }
});

Deno.test('owned SQL worker publishes immutable completed arguments and downloaded replay reproduces the plan', async () => {
  const { createClient } = await import('npm:@supabase/supabase-js@2.90.1');
  const { PlanningJobs } = await import('../supabase/functions/_shared/energy-planning-jobs.ts');
  const { handleEnergyPlanningStep } = await import('../supabase/functions/_shared/energy-planning-worker.ts');
  const { connectedRoomSnapshot } = await import('../supabase/functions/_shared/room-network.fixture.ts');
  const { CONNECTED_CAPTURE_IMPLEMENTATION } = await import('../supabase/functions/_shared/connected-room-planning-capture.ts');
  const { RULES_MODEL_VERSION, RULES_PLANNING_PROTOCOL } = await import('../supabase/functions/_shared/rules-planner-identity.ts');
  const { replayExecution } = await import('../src/lib/energy-shift/plan-replay.ts');
  const { executeRulesPlanning } = await import('../supabase/functions/_shared/rules-planning-execution.ts');
  const { sha256Hex } = await import('../supabase/functions/_shared/ha-device-auth.ts');
  const { unpackOwnedPlanningValue } = await import('../supabase/functions/_shared/owned-planning-codec.ts');
  const db = await ownershipDatabase();
  try {
    await db.exec(await migration('20261126153000_archive_completed_planning_inputs'));
    await db.exec(await migration('20261126153100_durable_connected_planning_execution'));
    await db.exec('CREATE TABLE private.energy_planning_room_source_blocks(job_id uuid); CREATE TABLE private.energy_planning_room_capture(job_id uuid,state json);');
    // Source qualification/replay has separate actual SQL tests. This fixture
    // starts at its completed immutable state; every subsequent RPC is production.
    await db.exec(`CREATE FUNCTION public.load_energy_planning_room_capture(p_home_id uuid,p_job_id uuid,p_fence bigint) RETURNS json LANGUAGE sql AS $$
      SELECT json_build_object('cursor',42,'state',state) FROM private.energy_planning_room_capture WHERE job_id=$2 $$;`);
    await db.exec(await migration('20261126154000_owned_planning_forecast_replicas'));
    await db.exec(await migration('20261126160000_reuse_admitted_planning_input'));
    await db.exec(await migration('20261126200000_seal_owned_planning_snapshots'));
    const connected = connectedRoomSnapshot(); connected.snapshot_id = snapshot;
    connected.operating_scope = { modes: { $battery:'controlling',$pool:'controlling',$ev:'controlling','synthetic-a':'controlling' },
      device_owners: { 'synthetic-a-heater':'synthetic-a' }, external_demands: {} };
    Object.assign(connected, rulesFixtureInput(connected).snapshot);
    const nodes = connected.room_network!.nodes;
    const admitted = structuredClone(connected); admitted.room_network = undefined;
    admitted.room_network_capture = { rooms: nodes.map(node => {
      const zone = connected.thermal_zones!.find(zone => zone.key === node.key);
      return { key:node.key,name:node.key,device_keys:zone?.device_keys??[],model:zone?.model??null,
        connected_exchange:{...node.model,incoming:[]},rated_power_w:zone?.rated_power_w??0,
        maximum_power_w_by_slot:zone?.maximum_power_w_by_slot??[] };
    }), observations: [] };
    const input = captureRulesPlanningInput({ snapshot:admitted, now:admitted.captured_at,
      resolved_price_outlook:rulesFixtureInput(admitted).price_outlook },null,resolveRulePolicy());
    const original = JSON.parse(JSON.stringify(input));
    const args = { ...capturedSubmission(snapshot,{model_version:RULES_MODEL_VERSION,accepted_reference_revision:0}),input,protocol:RULES_PLANNING_PROTOCOL };
    const accepted = await rpc<Receipt>(db,'accept_energy_planning_job',args);
    await db.query('INSERT INTO private.energy_planning_room_capture VALUES($1,$2)',[accepted.job_id,JSON.stringify({version:1,
      implementation:CONNECTED_CAPTURE_IMPLEMENTATION,runtime:Deno.version.v8,room:nodes.length,phase:'complete',
      from_at:admitted.captured_at,next_from_at:admitted.captured_at,policy:null,row:0,nodes,warnings:[]})]);
    const calls: string[] = [], bytes = { http_request:0,http_response:0,db_request:0,db_response:0,http_calls:0,max_http_request:0,max_http_response:0 };
    let publication: Record<string,unknown> | undefined;
    const stageCheckpoints: {phase:string;pending:boolean;next_room?:number}[] = [];
    const client = createClient('http://localhost:54321','synthetic-service',{auth:{persistSession:false},global:{fetch:async(url,init)=>{
      const name = String(url).split('/').at(-1)!; const body = JSON.parse(String(init?.body??'{}'));
      if (!String(url).includes('/rpc/')) return Response.json([]);
      calls.push(name); bytes.db_request+=new TextEncoder().encode(String(init?.body??'')).length;
      if(name==='publish_energy_planning_job') publication=body;
      if(name==='checkpoint_energy_owned_planning_stage') {
        const update=body.p_update;
        const progress=update.phase==='prepare'&&update.payload ? await unpackOwnedPlanningValue<{forecast_pending?:true;next_room:number}>(update.payload) : null;
        stageCheckpoints.push({phase:update.phase,pending:progress?.forecast_pending===true,next_room:progress?.next_room});
      }
      try {
        const signatures = (await db.query<{proargnames:string[]|null}>('SELECT proargnames FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=\'public\' AND p.proname=$1',[name])).rows;
        if(!signatures.length) return Response.json([]); // non-critical activity archive outside this fixture
        const names = Object.keys(body); assert(names.every(key=>/^[a-z_]+$/.test(key)));
        const named = signatures.some(signature=>signature.proargnames?.includes(names[0]));
        const query = named ? `SELECT public.${name}(${names.map((key,i)=>`${key}=>$${i+1}`).join(',')}) AS value` : `SELECT public.${name}($1::json) AS value`;
        const values = named ? names.map(key=>typeof body[key]==='object'?JSON.stringify(body[key]):body[key]) : [JSON.stringify(body)];
        const data = (await db.query<{value:unknown}>(query,values)).rows[0].value;
        const response=Response.json(data); bytes.db_response+=(await response.clone().arrayBuffer()).byteLength; return response;
      } catch(error) { return Response.json({message:(error as Error).message,code:(error as {code?:string}).code??'XX000'},{status:500}); }
    }}});
    const jobs = new PlanningJobs(client,()=>Date.parse(admitted.captured_at));
    let receipt: Awaited<ReturnType<typeof jobs.advanceForHome>> = null;
    let active=0,maxActive=0;
    for(let poll=0;poll<20&&(!receipt||receipt.pending);poll++) {
      receipt=await jobs.advanceForHome(home,{jobId:accepted.job_id},{url:'https://synthetic.test',planningSecret:'synthetic'},async(url,init)=>{
        const requestBytes=new TextEncoder().encode(String(init?.body)).length;bytes.http_request+=requestBytes;bytes.max_http_request=Math.max(bytes.max_http_request,requestBytes);bytes.http_calls++;
        const body=JSON.parse(String(init?.body));assertEquals(body.stage,'owned');assertEquals(body.input,undefined);
        active++;maxActive=Math.max(maxActive,active);
        try {const response=await handleEnergyPlanningStep(new Request(url,init),'synthetic',()=>client);
          const length=(await response.clone().arrayBuffer()).byteLength;bytes.http_response+=length;bytes.max_http_response=Math.max(bytes.max_http_response,length);return response;
        } finally {active--;}
      });
    }
    assert(receipt?.state==='published',JSON.stringify(receipt)); assert(maxActive<=4);
    const compileBoundary=stageCheckpoints.findIndex(stage=>stage.pending);
    assert(compileBoundary>=0,'final proposal is durably checkpointed before forecast compilation');
    assertEquals(stageCheckpoints[compileBoundary].next_room,connected.thermal_zones!.length);
    assertEquals(stageCheckpoints[compileBoundary+1].phase,'catalog','a separate owned action compiles the forecast');
    assertEquals(stageCheckpoints.filter(stage=>stage.pending).length,1);
    assert(!calls.includes('load_energy_planning_attempt'),'parent never loads expanded admission per poll');
    assertEquals(JSON.parse(JSON.stringify(input)),original);
    assertEquals(calls.filter(name=>name==='seal_energy_owned_planning_snapshot').length,1);
    assertEquals(publication!.use_frozen_execution,true);
    assertEquals(publication!.execution_input,undefined);
    assertEquals((publication!.current as {snapshot?:unknown}).snapshot,undefined);
    const archived=(await db.query<{input:typeof input}>('SELECT input FROM private.energy_planning_current_input WHERE job_id=$1',[accepted.job_id])).rows[0].input;
    const {room_network:_network,room_network_capture:_capture,...operational}=archived.snapshot;
    assertEquals((await db.query<{snapshot:unknown}>('SELECT snapshot FROM energy_optimisation_current WHERE home_id=$1',[home])).rows[0].snapshot,operational);
    assertEquals(archived.snapshot.room_network_capture,undefined);assertEquals(archived.snapshot.room_network!.nodes,nodes);
    const forecast=archived.snapshot.room_network!.forecast;
    assertEquals(forecast.seed,connected.room_network!.forecast.seed);assertEquals(forecast.runtime,Deno.version.v8);
    assert(Number.isSafeInteger(forecast.trajectories)&&forecast.trajectories!>0);
    assert(Number.isSafeInteger(forecast.replayed_paths)&&forecast.replayed_paths!>=forecast.trajectories!);
    assertEquals(forecast.replicate_trajectories!.length,4);
    assertEquals(forecast.replicate_trajectories!.reduce((sum,n)=>sum+n,0),forecast.trajectories);
    const hash=await sha256Hex(JSON.stringify(archived.snapshot));
    assertEquals((publication!.current as {input_hash:string}).input_hash,hash);
    assertEquals((publication!.run as {input_hash:string}).input_hash,hash);
    const downloaded=JSON.parse(JSON.stringify(replayExecution({input:archived,snapshot_hash:hash,planner_version:archived.model_version,runtime_version:Deno.version.v8})));
    assertEquals(downloaded.entrypoint.export,'executeRulesPlanning');
    assertEquals(JSON.parse(JSON.stringify(executeRulesPlanning(downloaded.entrypoint.arguments).plan)),JSON.parse(JSON.stringify(receipt.plan)));
    assertEquals((await db.query('SELECT count(*)::integer AS n FROM private.energy_forecast_catalog_pages')).rows,[{n:0}]);
    assertEquals((await db.query('SELECT count(*)::integer AS n FROM private.energy_planning_current_input')).rows,[{n:1}]);
    assertEquals((await db.query('SELECT count(*)::integer AS n FROM private.energy_planning_execution')).rows,[{n:0}], 'current replay owns the only completed execution copy');
    console.info('owned synthetic transport bytes',bytes);
  } finally {await db.close();}
});
