// Synthetic planning attempt and sensor lineage; no household replay inputs.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connectedDatabase } from "./helpers/connected-room-sql.ts";
import { home } from "./helpers/room-fit-sql.ts";
const id = "55555555-5555-4555-8555-555555555555";

async function planningDatabase() {
  const db = await connectedDatabase();
    await db.exec(`CREATE TABLE private.energy_planning_jobs(id uuid PRIMARY KEY,home_id uuid,customer_id uuid,
      state text,fence bigint,lease_until timestamptz,wake_after timestamptz,input json,code text,detail text);
      CREATE FUNCTION private.energy_planning_is_current(private.energy_planning_jobs) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION private.lock_energy_planning_job(uuid) RETURNS private.energy_planning_jobs LANGUAGE sql AS $$
        SELECT j FROM private.energy_planning_jobs j WHERE id=$1 FOR UPDATE $$;
      CREATE FUNCTION private.energy_planning_receipt(private.energy_planning_jobs) RETURNS json LANGUAGE sql AS $$
        SELECT json_build_object('job_id',$1.id,'state',$1.state,'pending',true,'retry_after_ms',100) $$;`);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261126152000_staged_connected_planning_capture.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261126153200_connected_inference_prefix_cache.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261127093000_reuse_leading_room_evidence_block.sql"));
  return db;
}

Deno.test("planning capture checkpoints isolate home, fence, cursor and immutable source blocks while releasing the same attempt", async () => {
  const db = await planningDatabase();
  try {
    const context = (await db.query<{ value: { graph: { owner: string; revision: number; topology_hash: string }; binding: string; policy: string } }>(
      "SELECT get_energy_connected_planning_source_context($1,$1,'room','2001-01-01','2001-01-03') AS value", [home])).rows[0].value;
    const input = { snapshot: { room_network_capture: { rooms: [{ key: "room", connected_exchange: { basis: {
      graph_owner: context.graph.owner, graph_revision: context.graph.revision, topology_hash: context.graph.topology_hash,
    } } }] } } };
    await db.query("INSERT INTO private.energy_planning_jobs VALUES($1,$2,$2,'pending',1,now()+interval '60 seconds',now(),$3,NULL,NULL)", [id, home, JSON.stringify(input)]);
    const state = { version: 1, implementation: "synthetic-v1", runtime: "synthetic-runtime", room: 0, phase: "source", policy: context.policy };
    const bytes = new TextEncoder().encode("synthetic raw immutable bytes");
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    const raw = { room: 0, from_at: "2001-01-01T00:00:00Z", to_at: "2001-01-02T00:00:00Z", base64: btoa("synthetic raw immutable bytes"), sha256 };
    const proof = { room_key: "room", binding: context.binding, policy: context.policy, from_at: "2001-01-01", to_at: "2001-01-03" };
    const checkpoint = async (cursor: number, fence: number, next: unknown = state, block: unknown = raw, numeric: unknown = null) => (await db.query<{ value: unknown }>(
      "SELECT checkpoint_energy_planning_room_capture($1,$2,$3,$4,$5,$6,$8,$7) AS value",
      [home, id, fence, cursor, JSON.stringify(next), JSON.stringify(block), JSON.stringify(proof), JSON.stringify(numeric)])).rows[0].value;
    assertEquals(await checkpoint(0, 2), null);
    assert(await checkpoint(0, 1));
    assertEquals((await db.query("SELECT lease_until FROM private.energy_planning_jobs WHERE id=$1", [id])).rows, [{ lease_until: null }]);
    assertEquals((await db.query("SELECT count(*)::integer AS n FROM private.energy_planning_room_source_blocks WHERE job_id=$1", [id])).rows, [{ n: 1 }],
      "initial checkpoint retains its first immutable block");
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds',fence=2 WHERE id=$1", [id]);
    assertEquals(await checkpoint(0, 2), null, "duplicate/lost reply cannot append source rows twice");
    assertEquals(await checkpoint(1, 1), null);
    assert(await checkpoint(1, 2, { ...state, phase: "qualify" }, null));
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds',fence=3 WHERE id=$1", [id]);
    const loaded = (await db.query<{ value: { cursor: number; blocks: { capture: string }[] } }>(
      "SELECT load_energy_planning_room_capture($1,$2,3) AS value", [home, id])).rows[0].value;
    assertEquals(loaded.cursor, 2); assertEquals(loaded.blocks[0].capture, raw.base64);
    assertEquals((await db.query<{ input: unknown }>("SELECT input FROM private.energy_planning_jobs WHERE id=$1", [id])).rows[0].input, input);
    assert(await checkpoint(2, 3, { ...state, phase: "process" }, null,
      { ...raw, header_bytes: 0, row_bytes: bytes.length, row_count: 1 }));
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds',fence=4 WHERE id=$1", [id]);
    const process = (await db.query<{ value: { blocks: unknown; numeric: { capture: string } } }>(
      "SELECT load_energy_planning_room_capture($1,$2,4) AS value", [home, id])).rows[0].value;
    assertEquals(process.blocks, null, "process polls never transport the raw archive again");
    assertEquals(process.numeric.capture, raw.base64);
    assert(await checkpoint(3, 4, { ...state, implementation: "synthetic-v2" }, null));
    assertEquals((await db.query("SELECT count(*)::integer AS n FROM private.energy_planning_room_source_blocks WHERE job_id=$1", [id])).rows, [{ n: 0 }],
      "a numerical implementation upgrade clears all incompatible frozen scratch while preserving the attempt");
    assertEquals((await db.query("SELECT numeric_capture FROM private.energy_planning_room_capture WHERE job_id=$1", [id])).rows,
      [{ numeric_capture: null }]);
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds',fence=5 WHERE id=$1", [id]);
    await db.query("UPDATE energy_room_profiles SET app_map_revision=2 WHERE home_id=$1", [home]);
    await assertRejects(() => checkpoint(4, 5, { ...state, implementation: "synthetic-v2" }, { ...raw, from_at: "2001-01-02", to_at: "2001-01-03" }), Error,
      "Room connections changed during capture");
  } finally { await db.close(); }
});

Deno.test('source freeze reuses clean fitted blocks, replays corrected extents and scopes reusable inference to exact identity', async () => {
  const db = await planningDatabase();
  try {
    const historyFrom = "2001-01-01T01:31:00Z";
    const context = (await db.query<{ value: { graph: { owner: string; revision: number; topology_hash: string }; binding: string; policy: string } }>(
      "SELECT get_energy_connected_planning_source_context($1,$1,'room',$2,'2001-01-21') AS value", [home, historyFrom])).rows[0].value;
    const revision = (await db.query<{ value: number }>('SELECT private.lock_room_evidence($1) AS value', [home])).rows[0].value;
    const model = { basis: { graph_owner: context.graph.owner, graph_revision: context.graph.revision, topology_hash: context.graph.topology_hash,
      history_from: historyFrom, history_to: '2001-01-21T00:00:00Z', source_policy: context.policy, source_revision: revision } };
    const input = { snapshot: { room_network_capture: { rooms: [{ key: 'room', connected_exchange: model }] } } };
    const install = () => db.query("INSERT INTO private.energy_planning_jobs VALUES($1,$2,$2,'pending',1,now()+interval '60 seconds',now(),$3,NULL,NULL)", [id, home, JSON.stringify(input)]);
    await install();
    for (const [from, to, bytes] of [['2001-01-01', '2001-01-11', 'first'], ['2001-01-11', '2001-01-21', 'second']]) {
      await db.query(`INSERT INTO private.energy_room_evidence_blocks(home_id,customer_id,room_key,binding,implementation,from_at,to_at,source_revision,capture,sha256,row_count)
        VALUES($1,$1,'room',$2,'synthetic-source',$3,$4,$5,convert_to($6,'UTF8'),encode(sha256(convert_to($6,'UTF8')),'hex'),1)`,
        [home, context.binding, from, to, revision, bytes]);
    }
    const freeze = async (fence = 1) => (await db.query<{ value: { next: { from_at: string; to_at: string } | null; source_revision: number } | null }>(
      "SELECT freeze_energy_connected_planning_sources($1,$2,$3,0,$4,'2001-01-21','synthetic-source',NULL) AS value", [home, id, fence, historyFrom])).rows[0].value;
    for (const [room, from, to, binding, implementation] of [
      ['room', '2000-12-01', '2000-12-02', context.binding, 'synthetic-source'],
      ['room', '2001-01-02', '2001-01-03', 'superseded-binding', 'synthetic-source'],
      ['room', '2001-01-03', '2001-01-04', context.binding, 'superseded-implementation'],
      ['room', '2001-01-04', '2001-01-05', context.binding, 'synthetic-source'],
      ['room', '2000-12-31', '2001-01-02', context.binding, 'synthetic-source'],
      ['observed', '2000-12-01', '2000-12-02', context.binding, 'synthetic-source'],
    ]) await db.query(`INSERT INTO private.energy_connected_source_cache
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,convert_to('synthetic derived bytes','UTF8'),repeat('a',64))`,
      [home, room, binding, implementation, context.policy, from, to, revision]);
    assertEquals(await freeze(2), null);
    assertEquals((await db.query('SELECT count(*)::integer AS n FROM private.energy_connected_source_cache')).rows, [{ n: 6 }],
      'a stale lease cannot clean another attempt’s derived source cache');
    assertEquals((await freeze())!.next, null, 'the fitted archive spans the model start and covers the entire population');
    assertEquals((await db.query(`SELECT room_key,to_char(from_at,'YYYY-MM-DD') AS from_at FROM private.energy_connected_source_cache
      ORDER BY room_key,from_at`)).rows, [
      { room_key: 'observed', from_at: '2000-12-01' }, { room_key: 'room', from_at: '2000-12-31' }, { room_key: 'room', from_at: '2001-01-04' },
    ], 'only obsolete dependencies or wholly out-of-basis extents are removed; overlapping/current/other-room bytes remain');
    assertEquals((await db.query('SELECT count(*)::integer AS n FROM private.energy_planning_room_source_blocks')).rows, [{ n: 2 }]);
    const leading = await db.query(`SELECT b.from_at=f.from_at AND b.to_at=f.to_at AND b.sha256=f.sha256
      AND b.capture=f.capture AS identical FROM private.energy_planning_room_source_blocks f
      JOIN private.energy_room_evidence_blocks b ON b.home_id=$1 AND b.from_at=f.from_at
      WHERE f.job_id=$2 AND f.from_at<$3::timestamptz AND f.to_at>$3::timestamptz`, [home, id, historyFrom]);
    assertEquals(leading.rows, [{ identical: true }], 'the leading envelope keeps its original boundaries, bytes and digest');
    // Real canonical insertion fills an older missing peer observation. The
    // production statement trigger, not a fabricated dirty/hash response,
    // journals it for every receiving room before the next capture.
    await db.query("INSERT INTO energy_heating_probe_observations(home_id,customer_id,start_ts,duration_s,probes) VALUES($1,$1,'2001-01-12',900,$2)",
      [home, JSON.stringify([{ source_key: 'b'.repeat(64), area_key: 'observed', mean: 21, unavailable: false, cohort_key: null }])]);
    assert((await db.query<{ revision: number }>('SELECT revision FROM private.energy_room_evidence_clocks WHERE home_id=$1', [home])).rows[0].revision > revision);
    assertEquals((await freeze())!.next, null, 'later correction cannot rewrite this attempt’s frozen blocks');
    await db.query('DELETE FROM private.energy_planning_jobs WHERE id=$1', [id]);
    await install();
    const dirty = (await freeze())!;
    assertEquals(Date.parse(dirty.next!.from_at), Date.parse('2001-01-11'));
    assertEquals(Date.parse(dirty.next!.to_at), Date.parse('2001-01-21'));
    const bytes = new TextEncoder().encode('corrected synthetic raw');
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const raw = { room: 0, from_at: '2001-01-11', to_at: '2001-01-21', base64: btoa('corrected synthetic raw'), sha256: sha };
    const proof = { room_key: 'room', binding: context.binding, policy: context.policy, from_at: historyFrom, to_at: '2001-01-21',
      source_revision: dirty.source_revision, implementation: 'synthetic-source' };
    const state = { version: 1, implementation: 'synthetic-v2', runtime: 'synthetic-runtime', room: 0, phase: 'qualify', policy: context.policy };
    await db.query('SELECT checkpoint_energy_planning_room_capture($1,$2,1,0,$3,$4,NULL,$5)',
      [home, id, JSON.stringify(state), JSON.stringify(raw), JSON.stringify(proof)]);
    await db.query('DELETE FROM private.energy_planning_jobs WHERE id=$1', [id]);
    await install();
    assertEquals((await freeze())!.next, null, 'next attempt combines clean fit archive and corrected planning raw cache');
    await db.query(`INSERT INTO private.energy_planning_room_capture(job_id,cursor,state,numeric_capture,numeric_sha256,numeric_from_at,numeric_header_bytes,numeric_row_bytes,numeric_row_count)
      VALUES($1,1,'{"phase":"process","room":0}',decode($2,'base64'),$3,'2001-01-01',$4,1,20)`, [id, raw.base64, sha, bytes.length - 20]);
    const belief = { revision: 'connected_process_quadrature_v1', hypotheses: [{ log_weight: -10000, posterior: { through_ms: Date.parse('2001-01-21') } }] };
    const save = async (fence: number) => (await db.query<{ value: boolean }>(
      "SELECT save_energy_connected_inference($1,$2,$3,0,'identity','2001-01-21',20,$4,$5) AS value",
      [home, id, fence, sha, JSON.stringify(belief)])).rows[0].value;
    assertEquals(await save(2), false);
    assertEquals(await save(1), true);
    const load = async (identity: string) => (await db.query<{ value: { belief: unknown } | null }>(
      "SELECT load_energy_connected_inference($1,$2,1,0,$3,'2001-01-21') AS value", [home, id, identity])).rows[0].value;
    assertEquals(await load('different'), null);
    assertEquals((await load('identity'))!.belief, belief, 'finite underflowed log weights survive JSON storage');
    await db.query("SELECT save_energy_connected_inference($1,$2,1,0,'identity','2001-01-11',10,NULL,$3,true)", [home, id, JSON.stringify(belief)]);
    await db.query("SELECT save_energy_connected_inference($1,$2,1,0,'new-model-identity','2001-01-21',20,$3,$4)", [home, id, sha, JSON.stringify(belief)]);
    assertEquals((await db.query('SELECT identity,count(*)::integer AS n FROM private.energy_connected_inference_cache GROUP BY identity')).rows,
      [{ identity: 'new-model-identity', n: 1 }], 'daily model revisions replace old canonical and latest posterior checkpoints rather than accumulating them');
    await db.exec('SET ROLE authenticated');
    await assertRejects(() => load('identity'), Error, 'permission denied');
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});

Deno.test("room interval readers preserve late quarters, holes and unknown meter energy for the owning source", async () => {
  const db = await planningDatabase();
  try {
    const record = (quarter: number, kwh: number | null) => db.query(`INSERT INTO energy_heating_observations
      (home_id,customer_id,room_key,source_key,device_statistics,start_ts,duration_s,source,room_temperature_c,
       outdoor_temperature_c,device_energy_kwh,heater_energy_limits_w,cooling)
      VALUES($1,$1,'room',repeat('a',64),'{"heater":"synthetic.energy"}',
        timestamptz '2001-02-01'+$2::int*interval '15 minutes',900,'recorder_5minute_mean',19,7,
        jsonb_build_object('heater',$3::double precision),'{"heater":800}',false)
      ON CONFLICT(home_id,room_key,start_ts,duration_s) DO UPDATE SET device_energy_kwh=excluded.device_energy_kwh`,
      [home, quarter, kwh]);
    const read = async (room: string) => (await db.query<{ quarter: number; heat_w: number | null; room_c: number; outdoor_c: number }>(`SELECT
      (extract(epoch FROM start_ts-timestamptz '2001-02-01')/900)::int AS quarter,
      heat_w,room_temperature_c AS room_c,outdoor_temperature_c AS outdoor_c
      FROM get_energy_room_thermal_intervals($1,$1,$2,'2001-02-01','2001-02-01 01:00Z') ORDER BY start_ts`,
      [home, room])).rows;
    await record(0, 0.1);
    await record(2, null);
    await db.query(`INSERT INTO energy_heating_probe_observations(home_id,customer_id,start_ts,duration_s,probes)
      VALUES($1,$1,'2001-02-01',900,jsonb_build_array(jsonb_build_object('source_key',repeat('b',64),
        'area_key','observed','mean',17,'unavailable',false,'cohort_key',NULL),
        jsonb_build_object('source_key',repeat('a',64),'area_key','room','mean',19,'unavailable',false,'cohort_key',NULL)))`, [home]);
    assertEquals(await read("room"), [
      { quarter: 0, heat_w: 400, room_c: 19, outdoor_c: 7 }, { quarter: 2, heat_w: null, room_c: 19, outdoor_c: 7 },
    ]);
    assertEquals(await read("observed"), [{ quarter: 0, heat_w: null, room_c: 17, outdoor_c: 7 }]);
    assertEquals(await read("unlinked"), []);
    await record(1, 0.15);
    await record(2, 0.05);
    // The newest quarter arrives through the legacy slot source alone.
    await db.query(`INSERT INTO energy_optimisation_thermal_slots(home_id,customer_id,room_key,start_ts,room_temperature_c,cooling_duty)
      VALUES($1,$1,'room','2001-02-01 00:45Z',20,0)`, [home]);
    await db.query(`INSERT INTO energy_optimisation_device_slots(home_id,customer_id,device_id,start_ts,energy_kwh)
      SELECT home_id,customer_id,id,'2001-02-01 00:45Z',0.2 FROM energy_optimisation_devices WHERE home_id=$1`, [home]);
    assertEquals((await read("room")).map(r => [r.quarter, r.heat_w]), [[0, 400], [1, 600], [2, 200], [3, 800]]);
    await db.query("UPDATE energy_optimisation_devices SET retired_at=now() WHERE home_id=$1", [home]);
    assertEquals(await read("room"), [{ quarter: 0, heat_w: null, room_c: 19, outdoor_c: 7 }],
      "retiring the meter keeps the linked receiver's observed probe and removes attribution to the retired source");
  } finally { await db.close(); }
});

Deno.test('late canonical probe reports can invalidate a qualified prefix before the raw dirty span', async () => {
  const { qualifyProbeFreshness } = await import('../supabase/functions/_shared/device-learning/room/source-freshness.ts');
  const { thermalQuarter } = await import('../supabase/functions/_shared/thermal-training.ts');
  const { encodeRoomResponseFitCapture } = await import('../supabase/functions/_shared/device-model-learning/room-band-fit-capture.ts');
  const db = await planningDatabase();
  try {
    const from = Date.parse('2001-01-01T00:00:00Z'), at = (hour: number) => new Date(from + hour * 3600000).toISOString();
    const insert = (first: number, last: number, quiet: boolean) => db.query(`
      INSERT INTO energy_heating_probe_observations(home_id,customer_id,start_ts,duration_s,probes)
      SELECT $1,$1,$2::timestamptz+i*interval '1 hour',3600,jsonb_build_array(
        jsonb_build_object('source_key',repeat('b',64),'area_key','observed','cohort_key',NULL,'mean',19+sin(i::double precision)/10,
          'unchanged',false,'joint_unchanged',false,'reported',true,'unavailable',false),
        jsonb_build_object('source_key',repeat('a',64),'area_key','room','cohort_key',NULL,'mean',20,
          'unchanged',$5::boolean,'joint_unchanged',$5::boolean,'reported',NULL,'unavailable',false))
      FROM generate_series($3::integer,$4::integer-1) i`, [home, at(0), first, last, quiet]);
    await insert(0, 160, true);
    const revision = (await db.query<{ value: number }>('SELECT private.lock_room_evidence($1) AS value', [home])).rows[0].value;
    const read = async (hours: number) => (await db.query<import('../supabase/functions/_shared/thermal-training.ts').ThermalQuarterRow>(
      "SELECT * FROM get_energy_room_thermal_intervals($1,$1,'observed',$2,$3)", [home, at(0), at(hours)])).rows
      .map(row => ({ ...row, start_ts: new Date(row.start_ts).toISOString() }));
    const initial = qualifyProbeFreshness(await read(160), ['room']).rows.map(thermalQuarter);
    assertEquals(initial.length, 160);
    assertEquals(initial[40].peer_c?.room, 20);
    const encoded = await encodeRoomResponseFitCapture(initial, at(0));
    const input = { snapshot: { room_network_capture: { rooms: [{ key: 'observed' }] } } };
    const install = async (numeric: typeof encoded) => {
      await db.query("INSERT INTO private.energy_planning_jobs VALUES($1,$2,$2,'pending',1,now()+interval '60 seconds',now(),$3,NULL,NULL)", [id, home, JSON.stringify(input)]);
      await db.query(`INSERT INTO private.energy_planning_room_capture(job_id,cursor,state,numeric_capture,numeric_sha256,numeric_from_at,numeric_header_bytes,numeric_row_bytes,numeric_row_count)
        VALUES($1,1,'{"phase":"reuse","room":0}',decode($2,'base64'),$3,$4,$5,$6,$7)`,
        [id, numeric.base64, numeric.sha256, at(0), numeric.header_bytes, numeric.row_bytes, numeric.row_count]);
    };
    await install(encoded);
    const belief = { revision: 'connected_process_quadrature_v1', hypotheses: [{ log_weight: 0, posterior: { through_ms: Date.parse(at(160)) } }] };
    await db.query('SELECT save_energy_connected_inference($1,$2,1,0,$3,$4,160,$5,$6)',
      [home, id, 'same-model-source-policy', at(160), encoded.sha256, JSON.stringify(belief)]);
    await insert(160, 840, false);
    assertEquals((await db.query<{ value: boolean }>("SELECT private.room_evidence_changed($1,'observed',$2,$3,$4) AS value",
      [home, revision, at(0), at(160)])).rows[0].value, false, 'raw dirt begins after the retained prefix');
    const revised = qualifyProbeFreshness(await read(840), ['room']).rows.map(thermalQuarter);
    assertEquals(revised[40].peer_c?.room, null, 'new population establishes the earlier joint reporting freeze');
    await db.query('DELETE FROM private.energy_planning_jobs WHERE id=$1', [id]);
    await install(await encodeRoomResponseFitCapture(revised, at(0)));
    const proof = (await db.query<{ value: { numeric_sha256: string; current_prefix_sha256: string } }>(
      'SELECT load_energy_connected_inference($1,$2,1,0,$3,$4) AS value', [home, id, 'same-model-source-policy', at(160)])).rows[0].value;
    assertEquals(proof.numeric_sha256, encoded.sha256);
    assert(proof.current_prefix_sha256 !== proof.numeric_sha256,
      'actual DB byte-prefix proof rejects warmed posterior despite unchanged old raw blocks and unchanged model');
  } finally { await db.close(); }
});

Deno.test('numeric process transport sends bounded row slices while SQL retains completed nodes and full prefix bytes', async () => {
  const { encodeRoomResponseFitCapture, decodeRoomResponseFitCapture } = await import('../supabase/functions/_shared/device-model-learning/room-band-fit-capture.ts');
  const db = await planningDatabase();
  try {
    const from = '2001-01-01T00:00:00Z';
    const rows = Array.from({ length: 4097 }, (_, i) => ({ start_ms: Date.parse(from) + i * 900000, duration_s: 900 as const,
      room_c: 19 + i / 10000, outdoor_c: 5, heat_w: null, house_c: null, solar_w_per_m2: null, cooling: null,
      peer_c: { zero: 0, missing: null } }));
    const numeric = await encodeRoomResponseFitCapture(rows, from);
    await db.query("INSERT INTO private.energy_planning_jobs VALUES($1,$2,$2,'pending',1,now()+interval '60 seconds',now(),$3,NULL,NULL)",
      [id, home, JSON.stringify({ snapshot: { room_network_capture: { rooms: [{ key: 'room' }] } } })]);
    const state = { version: 1, implementation: 'synthetic-v2', runtime: 'synthetic', room: 0, row: 2048,
      phase: 'process', nodes: [{ key: 'completed-synthetic-peer' }] };
    const checkpoint = (cursor: number, fence: number, next: unknown, encoded: unknown = null) => db.query(
      'SELECT checkpoint_energy_planning_room_capture($1,$2,$3,$4,$5,NULL,$6,NULL)',
      [home, id, fence, cursor, JSON.stringify(next), JSON.stringify(encoded)]);
    const load = async (fence: number) => (await db.query<{ value: { state: Record<string, unknown>; numeric: {
      capture: string; sha256: string; full_sha256: string; from_at: string; row_from: number; total_rows: number } } }>(
      'SELECT load_energy_planning_room_capture($1,$2,$3) AS value', [home, id, fence])).rows[0].value;
    await checkpoint(0, 1, state, { ...numeric, from_at: from });
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds',fence=2 WHERE id=$1", [id]);
    const first = await load(2);
    assertEquals(first.state.nodes, undefined);
    assertEquals(first.numeric.row_from, 2048);
    assertEquals(first.numeric.total_rows, rows.length);
    assertEquals(first.numeric.full_sha256, numeric.sha256);
    assertEquals(await decodeRoomResponseFitCapture(first.numeric.capture, from, first.numeric.sha256), rows.slice(2048, 4096));
    await checkpoint(1, 2, { ...first.state, row: 4096 });
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds',fence=3 WHERE id=$1", [id]);
    const last = await load(3);
    assertEquals(await decodeRoomResponseFitCapture(last.numeric.capture, from, last.numeric.sha256), rows.slice(4096));
    await checkpoint(2, 3, { ...last.state, phase: 'assemble', diagnostics: { thermal_state_identified: true } });
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds',fence=4 WHERE id=$1", [id]);
    const assembled = await load(4);
    assertEquals(assembled.state.nodes, state.nodes, 'intermediate omission never deletes completed nodes');
    assertEquals(await decodeRoomResponseFitCapture(assembled.numeric.capture, from, assembled.numeric.sha256), [],
      'identified current state does not reload the historical numeric payload for assembly');
  } finally { await db.close(); }
});
