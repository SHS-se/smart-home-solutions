// Independent synthetic models, contexts and planning jobs exercise the real admission RPC.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connectedDatabase } from "./helpers/connected-room-sql.ts";
import { home, other } from "./helpers/room-fit-sql.ts";

async function planningDatabase() {
  const db = await connectedDatabase();
  await db.exec(`CREATE TABLE private.energy_planning_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),home_id uuid,customer_id uuid,
    snapshot_id uuid,source_hash text,revision bigint,protocol integer,input json,context json,state text DEFAULT 'pending',
    fence bigint DEFAULT 1,lease_until timestamptz DEFAULT now()+interval '60 seconds',wake_after timestamptz,code text,detail text,finished_at timestamptz);
    CREATE TABLE private.energy_planning_heads(home_id uuid PRIMARY KEY,revision bigint DEFAULT 0,active_job_id uuid);
    CREATE TABLE energy_optimisation_current(home_id uuid,accepted_household_reference jsonb,accepted_reference_revision bigint,
      accepted_reference_unresolved boolean,plan_id uuid,fixed_plan_revision integer,replan_request_id uuid,replan_error text);
    CREATE FUNCTION private.energy_planning_is_current(private.energy_planning_jobs) RETURNS boolean LANGUAGE sql AS $$
      SELECT active_job_id=$1.id FROM private.energy_planning_heads WHERE home_id=$1.home_id $$;
    CREATE FUNCTION private.lock_energy_planning_job(uuid) RETURNS private.energy_planning_jobs LANGUAGE sql AS $$
      SELECT j FROM private.energy_planning_jobs j WHERE id=$1 FOR UPDATE $$;
    CREATE FUNCTION private.energy_planning_receipt(private.energy_planning_jobs) RETURNS json LANGUAGE sql AS $$
      SELECT json_build_object('job_id',$1.id,'state',$1.state) $$;
    CREATE TABLE private.energy_planning_runtime(job_id uuid);
    CREATE TABLE private.energy_planning_execution(job_id uuid);`);
  const migration = (name: string) => Deno.readTextFile("supabase/migrations/" + name + ".sql");
  const admission = await migration("20261126160000_reuse_admitted_planning_input");
  const start = admission.indexOf("CREATE OR REPLACE FUNCTION public.accept_energy_planning_job(json)");
  await db.exec(admission.slice(start, admission.indexOf("END; $$;", start) + 8));
  await db.exec(await migration("20261126152000_staged_connected_planning_capture"));
  await db.exec(await migration("20261126153200_connected_inference_prefix_cache"));
  await db.exec(await migration("20261127120000_minimal_planning_model_capture"));
  await db.exec(`CREATE TRIGGER clean_owned_planning_scratch AFTER UPDATE OF state ON private.energy_planning_jobs
    FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION private.clean_owned_planning_scratch();`);
  return db;
}

Deno.test("admission pins selected receiver beliefs once and returns bounded claims under the existing cursor", async () => {
  const db = await planningDatabase();
  try {
    type Model = { header: string; process_belief?: unknown };
    type Row = { room_key: string; model_revision: number; heating_bands: { binding: string; reference_revision: string | null;
      reference: { connected_exchange: Model } }; connected_reference?: { revision: string | null; binding: string } };
    type Room = { key: string; connected_exchange: Model; connected_reference?: Row["connected_reference"] };
    const bundle = async (headers: boolean) => (await db.query<{ value: { rooms: Row[] } }>(
      headers ? "SELECT capture_energy_device_models($1,true) AS value" : "SELECT capture_energy_device_models($1) AS value", [home])).rows[0].value;
    await db.query(`INSERT INTO energy_optimisation_zone_models(home_id,customer_id,room_key,trained,gain_c_per_wh)
      VALUES($1,$1,'observed',true,.002),($1,$1,'other-model',true,.002)`, [home]);
    await db.query(`UPDATE energy_optimisation_zone_models m SET heating_bands=jsonb_build_object('binding',c.binding,
      'reference_revision',CASE WHEN m.room_key='room' THEN 'accepted-7' END,'reference',jsonb_build_object('connected_exchange',
        jsonb_build_object('header',m.room_key,'process_belief',CASE WHEN m.room_key='room' THEN
          jsonb_build_object('synthetic_population',repeat('1234567',2000),'log_weight',-10000) ELSE 'null'::jsonb END)))
      FROM private.energy_room_heating_contexts($1,false) c WHERE m.home_id=$1 AND m.room_key=c.room_key`, [home]);
    await db.query(`UPDATE energy_optimisation_zone_models SET heating_bands='{"reference":{"connected_exchange":{"header":"no population"}}}'
      WHERE home_id=$1 AND room_key='other-model'`, [home]);
    const original = await bundle(false), compact = await bundle(true);
    const rows = new Map(compact.rooms.map(row => [row.room_key, row]));
    const originalRows = new Map(original.rooms.map(row => [row.room_key, row]));
    assertEquals(rows.get("other-model"), originalRows.get("other-model"));
    for (const key of ["room", "observed"]) {
      const row = rows.get(key)!, full = originalRows.get(key)!;
      assertEquals(row.connected_reference, { revision: full.heating_bands.reference_revision, binding: full.heating_bands.binding });
      const projected = structuredClone(full);
      delete projected.heating_bands.reference.connected_exchange.process_belief;
      assertEquals(row, { ...projected, connected_reference: row.connected_reference });
    }
    assertEquals({ ...compact, rooms: [] }, { ...original, rooms: [] });
    const rooms: Room[] = ["room", "observed"].map(key => {
      const row = rows.get(key)!;
      return { key, connected_exchange: row.heating_bands.reference.connected_exchange, connected_reference: row.connected_reference };
    });
    const revisions = Object.fromEntries(compact.rooms.map(row => [row.room_key, row.model_revision]));
    const capture = (selected: Room[]) => ({ snapshot: { room_network_capture: { rooms: selected } } });
    const accept = async (snapshot: string, selected = rooms, modelRevisions = revisions) => (await db.query<{ value: { job_id: string } }>(
      "SELECT accept_energy_planning_job($1::json) AS value", [JSON.stringify({ home_id: home, customer_id: home, snapshot_id: snapshot,
        protocol: 10, source_hash: "same synthetic source", input: capture(selected),
        context: { fixed_revision: 0, accepted_reference_revision: 0, model_revisions: { rooms: modelRevisions } } })])).rows[0].value.job_id;
    const snap = crypto.randomUUID(), job = await accept(snap);
    const pinned = await db.query<{ room: number; belief: unknown }>(
      "SELECT room,belief FROM private.energy_planning_room_beliefs WHERE job_id=$1 ORDER BY room", [job]);
    assertEquals(pinned.rows, ["room", "observed"].map((key, room) => ({ room, belief: originalRows.get(key)!.heating_bands.reference.connected_exchange.process_belief })));
    assertEquals((await db.query("SELECT input FROM private.energy_planning_jobs WHERE id=$1", [job])).rows, [{ input: capture(rooms) }]);
    for (const selected of [
      [{ ...rooms[0], key: "unrelated" }], [{ ...rooms[0], connected_reference: { binding: "bad", revision: "accepted-7" } }],
      [{ ...rooms[0], connected_reference: { ...rooms[0].connected_reference!, revision: "not accepted" } }],
      [{ ...rooms[0], connected_exchange: { header: "other" } }],
    ]) await assertRejects(() => accept(crypto.randomUUID(), selected), Error, "Accepted room response changed");
    await assertRejects(() => accept(crypto.randomUUID(), rooms, { ...revisions, room: revisions.room + 1 }), Error, "Accepted room response changed");
    await db.query("UPDATE energy_optimisation_zone_models SET heating_bands=NULL WHERE home_id=$1", [home]);
    assertEquals(await accept(snap), job, "lost reply resolves an already accepted attempt after the live model is replaced");
    assertEquals((await db.query("SELECT state FROM private.energy_planning_jobs WHERE id=$1", [job])).rows, [{ state: "pending" }]);

    type Loaded = { state: { nodes?: unknown[]; completed_nodes?: unknown }; frozen_model: Model | null } | null;
    const load = async (owner = home, fence = 1, delta = true) => (await db.query<{ value: Loaded }>(
      delta ? "SELECT load_energy_planning_room_capture($1,$2,$3,true) AS value" : "SELECT load_energy_planning_room_capture($1,$2,$3) AS value",
      [owner, job, fence])).rows[0].value;
    const state = (phase: string, room: number) => ({ version: 1, runtime: "synthetic", implementation: "synthetic", phase, room });
    await db.query("INSERT INTO private.energy_planning_room_capture(job_id,cursor,state) VALUES($1,1,$2)", [job, JSON.stringify(state("source", 0))]);
    const set = (body: unknown) => db.query("UPDATE private.energy_planning_room_capture SET state=$2::jsonb-'nodes',completed_nodes=coalesce($2::jsonb->'nodes','[]'::jsonb) WHERE job_id=$1", [job, JSON.stringify(body)]);
    assertEquals(await load(other), null); assertEquals(await load(home, 3), null);
    for (const phase of ["source", "reuse", "process", "filter"]) {
      await set({ ...state(phase, 0), nodes: [{ key: "earlier" }] });
      const claim = (await load())!;
      assertEquals(claim.frozen_model, null); assertEquals(claim.state.nodes, undefined);
    }
    for (const [index, key] of ["room", "observed"].entries()) {
      for (const phase of ["qualify", "assemble"]) {
        await set({ ...state(phase, index), nodes: [] });
        assertEquals((await load())!.frozen_model, originalRows.get(key)!.heating_bands.reference.connected_exchange);
      }
    }
    await set({ ...state("assemble", 0), nodes: [], process_response: { header: "derived" } });
    assertEquals((await load())!.frozen_model, null); assertEquals((await load(home, 1, false))!.state.nodes, []);
    const checkpoint = async (cursor: number, next: unknown) => (await db.query<{ value: unknown }>(
      "SELECT checkpoint_energy_planning_room_capture($1,$2,1,$3,$4,NULL,NULL,NULL) AS value", [home, job, cursor, JSON.stringify(next)])).rows[0].value;
    for (const invalid of [
      { ...state("complete", 2), completed_nodes: [] }, { ...state("source", 1), completed_nodes: [{ key: "wrong" }] },
      { ...state("source", 1), completed_nodes: [{}] }, { ...state("source", 1), completed_nodes: [], nodes: [] },
      { ...state("source", 1), implementation: "different", completed_nodes: [] },
      { ...state("source", 1), completed_nodes: [{ key: "room" }, { key: "room" }] },
    ]) await assertRejects(() => checkpoint(1, invalid), Error, "Invalid completed room node");
    const firstNode = { key: "room", synthetic_path: [0, -10000],
      population: Array.from({ length: 2048 }, (_, i) => Math.imul(i + 1, 23465789).toString(36)) };
    const advanced = { ...state("source", 1), completed_nodes: [firstNode] };
    assertEquals(await checkpoint(0, advanced), null); assert(await checkpoint(1, advanced));
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1", [job]);
    assertEquals(await checkpoint(1, advanced), null);
    assertEquals((await load())!.state.nodes, undefined);
    const chunks = async () => {
      await db.exec("RESET ROLE");
      try {
        const oid = (await db.query<{ id: number }>("SELECT oid::integer AS id FROM pg_class WHERE oid='private.energy_planning_room_capture'::regclass")).rows[0].id;
        return (await db.query<{ chunk_id: number }>(`SELECT DISTINCT chunk_id FROM pg_toast.pg_toast_${Number(oid)} ORDER BY chunk_id`)).rows;
      } finally { await db.exec("SET ROLE room_migration"); }
    };
    const priorChunks = await chunks(); assert(priorChunks.length > 0, "synthetic populations exercise out-of-line TOAST storage");
    assert(await checkpoint(2, state("assemble", 1)));
    assertEquals(await chunks(), priorChunks, "scalar work reuses out-of-line population bytes");
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1", [job]);
    assert(await checkpoint(3, { ...state("complete", 2), completed_nodes: [] }));
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1", [job]);
    const final = (await load())!; assertEquals(final.state.nodes, [firstNode]); assertEquals(final.state.completed_nodes, undefined);
    await db.query("DELETE FROM private.energy_planning_room_capture WHERE job_id=$1", [job]);
    assert(await checkpoint(0, state("complete", 2)), "rooms without bounded state may all be skipped");
    await db.query("UPDATE private.energy_planning_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1", [job]);
    assertEquals((await load())!.state.nodes, []);
    await db.query("UPDATE private.energy_planning_jobs SET state='published' WHERE id=$1", [job]);
    assertEquals((await db.query("SELECT count(*)::integer AS n FROM private.energy_planning_room_beliefs")).rows, [{ n: 0 }]);
    await db.exec("SET ROLE authenticated");
    await assertRejects(() => bundle(true), Error, "permission denied"); await assertRejects(() => load(), Error, "permission denied");
  } finally { await db.close(); }
});

Deno.test("proposal peer order and catalog identity preserve native JSON bytes across receiver and page boundaries", async () => {
  const { PGlite } = await import("npm:@electric-sql/pglite@0.3.14");
  const db = new PGlite();
  try {
    const sql = await Deno.readTextFile("supabase/migrations/20261127121000_owned_planning_room_projections.sql");
    await db.exec(`CREATE SCHEMA private;
      CREATE TABLE private.energy_forecast_catalog_nodes(job_id uuid,node integer,before_records text,after_records text);
      CREATE TABLE private.energy_forecast_catalog_pages(job_id uuid,node integer,first_record integer,count integer,offsets integer[],payload bytea);`);
    for (const name of ["planning_node_projection", "planning_catalog_identity"]) {
      const start = sql.indexOf("CREATE FUNCTION private." + name + "(");
      await db.exec(sql.slice(start, sql.indexOf("$$;", start) + 3));
    }
    const edge = (from: string, positive: boolean) => ({ from, kind: "constant", per_h: positive ? .4 : 0 });
    const node = { key: "receiver", process_belief: { hypotheses: [
      { incoming: [edge("x", false), edge("y", true), edge("dead", false)] },
      { incoming: [edge("x", true), edge("z", false)] },
      { incoming: [{ kind: "log_ou", from: "p" }, edge("y", true)] },
    ], reset_priors: [{ from: "z" }, { from: "y" }, { from: "reset" }] } };
    assertEquals((await db.query<{ value: unknown }>("SELECT private.planning_node_projection($1::json) AS value",
      [JSON.stringify(node)])).rows[0].value, { key: "receiver", required_peers: ["y", "x", "p", "z", "reset"],
      hypothesis_peers: ["x", "y", "dead", "z", "p"] });

    const prefix = { snapshot: "synthetic μ", forecast: { seed: [1, 2] }, network: { schedule: [0, 3] } };
    const beliefs = [
      { bounded_thermal: false, thermal_noise_c2_per_h: 1e-12, reset_priors: [], hypotheses: [
        { log_weight: -1200.1, extra: "synthetic 🌡" }, { log_weight: 3e-9, extra: "a,b" }, { log_weight: -1e100, extra: "[]重" },
      ] },
      { hypotheses: [], thermal_noise_c2_per_h: 0, bounded_thermal: true },
    ];
    for (const [index, belief] of beliefs.entries()) {
      const frame = JSON.stringify({ ...belief, hypotheses: [] });
      const offset = frame.indexOf('"hypotheses":[]') + '"hypotheses":['.length;
      await db.query("INSERT INTO private.energy_forecast_catalog_nodes VALUES($1,$2,$3,$4)", [home, index, frame.slice(0, offset), frame.slice(offset)]);
    }
    const records = beliefs[0].hypotheses.map(record => JSON.stringify(record));
    for (const [start, page] of [[2, records.slice(2)], [0, records.slice(0, 2)]] as const) {
      const offsets = [0];
      for (const record of page) offsets.push(offsets.at(-1)! + new TextEncoder().encode(record).length);
      await db.query("INSERT INTO private.energy_forecast_catalog_pages VALUES($1,0,$2,$3,$4,convert_to($5,'UTF8'))",
        [home, start, page.length, offsets, page.join("")]);
    }
    const identity = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ ...prefix, beliefs })));
    const expected = Array.from(new Uint8Array(identity), byte => byte.toString(16).padStart(2, "0")).join("");
    assertEquals((await db.query<{ digest: string }>("SELECT private.planning_catalog_identity($1,$2) AS digest",
      [home, JSON.stringify({ ...prefix, beliefs: [] }).slice(0, -2)])).rows[0].digest, expected);
  } finally { await db.close(); }
});
