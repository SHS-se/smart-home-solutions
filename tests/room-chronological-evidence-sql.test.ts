// Independently generated synthetic source rows and room responses.
import type { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { claim, type Claim, handBack, home, other, release, revision } from "./helpers/room-fit-sql.ts";

import { chronologicalRoomDatabase as fixture } from "./helpers/chronological-room-sql.ts";

const begin = "2001-01-01T00:00:00.000Z", end = "2001-01-02T00:00:00.000Z";
const implementation = "synthetic-raw-v1", policy = "shared_interval_transitions_v1", binding = "synthetic-binding";
const snapshotMigration = "supabase/migrations/20261123150000_room_fit_snapshot_publication.sql";
const source = "energy_heating_observations";

type Work = { source_revision: number; policy_fingerprint: string; next: null | { from_at: string; to_at: string; solar_retry_at?: string } };
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
    assertEquals(await work(db), { ...w, next: null }, "actual retention path preserves the archive");
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

async function stage(db: PGlite, afterCell?: (index: number) => Promise<unknown>) {
  let j = await claim(db);
  const w = await work(db);
  if (w.next) j = await saveAndClaim(db, j, w);
  const rev = await revision(db);
  const evidence = { sourceRevision: w.source_revision, fromAt: begin, toAt: end, implementation };
  const fitImplementation = implementation + ":fit";
  const capture = { implementation: fitImplementation, attemptedAt: new Date().toISOString(), homeId: home, customerId: home, roomKey: "room", binding, baseRevision: rev, evidence };
  assert((await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit($1,$2,$3,$4,-1,$5::jsonb||jsonb_build_object('sha256',encode(sha256(decode($6,'base64')),'hex')),$6,null) AS ok",
    [j.id,j.generation,j.fence,rev,JSON.stringify({ version: 4, capture, policy_fingerprint: w.policy_fingerprint }),btoa("synthetic numerical capture")])).rows[0].ok);
  await release(db, j); j = await claim(db);
  let cursor = 0;
  while (cursor < 18) {
    const cells = Array.from({ length: afterCell ? 1 : 18 }, (_, i) => ({ index: cursor + i }));
    assert((await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit_cells($1,$2,$3,$4,$5,null,$6,null) AS ok",
      [j.id,j.generation,j.fence,rev,cursor,JSON.stringify(cells)])).rows[0].ok);
    await afterCell?.(cursor);
    cursor += cells.length;
    await release(db, j); j = await claim(db);
  }
  const transition_calibration = { policy, fitted_transitions: 100 };
  const learning = { transition_calibration, residual_degrees_of_freedom: 90 };
  const model = { home_id: home, customer_id: home, room_key: "room", sample_count: 100,
    last_attempted_at: new Date().toISOString(), last_fit_attempt: { learning }, heating_bands: { binding, reference_revision: "synthetic-revision",
      calibration_policy: policy, reference: { scope: {kind: "shared"}, learning_evidence: learning, model: {sample_count:100} },
      active: [], shared_attempt: { status: "fitted", implementation: fitImplementation, evidence } } };
  const complete = async (runs: {id: string; disposition: string}[] | null, patch: object = model) =>
    (await db.query<{ ok: boolean }>("SELECT complete_energy_room_fit($1,$2,$3,$4,18,$5,$6) AS ok", [j.id,j.generation,j.fence,rev,
      JSON.stringify(patch), runs === null ? null : JSON.stringify({ policy, observed_runs: runs.length, assessed_against: "synthetic-revision", runs })])).rows[0].ok;
  return { j, complete, model, evidence };
}
Deno.test("a sealed capture publishes through continuous backfill and pages every run by response revision", async () => {
  const db = await fixture();
  try {
    let fit = await stage(db, i => write(db, begin, i / 100));
    await write(db, begin, .77);
    assert((await work(db)).next, "ordinary corrections while every numerical cell runs remain durable");
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
    assert((await work(db)).next, "publication leaves later observations for the regular refit");
    const due = async () => (await db.query<{ due: number }>("SELECT request_energy_device_learning($1,$1,$2) AS due", [home,
      JSON.stringify([{ kind: "room", key: "room", input: {} }])])).rows[0].due;
    assertEquals(await due(), 0, "new observations alone cannot start an immediate successor");
    const accepted = (await db.query<{ reference: typeof model.heating_bands.reference & {
      learning_evidence: {source_evidence: typeof fit.evidence} } }>(
      "SELECT heating_bands->'reference' AS reference FROM energy_optimisation_zone_models WHERE home_id=$1", [home])).rows[0].reference;
    assertEquals(accepted.learning_evidence.source_evidence, fit.evidence);
    await db.query("UPDATE energy_optimisation_zone_models SET last_attempted_at=now()-interval '25 hours' WHERE home_id=$1", [home]);
    assertEquals(await due(), 1, "the trained room is admitted at its ordinary cadence");
    await release(db, fit.j);
    fit = await stage(db);
    const failed = { ...fit.model, heating_bands: { ...fit.model.heating_bands, reference: accepted,
      shared_attempt: { ...fit.model.heating_bands.shared_attempt, status: "unidentified" } } };
    assert(await fit.complete(null, failed), "a failed attempt records its diagnostics without changing the accepted response");
    const persisted = (await db.query<{ old: typeof fit.evidence; current: typeof fit.evidence }>(
      "SELECT heating_bands#>'{reference,learning_evidence,source_evidence}' AS old,heating_bands#>'{shared_attempt,evidence}' AS current FROM energy_optimisation_zone_models WHERE home_id=$1", [home])).rows[0];
    assertEquals(persisted.old, accepted.learning_evidence.source_evidence);
    assertEquals(persisted.current, fit.evidence); assert(persisted.current.sourceRevision > persisted.old.sourceRevision);
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

const fact = async (db: PGlite, basis: "customer_assertion" | "source_capability", from = begin, to = end) =>
  (await db.query<{ id: string }>(`INSERT INTO private.energy_room_operation_facts(home_id,customer_id,room_key,binding,from_at,to_at,basis)
    VALUES($1,$1,'room',$2,$3,$4,$5) RETURNING id`, [home, binding, from, to, basis])).rows[0].id;
const removeFact = (db: PGlite, id: string) => db.query("DELETE FROM private.energy_room_operation_facts WHERE id=$1", [id]);
const jobState = async (db: PGlite, id: string) => (await db.query<{ generation: number; pending: boolean; scratch: boolean }>(
  `SELECT generation,pending,EXISTS(SELECT FROM private.energy_room_fit_progress WHERE job_id=j.id) AS scratch
   FROM private.energy_learning_jobs j WHERE id=$1`, [id])).rows[0];

Deno.test("customer assertions veto incompatible checkpoints and sealed fits, including deletion; automatic facts follow normal cadence", async () => {
  const db = await fixture();
  try {
    const j = await claim(db);
    const rev = await revision(db);
    const w = await work(db);
    const evidence = { sourceRevision: w.source_revision, fromAt: begin, toAt: end, implementation };
    const capture = { homeId: home, customerId: home, roomKey: "room", binding, baseRevision: rev, evidence };
    const id = await fact(db, "customer_assertion");
    assert(w.policy_fingerprint !== (await work(db)).policy_fingerprint);
    assertEquals((await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit($1,$2,$3,$4,-1,$5,$6,null) AS ok",
      [j.id,j.generation,j.fence,rev,JSON.stringify({ version: 4, capture, policy_fingerprint: w.policy_fingerprint }),btoa("synthetic")])).rows[0].ok, false);
    assertEquals((await jobState(db, j.id)).scratch, false);
    await release(db, j);
    let fit = await stage(db);
    await removeFact(db, id);
    assertEquals(await fit.complete([]), false, "deleting an assertion used at capture vetoes publication");
    const active = await jobState(db, fit.j.id);
    assert(active.pending && !active.scratch);
    assertEquals(Number(active.generation), fit.j.generation);
    await release(db, fit.j);
    fit = await stage(db);
    const reviewed = await fact(db, "customer_assertion");
    assertEquals(await fit.complete([]), false, "adding a reviewed assertion vetoes a previously sealed capture");
    await release(db, fit.j);
    fit = await stage(db);
    const hash = (await work(db)).policy_fingerprint;
    await fact(db, "customer_assertion", end, "2001-01-03");
    const observing = await fact(db, "source_capability");
    assertEquals((await work(db)).policy_fingerprint, hash);
    assert(await fit.complete([]), "source capability is ordinary evidence and future assertions cannot alter this span");
    await release(db, fit.j);
    const idle = await jobState(db, fit.j.id);
    assertEquals(idle.pending, false);
    await removeFact(db, observing);
    const automatic = await fact(db, "source_capability");
    assertEquals(await jobState(db, fit.j.id), idle, "automatic insertion and removal cannot requeue idle rooms");
    await removeFact(db, automatic);
    await removeFact(db, reviewed);
    const awake = await jobState(db, fit.j.id);
    assert(awake.pending); assertEquals(Number(awake.generation), Number(idle.generation) + 1);
  } finally { await db.close(); }
});

Deno.test("material reviewed lineage wakes idle current rooms while unchanged eligibility and unrelated meters leave their capsules intact", async () => {
  const db = await fixture();
  try {
    await db.query("INSERT INTO energy_room_profiles VALUES($1,jsonb_build_object('room',jsonb_build_object('source_key',repeat('a',64))),'[]')", [home]);
    await db.query(`INSERT INTO energy_optimisation_devices(home_id,id,customer_id,device_key,statistic_id,category,
      mapping_summary,planning_role_override,control_type_override,mapping_status,mapped_control_type,active_power_w)
      VALUES($1,'33333333-3333-4333-8333-333333333333',$1,'heater','measured-meter','heating',
        '{"room_key":"room","room_name":"Synthetic room"}','controllable','setpoint','ready','setpoint',1000)`, [home]);
    // A previously accepted response used an earlier period. The review
    // below changes the new capture's policy without withdrawing that model.
    await db.query("UPDATE energy_optimisation_zone_models SET training_from='1999-01-01',training_to='2000-01-01' WHERE home_id=$1", [home]);
    let fit = await stage(db);
    const base = await revision(db);
    const hash = (await work(db)).policy_fingerprint;
    const exclude = (statistic: string) => db.query(`INSERT INTO private.energy_heating_meter_exclusions(
      home_id,device_key,statistic_id,valid_from,valid_to,reason) VALUES($1,'heater',$2,$3,$4,'synthetic review')`,
    [home, statistic, begin, end]);
    await exclude("unrelated-physical-meter");
    assertEquals((await work(db)).policy_fingerprint, hash);
    await exclude("measured-meter");
    assert(hash !== (await work(db)).policy_fingerprint);
    assertEquals(await revision(db), base);
    assertEquals(await fit.complete([]), false);
    await release(db, fit.j);
    fit = await stage(db);
    const addAssignment = () => db.query(`INSERT INTO private.energy_heating_history_sources(home_id,valid_from,valid_to,basis,
      target_source_key,target_device_statistics,observed_device_statistics)
      VALUES($1,$2,$3,'synthetic review',repeat('a',64),'{"heater":"measured-meter"}','{"heater":"former"}')`, [home, begin, end]);
    await addAssignment();
    assertEquals(await fit.complete([]), false, "a reviewed historical source change invalidates a sealed fit");
    await release(db, fit.j);
    fit = await stage(db); assert(await fit.complete([])); await release(db, fit.j);
    const idle = await jobState(db, fit.j.id);
    await db.query("UPDATE private.energy_heating_history_sources SET basis='reworded note' WHERE home_id=$1", [home]);
    assertEquals(await jobState(db, fit.j.id), idle);
    await db.query("DELETE FROM private.energy_heating_history_sources WHERE home_id=$1", [home]);
    const awakened = await jobState(db, fit.j.id);
    assert(awakened.pending); assertEquals(Number(awakened.generation), Number(idle.generation) + 1);
  } finally { await db.close(); }
});

Deno.test("claim discards captured work on a binding or base-model change before a numerical callback sees it", async () => {
  for (const change of ["binding", "model"]) {
    const db = await fixture();
    try {
      const fit = await stage(db);
      if (change === "binding") await db.query("UPDATE private.synthetic_bindings SET binding='replacement' WHERE home_id=$1", [home]);
      else await db.query("UPDATE energy_optimisation_zone_models SET gain_c_per_wh=.006 WHERE home_id=$1", [home]);
      await db.query("SELECT private.resume_energy_room_fit($1)", [fit.j.id]);
      await release(db, fit.j);
      const next = (await db.query<{ j: Claim & { room_fit_progress: unknown } }>("SELECT claim_energy_device_learning($1) AS j", [fit.j.id])).rows[0].j;
      assert(next); assertEquals(next.room_fit_progress, null, change);
      assertEquals((await jobState(db, fit.j.id)).scratch, false);
    } finally { await db.close(); }
  }
});

Deno.test("the block save ignores a concurrent append exactly at the owner's pinned horizon", async () => {
  const db = await fixture();
  try {
    const j = await claim(db);
    const scope = (await db.query<{ from_at: string; to_at: string }>(`SELECT
      (room_history_to-interval '15 minutes')::text AS from_at,room_history_to::text AS to_at
      FROM private.energy_learning_jobs WHERE id=$1`, [j.id])).rows[0];
    const tail = await work(db, scope.from_at, scope.to_at);
    await write(db, scope.to_at, .02);
    assert(await save(db, j, tail));
    assertEquals((await work(db, scope.from_at, scope.to_at)).next, null);
  } finally { await db.close(); }
});

Deno.test("reapplying snapshot publication preserves completed cells; missing certification fails closed", async () => {
  const db = await fixture();
  try {
    const sql = await Deno.readTextFile(snapshotMigration);
    let fit = await stage(db);
    const staged = (await db.query("SELECT * FROM private.energy_room_fit_progress WHERE job_id=$1", [fit.j.id])).rows;
    await db.exec(sql);
    assertEquals((await db.query("SELECT * FROM private.energy_room_fit_progress WHERE job_id=$1", [fit.j.id])).rows, staged);
    await db.query("UPDATE private.energy_room_fit_progress SET metadata=metadata-'policy_fingerprint' WHERE job_id=$1", [fit.j.id]);
    await db.exec(sql);
    assert((await jobState(db, fit.j.id)).scratch, "migration makes no destructive decision about pre-cutover work");
    assertEquals(await fit.complete([]), false);
    assert((await jobState(db, fit.j.id)).scratch, "an old worker cannot erase earned cells during rollout");
    assert((await db.query<{ ok: boolean }>("SELECT reset_energy_room_fit($1,$2,$3,$4,18) AS ok",
      [fit.j.id,fit.j.generation,fit.j.fence,await revision(db)])).rows[0].ok);
    await release(db, fit.j);
    fit = await stage(db);
    assert(await fit.complete([]), "an uncertifiable fit can roll forward with current certification");
  } finally { await db.close(); }
});

type PolicyAudit = {
  policy_fingerprint: string;
  source_policy_at: string | null;
  operation_facts: { id: string; home_id: string; customer_id: string; room_key: string; binding: string;
    kind: string; basis: string; from_at: string; to_at: string; created_at: string }[];
  exclusions: { from_at: string; to_at: string }[];
};
async function unsealed(db: PGlite) {
  const fit = await stage(db);
  const { j } = fit;
  const original = (await db.query<{ metadata: { sha256: string; policy_fingerprint: string }; cells: unknown[]; capture: Uint8Array }>(
    "SELECT metadata,cells,capture FROM private.energy_room_fit_progress WHERE job_id=$1", [j.id])).rows[0];
  await db.query("UPDATE private.energy_room_fit_progress SET metadata=metadata-'policy_fingerprint' WHERE job_id=$1", [j.id]);
  const args = [j.id,j.generation,j.fence,await revision(db)];
  const inspect = async (sha = original.metadata.sha256) => (await db.query<{ audit: PolicyAudit | null }>(
    "SELECT get_energy_room_fit_policy_audit($1,$2,$3,$4,$5) AS audit", [...args,sha])).rows[0].audit;
  const certify = async (fingerprint: string, options: { sha?: string; fence?: number; witnesses?: PolicyAudit["operation_facts"] } = {}) =>
    (await db.query<{ ok: boolean }>("SELECT certify_energy_room_fit_policy($1,$2,$3,$4,$5,$6,$7) AS ok",
      [j.id,j.generation,options.fence ?? j.fence,args[3],options.sha ?? original.metadata.sha256,fingerprint,
        JSON.stringify(options.witnesses ?? [])])).rows[0].ok;
  return { fit, original, inspect, certify };
}
Deno.test("only the learning service can audit and certify an unchanged immutable capture, then resume its exact cells", async () => {
  const db = await fixture();
  try {
    const privileges = await db.query<{ readable: boolean; writable: boolean }>(`SELECT
      has_function_privilege(r,'public.get_energy_room_fit_policy_audit(uuid,bigint,bigint,bigint,text)','EXECUTE') AS readable,
      has_function_privilege(r,'public.certify_energy_room_fit_policy(uuid,bigint,bigint,bigint,text,text,jsonb)','EXECUTE') AS writable
      FROM unnest(ARRAY['anon','authenticated','service_role']) r`);
    assertEquals(privileges.rows, [{readable:false,writable:false},{readable:false,writable:false},{readable:true,writable:true}]);
    await db.query(`INSERT INTO private.energy_heating_source_revisions(home_id,fingerprint,learning_updated_at)
      VALUES($1,private.energy_heating_source_fingerprint($1),now()-interval '1 day')`, [home]);
    const early = await fact(db, "source_capability");
    const { fit, original, inspect, certify } = await unsealed(db);
    const audit = await inspect(); assert(audit && audit.source_policy_at);
    assertEquals(Object.keys(audit).sort(), ["exclusions","operation_facts","policy_fingerprint","source_policy_at"]);
    assertEquals(audit.operation_facts.map(f => [f.id,f.home_id,f.customer_id,f.room_key,f.binding,f.kind,f.basis]),
      [[early,home,home,"room",binding,"heating_off_fan","source_capability"]]);
    assertEquals(audit.exclusions, []);
    assertEquals(await inspect("not a digest"), null); assertEquals(await inspect("0".repeat(64)), null);
    assertEquals(await certify(audit.policy_fingerprint, { sha: "0".repeat(64) }), false);
    assertEquals(await certify(audit.policy_fingerprint, { fence: fit.j.fence+1 }), false);
    const late = await fact(db, "customer_assertion");
    const revised = await inspect(); assert(revised); assert(revised.policy_fingerprint !== audit.policy_fingerprint);
    assertEquals(await certify(audit.policy_fingerprint), false, "a stale policy read cannot certify");
    assertEquals(await certify(revised.policy_fingerprint), false, "knowing the new hash cannot certify a newly created assertion");
    await removeFact(db, late);
    const [used] = audit.operation_facts;
    assertEquals(await certify(audit.policy_fingerprint, {witnesses:[used,used]}), false, "duplicate used UUID");
    assertEquals(await certify(audit.policy_fingerprint, {witnesses:[{...used,to_at:begin}]}), false, "forged coverage");
    assertEquals(await certify(audit.policy_fingerprint, {witnesses:[{...used,id:home}]}), false, "unknown UUID");
    await fact(db, "source_capability");
    assert(await certify(audit.policy_fingerprint, {witnesses:[used]}), "an additional unused automatic fact cannot cancel certification");
    assertEquals(await certify(audit.policy_fingerprint), false, "lost-reply retry cannot rewrite certified progress");
    assertEquals((await db.query("SELECT metadata,cells,capture FROM private.energy_room_fit_progress WHERE job_id=$1",
      [fit.j.id])).rows[0], original, "only the expected fingerprint was restored");
    await release(db, fit.j);
    const next = (await db.query<{ j: Claim & { room_fit_progress: { cursor: number } } }>(
      "SELECT claim_energy_device_learning($1) AS j", [fit.j.id])).rows[0].j;
    assertEquals(next.generation, fit.j.generation); assert(next.fence > fit.j.fence);
    assertEquals(next.room_fit_progress.cursor, 18);
  } finally { await db.close(); }
});

Deno.test("removing an automatic operation actually used by a cutover capture vetoes its certificate", async () => {
  const db = await fixture();
  try {
    await db.query(`INSERT INTO private.energy_heating_source_revisions(home_id,fingerprint,learning_updated_at)
      VALUES($1,private.energy_heating_source_fingerprint($1),now()-interval '1 day')`, [home]);
    const used = await fact(db, "source_capability");
    const { inspect, certify, fit } = await unsealed(db);
    const audit = await inspect(); assert(audit);
    await removeFact(db, used);
    const after = await inspect(); assert(after); assertEquals(after.policy_fingerprint, audit.policy_fingerprint);
    assertEquals(await certify(audit.policy_fingerprint, {witnesses:audit.operation_facts}), false);
    assert((await jobState(db, fit.j.id)).scratch, "failed certification leaves the reset decision to the owner");
  } finally { await db.close(); }
});

Deno.test("cutover audit returns only exclusion spans belonging to the relevant current or reviewed physical meter epoch", async () => {
  const db = await fixture();
  try {
    await db.query("INSERT INTO energy_room_profiles VALUES($1,jsonb_build_object('room',jsonb_build_object('source_key',repeat('a',64))),'[]')", [home]);
    await db.query(`INSERT INTO energy_optimisation_devices(home_id,id,customer_id,device_key,statistic_id,category,mapping_summary,
      planning_role_override,control_type_override,mapping_status,mapped_control_type)
      VALUES($1,'33333333-3333-4333-8333-333333333333',$1,'heater','current','heating','{"room_key":"room"}',
        'controllable','setpoint','ready','setpoint')`, [home]);
    const hour = (h: number) => new Date(Date.parse(begin)+h*3600000).toISOString();
    await db.query(`INSERT INTO private.energy_heating_history_sources(home_id,valid_from,valid_to,basis,
      target_source_key,target_device_statistics,observed_device_statistics)
      VALUES($1,$2,$3,'synthetic assignment',repeat('a',64),'{"heater":"current"}','{"heater":"former"}')`, [home,hour(6),hour(12)]);
    const exclude = (statistic: string, from: number, to: number) => db.query(`INSERT INTO private.energy_heating_meter_exclusions(
      home_id,device_key,statistic_id,valid_from,valid_to,reason) VALUES($1,'heater',$2,$3,$4,'synthetic review')`,
      [home,statistic,hour(from),hour(to)]);
    await exclude("current",0,24); await exclude("former",8,9); await exclude("unrelated",0,24);
    const { inspect, certify } = await unsealed(db);
    const audit = await inspect(); assert(audit);
    assertEquals(audit.exclusions.map(s => [Date.parse(s.from_at),Date.parse(s.to_at)]),
      [[0,6],[8,9],[12,24]].map(r => r.map(h => Date.parse(hour(h)))));
    await db.query("UPDATE private.energy_heating_source_revisions SET learning_updated_at=now()+interval '1 minute' WHERE home_id=$1", [home]);
    assertEquals(await certify(audit.policy_fingerprint), false, "a newer identity clock vetoes certification even if its hash returned to the old value");
  } finally { await db.close(); }
});
