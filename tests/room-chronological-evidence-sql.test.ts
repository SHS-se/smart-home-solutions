// Independently generated synthetic source rows and room responses.
import type { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { claim, type Claim, database, handBack, home, other, release, revision } from "./helpers/room-fit-sql.ts";

const begin = "2001-01-01T00:00:00.000Z", end = "2001-01-02T00:00:00.000Z";
const implementation = "synthetic-raw-v1", policy = "shared_interval_transitions_v1", binding = "synthetic-binding";
const migration = "supabase/migrations/20261123130000_chronological_room_evidence.sql";
const source = "energy_heating_observations";
async function fixture() {
  const db = await database();
  await db.exec(`CREATE TABLE energy_heating_observations(home_id uuid,room_key text,start_ts timestamptz,
    duration_s integer,source_revision text,customer_id uuid,source_key text,device_statistics jsonb,room_temperature_c numeric,
    outdoor_temperature_c numeric,house_temperature_c numeric,solar_w_per_m2 numeric,device_energy_kwh jsonb,
    heater_energy_limits_w jsonb,cooling boolean,source text,PRIMARY KEY(home_id,room_key,start_ts,duration_s));
    CREATE TABLE energy_heating_probe_observations(home_id uuid,start_ts timestamptz,duration_s integer,customer_id uuid,
      probes jsonb,probe_fingerprint text GENERATED ALWAYS AS (md5(probes::text)) STORED);
    CREATE TABLE energy_optimisation_thermal_slots(home_id uuid,room_key text,start_ts timestamptz,customer_id uuid,
      room_temperature_c numeric,cooling_duty numeric);
    CREATE TABLE energy_optimisation_outdoor_slots(home_id uuid,start_ts timestamptz,customer_id uuid,temperature_c numeric,solar_w_per_m2 numeric);
    CREATE TABLE energy_optimisation_house_slots(home_id uuid,start_ts timestamptz,customer_id uuid,temperature_c numeric);
    CREATE TABLE energy_optimisation_devices(home_id uuid,id uuid PRIMARY KEY,device_key text,statistic_id text,category text,
      active_power_w numeric,first_seen_at timestamptz,mapping_summary jsonb,control_type_override text,mapping_status text,
      mapped_control_type text,retired_at timestamptz,planning_role_override text);
    CREATE TABLE energy_optimisation_device_slots(home_id uuid,device_id uuid,start_ts timestamptz,customer_id uuid,energy_kwh numeric);
    ALTER TABLE energy_optimisation_zone_models ADD COLUMN training_from timestamptz, ADD COLUMN training_to timestamptz;
    CREATE TABLE private.energy_heating_history_sources(home_id uuid,valid_from timestamptz,valid_to timestamptz,basis text);
    CREATE TABLE energy_room_profiles(home_id uuid,rooms jsonb,connections jsonb);
    CREATE TABLE energy_room_probe_slots(home_id uuid,room_key text,source_key text,start_ts timestamptz);
    ALTER TABLE energy_optimisation_devices ADD COLUMN customer_id uuid;
    ALTER TABLE energy_optimisation_device_slots ADD COLUMN id uuid DEFAULT gen_random_uuid();
    CREATE TABLE private.energy_room_passive_heat_sources(home_id uuid,customer_id uuid,room_key text,device_id uuid);`);
  const reliability = await Deno.readTextFile("supabase/migrations/20261119143000_exclude_reviewed_unreliable_heating_meters.sql");
  await db.exec(reliability.slice(0, reliability.indexOf("CREATE OR REPLACE FUNCTION private.energy_room_thermal_intervals")));
  const retention = await Deno.readTextFile("supabase/migrations/20261119042000_hold_room_fit_inputs_during_retention.sql");
  await db.exec(retention.slice(0, retention.indexOf("SELECT cron.schedule")));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261120001000_room_operation_facts.sql"));
  // Hosted migrations own application objects without PostgreSQL superuser rights.
  await db.exec(`CREATE ROLE room_migration NOSUPERUSER;
    DO $$ DECLARE obj record; BEGIN
      FOR obj IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','private','net','cron','extensions') AND c.relkind IN ('r','p') LOOP
        EXECUTE format('ALTER TABLE %I.%I OWNER TO room_migration',obj.nspname,obj.relname);
      END LOOP;
      FOR obj IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','private','net','cron','extensions') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO room_migration',obj.signature);
      END LOOP;
      FOR obj IN SELECT nspname FROM pg_namespace WHERE nspname IN ('public','private','net','cron','extensions') LOOP
        EXECUTE format('ALTER SCHEMA %I OWNER TO room_migration',obj.nspname);
      END LOOP;
    END; $$; SET ROLE room_migration`);
  await db.exec(await Deno.readTextFile(migration));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261123140000_exclude_inventory_estimates_from_room_evidence.sql"));
  await db.exec("UPDATE private.energy_learning_jobs SET wake_after=now()");
  return db;
}
type Work = { source_revision: number; next: null | { from_at: string; to_at: string; solar_retry_at?: string } };
async function work(db: PGlite, from = begin, to = end, owner = "room", impl = implementation) {
  return (await db.query<{ work: Work }>(
    "SELECT get_energy_room_evidence_work($1,$1,$2,$3,$4,$5,$6) AS work",
    [home, owner, binding, from, to, impl])).rows[0].work;
}
async function save(db: PGlite, j: Claim, w: Work, opts: {
  rows?: number; from?: string; to?: string; binding?: string; revision?: number; retry?: string;
} = {}) {
  const data = btoa("synthetic-records");
  return (await db.query<{ saved: boolean }>(`SELECT save_energy_room_evidence_block(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,encode(sha256(decode($10,'base64')),'hex'),$11,$12,null) AS saved`,
    [j.id, j.generation, j.fence, opts.revision ?? await revision(db), opts.binding ?? binding, w.source_revision,
      opts.from ?? w.next?.from_at ?? begin, opts.to ?? w.next?.to_at ?? end, implementation, data, opts.rows ?? 0, opts.retry ?? null])).rows[0].saved;
}
/** Finish this worker request and reacquire its admission exactly as the next invocation does. */
async function saveAndClaim(db: PGlite, j: Claim, work: Work, options?: Parameters<typeof save>[3]) {
  assert(await save(db, j, work, options));
  await release(db, j);
  const next = await claim(db);
  assert(next && next.fence > j.fence);
  assertEquals(next.generation, j.generation);
  return next;
}
const write = (db: PGlite, at: string, energy: number | null, room = "room") => db.query(
  `INSERT INTO ${source}(home_id,customer_id,room_key,start_ts,duration_s,device_energy_kwh)
   VALUES($1,$1,$2,$3,900,$4) ON CONFLICT(home_id,room_key,start_ts,duration_s)
   DO UPDATE SET device_energy_kwh=EXCLUDED.device_energy_kwh`, [home, room, at, JSON.stringify({ synthetic: energy })]);

Deno.test("chronological blocks refresh late data, share probe and weather changes, and distinguish retention from retraction", async () => {
  const db = await fixture();
  try {
    let j = await claim(db);
    const baseRevision = await revision(db);
    const firstClaim = j;
    let w = await work(db);
    assert(w.next); j = await saveAndClaim(db, j, w);
    assertEquals(await save(db, firstClaim, w), false, "a repeated request after a lost reply has already released its lease");
    j = await saveAndClaim(db, j, w);
    assertEquals((await work(db)).next, null, "an explicitly empty range is covered");
    assert((await work(db, begin, end, "room", "changed policy")).next);
    await write(db, "2001-01-01T23:45Z", .02);
    assertEquals(await save(db, j, w), false, "a late newest quarter supersedes an in-flight read");
    w = await work(db); assert(w.next); j = await saveAndClaim(db, j, w, { rows: 1 });
    await write(db, "2001-01-01T23:45Z", .02);
    assertEquals((await work(db)).source_revision, w.source_revision, "identical overlapping uploads are quiet");
    await write(db, "2001-01-01T12:00Z", .01);
    assert((await work(db)).next, "a filled middle hole needs refresh");
    const beforeMissing = await work(db); j = await saveAndClaim(db, j, beforeMissing, { rows: 2 });
    await write(db, "2001-01-01T12:00Z", null);
    assert((await work(db)).next, "an unavailable counter changes its already stored row");
    w = await work(db); j = await saveAndClaim(db, j, w, { rows: 2 });
    for (const altered of [{ ...j, fence: j.fence + 1 }, { ...j, generation: j.generation + 1 }]) {
      assertEquals(await save(db, altered, w), false);
    }
    assertEquals(await save(db, j, w, { binding: "other heater" }), false);
    assertEquals(await save(db, j, w, { revision: 1000 }), false);
    await write(db, "2001-01-01T12:00Z", .03, "other room");
    assertEquals((await work(db)).next, null, "another room owns its electrical data");
    await db.query("INSERT INTO energy_heating_probe_observations VALUES($1,$2,900,$1,'[]')", [home, begin]);
    assert((await work(db)).next, "probe freshness depends on home-shared peers");
    w = await work(db); j = await saveAndClaim(db, j, w, { rows: 2 });
    await db.query("INSERT INTO energy_optimisation_outdoor_slots VALUES($1,$2,$1,2,null)", [home, begin]);
    assert((await work(db)).next);
    w = await work(db); j = await saveAndClaim(db, j, w, { rows: 2 });
    await db.exec("BEGIN");
    await db.query("SELECT private.prune_native_room_fit_history($1,$2,false)", [home, end]);
    assertEquals((await db.query("SELECT 1 FROM energy_heating_observations")).rows.length, 0);
    assertEquals((await db.query<{ marker: string }>("SELECT current_setting('shs.room_evidence_retention',true) AS marker")).rows[0].marker, "",
      "retention marker must not leak into later explicit retractions in the same transaction");
    assertEquals(await work(db), { source_revision: w.source_revision, next: null }, "actual retention path preserves the archive");
    const loaded = await db.query<{ blocks: { row_count: number }[] }>(
      "SELECT load_energy_room_evidence_blocks($1,$1,'room',$2,$3,$4,$5) AS blocks", [home, binding, begin, end, implementation]);
    assertEquals(loaded.rows[0].blocks.map(b => b.row_count), [2]);
    await db.query("DELETE FROM energy_heating_probe_observations WHERE home_id=$1", [home]);
    w = await work(db); assert(w.next, "explicit deletion of evidence from the same date still counts");
    await db.exec("COMMIT");
    j = await saveAndClaim(db, j, w);
    const extended = await work(db, "2001-01-01T12:00Z", "2001-02-01T00:00Z");
    assertEquals(Date.parse(extended.next!.from_at), Date.parse(end), "a moving floor can lie inside an existing extent");
    assertEquals(Date.parse(extended.next!.to_at) - Date.parse(end), 10 * 86400000);
    j = await saveAndClaim(db, j, extended);
    assertEquals(await revision(db), baseRevision, "archiving multiple blocks and corrections keeps the accepted model revision");
    await assertRejects(() => db.query("SELECT load_energy_room_evidence_blocks($1,$2,'room',$3,$4,$5,$6)",
      [home, other, binding, begin, end, implementation]), Error, "mismatch");
  } finally { await db.close(); }
});

async function stage(db: PGlite) {
  let j = await claim(db);
  const w = await work(db);
  if (w.next) j = await saveAndClaim(db, j, w);
  const rev = await revision(db);
  const evidence = { sourceRevision: w.source_revision, fromAt: begin, toAt: end, implementation };
  const fitImplementation = implementation + ":fit";
  const capture = { implementation: fitImplementation, homeId: home, customerId: home, roomKey: "room", binding, baseRevision: rev, evidence };
  assert((await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit($1,$2,$3,$4,-1,$5,$6,null) AS ok",
    [j.id,j.generation,j.fence,rev,JSON.stringify({ version: 4, capture }),btoa("synthetic numerical capture")])).rows[0].ok);
  await release(db, j); j = await claim(db);
  const cells = Array.from({ length: 18 }, (_, index) => ({ index }));
  assert((await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit_cells($1,$2,$3,$4,0,null,$5,null) AS ok",
    [j.id,j.generation,j.fence,rev,JSON.stringify(cells)])).rows[0].ok);
  await release(db, j); j = await claim(db);
  const transition_calibration = { policy, fitted_transitions: 100 };
  const learning = { transition_calibration, residual_degrees_of_freedom: 90 };
  const model = { home_id: home, customer_id: home, room_key: "room", sample_count: 100,
    last_fit_attempt: { learning }, heating_bands: { binding, reference_revision: "synthetic-revision",
      calibration_policy: policy, reference: { scope: {kind: "shared"}, learning_evidence: learning, model: {sample_count:100} },
      active: [], shared_attempt: { status: "fitted", implementation: fitImplementation, evidence } } };
  const complete = async (runs: {id: string; disposition: string}[] | null, patch: object = model) =>
    (await db.query<{ ok: boolean }>("SELECT complete_energy_room_fit($1,$2,$3,$4,18,$5,$6) AS ok", [j.id,j.generation,j.fence,rev,
      JSON.stringify(patch), runs === null ? null : JSON.stringify({ policy, observed_runs: runs.length, assessed_against: "synthetic-revision", runs })])).rows[0].ok;
  return { j, complete, model };
}
Deno.test("publication uses changed intervals inside the pinned horizon and pages every run by response revision", async () => {
  const db = await fixture();
  try {
    let fit = await stage(db);
    await write(db, begin, .04);
    assertEquals(await fit.complete([]), false);
    const jobs = (await db.query<{ generation: number; pending: boolean; scratch: boolean }>(`SELECT generation,pending,
      EXISTS(SELECT FROM private.energy_room_fit_progress WHERE job_id=j.id) AS scratch FROM private.energy_learning_jobs j WHERE id=$1`, [fit.j.id])).rows[0];
    assertEquals(Number(jobs.generation), fit.j.generation); assert(jobs.pending); assertEquals(jobs.scratch, false);
    await handBack(db, fit.j);
    fit = await stage(db);
    const { model } = fit;
    await assertRejects(() => fit.complete([], { ...model, sample_count: 99 }), Error, "Invalid shared transition support");
    await assertRejects(() => fit.complete([{ id: "repeat", disposition: "assessed" }, { id: "repeat", disposition: "assessed" }]),
      Error, "Invalid room run assessments");
    await write(db, end, .04);
    const runs = Array.from({ length: 73 }, (_, i) => ({ id: `test-${i}`, from_ms: i, disposition: "assessed" }));
    assert(await fit.complete(runs), "an append at the exclusive horizon leaves the fit publishable");
    const page = await db.query<{ items: typeof runs }>("SELECT get_energy_room_run_assessments($1,'room','synthetic-revision',50,50) AS items", [home]);
    assertEquals(page.rows[0].items, runs.toReversed().slice(50));
    const view = await db.query<{ view: { ledgers: { evidence: { observed_runs: number; runs: typeof runs } }[] } }>(
      "SELECT get_energy_room_response_evidence($1,'room') AS view", [home]);
    assertEquals(view.rows[0].view.ledgers[0].evidence.runs, runs.toReversed().slice(0,50));
    assertEquals(view.rows[0].view.ledgers[0].evidence.observed_runs, 73);
    await handBack(db, fit.j);
    fit = await stage(db);
    const failed = { ...fit.model, heating_bands: { ...fit.model.heating_bands,
      shared_attempt: { ...fit.model.heating_bands.shared_attempt, status: "unidentified" } } };
    assert(await fit.complete(null, failed), "a failed attempt records its diagnostics without changing the accepted response");
    assertEquals((await db.query<{ items: typeof runs }>("SELECT get_energy_room_run_assessments($1,'room','synthetic-revision',50,50) AS items", [home])).rows[0].items,
      runs.toReversed().slice(50));
    await assertRejects(() => db.query("SELECT get_energy_room_run_assessments($1,'room','synthetic-revision',0,50)", [other]), Error, "access denied");
  } finally { await db.close(); }
});
Deno.test("identified transitions can publish with no complete runs", async () => {
  const db = await fixture();
  try { assert(await (await stage(db)).complete([])); } finally { await db.close(); }
});

Deno.test("every canonical writer journals material changes and identical review and upload replays are quiet", async () => {
  const db = await fixture();
  try {
    let j = await claim(db);
    const device = "33333333-3333-4333-8333-333333333333";
    // This accepted model predates the reviewed epoch. Its active job keeps its base revision and horizon.
    await db.query("UPDATE energy_optimisation_zone_models SET training_from='1999-01-01',training_to='2000-01-01' WHERE home_id=$1", [home]);
    const tables = [
      ["energy_room_profiles", `INSERT INTO energy_room_profiles VALUES('${home}','{"room":{"source_key":"new"}}','[]')`, "rooms=rooms"],
      ["private.energy_heating_history_sources", `INSERT INTO private.energy_heating_history_sources VALUES('${home}','${begin}','${end}','reviewed')`, "basis='same identity'"],
      ["energy_optimisation_devices", `INSERT INTO energy_optimisation_devices(home_id,id,customer_id,mapping_summary,planning_role_override,control_type_override,device_key,category)
        VALUES('${home}','${device}','${home}','{"room_key":"room"}','controllable','setpoint','heater','heating')`, "id=id"],
      ["energy_optimisation_device_slots", `INSERT INTO energy_optimisation_device_slots(home_id,device_id,start_ts,customer_id,energy_kwh)
        VALUES('${home}','${device}','${begin}','${home}',0.05)`, "energy_kwh=energy_kwh"],
      ["energy_optimisation_thermal_slots", `INSERT INTO energy_optimisation_thermal_slots VALUES('${home}','room','${begin}','${home}',20,0)`, "cooling_duty=cooling_duty"],
      ["energy_optimisation_house_slots", `INSERT INTO energy_optimisation_house_slots VALUES('${home}','${begin}','${home}',19)`, "temperature_c=temperature_c"],
      ["energy_optimisation_outdoor_slots", `INSERT INTO energy_optimisation_outdoor_slots VALUES('${home}','${begin}','${home}',1,2)`, "solar_w_per_m2=solar_w_per_m2"],
      ["energy_room_probe_slots", `INSERT INTO energy_room_probe_slots VALUES('${home}','room','prior','${begin}')`, "source_key=source_key"],
      ["private.energy_heating_meter_exclusions", `INSERT INTO private.energy_heating_meter_exclusions(home_id,valid_from,valid_to,device_key,statistic_id,reason) VALUES('${home}','${begin}','${end}','heater','meter','synthetic review')`, "valid_to=valid_to"],
      ["private.energy_room_operation_facts", `INSERT INTO private.energy_room_operation_facts(home_id,customer_id,room_key,binding,from_at,to_at,basis)
        VALUES('${home}','${home}','room','${binding}','${begin}','${end}','source_capability')`, "basis=basis"],
    ];
    for (const [table, insert, noop] of tables) {
      const before = await work(db);
      if (before.next) j = await saveAndClaim(db, j, before);
      await db.exec(insert);
      const revised = await work(db);
      assert(revised.next, table); assert(revised.source_revision > before.source_revision, table);
      await db.exec(`UPDATE ${table} SET ${noop}`);
      assertEquals(await work(db), revised, table);
    }
    const beforeSolar = await work(db);
    j = await saveAndClaim(db, j, beforeSolar, { retry: "2999-01-01" });
    assertEquals((await work(db)).next, null, "an archive outage waits until its retry date");
    await db.query("UPDATE energy_optimisation_outdoor_slots SET solar_w_per_m2=3 WHERE home_id=$1", [home]);
    const corrected = await work(db);
    assertEquals(Date.parse(corrected.next!.solar_retry_at!), Date.parse("2999-01-01"));
    j = await saveAndClaim(db, j, corrected, { retry: "1999-01-01" });
    assert((await work(db)).next, "the daily archive retry becomes eligible without a new source upload");
  } finally { await db.close(); }
});

Deno.test("retention protects the source side of a partially aged block while its other half can still be refreshed", async () => {
  const db = await fixture();
  try {
    let j = await claim(db);
    const floor = Date.now() - 400 * 86400000;
    const at = (days: number) => new Date(floor + days * 86400000).toISOString();
    const w = await work(db, at(-2), at(2));
    await write(db, at(-1), .02); await write(db, at(1), .03);
    j = await saveAndClaim(db, j, { ...w, source_revision: (await work(db, at(-2), at(2))).source_revision }, { rows: 2 });
    await db.query("SELECT private.prune_native_room_fit_history($1,$2,false)", [home, at(0)]);
    assertEquals((await db.query("SELECT 1 FROM energy_heating_observations")).rows.length, 2);
    await write(db, at(1), null);
    const corrected = await work(db, at(0), at(2));
    assertEquals(Date.parse(corrected.next!.from_at), Date.parse(at(-2)));
    j = await saveAndClaim(db, j, corrected, { rows: 2 });
  } finally { await db.close(); }
});

Deno.test("rolling inventory estimates preserve archived evidence and a pinned numerical fit", async () => {
  const db = await fixture();
  try {
    await db.query(`INSERT INTO energy_optimisation_devices(home_id,id,customer_id,device_key,statistic_id,category,
      mapping_summary,planning_role_override,control_type_override,mapping_status,mapped_control_type,active_power_w)
      VALUES($1,'33333333-3333-4333-8333-333333333333',$1,'heater','measured-meter','heating',
        '{"room_key":"room","room_name":"Synthetic room"}','controllable','setpoint','ready','setpoint',1000)`, [home]);
    const fit = await stage(db);
    const before = await work(db);
    for (let power = 1001; power < 1005; power++) {
      await db.query("UPDATE energy_optimisation_devices SET active_power_w=$1,mapping_summary=mapping_summary||jsonb_build_object('room_name',$2::text)",
        [power, `Synthetic display ${power}`]);
      assertEquals(await work(db), before, "successive inventory uploads do not re-read historical evidence");
    }
    assert(await fit.complete([]), "inventory estimates cannot starve a pinned fit before publication");
    await db.exec("UPDATE energy_optimisation_devices SET statistic_id='corrected-meter'");
    assert((await work(db)).next, "a real meter identity correction must still refresh evidence");
  } finally { await db.close(); }
});
