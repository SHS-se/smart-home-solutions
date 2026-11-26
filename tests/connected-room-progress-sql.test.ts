// Independent synthetic numerical continuations, not household learned states.
import { assert, assertEquals } from "@std/assert";
import { connectedDatabase } from "./helpers/connected-room-sql.ts";
import { claim, release, home, type Claim } from "./helpers/room-fit-sql.ts";

Deno.test("adaptive continuation uses fenced state CAS beyond measured cell count and preserves immutable capture", async () => {
  const db = await connectedDatabase();
  try {
    for (const name of ["20261123160000_measured_room_response", "20261123170000_state_carrying_room_forecasts",
      "20261126151000_connected_room_publication", "20261126151100_connected_room_fit_progress"]) {
      await db.exec(await Deno.readTextFile(`supabase/migrations/${name}.sql`));
    }
    await db.query("UPDATE private.energy_learning_jobs SET pending=true,wake_after=now(),lease_until=NULL WHERE home_id=$1", [home]);
    let owner = await claim(db);
    const binding = (await db.query<{ value: { binding: string } }>("SELECT get_energy_room_heating_context($1,'room') AS value", [home])).rows[0].value.binding;
    const work = (await db.query<{ value: { source_revision: number; policy_fingerprint: string; connected: unknown } }>(
      "SELECT get_energy_room_evidence_work($1,$1,'room',$2,'2001-01-01','2001-01-02','chronological_native_evidence_v1') AS value", [home, binding])).rows[0].value;
    const metadata = { version: 6, policy_fingerprint: work.policy_fingerprint, capture: {
      homeId: home, customerId: home, roomKey: "room", binding, baseRevision: 1,
      implementation: "chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1",
      evidence: { sourceRevision: work.source_revision, fromAt: "2001-01-01T00:00:00Z", toAt: "2001-01-02T00:00:00Z",
        implementation: "chronological_native_evidence_v1" }, connected: work.connected } };
    assert((await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_fit($1,$2,$3,1,-1,$4,$5,NULL) AS ok",
      [owner.id, owner.generation, owner.fence, JSON.stringify(metadata), btoa("synthetic-immutable")])).rows[0].ok);
    const reclaim = async () => { await release(db, owner); owner = await claim(db); };
    const checkpoint = async (cursor: number, expected: unknown, next: unknown, fence = owner.fence) =>
      (await db.query<{ ok: boolean }>("SELECT checkpoint_energy_room_adaptive_fit($1,$2,$3,1,$4,$5,$6) AS ok",
        [owner.id, owner.generation, fence, cursor, JSON.stringify(expected), JSON.stringify(next)])).rows[0].ok;
    await reclaim();
    let state: { version: number; stage: string; row: number } | null = null;
    for (let cursor = 0; cursor < 110; cursor++) {
      const next = { version: 1, stage: "static", row: cursor + 1 };
      if (cursor === 1) {
        assertEquals(await checkpoint(0, null, next), false, "lost reply cannot apply the same progress twice");
        assertEquals(await checkpoint(cursor, state, next, owner.fence - 1), false, "a previous claimant cannot update the state");
      }
      assert(await checkpoint(cursor, state, next));
      state = next;
      await reclaim();
      const progress = (owner as Claim & { room_fit_progress: { cursor: number; cells: unknown[] } }).room_fit_progress;
      assertEquals(progress.cursor, cursor + 1);
      assertEquals(progress.cells, []);
    }
    const saved = (await db.query<{ value: unknown; bytes: string }>(
      "SELECT metadata->'capture' AS value,convert_from(capture,'UTF8') AS bytes FROM private.energy_room_fit_progress WHERE job_id=$1", [owner.id])).rows[0];
    assertEquals(saved.value, metadata.capture);
    assertEquals(saved.bytes, "synthetic-immutable");
    assertEquals((await db.query<{ ok: boolean }>("SELECT reset_energy_room_fit($1,$2,$3,1,109) AS ok", [owner.id, owner.generation, owner.fence])).rows[0].ok, false);
    assert((await db.query<{ ok: boolean }>("SELECT reset_energy_room_fit($1,$2,$3,1,110) AS ok", [owner.id, owner.generation, owner.fence])).rows[0].ok);
  } finally { await db.close(); }
});
