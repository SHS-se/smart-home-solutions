// Independent synthetic accepted receiving responses and durable ownership.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connectedDatabase } from "./helpers/connected-room-sql.ts";
import { claim, home } from "./helpers/room-fit-sql.ts";

async function staged(observed: boolean) {
  const db = await connectedDatabase();
  await db.exec(await Deno.readTextFile("supabase/migrations/20261123160000_measured_room_response.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261123170000_state_carrying_room_forecasts.sql"));
  await db.exec(await Deno.readTextFile("supabase/migrations/20261126151000_connected_room_publication.sql"));
  const room = observed ? "observed" : "room";
  if (observed) {
    await db.query("UPDATE private.energy_learning_jobs SET pending=false WHERE home_id=$1", [home]);
    await db.query(`INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
      VALUES($1,$1,'room','observed','{}')`, [home]);
  }
  await db.query("UPDATE private.energy_learning_jobs SET wake_after=now(),pending=true,lease_until=NULL WHERE home_id=$1 AND owner_key=$2", [home, room]);
  const j = await claim(db);
  const revision = observed ? 0 : 1;
  const fromAt = "2001-01-01T00:00:00Z", toAt = "2001-01-02T00:00:00Z";
  const context = (await db.query<{ value: { binding: string } }>("SELECT get_energy_room_heating_context($1,$2) AS value", [home, room])).rows[0].value;
  const work = (await db.query<{ value: { source_revision: number; policy_fingerprint: string; connected: {
    graph: { owner: string; revision: number; topology_hash: string }; peerKeys: string[]; observedOnly: boolean } } }>(
    "SELECT get_energy_room_evidence_work($1,$1,$2,$3,$4,$5,'chronological_native_evidence_v1') AS value",
    [home, room, context.binding, fromAt, toAt])).rows[0].value;
  const evidence = { sourceRevision: work.source_revision, fromAt, toAt, implementation: "chronological_native_evidence_v1" };
  const implementation = "chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1";
  const metadata = { version: 6, policy_fingerprint: work.policy_fingerprint, heat_state: { stage: "complete" },
    capture: { homeId: home, customerId: home, roomKey: room, binding: context.binding, baseRevision: revision, implementation,
      evidence, connected: work.connected } };
  await db.query(`INSERT INTO private.energy_room_evidence_blocks(home_id,customer_id,room_key,binding,implementation,
      from_at,to_at,source_revision,capture,sha256,row_count) VALUES($1,$1,$2,$3,$4,$5,$6,$7,'synthetic',repeat('a',64),0)`,
    [home, room, context.binding, evidence.implementation, fromAt, toAt, work.source_revision]);
  await db.query(`INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture,cells,adaptive_cursor)
    VALUES($1,$2,$3,$4,'synthetic','[]',1)`, [j.id, j.generation, revision, JSON.stringify(metadata)]);
  const basis = { graph_owner: work.connected.graph.owner, graph_revision: work.connected.graph.revision,
    topology_hash: work.connected.graph.topology_hash, source_policy: work.policy_fingerprint,
    source_revision: work.source_revision, history_from: fromAt, history_to: toAt };
  const connected = { family: "adaptive_connected_native_v1", thermal: { outdoor_per_h: .05,
    heater: observed ? null : { gain_c_per_wh: .001, lag_h: 0, gain_reference_outdoor_c: 0, gain_outdoor_slope_per_c: 0 },
    solar_per_wm2_h: 0, background_per_h: 0 }, incoming: [{ kind: "constant", from: observed ? "room" : "observed", per_h: .1 }],
    observation_noise_c2_h: .01, thermal_noise_c2_per_h: .01,
    reference_state: { through_ms: Date.parse(toAt), temperature_c: 20, stored_heat_c: 0,
      log_rates: [], covariance: [[.01, 0], [0, 0]], observations: 20 }, basis, evidence: { fitted_observations: 20 } };
  const learning = { source_evidence: evidence };
  const model = { home_id: home, customer_id: home, room_key: room, trained: true, rejection_reason: null,
    gain_c_per_wh: observed ? null : .001, cooling_constant_per_h: observed ? null : .05,
    background_gain_c_per_h: observed ? null : 0, sample_count: 20, last_fit_attempt: { learning },
    heating_bands: { binding: context.binding, calibration_policy: "measured_room_runs_v1", reference_revision: "synthetic-connected",
      active: [], reference: { scope: { kind: "shared" }, model: observed ? null : { response_family: "finite", sample_count: 20 },
        connected_exchange: connected, learning_evidence: learning }, shared_attempt: { implementation, evidence, status: "fitted" } } };
  const complete = async (value: unknown = model) => (await db.query<{ value: boolean }>(
    "SELECT complete_energy_room_fit($1,$2,$3,$4,1,$5,NULL) AS value", [j.id, j.generation, j.fence, revision, JSON.stringify(value)])).rows[0].value;
  return { db, complete, model };
}

Deno.test("connected publication accepts observed thermal nodes with no fitted heater or scalar model", async () => {
  const { db, complete } = await staged(true);
  try {
    assert(await complete());
    assertEquals((await db.query("SELECT trained,gain_c_per_wh,heating_bands#>'{reference,model}' AS model FROM energy_optimisation_zone_models WHERE room_key='observed'")).rows,
      [{ trained: true, gain_c_per_wh: null, model: null }]);
  } finally { await db.close(); }
});

Deno.test("connected publication fences both captured source basis and a graph revision change", async () => {
  const { db, complete, model } = await staged(false);
  try {
    const forged = structuredClone(model);
    forged.heating_bands.reference.connected_exchange.basis.source_revision++;
    await assertRejects(() => complete(forged), Error, "Invalid connected room response");
    await db.query("UPDATE energy_room_profiles SET app_map_revision=2 WHERE home_id=$1", [home]);
    assertEquals(await complete(), false);
  } finally { await db.close(); }
});

Deno.test("an uncalibrated controlled heater publishes only its identified passive response with explicit evidence", async () => {
  const { db, complete, model } = await staged(false);
  try {
    model.heating_bands.reference.model = null;
    model.heating_bands.reference.connected_exchange.thermal.heater = null;
    model.gain_c_per_wh = null; model.cooling_constant_per_h = null; model.background_gain_c_per_h = null;
    await assertRejects(() => complete(model), Error, "Invalid connected room response");
    Object.assign(model.heating_bands.reference.connected_exchange.evidence, { heater_identified: false, unidentified_heater: true });
    assert(await complete());
    assertEquals((await db.query("SELECT trained,gain_c_per_wh,heating_bands#>'{reference,model}' AS model FROM energy_optimisation_zone_models WHERE room_key='room' AND home_id=$1", [home])).rows,
      [{ trained: true, gain_c_per_wh: null, model: null }]);
    const context = (await db.query<{ value: { observed_only: boolean; meters: unknown } }>("SELECT get_energy_room_heating_context($1,'room') AS value", [home])).rows[0].value;
    assertEquals(context.observed_only, false, "the physical actuator remains controlled, though its thermal gain is unidentified");
  } finally { await db.close(); }
});

Deno.test("an electrically identified connected heater publishes no invented physical heat capacity or loss", async () => {
  const { db, complete, model } = await staged(false);
  try {
    await db.exec("ALTER TABLE energy_optimisation_zone_models ADD COLUMN heat_loss_w_per_c numeric, ADD COLUMN thermal_capacity_wh_per_c numeric");
    Object.assign(model, { thermal_capacity_wh_per_c: null, heat_loss_w_per_c: null });
    Object.assign(model.heating_bands.reference.model!, { thermal_capacity_wh_per_c: null, heat_loss_w_per_c: null });
    assert(await complete());
    assertEquals((await db.query("SELECT thermal_capacity_wh_per_c,heat_loss_w_per_c FROM energy_optimisation_zone_models WHERE home_id=$1 AND room_key='room'", [home])).rows,
      [{ thermal_capacity_wh_per_c: null, heat_loss_w_per_c: null }]);
  } finally { await db.close(); }
});
