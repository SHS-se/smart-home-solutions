import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { DbStore, LocalStore, type EvaluatedResult } from '../bench/store.ts';
import { evaluate } from '../src/lib/planner-bench/evaluate.ts';
import { plan, world } from '../src/lib/planner-bench/world.fixture.ts';
import type { PlanRecord } from '../src/lib/planner-bench/types.ts';

const scenario = '11111111-1111-4111-8111-111111111111';
const c = world();
const record: PlanRecord = {
  status: 'ready', generation: 'test', valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' },
  decisions: plan(), beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh, grid_cost_sek: null }, curves: [],
};
const value = evaluate(c, record, {});

async function database() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION is_staff(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;`);
  const schema = await Deno.readTextFile('bench/schema.sql');
  await db.exec(schema);
  // Upgrade an installation with the old status constraint, then reapply idempotently.
  await db.exec("ALTER TABLE bench_runs DROP CONSTRAINT bench_runs_status_check; ALTER TABLE bench_runs ADD CONSTRAINT bench_runs_status_check CHECK (status IN ('running','done','failed'))");
  await db.exec(schema);
  await db.exec(schema); // the workflow applies it on every run
  await db.exec(`GRANT SELECT,UPDATE ON bench_results TO service_role;
    INSERT INTO bench_scenarios(id,name,captured_at) VALUES('${scenario}','Synthetic',now());
    INSERT INTO bench_runs(sha,short_sha,committed_at) VALUES('test','test',now());`);
  await db.query('UPDATE bench_scenarios SET dataset=$1::jsonb,recorded=$2::jsonb WHERE id=$3',
    [JSON.stringify(c), JSON.stringify(c.recorded), scenario]);
  await db.query(`INSERT INTO bench_results(sha,scenario_id,lane,status,input_hash,record,series,stats,outcome,score,referee_version)
    VALUES('test',$1,'told/nominal','ok','immutable',$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7)`,
    [scenario, JSON.stringify(record), JSON.stringify(value.series), JSON.stringify(value.stats),
      JSON.stringify(value.outcome), JSON.stringify(value.score), value.referee_version]);
  await db.exec("UPDATE bench_results SET case_revision=(SELECT revision FROM bench_scenarios WHERE id=bench_results.scenario_id)");
  return db;
}
const observed = async (db: PGlite) => (await db.query<EvaluatedResult>('SELECT * FROM bench_result_summaries')).rows[0];
const row = async (db: PGlite) => (await db.query<Record<string, unknown>>('SELECT * FROM bench_results')).rows[0];

Deno.test('the reapplied bench schema accepts unavailable commits and preserves exact environment marks', async () => {
  const db = await database();
  try {
    await db.exec("UPDATE bench_runs SET status='unavailable',error='This commit does not contain a planner entry point.',planner_version=NULL WHERE sha='test'");
    await db.query("SELECT bench_set_deployed('test','production')");
    assertEquals((await db.query<{ sha: string; status: string; is_current: boolean }>("SELECT sha,status,is_current FROM bench_runs")).rows,
      [{ sha: 'test', status: 'unavailable', is_current: true }]);
    await assertRejects(() => db.exec("UPDATE bench_runs SET status='invented'"));
  } finally { await db.close(); }
});

Deno.test('bench mutations preserve exact evaluations, avoid unchanged fields, and reject concurrent replacements', async () => {
  const db = await database();
  const original = globalThis.fetch;
  const updates: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    assertEquals(new URL(String(url)).pathname, '/rest/v1/rpc/bench_save_evaluation');
    const { p_update } = JSON.parse(String(init!.body));
    updates.push(p_update);
    const saved = (await db.query<{ saved: boolean }>('SELECT bench_save_evaluation($1::jsonb) AS saved', [JSON.stringify(p_update)])).rows[0].saved;
    return Response.json(saved);
  };
  try {
    const store = new DbStore('https://bench.invalid','test-key', { now: () => 0, wait: () => Promise.resolve() });
    // Scorer-only change leaves the complete series and all referee output alone.
    await db.exec("UPDATE bench_results SET score=jsonb_set(score,'{version}','0')");
    let before = await row(db);
    await store.saveEvaluation(await observed(db), value);
    assertEquals(updates.at(-1)!.kind, 'score');
    assertEquals(Object.keys(updates.at(-1)!).sort(), ['guard','kind','score']);
    assertEquals(await row(db), { ...before, score: value.score });
    // An audit version change must refresh the browser's audit and score together.
    await db.exec("UPDATE bench_results SET score=jsonb_set(score,'{audit,version}','0'),series=jsonb_set(series,'{audit,version}','0')");
    before = await row(db);
    await store.saveEvaluation(await observed(db), value);
    assertEquals(updates.at(-1)!.kind, 'audit-score');
    assertEquals(Object.keys(updates.at(-1)!).sort(), ['audit','guard','kind','score']);
    assertEquals(await row(db), { ...before, score: value.score, series: value.series });
    // Referee changes and missing derived artifacts require a full evaluation.
    await db.exec('UPDATE bench_results SET referee_version=0,stats=NULL');
    before = await row(db);
    await store.saveEvaluation(await observed(db), value);
    assertEquals(updates.at(-1)!.kind, 'evaluation');
    assertEquals(await row(db), { ...before, ...value });
    for (const change of ["input_hash='replacement'", "created_at=created_at+interval '1 second'",
      "score=jsonb_set(score,'{version}','-1')", "referee_version=referee_version+1", "record=NULL"]) {
      const old = await observed(db);
      await db.exec(`UPDATE bench_results SET ${change}`);
      const changed = await row(db);
      await assertRejects(() => store.saveEvaluation(old, value), Error, 'changed during rescore');
      assertEquals(await row(db), changed);
      await db.query('UPDATE bench_results SET record=$1::jsonb', [JSON.stringify(record)]);
    }
  } finally { globalThis.fetch = original; await db.close(); }
});

Deno.test('bench coverage distinguishes SQL/JSON null sources and mutations remain service-only', async () => {
  const db = await database();
  try {
    for (const role of ['anon','authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(() => db.query("SELECT bench_save_evaluation('{}'::jsonb)"), Error, 'permission denied');
      await db.exec('RESET ROLE');
    }
    assert((await observed(db)).has_record);
    assert((await observed(db)).has_evaluation);
    await assertRejects(() => db.exec("UPDATE bench_results SET record='null'::jsonb,series='null'::jsonb"), Error, 'bench_result_json_objects');
    await db.exec('UPDATE bench_results SET record=NULL,series=NULL');
    assertEquals((await observed(db)).has_record, false);
    assertEquals((await observed(db)).has_evaluation, false);
    await db.exec('SET ROLE service_role');
    await assertRejects(() => db.query("SELECT bench_save_evaluation('{}'::jsonb)"), Error, 'Invalid benchmark');
  } finally { await db.close(); }
});

Deno.test('local partial evaluations reject derived artifacts removed after observation', async () => {
  const dir = await Deno.makeTempDir();
  const out = `${dir}/results.json`;
  try {
    const store = new LocalStore(dir, out);
    for (const kind of ['score', 'audit-score']) {
      for (const field of ['series', 'stats', 'outcome']) {
        await store.saveResult({ sha: 'test', scenario_id: scenario, lane: 'told/nominal',
          status: 'ok', error: null, cpu_ms: 0, case_revision: null, input_hash: 'immutable', record, ...value,
          score: kind === 'score' ? { ...value.score, version: 0 }
            : { ...value.score, audit: { ...value.score.audit!, version: 0 } } });
        const old = (await store.evaluatedResults())[0];
        const file = JSON.parse(await Deno.readTextFile(out));
        file.results[0][field] = null;
        const changed = JSON.stringify(file);
        await Deno.writeTextFile(out, changed);
        await assertRejects(() => store.saveEvaluation(old, value), Error, 'changed during rescore');
        assertEquals(await Deno.readTextFile(out), changed);
      }
    }
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test('schema upgrades canonicalize absent JSON artifacts once', async () => {
  const db = await database();
  try {
    await db.exec(`ALTER TABLE bench_results DROP CONSTRAINT bench_result_json_objects;
      UPDATE bench_results SET record='null'::jsonb,series='null'::jsonb,stats='null'::jsonb,outcome='null'::jsonb`);
    await db.exec(await Deno.readTextFile('bench/schema.sql'));
    const upgraded = await row(db);
    for (const field of ['record', 'series', 'stats', 'outcome']) assertEquals(upgraded[field], null);
    assertEquals((await observed(db)).has_record, false);
    assertEquals((await observed(db)).has_evaluation, false);
    await db.exec(await Deno.readTextFile('bench/schema.sql'));
    assertEquals(await row(db), upgraded);
  } finally { await db.close(); }
});

Deno.test('case revision follows content, ignores capture metadata, and fences both binding and rescoring', async () => {
  const db = await database();
  try {
    const before = await observed(db);
    const revision = (await db.query<{ revision: string }>('SELECT revision FROM bench_scenarios')).rows[0].revision;
    await db.exec("UPDATE bench_scenarios SET dataset=jsonb_set(dataset,'{origin,detail}','\"other provenance\"'),recorded=jsonb_set(recorded,'{recorded_at}','\"2026-10-07\"')");
    assertEquals((await db.query<{ revision: string }>('SELECT revision FROM bench_scenarios')).rows[0].revision, revision);
    await db.exec('UPDATE bench_results SET case_revision=NULL');
    const bind = async (hash: string) => (await db.query<{ saved: boolean }>(
      "SELECT bench_bind_result_revision('test',$1,'told/nominal',$2,$3) AS saved", [scenario, hash, revision])).rows[0].saved;
    assertEquals(await bind('wrong'), false);
    assertEquals(await bind('immutable'), true);
    assertEquals((await observed(db)).created_at, before.created_at);
    const source = await observed(db);
    await db.exec("UPDATE bench_scenarios SET dataset=jsonb_set(dataset,'{start_state,battery_soc}','0.8')");
    assert((await db.query<{ revision: string }>('SELECT revision FROM bench_scenarios')).rows[0].revision !== revision);
    assertEquals(await bind('immutable'), false);
    const saved = (await db.query<{ saved: boolean }>('SELECT bench_save_evaluation($1::jsonb) AS saved', [JSON.stringify({ guard: source, kind: 'evaluation', value })])).rows[0].saved;
    assertEquals(saved, false);
    assertEquals(await observed(db), source);
  } finally { await db.close(); }
});
