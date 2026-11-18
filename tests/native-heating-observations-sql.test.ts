import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { assertEquals, assertRejects } from "@std/assert";

Deno.test("native heating storage preserves interval energy, source lineage and material evidence revisions", async () => {
  const db = new PGlite();
  // Independently generated synthetic installation; no household replay inputs.
  const home = "11111111-1111-4111-8111-111111111111", customer = "22222222-2222-4222-8222-222222222222";
  const hash = async (entity: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entity)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const source = "a".repeat(64), formerEntity = "sensor.synthetic_former_room_temperature";
  const former = await hash(formerEntity), conflictingEntity = "sensor.synthetic_conflicting_temperature";
  const conflicting = await hash(conflictingEntity);
  const device = "33333333-3333-4333-8333-333333333333";
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA private; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
      CREATE FUNCTION can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE TABLE homes(id uuid PRIMARY KEY, customer_id uuid);
      CREATE FUNCTION energy_home_matches_customer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT FROM homes WHERE id=$1 AND customer_id=$2) $$;
      INSERT INTO homes VALUES('${home}','${customer}');
      CREATE TABLE energy_room_profiles(home_id uuid,rooms jsonb,connections jsonb);
      INSERT INTO energy_room_profiles VALUES('${home}','{"room":{"source_key":"${source}"}}','[]');
      CREATE TABLE energy_optimisation_devices(id uuid PRIMARY KEY,home_id uuid,customer_id uuid,
        device_key text,statistic_id text,category text,mapping_summary jsonb,active_power_w numeric,
        retired_at timestamptz,planning_role_override text,control_type_override text,mapping_status text,mapped_control_type text,
        first_seen_at timestamptz DEFAULT now(),UNIQUE(id,home_id,customer_id));
      INSERT INTO energy_optimisation_devices VALUES('${device}','${home}','${customer}','heater','sensor.synthetic_energy','heating',
        '{"room_key":"room","room_name":"Synthetic room"}',800,null,'controllable','switch_schedule','ready','switch_schedule',now());
      CREATE TABLE energy_room_probe_slots(home_id uuid,room_key text,source_key text,start_ts timestamptz);
      CREATE TABLE energy_history_notes(home_id uuid,note_date date,event_type text);
      CREATE TABLE private.energy_room_passive_heat_sources(home_id uuid,room_key text,device_id uuid);
      CREATE TABLE energy_optimisation_device_slots(device_id uuid,home_id uuid,customer_id uuid,start_ts timestamptz,energy_kwh numeric NOT NULL,
        quality jsonb DEFAULT '{}');
      CREATE TABLE energy_optimisation_thermal_slots(home_id uuid,customer_id uuid,room_key text,start_ts timestamptz,
        room_temperature_c numeric,cooling_duty numeric);
      CREATE TABLE energy_optimisation_outdoor_slots(home_id uuid,customer_id uuid,start_ts timestamptz,temperature_c numeric,solar_w_per_m2 numeric);
      CREATE TABLE energy_optimisation_house_slots(home_id uuid,start_ts timestamptz,temperature_c numeric);
      CREATE FUNCTION get_energy_room_planning_history(uuid,uuid,text[],timestamptz,timestamptz) RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION get_energy_room_heating_band_history(uuid,text,timestamptz,timestamptz) RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE TABLE energy_optimisation_device_operating_points(home_id uuid,device_key text,last_attempted_at timestamptz,
        last_fit_attempt jsonb, operating_points jsonb);
      CREATE TABLE private.energy_learning_jobs(id uuid DEFAULT gen_random_uuid(),home_id uuid,customer_id uuid,
        owner_kind text,owner_key text,input jsonb,pending boolean DEFAULT true,generation int DEFAULT 1,
        fence int DEFAULT 1,lease_until timestamptz,wake_after timestamptz,attempts int,last_error text,finished_at timestamptz,
        UNIQUE(home_id,owner_kind,owner_key));
      CREATE FUNCTION private.wake_energy_learning_job(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    `);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261026002000_preserve_unknown_room_heat_observations.sql"));
    await db.exec(await Deno.readTextFile("supabase/migrations/20261113161000_learn_from_hourly_heating_history.sql"));
    // Unused lifecycle functions reference deployment-owned job tables. The
    // functions under test execute against the concrete synthetic relations.
    await db.exec("SET check_function_bodies=false");
    await db.exec(await Deno.readTextFile("supabase/migrations/20261118190000_native_heating_observations.sql"));
    await db.exec("SET check_function_bodies=true");
    const start = (await db.query<{ at: string }>("SELECT to_char(date_trunc('hour',now()-interval '1 day'),'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS at")).rows[0].at;
    const end = new Date(Date.parse(start) + 3_600_000).toISOString();
    const row = { room_key: "room", source_key: source, device_statistics: { heater: "sensor.synthetic_energy" },
      start, duration_s: 3600, source: "recorder_hour_mean", room_temperature_c: 20, outdoor_temperature_c: -7,
      house_temperature_c: 21, cooling: false, device_energy_kwh: { heater: 1.4 }, heater_energy_limits_w: { heater: 800 } };
    const write = async (value: unknown) => (await db.query<{ receipt: unknown }>(
      "SELECT record_energy_heating_observations($1,$2,$3::jsonb) AS receipt", [home, customer, JSON.stringify([value])])).rows[0].receipt;
    const intervals = async () => (await db.query("SELECT duration_s,heat_w,heat_attributed FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, start, end])).rows;
    const stamp = async () => (await db.query<{ at: string }>("SELECT learning_updated_at::text AS at FROM energy_heating_observations WHERE start_ts=$1", [start])).rows[0].at;
    assertEquals(await write(row), { accepted: 1, accepted_by_source: [{ room_key: "room", source_key: source, accepted: 1 }] });
    assertEquals(await intervals(), [{ duration_s: 3600, heat_w: 800, heat_attributed: true }]);
    // Qualified native history precedes current meter discovery and an old
    // probe cutoff. Ambiguous legacy rows must remain excluded there.
    await db.query("INSERT INTO energy_room_probe_slots VALUES($1,'room',$2,$3)", [home, former, end]);
    assertEquals((await db.query<{at:string}>("SELECT observed_since::text AS at FROM private.energy_room_heating_contexts($1,true)", [home])).rows
      .map(r => new Date(r.at).toISOString()), [new Date(start).toISOString()]);
    assertEquals((await db.query("SELECT device_energy_kwh FROM energy_heating_observations")).rows, [{ device_energy_kwh: { heater: 1.4 } }]);
    await write({ ...row, heater_energy_limits_w: {} });
    assertEquals(await intervals(), [{ duration_s: 3600, heat_w: 1400, heat_attributed: false }]);
    assertEquals((await db.query("SELECT device_energy_kwh FROM energy_heating_observations")).rows, [{ device_energy_kwh: { heater: 1.4 } }],
      "removing attribution limits leaves raw measured energy intact");
    await write(row);
    const legacyAt = new Date(Date.parse(start) - 900_000).toISOString();
    await db.query("INSERT INTO energy_optimisation_thermal_slots VALUES($1,$2,'room',$3,20,0)", [home, customer, legacyAt]);
    assertEquals((await db.query("SELECT start_ts FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, legacyAt, start])).rows, []);
    const original = await stamp();
    await write(row);
    assertEquals(await stamp(), original);
    await write({ ...row, device_energy_kwh: { heater: null } });
    assertEquals(await intervals(), [{ duration_s: 3600, heat_w: 800, heat_attributed: true }]);
    assertEquals(await stamp(), original);
    // Contradictory counter evidence wins over an accompanying positive value.
    await write({ ...row, invalidated_device_keys: ["heater"] });
    assertEquals(await intervals(), [{ duration_s: 3600, heat_w: null, heat_attributed: true }]);
    assertEquals(await stamp() === original, false);
    assertEquals((await db.query("SELECT band_c FROM get_energy_room_heating_fit_windows($1,$2,'room',$3,$4)",
      [home, customer, start, end])).rows, [{ band_c: -10 }]);
    // Newest missing thermometer does not discard a known heating interval.
    await write({ ...row, start: end, room_temperature_c: null, device_energy_kwh: { heater: .2 } });
    assertEquals((await db.query("SELECT room_temperature_c,heat_w FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, end, new Date(Date.parse(end) + 3_600_000).toISOString()])).rows,
    [{ room_temperature_c: null, heat_w: 200 }]);
    assertEquals(await write({ ...row, source_key: former }), { accepted: 0, accepted_by_source: [] });
    await db.query(`INSERT INTO private.energy_heating_history_sources(home_id,room_key,target_source_key,target_device_statistics,observed_source_key,observed_device_statistics,valid_from,valid_to,basis,observed_temperature_entity_id,heater_energy_limits_w) VALUES($1,'room',$2,$3::jsonb,$4,$3::jsonb,$5,$6,'Synthetic lineage',$7,'{"heater":800}')`,
      [home, source, JSON.stringify(row.device_statistics), former, start, end, formerEntity]);
    // A current-source resweep is acknowledged as raw history, while the
    // explicit historical assignment alone is eligible for model learning.
    assertEquals(await write(row), { accepted: 1, accepted_by_source: [{ room_key: "room", source_key: source, accepted: 1 }] });
    assertEquals(await intervals(), []);
    assertEquals(await write({ ...row, source_key: former }), { accepted: 1,
      accepted_by_source: [{ room_key: "room", source_key: former, accepted: 1 }] });
    assertEquals(await intervals(), [{ duration_s: 3600, heat_w: 800, heat_attributed: true }]);
    await assertRejects(() => db.query(`INSERT INTO private.energy_heating_history_sources(home_id,room_key,target_source_key,target_device_statistics,observed_source_key,observed_device_statistics,valid_from,valid_to,basis,observed_temperature_entity_id)
      VALUES($1,'room',$2,$3::jsonb,$4,$3::jsonb,$5,$6,'Synthetic conflict',$7)`,
    [home, source, JSON.stringify(row.device_statistics), conflicting, start, end, conflictingEntity]), Error, "Conflicting historical heating source assignments");

    // Shared probe facts are joined by exact native interval and source identity.
    const neighbour = await hash("sensor.synthetic_neighbour_temperature");
    const fact = { source_key: former, area_key: "room", mean: 20, unchanged: true,
      joint_unchanged: true, cohort_key: "synthetic-bridge", reported: false, unavailable: false };
    const otherFact = { ...fact, source_key: neighbour, area_key: "neighbour", mean: 21 };
    await db.query("UPDATE energy_room_profiles SET rooms=rooms||jsonb_build_object('neighbour',jsonb_build_object('source_key',$1::text)) WHERE home_id=$2", [neighbour, home]);
    const writeProbes = async (probes: unknown[], at = start, duration = 3600) => (await db.query<{ accepted: number }>(
      "SELECT record_energy_heating_probe_observations($1,$2,$3::jsonb) AS accepted",
      [home, customer, JSON.stringify([{ start: at, duration_s: duration, probes }])])).rows[0].accepted;
    const facts = async (at = start) => (await db.query<{ probes: Record<string, unknown>[] }>(
      "SELECT probes FROM energy_heating_probe_observations WHERE start_ts=$1 ORDER BY duration_s", [at])).rows[0].probes;
    const window = async () => (await db.query<{ fingerprint: string; changed: string }>(
      "SELECT fingerprint,evidence_updated_at::text AS changed FROM get_energy_room_heating_fit_windows($1,$2,'room',$3,$4)",
      [home, customer, start, end])).rows[0];
    let beforeProbes = await window();
    await db.query("UPDATE energy_optimisation_devices SET active_power_w=999,mapping_summary=jsonb_set(mapping_summary,'{room_name}','\"Renamed synthetic room\"') WHERE id=$1", [device]);
    assertEquals(await window(), beforeProbes,
      "diagnostic learned watts and display labels do not restart numerical evidence");
    await db.query("UPDATE energy_optimisation_devices SET active_power_w=800,mapping_summary=jsonb_set(mapping_summary,'{room_name}','\"Synthetic room\"') WHERE id=$1", [device]);
    assertEquals(await window(), beforeProbes);
    await write({ ...row, source_key: former, room_temperature_c: 20.5 });
    const temperatureCorrection = await window();
    assertEquals(temperatureCorrection.fingerprint === beforeProbes.fingerprint, false);
    assertEquals(temperatureCorrection.changed === beforeProbes.changed, false);
    await write({ ...row, source_key: former, device_energy_kwh: { heater: .2 } });
    const energyCorrection = await window();
    assertEquals(energyCorrection.fingerprint === temperatureCorrection.fingerprint, false);
    assertEquals(energyCorrection.changed === temperatureCorrection.changed, false);
    await write({ ...row, source_key: former });
    beforeProbes = await window();
    assertEquals(await writeProbes([otherFact, fact]), 1);
    const afterProbes = await window();
    assertEquals(afterProbes.fingerprint === beforeProbes.fingerprint, false);
    assertEquals(afterProbes.changed === beforeProbes.changed, false);
    assertEquals((await db.query("SELECT temperature_source_key,probe_evidence FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, start, end])).rows, [{ temperature_source_key: former, probe_evidence: await facts() }]);
    await writeProbes([fact, otherFact]);
    assertEquals(await window(), afterProbes, "array order alone is not new evidence");
    await writeProbes([otherFact, { ...fact, mean: null, unchanged: null, joint_unchanged: null,
      cohort_key: null, reported: null, unavailable: null }]);
    assertEquals(await window(), afterProbes, "missing rereads preserve known same-source facts");
    await writeProbes([{ ...fact, mean: 20.5, unchanged: null, joint_unchanged: null, reported: null, unavailable: null }]);
    assertEquals(await facts(), [{ ...fact, mean: 20.5, unchanged: null, joint_unchanged: null, reported: null, unavailable: null }],
      "a corrected mean cannot inherit old stillness/outage evidence; omitted roster members are removed");
    assertEquals((await window()).fingerprint === afterProbes.fingerprint, false);
    await writeProbes([{ ...fact, mean: 20.5, unchanged: false, joint_unchanged: false, reported: true, unavailable: true }]);
    assertEquals((await facts())[0].unavailable, true, "explicit unavailable is authoritative even with a retained mean");
    await writeProbes([{ ...fact, mean: 20.6, unchanged: null, joint_unchanged: null, reported: null, unavailable: null }]);
    assertEquals((await facts())[0].unavailable, null, "a new measured mean does not inherit an old outage");
    await writeProbes([{ ...fact, cohort_key: "synthetic-other-bridge", mean: 20.6, unchanged: null,
      joint_unchanged: null, reported: null, unavailable: null }]);
    assertEquals((await facts())[0].joint_unchanged, null);
    await assertRejects(() => writeProbes([{ ...fact, source_key: "unhashed" }]), Error, "Invalid probe evidence");
    await assertRejects(() => db.query("SELECT record_energy_heating_probe_observations($1,$2,'[]')", [home, device]), Error, "Home mismatch");
    await assertRejects(() => db.query("SELECT get_energy_heating_history_sources($1,$2)", [home, device]), Error, "Home mismatch");
    assertEquals((await db.query("SELECT * FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [device, home, start, end])).rows, []);

    const lineage = async () => (await db.query<{ sources: { revision: string; assignments: unknown[] } }>(
      "SELECT get_energy_heating_history_sources($1,$2) AS sources", [home, customer])).rows[0].sources;
    const initialLineage = await lineage();
    assertEquals(initialLineage.assignments.length, 1);
    assertEquals(initialLineage.assignments[0], { room_key: "room", target_source_key: source,
      target_device_statistics: row.device_statistics, observed_source_key: former,
      observed_temperature_entity_id: formerEntity, observed_device_statistics: row.device_statistics,
      valid_from: new Date(start).toISOString().replace(".000Z", "+00:00"),
      valid_to: new Date(end).toISOString().replace(".000Z", "+00:00"), heater_energy_limits_w: { heater: 800 } });
    const beforeIdentity = await window();
    await db.query("UPDATE private.energy_heating_history_sources SET basis='Another reviewed description' WHERE home_id=$1", [home]);
    assertEquals(await lineage(), initialLineage, "descriptive notes do not change source assignments");
    assertEquals(await window(), beforeIdentity);
    await db.query("UPDATE private.energy_heating_history_sources SET heater_energy_limits_w='{\"heater\":700}' WHERE home_id=$1", [home]);
    assertEquals((await lineage()).revision === initialLineage.revision, false);
    assertEquals((await window()).changed === beforeIdentity.changed, false, "reviewed source-fact corrections are material evidence");
    assertEquals(await intervals(), [{ duration_s: 3600, heat_w: 700, heat_attributed: true }],
      "reviewed attribution is authoritative without reuploading unchanged raw energy");
    await db.query("UPDATE private.energy_heating_history_sources SET heater_energy_limits_w='{}' WHERE home_id=$1", [home]);
    assertEquals(await intervals(), [{ duration_s: 3600, heat_w: 1400, heat_attributed: false }]);
    assertEquals((await db.query("SELECT device_energy_kwh FROM energy_heating_observations WHERE source_key=$1 AND start_ts=$2", [former, start])).rows,
      [{ device_energy_kwh: { heater: 1.4 } }]);

    await assertRejects(() => db.query("UPDATE private.energy_heating_history_sources SET observed_temperature_entity_id='sensor.wrong' WHERE home_id=$1", [home]),
      Error, "check constraint");
    await db.query("UPDATE energy_optimisation_devices SET statistic_id='sensor.synthetic_replacement_energy' WHERE id=$1", [device]);
    assertEquals((await lineage()).assignments, [], "obsolete target meter assignments must not reach the app");
    await db.query("UPDATE energy_optimisation_devices SET statistic_id='sensor.synthetic_energy' WHERE id=$1", [device]);
    assertEquals((await lineage()).assignments.length, 1);
    await db.query("UPDATE private.energy_heating_history_sources SET heater_energy_limits_w='{\"heater\":800}' WHERE home_id=$1", [home]);

    const beforeDeletion = await window();
    await db.query("DELETE FROM private.energy_heating_history_sources WHERE home_id=$1", [home]);
    assertEquals((await lineage()).assignments, []);
    assertEquals((await window()).changed === beforeDeletion.changed, false, "the material clock survives lineage deletion");
    await db.query(`INSERT INTO private.energy_heating_history_sources(home_id,room_key,target_source_key,target_device_statistics,
      observed_source_key,observed_device_statistics,valid_from,valid_to,basis,observed_temperature_entity_id,heater_energy_limits_w)
      VALUES($1,'room',$2,$3::jsonb,$4,$3::jsonb,$5,$6,'Synthetic lineage',$7,'{"heater":800}')`,
      [home, source, JSON.stringify(row.device_statistics), former, start, end, formerEntity]);
    const beforeSourceReplacement = await window();
    await db.query("UPDATE energy_room_profiles SET rooms=jsonb_set(rooms,'{room,source_key}',to_jsonb($1::text)) WHERE home_id=$2", [neighbour, home]);
    assertEquals((await lineage()).assignments, [], "obsolete temperature assignments must not reach the app");
    await db.query("UPDATE energy_room_profiles SET rooms=jsonb_set(rooms,'{room,source_key}',to_jsonb($1::text)) WHERE home_id=$2", [source, home]);
    assertEquals((await window()).changed === beforeSourceReplacement.changed, false);
    await db.exec("SET ROLE service_role");
    assertEquals((await lineage()).assignments.length, 1);
    assertEquals(await writeProbes([fact]), 1);
    await db.exec("RESET ROLE; SET ROLE authenticated");
    await assertRejects(lineage, Error, "permission denied");
    await assertRejects(() => writeProbes([fact]), Error, "permission denied");
    await db.exec("RESET ROLE");

    // Legacy quarters expose today's source identity, but do not invent probe
    // facts from another duration or timestamp.
    const legacyCurrent = new Date(Date.parse(end) + 3_600_000).toISOString();
    const legacyThrough = new Date(Date.parse(legacyCurrent) + 900_000).toISOString();
    await db.query("UPDATE energy_optimisation_devices SET first_seen_at=$1 WHERE id=$2", [start, device]);
    await db.query("INSERT INTO energy_optimisation_thermal_slots(home_id,customer_id,room_key,start_ts,room_temperature_c,cooling_duty) VALUES($1,$2,'room',$3,20,0)",
      [home, customer, legacyCurrent]);
    const legacy = async () => (await db.query("SELECT temperature_source_key,probe_evidence FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, legacyCurrent, legacyThrough])).rows;
    assertEquals(await legacy(), [{ temperature_source_key: source, probe_evidence: null }]);
    await writeProbes([{ ...fact, source_key: source }], legacyCurrent, 900);
    assertEquals(await legacy(), [{ temperature_source_key: source, probe_evidence: [{ ...fact, source_key: source }] }]);

    // A complete finer-resolution raw capture stays fine after the qualifier
    // rejects its temperature evidence. A coarse copy must not reintroduce it.
    const fineStart = new Date(Date.parse(end) + 7_200_000).toISOString();
    const fineEnd = new Date(Date.parse(fineStart) + 3_600_000).toISOString();
    await write({ ...row, start: fineStart });
    for (let i = 0; i < 4; i++) {
      const at = new Date(Date.parse(fineStart) + i * 900_000).toISOString();
      await write({ ...row, start: at, duration_s: 900, source: "recorder_5minute_mean" });
      await writeProbes([{ ...fact, source_key: source, unavailable: true }], at, 900);
    }
    assertEquals((await db.query("SELECT duration_s,probe_evidence->0->>'unavailable' AS unavailable FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, fineStart, fineEnd])).rows, Array(4).fill({ duration_s: 900, unavailable: "true" }));
    const afterSpan = new Date(Date.parse(fineEnd) + 3_600_000).toISOString();
    const wideWindow = async () => (await db.query<{ fingerprint: string; changed: string }>(
      "SELECT fingerprint,evidence_updated_at::text AS changed FROM get_energy_room_heating_fit_windows($1,$2,'room',$3,$4) WHERE band_c=-10",
      [home, customer, start, new Date(Date.parse(afterSpan) + 3_600_000).toISOString()])).rows[0];
    const beforeCadenceCorrection = await wideWindow();
    await writeProbes([{ ...fact, source_key: source, mean: 20.2, unchanged: false }], legacyCurrent, 900);
    const cadenceCorrected = await wideWindow();
    assertEquals(cadenceCorrected.fingerprint === beforeCadenceCorrection.fingerprint, false,
      "probe cadence outside the cold band's fitted intervals is still a qualification dependency");
    assertEquals(cadenceCorrected.changed === beforeCadenceCorrection.changed, false);
    await writeProbes([fact], afterSpan);
    assertEquals(await wideWindow(), cadenceCorrected, "probe history outside a band's read span cannot replace its evidence");
    const expiredProbe = new Date(Date.parse(start) - 401 * 86_400_000).toISOString();
    await writeProbes([fact], expiredProbe);
    assertEquals((await db.query("SELECT * FROM energy_heating_probe_observations WHERE start_ts=$1", [expiredProbe])).rows, []);

    // Compact transport round-trips canonical facts; no string identities are
    // repeated per row and absence of evidence stays distinct from an empty list.
    interface CompactCapture { sources: { source_key: string; area_key: string; cohort_key: string | null }[];
      rows: (Record<string, unknown> & { probe_values: [number, number | null, number][] | null })[] }
    const capture = async (from = start, through = fineEnd) => (await db.query<{ capture: CompactCapture }>(
      "SELECT get_energy_room_thermal_interval_capture($1,$2,'room',$3,$4) AS capture",
      [customer, home, from, through])).rows[0].capture;
    const packed = await capture();
    const raw = (await db.query<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(q) AS row FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4) q",
      [customer, home, start, fineEnd])).rows.map(record => record.row);
    assertEquals(packed.sources, [...packed.sources].sort((a, b) => a.source_key.localeCompare(b.source_key)));
    assertEquals(packed.rows.map(({ probe_values, ...row }) => ({ ...row, probe_evidence: probe_values?.map(([index, mean, flags]) => ({
      ...packed.sources[index], mean, unchanged: [null, false, true][flags & 3],
      joint_unchanged: [null, false, true][(flags >> 2) & 3], reported: [null, false, true][(flags >> 4) & 3],
      unavailable: [null, false, true][(flags >> 6) & 3],
    })) ?? null })), raw);
    const fineCapture = await capture(fineStart, fineEnd);
    assertEquals(fineCapture.sources, [{ source_key: source, area_key: "room", cohort_key: "synthetic-bridge" }]);
    assertEquals(fineCapture.rows.map(r => r.probe_values), Array(4).fill([[0, 20, 154]]));
    assertEquals((await capture(end, legacyCurrent)).rows[0].probe_values, null);
    await db.exec("SET ROLE service_role");
    assertEquals(await capture(fineStart, fineEnd), fineCapture);
    await db.exec("RESET ROLE");

    // The SQL assignment contract must never publish something the app rejects.
    for (const [column, invalid] of [
      ["target_device_statistics", "[]"], ["observed_device_statistics", '{"other":"sensor.other"}'],
      ["target_device_statistics", '{"heater":null}'], ["observed_device_statistics", '{"heater":""}'],
      ["heater_energy_limits_w", '{"missing":800}'], ["heater_energy_limits_w", '{"heater":0}'],
      ["heater_energy_limits_w", '{"heater":-1}'], ["heater_energy_limits_w", '{"heater":"800"}'],
      ["heater_energy_limits_w", '{"heater":1e999}'],
    ]) {
      await assertRejects(() => db.query(`UPDATE private.energy_heating_history_sources SET ${column}=$1::jsonb WHERE home_id=$2`, [invalid, home]));
    }
    for (const invalid of ["infinity", "10000-01-01T00:00:00Z"]) {
      await assertRejects(() => db.query("UPDATE private.energy_heating_history_sources SET valid_to=$1::timestamptz WHERE home_id=$2", [invalid, home]),
        Error, "Invalid historical heating source identity or timestamps");
    }
    await assertRejects(() => db.query("UPDATE private.energy_heating_history_sources SET valid_from='-infinity' WHERE home_id=$1", [home]),
      Error, "Invalid historical heating source identity or timestamps");

    // Assignment boundaries need not align to Recorder intervals. Neither the
    // current nor the historical identity may claim a mixed boundary interval.
    await db.query("UPDATE private.energy_heating_history_sources SET valid_from=$1 WHERE home_id=$2",
      [new Date(Date.parse(start) + 7 * 60_000).toISOString(), home]);
    const match = async (observed: string, at: string, duration: number) => (await db.query<{ matches: boolean }>(
      "SELECT private.energy_heating_source_matches($1,'room',$2,$3::jsonb,$4,$3::jsonb,$5,$6) AS matches",
      [home, observed, JSON.stringify(row.device_statistics), source, at, duration])).rows[0].matches;
    assertEquals(await match(source, start, 900), false);
    assertEquals(await match(source, start, 3600), false);
    assertEquals(await match(former, start, 900), false);
    assertEquals(await match(former, new Date(Date.parse(start) + 900_000).toISOString(), 900), true);
    assertEquals(await match(source, end, 900), true);
    await db.query("UPDATE private.energy_heating_history_sources SET valid_from=$1 WHERE home_id=$2", [start, home]);

    // Unheated room-air contributors have an explicit empty meter binding.
    // Their historical thermometer swaps invalidate an old house aggregate.
    const peerEntity = "sensor.synthetic_hall_temperature", peerSource = await hash(peerEntity);
    const peerFormerEntity = "sensor.synthetic_former_hall_temperature", peerFormer = await hash(peerFormerEntity);
    await db.query("UPDATE energy_room_profiles SET rooms=rooms||jsonb_build_object('hall',jsonb_build_object('source_key',$1::text)) WHERE home_id=$2", [peerSource, home]);
    await db.query("INSERT INTO energy_optimisation_house_slots(home_id,start_ts,temperature_c) VALUES($1,$2,22)", [home, legacyCurrent]);
    const legacyHouse = async () => (await db.query("SELECT house_temperature_c FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, legacyCurrent, legacyThrough])).rows;
    assertEquals(await legacyHouse(), [{ house_temperature_c: 22 }]);
    await db.query(`INSERT INTO private.energy_heating_history_sources(home_id,room_key,target_source_key,target_device_statistics,
      observed_source_key,observed_temperature_entity_id,observed_device_statistics,valid_from,valid_to,basis)
      VALUES($1,'hall',$2,'{}',$3,$4,'{}',$5,$6,'Synthetic unheated-room lineage')`,
      [home, peerSource, peerFormer, peerFormerEntity, legacyCurrent, legacyThrough]);
    assertEquals((await lineage()).assignments.length, 2);
    assertEquals(await legacyHouse(), [{ house_temperature_c: null }]);
    // A room's own legacy quarter also cannot bypass a reviewed source interval.
    await db.query(`INSERT INTO private.energy_heating_history_sources(home_id,room_key,target_source_key,target_device_statistics,
      observed_source_key,observed_temperature_entity_id,observed_device_statistics,valid_from,valid_to,basis)
      VALUES($1,'room',$2,$3::jsonb,$4,$5,$3::jsonb,$6,$7,'Synthetic legacy exclusion')`,
      [home, source, JSON.stringify(row.device_statistics), former, formerEntity, legacyCurrent, legacyThrough]);
    assertEquals(await legacyHouse(), []);

    // Native house aggregates also retain their original provenance. A later
    // reviewed peer epoch must not reuse today's historical thermometer.
    const nativePeerAt = new Date(Date.parse(fineEnd) + 2 * 3_600_000).toISOString();
    const nativePeerEnd = new Date(Date.parse(nativePeerAt) + 3_600_000).toISOString();
    const nativePeerThrough = new Date(Date.parse(nativePeerEnd) + 3_600_000).toISOString();
    const ownCurrent = { ...fact, source_key: source, mean: 20 };
    const hallCurrent = { ...fact, area_key: "hall", source_key: peerSource, mean: 26 };
    await write({ ...row, start: nativePeerAt, house_temperature_c: 21 });
    await writeProbes([ownCurrent, otherFact, hallCurrent], nativePeerAt);
    const nativePeer = async (from = nativePeerAt, through = nativePeerEnd) => (await db.query<{
      room_temperature_c: number; house_temperature_c: number | null; heat_w: number;
      temperature_source_key: string; probe_evidence: Record<string, unknown>[] | null;
    }>("SELECT room_temperature_c,house_temperature_c,heat_w,temperature_source_key,probe_evidence FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
    [customer, home, from, through])).rows[0];
    assertEquals((await nativePeer()).house_temperature_c, 21);
    await db.query(`INSERT INTO private.energy_heating_history_sources(home_id,room_key,target_source_key,target_device_statistics,
      observed_source_key,observed_temperature_entity_id,observed_device_statistics,valid_from,valid_to,basis)
      VALUES($1,'hall',$2,'{}',$3,$4,'{}',$5,$6,'Synthetic native peer correction')`,
      [home, peerSource, peerFormer, peerFormerEntity, nativePeerAt, nativePeerThrough]);
    const invalidatedPeer = await nativePeer();
    assertEquals(invalidatedPeer.house_temperature_c, null);
    assertEquals([invalidatedPeer.room_temperature_c, invalidatedPeer.heat_w, invalidatedPeer.temperature_source_key], [20, 800, source]);
    assertEquals(invalidatedPeer.probe_evidence?.some(probe => probe.area_key === "hall"), false);
    assertEquals((await db.query("SELECT house_temperature_c FROM energy_heating_observations WHERE start_ts=$1", [nativePeerAt])).rows,
      [{ house_temperature_c: 21 }], "read-time source qualification never overwrites raw measurements");
    assertEquals((await facts(nativePeerAt)).some(probe => probe.source_key === peerSource), true);
    const invalidatedPacked = await capture(nativePeerAt, nativePeerEnd);
    assertEquals(invalidatedPacked.rows[0].house_temperature_c, null);
    assertEquals(invalidatedPacked.sources.some(probe => probe.source_key === peerSource), false);
    await write({ ...row, start: nativePeerEnd, house_temperature_c: 21 });
    assertEquals((await nativePeer(nativePeerEnd, nativePeerThrough)).house_temperature_c, null,
      "a missing vector cannot certify a house aggregate across a reviewed peer change");
    await write({ ...row, start: nativePeerAt, house_temperature_c: 20 });
    const hallHistorical = { ...hallCurrent, source_key: peerFormer, mean: 18 };
    await writeProbes([ownCurrent, otherFact, hallHistorical], nativePeerAt);
    const repairedPeer = await nativePeer();
    assertEquals(repairedPeer.house_temperature_c, 20);
    assertEquals(repairedPeer.probe_evidence?.some(probe => probe.source_key === peerFormer && probe.mean === 18), true);
    assertEquals((await capture(nativePeerAt, nativePeerEnd)).rows[0].house_temperature_c, 20);
    // A peer interval straddling an epoch is not certified even when the
    // observed source matches one side. The room's own valid reading remains.
    await db.query("UPDATE private.energy_heating_history_sources SET valid_from=$1 WHERE home_id=$2 AND room_key='hall' AND valid_from=$3",
      [new Date(Date.parse(nativePeerAt) + 7 * 60_000).toISOString(), home, nativePeerAt]);
    assertEquals((await nativePeer()).house_temperature_c, null);
    assertEquals((await nativePeer()).room_temperature_c, 20);
    assertEquals((await nativePeer()).probe_evidence?.some(probe => probe.area_key === "hall"), false);
    await db.query("UPDATE private.energy_heating_history_sources SET valid_from=$1 WHERE home_id=$2 AND room_key='hall' AND valid_to=$3",
      [nativePeerAt, home, nativePeerThrough]);
    assertEquals((await nativePeer()).house_temperature_c, 20);

    // Configured house probes do not depend on heating-learning eligibility.
    // A mixed equipment room, unresolved heater, and custom room without an
    // area-derived source hash still contribute their application-captured air.
    const mixedSource = await hash("sensor.synthetic_mixed_air");
    const unreadySource = await hash("sensor.synthetic_unready_air");
    const customSource = await hash("sensor.synthetic_custom_air");
    await db.query("UPDATE energy_room_profiles SET rooms=rooms||$1::jsonb WHERE home_id=$2", [JSON.stringify({
      mixed: { source_key: mixedSource }, unready: { source_key: unreadySource }, custom: {},
    }), home]);
    for (const [key, category, room, mapping] of [
      ["mixed-heater", "heating", "mixed", "ready"], ["mixed-cooler", "cooling", "mixed", "ready"],
      ["unready-heater", "heating", "unready", "unresolved"],
    ]) {
      await db.query(`INSERT INTO energy_optimisation_devices(id,home_id,customer_id,device_key,statistic_id,category,
        mapping_summary,active_power_w,planning_role_override,control_type_override,mapping_status,mapped_control_type)
        VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,jsonb_build_object('room_key',$6::text),800,
          'controllable','switch_schedule',$7,'switch_schedule')`,
      [home, customer, key, `sensor.synthetic_${key}_energy`, category, room, mapping]);
    }
    assertEquals((await db.query("SELECT room_key FROM private.energy_heating_history_targets($1) WHERE room_key=ANY($2)",
      [home, ["mixed", "unready", "custom"]])).rows, []);
    const extraPeers = [
      { ...fact, area_key: "mixed", source_key: mixedSource },
      { ...fact, area_key: "unready", source_key: unreadySource },
      { ...fact, area_key: "custom", source_key: customSource },
    ];
    await writeProbes([ownCurrent, otherFact, hallHistorical, ...extraPeers], nativePeerAt);
    assertEquals((await nativePeer()).house_temperature_c, 20);
    assertEquals((await nativePeer()).probe_evidence?.length, 6);
    assertEquals((await capture(nativePeerAt, nativePeerEnd)).sources.length, 6);
    // A known contradictory identity is still rejected even for an ineligible
    // room; unknown eligibility is not permission to disregard known identity.
    await writeProbes([ownCurrent, otherFact, hallHistorical, ...extraPeers.map(p =>
      p.area_key === "mixed" ? { ...p, source_key: conflicting } : p)], nativePeerAt);
    assertEquals((await nativePeer()).house_temperature_c, null);
    await writeProbes([ownCurrent, otherFact, hallHistorical, ...extraPeers], nativePeerAt);
    assertEquals((await nativePeer()).house_temperature_c, 20);

    await db.query("DELETE FROM energy_optimisation_devices WHERE home_id=$1 AND device_key=ANY($2)",
      [home, ["mixed-heater", "mixed-cooler", "unready-heater"]]);
    await db.query("UPDATE energy_room_profiles SET rooms=rooms-ARRAY['mixed','unready','custom'] WHERE home_id=$1", [home]);
    await writeProbes([ownCurrent, otherFact, hallHistorical], nativePeerAt);

    // Planning caps each measured device before adding the room. It never
    // turns a missing meter or a partial source epoch into measured zero heat.
    const planRoom = "synthetic-planning-room", planEntity = "sensor.synthetic_planning_temperature";
    const planSource = await hash(planEntity), planFormerEntity = "sensor.synthetic_old_planning_temperature";
    const planFormer = await hash(planFormerEntity);
    const planDeviceA = "44444444-4444-4444-8444-444444444444", planDeviceB = "55555555-5555-4555-8555-555555555555";
    const planStart = new Date(Date.parse(fineEnd) + 3_600_000).toISOString();
    const planEnd = new Date(Date.parse(planStart) + 3_600_000).toISOString();
    const planMeters = { main: "sensor.synthetic_plan_main", auxiliary: "sensor.synthetic_plan_auxiliary" };
    await db.query("UPDATE energy_room_profiles SET rooms=rooms||jsonb_build_object($1::text,jsonb_build_object('source_key',$2::text)) WHERE home_id=$3",
      [planRoom, planSource, home]);
    for (const [id, key] of [[planDeviceA, "main"], [planDeviceB, "auxiliary"]]) {
      await db.query(`INSERT INTO energy_optimisation_devices(id,home_id,customer_id,device_key,statistic_id,category,mapping_summary,
        active_power_w,planning_role_override,control_type_override,mapping_status,mapped_control_type)
        VALUES($1,$2,$3,$4,$5,'heating',jsonb_build_object('room_key',$6::text,'room_name','Synthetic planning room'),800,
          'controllable','switch_schedule','ready','switch_schedule')`, [id, home, customer, key, planMeters[key as keyof typeof planMeters], planRoom]);
    }
    await db.query(`INSERT INTO private.energy_heating_history_sources(home_id,room_key,target_source_key,target_device_statistics,
      observed_source_key,observed_temperature_entity_id,observed_device_statistics,valid_from,valid_to,basis,heater_energy_limits_w)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$4::jsonb,$7,$8,'Synthetic planning attribution','{"main":800,"auxiliary":200}')`,
      [home, planRoom, planSource, JSON.stringify(planMeters), planFormer, planFormerEntity, planStart, planEnd]);
    const planning = async (through = planEnd) => (await db.query<{ heater_quarters: unknown[] }>(
      "SELECT heater_quarters FROM get_energy_room_planning_history($1,$2,$3,$4,$5)",
      [customer, home, [planRoom], planStart, through])).rows[0].heater_quarters;
    await db.query("INSERT INTO energy_optimisation_device_slots(device_id,home_id,customer_id,start_ts,energy_kwh) VALUES($1,$2,$3,$4,.01)",
      [planDeviceA, home, customer, planStart]);
    assertEquals(await planning(), []);
    await db.query("INSERT INTO energy_optimisation_device_slots(device_id,home_id,customer_id,start_ts,energy_kwh) VALUES($1,$2,$3,$4,.5)",
      [planDeviceB, home, customer, planStart]);
    assertEquals(await planning(), [[Date.parse(planStart), 240]]);
    assertEquals(await planning(new Date(Date.parse(planStart) + 7 * 60_000).toISOString()), []);
    await db.query("UPDATE private.energy_heating_history_sources SET valid_from=$1 WHERE home_id=$2 AND room_key=$3",
      [new Date(Date.parse(planStart) + 7 * 60_000).toISOString(), home, planRoom]);
    assertEquals(await planning(), [], "mixed intervals are unknown; their energy is not prorated");
    await db.query("UPDATE private.energy_heating_history_sources SET valid_from=$1,observed_device_statistics=jsonb_set(observed_device_statistics,'{main}','\"sensor.old_meter\"') WHERE home_id=$2 AND room_key=$3",
      [planStart, home, planRoom]);
    assertEquals(await planning(), [], "a different historical meter cannot borrow current-meter quarter energy");
    await db.query("UPDATE private.energy_heating_history_sources SET observed_device_statistics=target_device_statistics,heater_energy_limits_w='{}' WHERE home_id=$1 AND room_key=$2",
      [home, planRoom]);
    assertEquals(await planning(), [[Date.parse(planStart), 2040]]);
    await db.query("UPDATE private.energy_heating_history_sources SET observed_source_key=$1,observed_temperature_entity_id=$2,valid_from=$3 WHERE home_id=$4 AND room_key=$5",
      [planSource, planEntity, new Date(Date.parse(planStart) + 7 * 60_000).toISOString(), home, planRoom]);
    assertEquals((await db.query<{ matches: boolean }>(
      "SELECT private.energy_heating_source_matches($1,$2,$3,$4::jsonb,$3,$4::jsonb,$5,900) AS matches",
      [home, planRoom, planSource, JSON.stringify(planMeters), planStart])).rows[0].matches, false,
      "even unchanged identity cannot bypass an attribution epoch boundary");
    assertEquals((await db.query("SELECT * FROM get_energy_room_planning_history($1,$2,$3,$4,$5)",
      [device, home, [planRoom], planStart, planEnd])).rows, []);


    // Several quarter corrections may overlap the same retained hour. Union
    // all invalidated meter keys before updating that hour, regardless of row
    // order. Otherwise UPDATE ... FROM can choose only one matching quarter.
    const retractAt = new Date(Date.parse(planEnd) + 3_600_000).toISOString();
    const retractThrough = new Date(Date.parse(retractAt) + 3_600_000).toISOString();
    const coarse = { ...row, room_key: planRoom, source_key: planSource, device_statistics: planMeters,
      start: retractAt, device_energy_kwh: { main: .4, auxiliary: .2 }, heater_energy_limits_w: {} };
    const correction = (key: string, quarter: number) => ({ ...coarse, duration_s: 900,
      source: "recorder_5minute_mean", start: new Date(Date.parse(retractAt) + quarter * 900_000).toISOString(),
      device_energy_kwh: {}, invalidated_device_keys: [key] });
    for (const corrections of [[correction("main", 0), correction("auxiliary", 2)],
      [correction("auxiliary", 2), correction("main", 0)]]) {
      await write(coarse);
      await db.query("SELECT record_energy_heating_observations($1,$2,$3::jsonb)",
        [home, customer, JSON.stringify(corrections)]);
      assertEquals((await db.query("SELECT device_energy_kwh FROM energy_heating_observations WHERE home_id=$1 AND room_key=$2 AND start_ts=$3 AND duration_s=3600",
        [home, planRoom, retractAt])).rows, [{ device_energy_kwh: {} }]);
      assertEquals((await db.query("SELECT duration_s,heat_w FROM get_energy_room_thermal_intervals($1,$2,$3,$4,$5)",
        [customer, home, planRoom, retractAt, retractThrough])).rows, [{ duration_s: 3600, heat_w: null }]);
    }


    // Binding-only planner captures must not enter the retained native scan.
    const sourceMatchDefinition = (await db.query<{ definition: string }>(
      "SELECT pg_get_functiondef('private.energy_heating_source_matches(uuid,text,text,jsonb,text,jsonb,timestamptz,integer)'::regprocedure) AS definition")).rows[0].definition;
    await db.exec(`CREATE OR REPLACE FUNCTION private.energy_heating_source_matches(
      p_home uuid,p_room text,p_observed_source text,p_observed_meters jsonb,
      p_target_source text,p_target_meters jsonb,p_start timestamptz,p_duration integer)
      RETURNS boolean LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'Synthetic native history scan'; END $$`);
    assertEquals((await db.query("SELECT room_key FROM private.energy_room_heating_contexts($1,false)", [home])).rows.length, 2);
    await assertRejects(() => db.query("SELECT * FROM private.energy_room_heating_contexts($1,true)", [home]), Error, "Synthetic native history scan");
    await db.exec(sourceMatchDefinition);

    // Electrical learning only uses a confirmed running quarter or reviewed
    // hourly electrical evidence. The native thermal mean cannot supply watts.
    const drawStart = new Date(Date.parse(start) - 2 * 86_400_000).toISOString();
    const drawEnd = new Date(Date.parse(drawStart) + 3_600_000).toISOString();
    const binding = "climate.synthetic|sensor.synthetic_power|sensor.synthetic_energy";
    const drawRow = { ...row, start: drawStart };
    interface DrawDay { outdoor_c: number; watts: number | null; hours: number; evidence_updated_at: string }
    const draw = async (from = drawStart, through = drawEnd) => (await db.query<{ days: DrawDay[] }>(
      "SELECT get_energy_weather_heating_days($1,$2,'heater',$3,$4,$5) AS days",
      [home, customer, binding, from, through])).rows[0].days;
    await write(drawRow);
    assertEquals(await draw(), []);
    await db.query(`INSERT INTO private.energy_weather_heating_hourly_imports(device_id,home_id,customer_id,start_ts,binding,outdoor_c,watts)
      VALUES($1,$2,$3,$4,$5,-3,600)`, [device, home, customer, drawStart, binding]);
    assertEquals((await draw()).map(r => [r.outdoor_c, r.watts, r.hours]), [[-3, 600, 1]]);
    await db.query(`INSERT INTO energy_optimisation_device_slots(device_id,home_id,customer_id,start_ts,energy_kwh,quality)
      VALUES($1,$2,$3,$4,.25,jsonb_build_object('weather_heating_binding',$5::text))`, [device, home, customer, drawStart, binding]);
    await db.query(`INSERT INTO energy_optimisation_outdoor_slots(home_id,customer_id,start_ts,temperature_c)
      VALUES($1,$2,$3,-7)`, [home, customer, drawStart]);
    const running = await draw();
    assertEquals(running.map(r => [r.outdoor_c, r.watts, r.hours]), [[-7, 1000, .25], [-5, null, 0]]);
    // Another layer can repair irradiance or reread the same meter unchanged.
    await db.query("UPDATE energy_optimisation_outdoor_slots SET solar_w_per_m2=100 WHERE start_ts=$1", [drawStart]);
    await db.query("UPDATE energy_optimisation_device_slots SET energy_kwh=.25 WHERE start_ts=$1", [drawStart]);
    assertEquals(await draw(), running);
    await db.query("UPDATE energy_optimisation_outdoor_slots SET temperature_c=-2 WHERE start_ts=$1", [drawStart]);
    const moved = await draw();
    assertEquals(moved.map(r => [r.outdoor_c, r.watts, r.hours]), [[-10, null, 0], [-5, null, 0], [-2, 1000, .25]]);
    assertEquals(Date.parse(moved[0].evidence_updated_at) >= Date.parse(running[0].evidence_updated_at), true);
    await write({ ...drawRow, device_energy_kwh: { heater: null } });
    await write({ ...drawRow, source_key: former, invalidated_device_keys: ["heater"] });
    assertEquals(await draw(), moved);
    await write({ ...drawRow, invalidated_device_keys: ["heater"] });
    const withdrawn = await draw();
    assertEquals(withdrawn.map(r => [r.outdoor_c, r.watts, r.hours]), [[-10, null, 0], [-5, null, 0]]);
    assertEquals(Date.parse(withdrawn[1].evidence_updated_at) >= Date.parse(moved[2].evidence_updated_at), true);
    await write({ ...drawRow, invalidated_device_keys: ["heater"] });
    assertEquals(await draw(), withdrawn);
    assertEquals((await db.query("SELECT energy_kwh::text FROM energy_optimisation_device_slots WHERE start_ts=$1",
      [drawStart])).rows, [{ energy_kwh: "0.25" }]);
    await db.query("UPDATE energy_optimisation_device_slots SET energy_kwh=.3 WHERE start_ts=$1", [drawStart]);
    assertEquals((await draw()).filter(r => r.hours > 0).map(r => [r.outdoor_c, r.watts, r.hours]), [[-2, 1200, .25]]);
    const beforeZero = (await draw()).find(r => r.watts === 1200)!;
    await assertRejects(() => db.query("UPDATE energy_optimisation_device_slots SET energy_kwh=NULL WHERE start_ts=$1",
      [drawStart]), Error, "null value in column");
    await db.query("UPDATE energy_optimisation_device_slots SET energy_kwh=0 WHERE start_ts=$1", [drawStart]);
    const replacedByZero = (await draw()).filter(r => r.outdoor_c === -5);
    assertEquals(replacedByZero.map(r => [r.watts, r.hours]), [[null, 0]]);
    assertEquals(replacedByZero[0].evidence_updated_at > beforeZero.evidence_updated_at, true);
    await db.query("UPDATE energy_optimisation_device_slots SET energy_kwh=.3 WHERE start_ts=$1", [drawStart]);
    await db.query("UPDATE energy_optimisation_device_slots SET quality='{}' WHERE start_ts=$1", [drawStart]);
    assertEquals((await draw()).filter(r => r.hours > 0), []);

    // A same-meter native counter retraction does not need to know the outdoor
    // band up front. A late weather upload must not resurrect the stale draw.
    const lateStart = new Date(Date.parse(drawStart) - 2 * 86_400_000).toISOString();
    const lateEnd = new Date(Date.parse(lateStart) + 3_600_000).toISOString();
    await db.query(`INSERT INTO energy_optimisation_device_slots(device_id,home_id,customer_id,start_ts,energy_kwh,quality)
      VALUES($1,$2,$3,$4,.25,jsonb_build_object('weather_heating_binding',$5::text))`, [device, home, customer, lateStart, binding]);
    await write({ ...drawRow, start: lateStart, outdoor_temperature_c: null, invalidated_device_keys: ["heater"] });
    assertEquals(await draw(lateStart, lateEnd), []);
    assertEquals((await db.query("SELECT band_c FROM private.energy_weather_heating_withdrawals WHERE start_ts=$1",
      [lateStart])).rows, [{ band_c: null }]);
    await db.query(`INSERT INTO energy_optimisation_outdoor_slots(home_id,customer_id,start_ts,temperature_c)
      VALUES($1,$2,$3,-6)`, [home, customer, lateStart]);
    assertEquals((await draw(lateStart, lateEnd)).map(r => [r.outdoor_c, r.watts, r.hours]), [[-10, null, 0]]);

    const old = new Date(Date.parse(drawStart) - 401 * 86_400_000).toISOString();
    await db.query(`INSERT INTO energy_optimisation_device_slots(device_id,home_id,customer_id,start_ts,energy_kwh,quality)
      VALUES($1,$2,$3,$4,.25,jsonb_build_object('weather_heating_binding',$5::text))`, [device, home, customer, old, binding]);
    await db.query(`INSERT INTO energy_optimisation_outdoor_slots(home_id,customer_id,start_ts,temperature_c)
      VALUES($1,$2,$3,-30)`, [home, customer, old]);
    await db.query("DELETE FROM energy_optimisation_device_slots WHERE start_ts=$1", [old]);
    assertEquals((await db.query("SELECT band_c FROM private.energy_weather_heating_withdrawals WHERE start_ts=$1", [old])).rows, []);

    // A banded learner with work remaining is due on another ingest, with
    // the existing lease fence coalescing repeated captures while pending.
    await db.query(`INSERT INTO energy_optimisation_device_operating_points VALUES($1,'heater',now(),
      '{"learning":{"method":"weather_heating_draw_v1"}}',jsonb_build_object('binding',$2::text,'versioned','{"pending_bands":0}'::jsonb))`,
      [home, binding]);
    const enqueue = async () => (await db.query<{ queued: number }>("SELECT request_energy_device_learning($1,$2,$3) AS queued",
      [home, customer, JSON.stringify([{ kind: "device", key: "heater", input: { weather_heating_binding: binding, banded_heating: true } }])])).rows[0].queued;
    assertEquals(await enqueue(), 0);
    await db.query("UPDATE energy_optimisation_device_operating_points SET operating_points=jsonb_set(operating_points,'{versioned,pending_bands}','2')");
    assertEquals(await enqueue(), 1);
    assertEquals(await enqueue(), 0);
    await db.exec("SET ROLE anon");
    await assertRejects(intervals, Error, "permission denied");
    await assertRejects(draw, Error, "permission denied");
    await assertRejects(() => writeProbes([fact]), Error, "permission denied");
    await assertRejects(lineage, Error, "permission denied");
    await assertRejects(() => capture(), Error, "permission denied");
    await assertRejects(() => db.query("SELECT * FROM energy_heating_probe_observations"), Error, "permission denied");
  } finally { await db.close(); }
});
