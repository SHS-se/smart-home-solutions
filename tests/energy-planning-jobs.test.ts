import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';

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
