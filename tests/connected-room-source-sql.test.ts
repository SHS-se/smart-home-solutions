// Independently generated synthetic installation; no private household inputs.
import { assertEquals, assertNotEquals } from "@std/assert";
import { connectedDatabase } from "./helpers/connected-room-sql.ts";
import { home } from "./helpers/room-fit-sql.ts";


Deno.test("connected SQL captures passive source identity without granting heater or comfort ownership", async () => {
  const db = await connectedDatabase();
  try {
    const capture = async () => (await db.query<{ value: { room_observed: Record<string, unknown>; room_heating: Record<string, { binding: string }>; room_graph: unknown } }>(
      "SELECT capture_energy_device_models($1) AS value", [home])).rows[0].value;
    const before = await capture();
    assertEquals(Object.keys(before.room_heating), ["room"]);
    assertEquals(Object.keys(before.room_observed), ["observed"]);
    const fingerprint = async () => (await db.query<{ value: string }>(
      "SELECT private.room_evidence_policy_fingerprint($1,'room',$2,'2001-01-01','2001-01-02') AS value",
      [home, (await capture()).room_heating.room.binding])).rows[0].value;
    const policy = await fingerprint();
    await db.query("UPDATE energy_room_profiles SET app_map_revision=2 WHERE home_id=$1", [home]);
    assertNotEquals(await fingerprint(), policy);
    assertNotEquals((await capture()).room_heating.room.binding, before.room_heating.room.binding);
    const work = (await db.query<{ value: { connected: { peerKeys: string[]; observedOnly: boolean; policyFingerprint: string }; policy_fingerprint: string } }>(
      "SELECT get_energy_room_evidence_work($1,$1,'room',$2,'2001-01-01','2001-01-02','chronological_native_evidence_v1') AS value",
      [home, (await capture()).room_heating.room.binding])).rows[0].value;
    assertEquals(work.connected.peerKeys, ["observed"]);
    assertEquals(work.connected.observedOnly, false);
    assertEquals(work.connected.policyFingerprint, work.policy_fingerprint);
  } finally { await db.close(); }
});

Deno.test("passive native rows preserve unavailable peers, missing weather and no heater measurement; lineage fences moved probes", async () => {
  const db = await connectedDatabase();
  try {
    const read = async () => (await db.query<{ heat_w: null; room_temperature_c: number; outdoor_temperature_c: null; duration_s: number; temperature_source_key: string }>(
      "SELECT heat_w,room_temperature_c,outdoor_temperature_c,duration_s,temperature_source_key FROM get_energy_room_thermal_intervals($1,$1,'observed','2001-01-01','2001-01-02')", [home])).rows;
    await db.query("INSERT INTO energy_heating_probe_observations(home_id,customer_id,start_ts,duration_s,probes) VALUES($1,$1,'2001-01-01',900,$2)",
      [home, JSON.stringify([{ source_key: "b".repeat(64), area_key: "observed", mean: 23, unavailable: false, cohort_key: null },
        { source_key: "a".repeat(64), area_key: "room", mean: null, unavailable: true, cohort_key: null }])]);
    assertEquals(await read(), [{ heat_w: null, room_temperature_c: 23, outdoor_temperature_c: null, duration_s: 900, temperature_source_key: "b".repeat(64) }]);
    await db.query("UPDATE energy_room_profiles SET rooms=jsonb_set(rooms,'{observed,source_key}',$2) WHERE home_id=$1", [home, JSON.stringify("d".repeat(64))]);
    assertEquals(await read(), []);
    await db.query(`INSERT INTO private.energy_heating_history_sources(home_id,room_key,valid_from,valid_to,
      observed_source_key,target_source_key,target_device_statistics,observed_device_statistics)
      VALUES($1,'observed','2000-01-01','2002-01-01',$2,$3,'{}','{}')`, [home, "b".repeat(64), "d".repeat(64)]);
    assertEquals((await read())[0].temperature_source_key, "b".repeat(64));
  } finally { await db.close(); }
});

Deno.test("snapshot enqueue includes linked observed rooms and preserves pending generations on repeat", async () => {
  const db = await connectedDatabase();
  try {
    await db.exec(await Deno.readTextFile("supabase/migrations/20261126194000_qualify_observed_room_enqueue.sql"));
    const input = { location: null, learner_version: "synthetic-learner" };
    const owners = [{ kind: "room", key: "room", input }];
    const enqueue = async () => (await db.query<{ queued: number }>(
      "SELECT request_energy_device_learning($1,$1,$2) AS queued", [home, JSON.stringify(owners)])).rows[0].queued;
    const jobs = async () => (await db.query<{ owner_key: string; input: typeof input; pending: boolean; generation: number; fence: number }>(
      "SELECT owner_key,input,pending,generation,fence FROM private.energy_learning_jobs WHERE home_id=$1 AND owner_kind='room' ORDER BY owner_key",
      [home])).rows;
    assertEquals(await enqueue(), 2);
    const first = await jobs();
    assertEquals(first.map(job => [job.owner_key, job.input, job.pending]), [["observed", input, true], ["room", input, true]]);
    assertEquals(await enqueue(), 0);
    assertEquals(await jobs(), first);
  } finally { await db.close(); }
});
