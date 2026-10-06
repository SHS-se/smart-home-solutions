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
  completed: unknown[]; rankings: unknown[] };

async function database() {
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
  await db.exec(`UPDATE private.energy_planning_credentials SET function_url=
    'https://example.supabase.co/functions/v1/energy-optimisation-planning-worker';`);
  return db;
}

async function rpc<T>(db: PGlite, name: string, value: unknown): Promise<T> {
  return (await db.query<{ value: T }>(`SELECT ${name}($1::json) AS value`, [JSON.stringify(value)])).rows[0].value;
}
async function claim(db: PGlite, job: string): Promise<Claim | null> {
  return (await db.query<{ value: Claim | null }>('SELECT claim_energy_planning_step($1) AS value', [job])).rows[0].value;
}
async function read(db: PGlite, job: string, homeId = home): Promise<Receipt | null> {
  return (await db.query<{ value: Receipt | null }>('SELECT read_energy_planning_job($1,$2) AS value', [homeId, job])).rows[0].value;
}
function submission(snapshotId = snapshot, context: Record<string, unknown> = {}) {
  const frozenContext: Record<string, unknown> = { request_id: 'request-1', integration_version: 'test', fixed_revision: 0,
    observed_replan_request_id: null, replan_request_id: null, ...context };
  return { home_id: home, customer_id: home, snapshot_id: snapshotId, source_hash: 'a'.repeat(64), protocol: 1,
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

Deno.test('planning RPCs are service-only, ordered JSON is frozen, and checkpoint ledgers append once', async () => {
  const db = await database();
  try {
    const args = submission(snapshot, { exchange: { watermarks: { z: 1, a: 2 } } });
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(() => rpc(db, 'accept_energy_planning_job', args), Error, 'permission denied');
      await assertRejects(() => read(db, snapshot), Error, 'permission denied');
      await assertRejects(() => claim(db, snapshot), Error, 'permission denied');
      for (const name of ['commit_energy_planning_step', 'publish_energy_planning_job', 'fail_energy_planning_job']) {
        await assertRejects(() => rpc(db, name, {}), Error, 'permission denied');
      }
      await assertRejects(() => db.query('SELECT verify_energy_planning_token($1)', ['wrong']), Error, 'permission denied');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    await assertRejects(() => db.query('SELECT * FROM private.energy_planning_jobs'), Error, 'permission denied');
    assertEquals((await db.query<{ ok: boolean }>('SELECT verify_energy_planning_token($1) ok', ['wrong'])).rows[0].ok, false);
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    assertEquals(accepted.state, 'pending');
    const dup = await rpc<Receipt>(db, 'accept_energy_planning_job', args);
    assertEquals(dup.job_id, accepted.job_id);
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', { ...args, source_hash: 'b'.repeat(64) }), Error, 'identity reused');
    assertEquals(await read(db, accepted.job_id, other), null);
    assertEquals((await read(db, accepted.job_id))?.exchange, undefined);
    const snapshotRead = (await db.query<{ value: Receipt }>('SELECT read_energy_planning_job($1,NULL,$2) value', [home, snapshot])).rows[0].value;
    assertEquals(snapshotRead.exchange, args.context.exchange);
    assertEquals(Object.keys((snapshotRead.exchange as { watermarks: object }).watermarks), ['z', 'a']);
    const first = (await claim(db, accepted.job_id))!;
    assertEquals(Object.keys(first.input.devices), ['z_device', 'a_device', 'middle']);
    assertEquals(await claim(db, accepted.job_id), null, 'Only one invocation owns a cursor');
    const step = { job_id: first.id, fence: first.fence, step: first.step,
      phase: 'solving', continuation: { z_cursor: 1, a_cursor: 2 },
      completed: [{ z_cost: 1, a_cost: 2 }], rankings: [{ z_rank: 2, a_rank: 1 }] };
    assertEquals((await rpc<Receipt>(db, 'commit_energy_planning_step', step)).state, 'pending');
    assertEquals(await rpc(db, 'commit_energy_planning_step', step), null, 'Replay cannot append twice');
    const next = (await claim(db, accepted.job_id))!;
    assertEquals(next.step, first.step + 1);
    assert(next.fence > first.fence);
    assertEquals(next.completed, step.completed);
    assertEquals(next.rankings, step.rankings);
    assertEquals(Object.keys(next.completed[0] as object), ['z_cost', 'a_cost']);
    assertEquals(Object.keys(next.continuation as object), ['z_cursor', 'a_cursor']);
    assertEquals(await rpc(db, 'commit_energy_planning_step', { ...step, fence: next.fence }), null, 'Old cursor cannot commit');
    assertEquals(await rpc(db, 'fail_energy_planning_job', { job_id: next.id, step: next.step, code: 'test', detail: 'Missing fence' }), null);
    await db.exec('RESET ROLE');
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM net.wakes')).rows[0].n, 2);
    assertEquals((await db.query<{ timeout_milliseconds: number }>('SELECT timeout_milliseconds FROM net.wakes')).rows,
      [{ timeout_milliseconds: 30000 }, { timeout_milliseconds: 30000 }]);
    assertEquals((await db.query('SELECT schedule FROM cron.schedules')).rows, [{ schedule: '10 seconds' }]);
    assertEquals((await db.query<{ ok: boolean }>('SELECT verify_energy_planning_token(token) ok FROM private.energy_planning_credentials')).rows[0].ok, true);
    const signatures = await db.query<{ proargnames: unknown }>(`SELECT proargnames FROM pg_proc
      WHERE oid IN ('accept_energy_planning_job(json)'::regprocedure,'commit_energy_planning_step(json)'::regprocedure,
        'publish_energy_planning_job(json)'::regprocedure,'fail_energy_planning_job(json)'::regprocedure)`);
    assertEquals(signatures.rows.map(row => row.proargnames), [null, null, null, null]);
    assertEquals((await db.query<{ proconfig: string[] }>(`SELECT proconfig FROM pg_proc
      WHERE oid='publish_energy_planning_job(json)'::regprocedure`)).rows[0].proconfig,
      ['search_path=public, private', 'statement_timeout=30s']);
  } finally { await db.close(); }
});

Deno.test('expired leases fence old workers and repeated expiry fails only the bound manual request', async () => {
  const db = await database();
  try {
    await insertCurrent(db);
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1,replan_requested_at=now()', [manual]);
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', submission(snapshot,
      { observed_replan_request_id: manual, replan_request_id: manual }));
    let owned = (await claim(db, accepted.job_id))!;
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [owned.id]);
    assertEquals(await rpc(db, 'commit_energy_planning_step', { job_id: owned.id, fence: owned.fence, step: owned.step,
      completed: [], rankings: [], continuation: null, phase: 'solving' }), null);
    const resumed = (await claim(db, accepted.job_id))!;
    assert(resumed.fence > owned.fence);
    assertEquals(resumed.step, owned.step);
    assertEquals(await rpc(db, 'fail_energy_planning_job', { job_id: owned.id, fence: owned.fence, step: owned.step,
      code: 'old', detail: 'Old worker failure' }), null);
    // A committed checkpoint resets the repeated-expiry counter.
    await rpc(db, 'commit_energy_planning_step', { job_id: resumed.id, fence: resumed.fence, step: resumed.step,
      completed: [], rankings: [], continuation: null, phase: 'solving' });
    owned = (await claim(db, accepted.job_id))!;
    for (let index = 0; index < 4; index++) {
      await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [owned.id]);
      const renewed = await claim(db, accepted.job_id);
      if (index < 3) { assert(renewed); owned = renewed; } else assertEquals(renewed, null);
    }
    assertEquals((await read(db, owned.id))?.code, 'worker_lease_expired');
    const state = (await db.query<{ error: string; completed: string | null }>('SELECT replan_error error,replan_completed_request_id completed FROM energy_optimisation_current')).rows[0];
    assert(state.error.includes('repeatedly'));
    assertEquals(state.completed, null);
  } finally { await db.close(); }
});

Deno.test('received-order supersession ignores source time and rejects stale manual/fixed preparation', async () => {
  const db = await database();
  try {
    await insertCurrent(db);
    const first = await rpc<Receipt>(db, 'accept_energy_planning_job', submission());
    const oldClaim = (await claim(db, first.job_id))!;
    const newer = await rpc<Receipt>(db, 'accept_energy_planning_job', { ...submission(other),
      input: { captured_at: '2000-01-01T00:00:00Z', devices: { z_device: 4, a_device: 5 } } });
    assertEquals((await read(db, first.job_id))?.state, 'superseded');
    assertEquals(await rpc(db, 'fail_energy_planning_job', { job_id: oldClaim.id, fence: oldClaim.fence,
      step: oldClaim.step, code: 'old', detail: 'An old job failed' }), null);
    assertEquals((await db.query<{ error: string | null }>('SELECT replan_error error FROM energy_optimisation_current')).rows[0].error, null);
    const newerClaim = (await claim(db, newer.job_id))!;
    await db.query('UPDATE energy_optimisation_current SET replan_request_id=$1,replan_error=NULL', [manual]);
    assertEquals(await rpc(db, 'commit_energy_planning_step', { job_id: newer.job_id,
      fence: newerClaim.fence, step: newerClaim.step, completed: [], rankings: [], continuation: null, phase: 'solving' }), null);
    assertEquals((await read(db, newer.job_id))?.state, 'superseded');
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', submission(plan)), Error, 'changed during preparation');
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', submission(plan,
      { observed_replan_request_id: manual, replan_request_id: nextManual })), Error, 'changed during preparation');
    const fixedJob = await rpc<Receipt>(db, 'accept_energy_planning_job', submission(plan, { observed_replan_request_id: manual }));
    const fixedClaim = (await claim(db, fixedJob.job_id))!;
    await db.exec('UPDATE energy_optimisation_current SET fixed_plan_revision=1');
    assertEquals(await rpc(db, 'fail_energy_planning_job', { job_id: fixedJob.job_id, fence: fixedClaim.fence,
      step: fixedClaim.step, code: 'old', detail: 'Old fixed plan failed' }), null);
    assertEquals((await read(db, fixedJob.job_id))?.state, 'superseded');
  } finally { await db.close(); }
});

Deno.test('publication atomically writes plan, run, request and job while preserving operational state', async () => {
  const db = await database();
  try {
    await insertCurrent(db);
    await db.query(`UPDATE energy_optimisation_current SET replan_request_id=$1,replan_requested_at=now(),
      ha_runtime='{"running":true}',replan_recommendations=$2`, [manual, [
      { key: 'before', occurred_at: '2026-10-06T08:30:00Z' },
      { key: 'during', occurred_at: '2026-10-06T08:32:00Z' },
    ]]);
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', submission(snapshot, { observed_replan_request_id: manual }));
    const solveClaim = (await claim(db, accepted.job_id))!;
    await rpc(db, 'commit_energy_planning_step', { job_id: solveClaim.id, fence: solveClaim.fence,
      step: solveClaim.step, completed: [], rankings: [], continuation: null, phase: 'assembling' });
    const owned = (await claim(db, accepted.job_id))!;
    const publish = { job_id: owned.id, fence: owned.fence, step: owned.step,
      current: { ...currentRow(), ha_runtime: null, replan_request_id: null, fixed_plan: null }, run: runRow() };
    // The current-plan write succeeds, then the run constraint fails. Everything rolls back.
    await assertRejects(() => rpc(db, 'publish_energy_planning_job', { ...publish, run: { ...runRow(), status: 'invalid' } }), Error, 'check constraint');
    assertEquals((await db.query<{ id: string }>('SELECT plan_id id FROM energy_optimisation_current')).rows[0].id, other);
    assertEquals((await read(db, owned.id))?.state, 'pending');
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM energy_optimisation_plan_runs')).rows[0].n, 0);
    assertEquals((await db.query<{ id: string | null }>('SELECT replan_completed_request_id id FROM energy_optimisation_current')).rows[0].id, null);
    await assertRejects(() => rpc(db, 'publish_energy_planning_job', { ...publish,
      current: { ...publish.current, generation_request_id: 'other-request' } }), Error, 'identity mismatch');
    const published = await rpc<Receipt>(db, 'publish_energy_planning_job', publish);
    assertEquals(published.state, 'published');
    assertEquals(published.plan, undefined, 'Worker publication acknowledgement does not transfer the plan again');
    assertEquals((await read(db, owned.id))?.plan, currentRow().plan);
    const state = (await db.query<{ value: Record<string, unknown> }>('SELECT to_jsonb(c) value FROM energy_optimisation_current c')).rows[0].value;
    assertEquals(state.replan_request_id, manual);
    assertEquals(state.replan_completed_request_id, manual);
    assertEquals(state.ha_runtime, { running: true });
    assertEquals(state.ha_ack_status, 'pending');
    assertEquals(state.replan_recommendations, [{ key: 'during', occurred_at: '2026-10-06T08:32:00Z' }]);
    assertEquals((await db.query<{ id: string }>('SELECT id FROM energy_optimisation_plan_runs')).rows[0].id, plan);
    assertEquals(await rpc(db, 'publish_energy_planning_job', publish), null);
    assertEquals(await rpc(db, 'fail_energy_planning_job', { job_id: owned.id, fence: owned.fence, step: owned.step,
      code: 'late', detail: 'Late failure' }), null);
    // A poll for an older published job must never substitute a newer plan.
    await db.query('SELECT store_energy_optimisation_current($1::jsonb)', [JSON.stringify({ ...currentRow(),
      plan_id: other, plan: { mode: 'live', plan_id: other } })]);
    assertEquals((await read(db, owned.id))?.state, 'superseded');
    assertEquals((await read(db, owned.id))?.plan, undefined);
  } finally { await db.close(); }
});

Deno.test('cron recovers missed wakes and retention removes bounded terminal history only', async () => {
  const db = await database();
  try {
    const accepted = await rpc<Receipt>(db, 'accept_energy_planning_job', submission());
    await db.query("UPDATE private.energy_planning_jobs SET wake_after=now()-interval '1 second' WHERE id=$1", [accepted.job_id]);
    await db.exec('SELECT private.sweep_energy_planning_jobs()');
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM net.wakes')).rows[0].n, 2);
    await db.exec('SELECT private.sweep_energy_planning_jobs()');
    assertEquals((await db.query<{ n: number }>('SELECT count(*)::int n FROM net.wakes')).rows[0].n, 2);
    // Pending work has no age validity gate or retention deadline.
    await db.query("UPDATE private.energy_planning_jobs SET created_at=now()-interval '30 days' WHERE id=$1", [accepted.job_id]);
    for (let index = 0; index < 105; index++) {
      await db.query(`INSERT INTO private.energy_planning_jobs(home_id,customer_id,snapshot_id,source_hash,revision,
        protocol,input,context,state,finished_at) VALUES($1,$1,gen_random_uuid(),'old',0,1,'{}','{}','superseded',now()-interval '8 days')`, [home]);
    }
    await db.exec(`INSERT INTO private.energy_planning_jobs(home_id,customer_id,snapshot_id,source_hash,revision,
      protocol,input,context,state,finished_at) VALUES
      ('${home}','${home}',gen_random_uuid(),'recent failure',0,1,'{}','{}','failed',now()-interval '8 days'),
      ('${home}','${home}',gen_random_uuid(),'old failure',0,1,'{}','{}','failed',now()-interval '15 days');`);
    await db.exec('SELECT private.sweep_energy_planning_jobs()');
    // One old failed job uses a place in the same 100-row deletion batch.
    assertEquals((await db.query<{ n: number }>("SELECT count(*)::int n FROM private.energy_planning_jobs WHERE state='superseded'")).rows[0].n, 6);
    assertEquals((await read(db, accepted.job_id))?.state, 'pending');
    await db.exec('SELECT private.sweep_energy_planning_jobs()');
    assertEquals((await db.query<{ n: number }>("SELECT count(*)::int n FROM private.energy_planning_jobs WHERE state='superseded'")).rows[0].n, 0);
    assertEquals((await db.query<{ source_hash: string }>("SELECT source_hash FROM private.energy_planning_jobs WHERE state='failed'")).rows,
      [{ source_hash: 'recent failure' }]);
    // Misconfigured delivery is fail-fast and cannot create an unwakeable job.
    await db.exec('UPDATE private.energy_planning_credentials SET function_url=NULL');
    await assertRejects(() => rpc(db, 'accept_energy_planning_job', submission(other)), Error, 'not configured');
    assertEquals((await read(db, accepted.job_id))?.state, 'pending', 'Acceptance rollback restores previous head');
  } finally { await db.close(); }
});
