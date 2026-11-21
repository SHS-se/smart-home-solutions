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
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119001500_bound_room_history_reads.sql"));
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119033000_preserve_cleaned_native_energy.sql"));
    await db.exec("SET check_function_bodies=true");
    const originalWindows = (await db.query<{ definition: string }>(
      "SELECT pg_get_functiondef('get_energy_room_heating_fit_windows(uuid,uuid,text,timestamptz,timestamptz)'::regprocedure) AS definition")).rows[0].definition;
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119080000_reduce_heating_learning_spills.sql"));
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119103000_seek_missing_heating_irradiance.sql"));
    await db.exec(await Deno.readTextFile("supabase/migrations/20261122000500_complete_legacy_training_intervals.sql"));
    const memorySettings = (await db.query<{ settings: string[] }>(`SELECT proconfig AS settings
      FROM pg_proc WHERE oid IN (
        'get_energy_room_heating_fit_windows(uuid,uuid,text,timestamptz,timestamptz)'::regprocedure,
        'get_energy_room_thermal_interval_capture(uuid,uuid,text,timestamptz,timestamptz)'::regprocedure)`)).rows;
    assertEquals(memorySettings.length, 2);
    assertEquals(memorySettings.every(row => row.settings.includes("work_mem=32MB")), true);
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
    const cutoff = new Date(Date.parse(start) + 45 * 60_000).toISOString();
    const boundedWindows = async () => (await db.query("SELECT * FROM get_energy_room_heating_fit_windows($1,$2,'room',$3,$4)",
      [home, customer, start, cutoff])).rows;
    assertEquals(await boundedWindows(), []);
    assertEquals(await write(row), { accepted: 1, accepted_by_source: [{ room_key: "room", source_key: source, accepted: 1 }] });
    assertEquals(await intervals(), [{ duration_s: 3600, heat_w: 800, heat_attributed: true }]);
    assertEquals(await boundedWindows(), [], "a late native hour crossing the generation ceiling cannot expand discovery");
    assertEquals((await db.query("SELECT * FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, start, cutoff])).rows, [], "a whole native hour is not split into invented quarters");

    // Independently generated synthetic mixed-resolution capture. The newest
    // legacy quarter is not a complete observation at an off-grid ceiling.
    await db.exec("BEGIN");
    await db.query("UPDATE energy_optimisation_devices SET first_seen_at=$1 WHERE id=$2", [start, device]);
    const legacyBase = end;
    const legacyStarts = Array.from({ length: 3 }, (_, i) => new Date(Date.parse(legacyBase) + i * 900_000).toISOString());
    for (const [i, at] of legacyStarts.entries()) {
      await db.query("INSERT INTO energy_optimisation_thermal_slots VALUES($1,$2,'room',$3,$4,0)", [home, customer, at, 20 + i / 10]);
      await db.query("INSERT INTO energy_optimisation_outdoor_slots(home_id,customer_id,start_ts,temperature_c,solar_w_per_m2) VALUES($1,$2,$3,2,0)", [home, customer, at]);
      if (i !== 1) await db.query("INSERT INTO energy_optimisation_device_slots(device_id,home_id,customer_id,start_ts,energy_kwh) VALUES($1,$2,$3,$4,.2)", [device, home, customer, at]);
    }
    const legacyCeiling = new Date(Date.parse(legacyBase) + 21 * 60_000 + 33_000).toISOString();
    const legacyIntervals = async (to = legacyCeiling) => (await db.query<{ start_ts: Date; heat_w: number | null }>(
      "SELECT start_ts,heat_w FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)", [customer, home, legacyBase, to])).rows;
    const legacyWindows = async (to = legacyCeiling) => (await db.query<{
      fingerprint: string; evidence_updated_at: Date; to_at: Date;
    }>("SELECT fingerprint,evidence_updated_at,to_at FROM get_energy_room_heating_fit_windows($1,$2,'room',$3,$4)",
      [home, customer, legacyBase, to])).rows;
    assertEquals((await legacyIntervals()).map(r => r.start_ts.toISOString()), [legacyStarts[0]],
      "an incomplete legacy quarter must not extend the frozen learning ceiling");
    const directLegacy = async (to = legacyCeiling) => (await db.query<{ start_ts: Date; heat_w: number | null }>(
      "SELECT start_ts,heat_w FROM get_energy_thermal_training_quarters($1,$2,$3,$4)", [customer, home, legacyBase, to])).rows;
    assertEquals(await directLegacy(), await legacyIntervals(), "legacy and mixed-resolution learning agree about complete quarters");
    const discovered = await legacyWindows();
    assertEquals(discovered.length, 1);
    assertEquals(discovered[0].to_at.toISOString(), legacyStarts[1]);
    assertEquals(await legacyWindows(discovered[0].to_at.toISOString()), discovered,
      "a discovered band's fingerprint is stable when revalidated at its own end");
    // A missing middle thermometer stays a hole; unavailable energy stays NULL.
    const threeQuarterEnd = new Date(Date.parse(legacyBase) + 45 * 60_000).toISOString();
    assertEquals((await legacyIntervals(threeQuarterEnd)).map(r => r.heat_w), [800, null, 800]);
    await db.query("DELETE FROM energy_optimisation_thermal_slots WHERE start_ts=$1", [legacyStarts[1]]);
    assertEquals((await legacyIntervals(threeQuarterEnd)).map(r => r.start_ts.toISOString()), [legacyStarts[0], legacyStarts[2]]);
    await db.query("INSERT INTO energy_optimisation_thermal_slots VALUES($1,$2,'room',$3,20.1,0)", [home, customer, legacyStarts[1]]);
    await db.query("DELETE FROM energy_optimisation_device_slots WHERE start_ts=$1", [legacyStarts[0]]);
    assertEquals((await legacyIntervals()).map(r => r.heat_w), [null], "an unavailable counter is not zero consumption");
    await db.query("INSERT INTO energy_optimisation_device_slots(device_id,home_id,customer_id,start_ts,energy_kwh) VALUES($1,$2,$3,$4,.2)",
      [device, home, customer, legacyStarts[0]]);
    const beforeLate = await legacyWindows();
    await write({ ...row, start: legacyBase, outdoor_temperature_c: 2 });
    assertEquals(await legacyWindows(), beforeLate,
      "a native hour ending beyond the captured band cannot suppress its completed legacy quarters");
    const lateQuarter = { ...row, start: legacyStarts[1], duration_s: 900, source: "recorder_5minute_mean",
      room_temperature_c: 20.15, outdoor_temperature_c: 2, solar_w_per_m2: 0, device_energy_kwh: {}, heater_energy_limits_w: {} };
    await write(lateQuarter);
    const lateProbe = { source_key: source, area_key: "room", mean: 20.15, unchanged: false,
      joint_unchanged: false, cohort_key: null, reported: true, unavailable: false };
    await db.query("SELECT record_energy_heating_probe_observations($1,$2,$3::jsonb)",
      [home, customer, JSON.stringify([{ start: legacyStarts[1], duration_s: 900, probes: [lateProbe] }])]);
    assertEquals(await legacyWindows(), beforeLate,
      "late native and probe facts beyond the frozen ceiling cannot substitute for an incomplete legacy quarter");
    assertEquals(await legacyWindows(beforeLate[0].to_at.toISOString()), beforeLate);
    assertEquals((await legacyIntervals(legacyStarts[2])).map(r => r.heat_w), [800, null],
      "the newest complete quarter is admitted at its exact end without fabricating unavailable energy");
    await write({ ...lateQuarter, start: legacyStarts[0], device_energy_kwh: { heater: .1 } });
    const corrected = await legacyWindows();
    assertEquals(corrected[0].fingerprint === beforeLate[0].fingerprint, false,
      "a genuine late replacement inside scope still invalidates the earlier capture");
    assertEquals(await legacyWindows(corrected[0].to_at.toISOString()), corrected);
    // Legacy timestamps can have fractional seconds; retain their declared
    // 900-second interval instead of silently rounding it or the cutoff.
    const fractionalAt = new Date(Date.parse(legacyBase) + 60 * 60_000 + 123).toISOString();
    const fractionalEnd = new Date(Date.parse(fractionalAt) + 900_000).toISOString();
    await db.query("INSERT INTO energy_optimisation_thermal_slots VALUES($1,$2,'room',$3,20.3,0)", [home, customer, fractionalAt]);
    const fractionalRead = async (to: string) => (await db.query("SELECT start_ts FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, fractionalAt, to])).rows;
    assertEquals(await fractionalRead(new Date(Date.parse(fractionalEnd) - 123).toISOString()), [],
      "an aligned cutoff must not admit a fractional-start interval ending beyond it");
    assertEquals((await fractionalRead(fractionalEnd)).length, 1);
    await db.query("INSERT INTO energy_optimisation_outdoor_slots(home_id,customer_id,start_ts,temperature_c) VALUES($1,$2,$3,2)",
      [home, customer, fractionalAt]);
    const fractionalWindows = async (to: string) => (await db.query<{ to_at: Date; fingerprint: string; evidence_updated_at: Date }>(
      "SELECT to_at,fingerprint,evidence_updated_at FROM get_energy_room_heating_fit_windows($1,$2,'room',$3,$4)",
      [home, customer, fractionalAt, to])).rows;
    const fractionalWindow = await fractionalWindows(new Date(Date.parse(fractionalEnd) + 1000).toISOString());
    assertEquals(fractionalWindow[0].to_at.toISOString(), fractionalEnd);
    assertEquals(await fractionalWindows(fractionalEnd), fractionalWindow, "fractional ends round-trip through real discovery and revalidation");
    assertEquals((await directLegacy(new Date(Date.parse(fractionalEnd) - 123).toISOString())).some(r => r.start_ts.toISOString() === fractionalAt), false);
    assertEquals((await directLegacy(fractionalEnd)).some(r => r.start_ts.toISOString() === fractionalAt), true);
    await db.exec("ROLLBACK");

    // The gap query uses current lineage and real missing coverage, independently
    // of thermal evidence revisions. Its cursor wraps only to remaining holes.
    const solarBinding = (await db.query<{ binding: string }>(
      "SELECT binding FROM private.energy_room_heating_contexts($1) WHERE room_key='room'", [home])).rows[0].binding;
    const solarGap = async (after: string | null = null) => (await db.query<{ gap: { from_at: string; to_at: string } | null }>(
      "SELECT get_energy_room_missing_irradiance_window($1,$2,'room',$3,$4,$5,$6) AS gap",
      [home, customer, solarBinding, start, end, after])).rows[0].gap;
    assertEquals(Date.parse((await solarGap())!.from_at), Date.parse(start));
    assertEquals(Date.parse((await solarGap())!.to_at), Date.parse(end));
    assertEquals(await solarGap(end), await solarGap(), "a remaining hole is retried after later ranges get a turn");
    await assertRejects(() => db.query("SELECT get_energy_room_missing_irradiance_window($1,$2,'room','wrong',$3,$4,NULL)",
      [home, customer, start, end]), Error, "Heating source changed");
    await db.query("SELECT repair_energy_heating_irradiance($1,$2,'room',$3,$4,$5,$6::jsonb)",
      [home, customer, solarBinding, start, end, JSON.stringify([{ t: Date.parse(end), v: 120 }])]);
    assertEquals(await solarGap(), null);
    await write({ ...row, room_temperature_c: 20.1, solar_w_per_m2: 120 });
    assertEquals(await solarGap(), null, "a temperature correction does not invalidate filled solar");
    await db.query("UPDATE energy_heating_observations SET solar_w_per_m2=NULL WHERE home_id=$1 AND room_key='room' AND start_ts=$2", [home, start]);
    assertEquals(Date.parse((await solarGap())!.from_at), Date.parse(start), "late missing coverage is discovered without resetting a traversal");
    await write(row);
    await db.exec("BEGIN");
    await db.query(`INSERT INTO energy_heating_observations SELECT
      (jsonb_populate_record(NULL::energy_heating_observations,to_jsonb(n)||jsonb_build_object('start_ts',at))).*
      FROM energy_heating_observations n CROSS JOIN generate_series($1::timestamptz-interval '40 days',
        $1::timestamptz-interval '1 day',interval '1 day') at WHERE n.start_ts=$1`, [start]);
    const oldest = new Date(Date.parse(start) - 40 * 86_400_000).toISOString();
    const longGap = (await db.query<{ gap: { from_at: string; to_at: string } }>(
      "SELECT get_energy_room_missing_irradiance_window($1,$2,'room',$3,$4,$5,NULL) AS gap",
      [home, customer, solarBinding, oldest, end])).rows[0].gap;
    assertEquals(Date.parse(longGap.from_at), Date.parse(oldest));
    assertEquals(Date.parse(longGap.to_at) - Date.parse(oldest), 30 * 86_400_000 + 3_600_000);
    await db.query("UPDATE energy_heating_observations SET source_key=$1", [conflicting]);
    assertEquals((await db.query<{ gap: unknown }>(
      "SELECT get_energy_room_missing_irradiance_window($1,$2,'room',$3,$4,$5,NULL) AS gap",
      [home, customer, solarBinding, oldest, end])).rows[0].gap, null, "unmatched source histories do not request weather");
    await db.exec("ROLLBACK");

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
    // Synthetic producer contract: fine counter timing can be withdrawn while
    // the independently cleaned whole-hour aggregate remains measured.
    const cleanedFineRow = (quarter: number, energy: number | null) => ({ ...row, duration_s: 900,
      source: "recorder_5minute_mean", start: new Date(Date.parse(start) + quarter * 900_000).toISOString(),
      device_energy_kwh: { heater: energy } });
    for (let quarter = 0; quarter < 4; quarter++) await write(cleanedFineRow(quarter, 0));
    const validHour = { ...row, device_energy_kwh: { heater: .3 }, invalidated_device_keys: ["heater"] };
    await write(validHour);
    assertEquals((await db.query("SELECT device_energy_kwh FROM energy_heating_observations WHERE duration_s=900 ORDER BY start_ts")).rows,
      Array.from({ length: 4 }, () => ({ device_energy_kwh: {} })), "old false fine zeros are withdrawn");
    assertEquals(await intervals(), [{ duration_s: 3600, heat_w: 300, heat_attributed: true }]);
    const nativeClocks = async () => (await db.query("SELECT start_ts,duration_s,learning_updated_at FROM energy_heating_observations ORDER BY start_ts,duration_s")).rows;
    const hourClocks = await nativeClocks();
    await write(validHour);
    assertEquals(await nativeClocks(), hourClocks, "identical measured hour plus retraction does not churn evidence clocks");

    // Conversely a suspect hourly aggregate must not erase independently
    // measured quarters. This is the same four-row batch emitted by capture.
    const validFine = Array.from({ length: 4 }, (_, quarter) => ({ ...cleanedFineRow(quarter, .075), invalidated_device_keys: ["heater"] }));
    await db.query("SELECT record_energy_heating_observations($1,$2,$3::jsonb)", [home, customer, JSON.stringify(validFine)]);
    assertEquals((await db.query("SELECT device_energy_kwh FROM energy_heating_observations WHERE duration_s=3600")).rows,
      [{ device_energy_kwh: {} }], "old coarse energy is withdrawn");
    assertEquals(await intervals(), Array.from({ length: 4 }, () => ({ duration_s: 900, heat_w: 300, heat_attributed: true })));
    const fineClocks = await nativeClocks();
    await db.query("SELECT record_energy_heating_observations($1,$2,$3::jsonb)", [home, customer, JSON.stringify(validFine)]);
    assertEquals(await nativeClocks(), fineClocks, "identical measured quarters plus retraction do not churn evidence clocks");

    // Genuine withdrawal has no measured replacement and clears both native
    // resolutions, including the previous measurements at this same interval.
    await write({ ...row, device_energy_kwh: { heater: null }, invalidated_device_keys: ["heater"] });
    assertEquals((await db.query("SELECT device_energy_kwh FROM energy_heating_observations")).rows,
      Array.from({ length: 5 }, () => ({ device_energy_kwh: {} })));
    const withdrawnClocks = await nativeClocks();
    await write({ ...row, device_energy_kwh: { heater: null }, invalidated_device_keys: ["heater"] });
    assertEquals(await nativeClocks(), withdrawnClocks, "an identical null withdrawal is idempotent too");
    await db.exec("DELETE FROM energy_heating_observations WHERE duration_s=900");
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
    const probeRevision = async () => (await db.query<{ fingerprint: string; changed: string; matches: boolean }>(`
      SELECT probe_fingerprint AS fingerprint,learning_updated_at::text AS changed,probe_fingerprint=md5(probes::text) AS matches
      FROM energy_heating_probe_observations WHERE home_id=$1 AND start_ts=$2 AND duration_s=3600`, [home, start])).rows[0];
    const recordedProbe = await probeRevision();
    assertEquals(recordedProbe.matches, true);
    await writeProbes([fact, otherFact]);
    assertEquals(await probeRevision(), recordedProbe, "identical probe facts preserve the generated hash and material clock");
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
    const previousLineage = await lineage();
    assertEquals(previousLineage.assignments.length, 1);
    const previousAssignment = { room_key: "room", target_source_key: source,
      target_device_statistics: row.device_statistics, observed_source_key: former,
      observed_temperature_entity_id: formerEntity, observed_device_statistics: row.device_statistics,
      valid_from: new Date(start).toISOString().replace(".000Z", "+00:00"),
      valid_to: new Date(end).toISOString().replace(".000Z", "+00:00"), heater_energy_limits_w: { heater: 800 } };
    assertEquals(previousLineage.assignments[0], previousAssignment);

    const materialLineage = async () => (await db.query<{ fingerprint: string; learning_updated_at: Date }>(
      "SELECT fingerprint,learning_updated_at FROM private.energy_heating_source_revisions WHERE home_id=$1", [home])).rows[0];
    const previousMaterial = await materialLineage();
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119053000_historical_heating_power_statistics.sql"));
    const initialLineage = await lineage();
    assertEquals(initialLineage.assignments, [{ ...previousAssignment, observed_device_power_statistics: {} }]);
    assertEquals(initialLineage.revision === previousLineage.revision, false, "the new catalog shape is a one-time resweep");
    const emptyMaterial = await materialLineage();
    assertEquals(emptyMaterial.fingerprint === previousMaterial.fingerprint, false);
    const setPowerStatistics = (map: unknown) => db.query(
      "UPDATE private.energy_heating_history_sources SET observed_device_power_statistics=$1::jsonb WHERE home_id=$2",
      [JSON.stringify(map), home]);
    for (const invalid of [
      [], null, { other: "sensor.synthetic_unmapped_power" }, { heater: null }, { heater: 800 },
      { heater: { statistic_id: "sensor.synthetic_power" } }, { heater: " \t\n" },
    ]) await assertRejects(() => setPowerStatistics(invalid), Error, "Historical power statistic");
    const powerMap = { heater: "sensor.synthetic_former_power" };
    await setPowerStatistics(powerMap);
    const pairedLineage = await lineage(), pairedMaterial = await materialLineage();
    assertEquals(pairedLineage.assignments, [{ ...previousAssignment, observed_device_power_statistics: powerMap }]);
    assertEquals(pairedLineage.revision === initialLineage.revision, false);
    assertEquals(pairedMaterial.fingerprint === emptyMaterial.fingerprint, false);
    await setPowerStatistics(powerMap);
    assertEquals(await lineage(), pairedLineage);
    assertEquals(await materialLineage(), pairedMaterial, "identical reviewed power statistics do not churn evidence");
    const secondPower = (from: string, to: string) => db.query(`INSERT INTO private.energy_heating_history_sources(
      home_id,room_key,target_source_key,target_device_statistics,observed_source_key,observed_temperature_entity_id,
      observed_device_statistics,valid_from,valid_to,basis,heater_energy_limits_w,observed_device_power_statistics)
      SELECT home_id,room_key,target_source_key,target_device_statistics,observed_source_key,observed_temperature_entity_id,
        observed_device_statistics,$1,$2,basis,heater_energy_limits_w,'{"heater":"sensor.synthetic_other_power"}'
      FROM private.energy_heating_history_sources WHERE home_id=$3`, [from, to, home]);
    const overlappingAt = new Date(Date.parse(start) + 900_000).toISOString();
    await assertRejects(() => secondPower(overlappingAt, end), Error, "Conflicting historical heating source assignments");
    await secondPower(end, new Date(Date.parse(end) + 3_600_000).toISOString());
    assertEquals((await lineage()).assignments.length, 2, "adjacent reviewed epochs can use different power statistics");
    await db.query("DELETE FROM private.energy_heating_history_sources WHERE home_id=$1 AND valid_from=$2", [home, end]);
    await setPowerStatistics({});
    assertEquals(await lineage(), initialLineage);

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
    const legacy = async (from = legacyCurrent, through = legacyThrough) => (await db.query<{
      start_ts: Date; temperature_source_key: string; probe_evidence: unknown;
    }>("SELECT start_ts,temperature_source_key,probe_evidence FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, from, through])).rows
      .filter(row => row.start_ts.getTime() === Date.parse(legacyCurrent))
      .map(({ temperature_source_key, probe_evidence }) => ({ temperature_source_key, probe_evidence }));
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
    const fine = async (from = fineStart) => (await db.query<{ start_ts: Date; duration_s: number; unavailable: string | null }>(
      "SELECT start_ts,duration_s,probe_evidence->0->>'unavailable' AS unavailable FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)",
      [customer, home, from, fineEnd])).rows.filter(row => row.start_ts.getTime() >= Date.parse(fineStart))
      .map(({ duration_s, unavailable }) => ({ duration_s, unavailable }));
    const expectedFine = Array(4).fill({ duration_s: 900, unavailable: "true" });
    assertEquals(await fine(), expectedFine);
    await db.query("INSERT INTO energy_optimisation_thermal_slots VALUES($1,$2,'room',$3,99,0)",
      [home, customer, new Date(Date.parse(fineStart) + 100).toISOString()]);
    assertEquals(await fine(), expectedFine, "a fractional legacy timestamp inside a native quarter is covered");
    const afterSpan = new Date(Date.parse(fineEnd) + 3_600_000).toISOString();
    const wideWindow = async () => (await db.query<{ fingerprint: string; changed: string }>(
      "SELECT fingerprint,evidence_updated_at::text AS changed FROM get_energy_room_heating_fit_windows($1,$2,'room',$3,$4) WHERE band_c=-10",
      [home, customer, start, new Date(Date.parse(afterSpan) + 3_600_000).toISOString()])).rows[0];
    const beforeCadenceCorrection = await wideWindow();
    const correctedFact = { ...fact, source_key: source, mean: 20.2, unchanged: false };
    await writeProbes([correctedFact], legacyCurrent, 900);
    const cadenceCorrected = await wideWindow();
    assertEquals(cadenceCorrected.fingerprint === beforeCadenceCorrection.fingerprint, false,
      "probe cadence outside the cold band's fitted intervals is still a qualification dependency");
    assertEquals(cadenceCorrected.changed === beforeCadenceCorrection.changed, false);
    await writeProbes([fact], afterSpan);
    assertEquals(await wideWindow(), cadenceCorrected, "probe history outside a band's read span cannot replace its evidence");
    const expiredProbe = new Date(Date.parse(start) - 401 * 86_400_000).toISOString();
    await writeProbes([fact], expiredProbe);
    assertEquals((await db.query("SELECT * FROM energy_heating_probe_observations WHERE start_ts=$1", [expiredProbe])).rows, []);
    const expectedLegacy = [{ temperature_source_key: source, probe_evidence: [correctedFact] }];
    assertEquals(await legacy(), expectedLegacy);
    assertEquals(await legacy(start, fineEnd), expectedLegacy,
      "a broader read spanning a former probe assignment retains the correct later current-source fact");
    assertEquals(await fine(start), expectedFine,
      "reading across a former source assignment preserves later complete fine intervals");

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
    const peerQualifiedWindow = async () => (await db.query<{ fingerprint: string; changed: string }>(`
      SELECT fingerprint,evidence_updated_at::text AS changed FROM get_energy_room_heating_fit_windows($1,$2,'room',$3,$4)
      WHERE band_c=-10`, [home, customer, nativePeerAt, nativePeerEnd])).rows[0];
    const { probe_evidence: peersBeforeEdit, ...observationsBeforeEdit } = await nativePeer();
    assertEquals(observationsBeforeEdit.house_temperature_c, null);
    assertEquals(peersBeforeEdit?.some(probe => probe.source_key === unreadySource), true);
    const beforePeerEdit = await peerQualifiedWindow();
    const rawBeforePeerEdit = await facts(nativePeerAt);
    const replacementUnreadySource = await hash("sensor.synthetic_replacement_unready_air");
    await db.query("UPDATE energy_room_profiles SET rooms=jsonb_set(rooms,'{unready,source_key}',to_jsonb($1::text)) WHERE home_id=$2",
      [replacementUnreadySource, home]);
    const { probe_evidence: peersAfterEdit, ...observationsAfterEdit } = await nativePeer();
    assertEquals(observationsAfterEdit, observationsBeforeEdit);
    assertEquals(peersAfterEdit?.some(probe => probe.area_key === "unready"), false);
    assertEquals(await facts(nativePeerAt), rawBeforePeerEdit, "changing the configured source preserves raw facts");
    const afterPeerEdit = await peerQualifiedWindow();
    assertEquals(afterPeerEdit.fingerprint === beforePeerEdit.fingerprint, false);
    assertEquals((await db.query<{ advanced: boolean }>("SELECT $1::timestamptz>$2::timestamptz AS advanced",
      [afterPeerEdit.changed, beforePeerEdit.changed])).rows[0].advanced, true,
    "an unready peer's binding change advances evidence even with the same numerical observations");
    await db.query("UPDATE energy_room_profiles SET rooms=jsonb_set(rooms,'{unready,source_key}',to_jsonb($1::text)) WHERE home_id=$2",
      [unreadySource, home]);
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
    // Compare the optimized discovery against the previous canonical digest
    // after exercising native corrections, dated lineage, probe changes and
    // legacy gaps. A read optimization must not trigger model replacement.
    const optimized = await window();
    await db.exec(originalWindows);
    assertEquals(await window(), optimized);
    // Algorithm provenance is per physical meter, not per room-source hash or
    // interval. These are independent synthetic readings, not household data.
    await db.exec(`CREATE FUNCTION private.prune_native_room_fit_history(uuid,timestamptz,boolean)
      RETURNS void LANGUAGE sql AS $$ SELECT $$`);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119130000_fence_heating_counter_processing.sql"));
    const protectedAt = new Date(Date.parse(start) - 10 * 86_400_000).toISOString();
    const protectedRow = { ...row, start: protectedAt, device_energy_kwh: { heater: 5 }, heater_energy_limits_w: { heater: 800 } };
    const rawEnergy = async (at = protectedAt) => (await db.query<{
      device_energy_kwh: Record<string, number>; heater_energy_limits_w: Record<string, number>;
      room_temperature_c: number; solar_w_per_m2: number | null; changed: string;
    }>(`SELECT device_energy_kwh,heater_energy_limits_w,room_temperature_c,solar_w_per_m2,
        learning_updated_at::text AS changed FROM energy_heating_observations
        WHERE home_id=$1 AND room_key='room' AND source_key=$2 AND start_ts=$3 AND duration_s=3600`,
      [home, source, at])).rows[0];
    await write(protectedRow);
    await write({ ...protectedRow, counter_processing_revision: 1,
      device_energy_kwh: {}, invalidated_device_keys: ["heater"] });
    assertEquals((await rawEnergy()).device_energy_kwh, {});
    // A delayed old value is ACKed, including when the withdrawal left no
    // measurement. It cannot restore energy or replace its attribution limit.
    assertEquals(await write({ ...protectedRow, heater_energy_limits_w: { heater: 900 } }),
      { accepted: 1, accepted_by_source: [{ room_key: "room", source_key: source, accepted: 1 }] });
    assertEquals((await rawEnergy()).device_energy_kwh, {});
    assertEquals((await rawEnergy()).heater_energy_limits_w, { heater: 800 });
    const blockedStamp = (await rawEnergy()).changed;
    await write({ ...protectedRow, heater_energy_limits_w: {} });
    assertEquals((await rawEnergy()).changed, blockedStamp, "an identical blocked replay is not new learning evidence");
    await write({ ...protectedRow, room_temperature_c: 22, solar_w_per_m2: 123 });
    assertEquals([(await rawEnergy()).room_temperature_c, (await rawEnergy()).solar_w_per_m2], [22, 123]);
    assertEquals((await rawEnergy()).device_energy_kwh, {});
    // Same/newer processing can replace an unknown; older explicit withdrawals
    // cannot undo recovery in either thermal or electrical learning.
    await write({ ...protectedRow, counter_processing_revision: 1, device_energy_kwh: { heater: .4 } });
    await write({ ...protectedRow, device_energy_kwh: {}, invalidated_device_keys: ["heater"] });
    assertEquals((await rawEnergy()).device_energy_kwh, { heater: .4 });
    await write({ ...protectedRow, counter_processing_revision: 2, device_energy_kwh: { heater: .3 }, heater_energy_limits_w: {} });
    await write({ ...protectedRow, counter_processing_revision: 1, device_energy_kwh: { heater: .8 }, invalidated_device_keys: ["heater"] });
    assertEquals((await rawEnergy()).device_energy_kwh, { heater: .3 });
    assertEquals((await rawEnergy()).heater_energy_limits_w, {});
    const absentAt = new Date(Date.parse(protectedAt) - 3600_000).toISOString();
    await write({ ...protectedRow, start: absentAt, counter_processing_revision: 2,
      device_energy_kwh: {}, invalidated_device_keys: ["heater"] });
    await write({ ...protectedRow, start: absentAt });
    assertEquals((await rawEnergy(absentAt)).device_energy_kwh, {});
    // A previously empty interval is protected too: no placeholder or existing
    // observation is needed to remember the upgraded cleaner for this counter.
    const emptyAt = new Date(Date.parse(absentAt) - 3600_000).toISOString();
    await write({ ...protectedRow, start: emptyAt });
    assertEquals((await rawEnergy(emptyAt)).device_energy_kwh, {});
    const fineAt = new Date(Date.parse(emptyAt) - 3600_000).toISOString();
    const fineRow = { ...protectedRow, start: fineAt, duration_s: 900, source: "recorder_5minute_mean",
      counter_processing_revision: 2, device_energy_kwh: { heater: .1 } };
    await write(fineRow);
    await write({ ...protectedRow, start: fineAt, device_energy_kwh: {}, invalidated_device_keys: ["heater"] });
    assertEquals((await db.query(`SELECT device_energy_kwh FROM energy_heating_observations
      WHERE home_id=$1 AND room_key='room' AND start_ts=$2 AND duration_s=900`, [home, fineAt])).rows,
      [{ device_energy_kwh: { heater: .1 } }]);
    await write({ ...protectedRow, start: fineAt, counter_processing_revision: 2, device_energy_kwh: { heater: .4 } });
    await write({ ...fineRow, counter_processing_revision: 0, device_energy_kwh: {}, invalidated_device_keys: ["heater"] });
    assertEquals((await rawEnergy(fineAt)).device_energy_kwh, { heater: .4 });
    // The electrical withdrawal owner must receive the same gated keys.
    const withdrawalCount = (await db.query("SELECT count(*)::int AS n FROM private.energy_weather_heating_withdrawals")).rows[0];
    await write({ ...drawRow, device_energy_kwh: {}, invalidated_device_keys: ["heater"] });
    assertEquals((await db.query("SELECT count(*)::int AS n FROM private.energy_weather_heating_withdrawals")).rows[0], withdrawalCount);

    // Every source-qualified row contributes to batch maxima before any
    // mutation. Input order does not let an old numeric sibling win.
    const batchAt = new Date(Date.parse(protectedAt) - 5 * 3600_000).toISOString();
    const batchOther = new Date(Date.parse(batchAt) - 3600_000).toISOString();
    for (const reverse of [false, true]) {
      await db.query("DELETE FROM private.energy_heating_meter_processing WHERE home_id=$1 AND device_key='heater'", [home]);
      const batch = [{ ...protectedRow, start: batchAt }, { ...protectedRow, start: batchOther,
        counter_processing_revision: 2, device_energy_kwh: {}, invalidated_device_keys: ["heater"] }];
      await db.query("SELECT record_energy_heating_observations($1,$2,$3::jsonb)",
        [home, customer, JSON.stringify(reverse ? batch.reverse() : batch)]);
      assertEquals((await rawEnergy(batchAt)).device_energy_kwh, {});
    }
    // A thermometer/source-hash change cannot reset the same physical meter.
    await db.query("UPDATE energy_room_profiles SET rooms=jsonb_set(rooms,'{room,source_key}',$1::jsonb) WHERE home_id=$2",
      [JSON.stringify("d".repeat(64)), home]);
    await write({ ...protectedRow, source_key: "d".repeat(64), start: batchOther });
    assertEquals((await db.query(`SELECT device_energy_kwh FROM energy_heating_observations WHERE home_id=$1
      AND room_key='room' AND source_key=$2 AND start_ts=$3`, [home, "d".repeat(64), batchOther])).rows,
      [{ device_energy_kwh: {} }]);
    await db.query("UPDATE energy_room_profiles SET rooms=jsonb_set(rooms,'{room,source_key}',$1::jsonb) WHERE home_id=$2",
      [JSON.stringify(source), home]);
    const beforeWrongSource = (await db.query("SELECT * FROM private.energy_heating_meter_processing ORDER BY device_key,statistic_id")).rows;
    assertEquals(await write({ ...protectedRow, source_key: "e".repeat(64), counter_processing_revision: 99 }),
      { accepted: 0, accepted_by_source: [] });
    assertEquals((await db.query("SELECT * FROM private.energy_heating_meter_processing ORDER BY device_key,statistic_id")).rows, beforeWrongSource);
    await assertRejects(() => db.query("SELECT record_energy_heating_observations($1,$2,$3::jsonb)",
      [home, "f".repeat(8) + "-ffff-4fff-8fff-" + "f".repeat(12), JSON.stringify([{ ...protectedRow, counter_processing_revision: 99 }])]), Error, "Home mismatch");
    for (const revision of [null, "3", -1, 1.5, 2147483648]) await assertRejects(() => write({ ...protectedRow,
      counter_processing_revision: revision }), Error, "Invalid counter processing revision");

    // One protected meter does not prevent another physical counter in the
    // same room from accepting a lower-revision observation.
    await write({ ...coarse, counter_processing_revision: 1, device_energy_kwh: { main: .3, auxiliary: .1 },
      heater_energy_limits_w: { main: 800, auxiliary: 200 } });
    await db.query("UPDATE energy_optimisation_devices SET statistic_id='sensor.synthetic_new_auxiliary' WHERE home_id=$1 AND device_key='auxiliary'", [home]);
    const changedMeters = { ...planMeters, auxiliary: "sensor.synthetic_new_auxiliary" };
    await write({ ...coarse, device_statistics: changedMeters, device_energy_kwh: { main: 5, auxiliary: .15 },
      heater_energy_limits_w: { main: 900, auxiliary: 210 }, invalidated_device_keys: ["main"] });
    assertEquals((await db.query(`SELECT device_energy_kwh,heater_energy_limits_w FROM energy_heating_observations
      WHERE home_id=$1 AND room_key=$2 AND start_ts=$3 AND device_statistics=$4::jsonb`,
      [home, planRoom, retractAt, JSON.stringify(changedMeters)])).rows,
      [{ device_energy_kwh: { auxiliary: .15 }, heater_energy_limits_w: { auxiliary: 210 } }]);
    // A genuinely different statistic ID for the same device starts its own
    // physical-counter epoch; the old counter's watermark is retained.
    await db.query("UPDATE energy_optimisation_devices SET statistic_id='sensor.synthetic_replaced_energy' WHERE id=$1", [device]);
    await write({ ...protectedRow, device_statistics: { heater: "sensor.synthetic_replaced_energy" } });
    assertEquals((await db.query(`SELECT device_energy_kwh FROM energy_heating_observations WHERE home_id=$1
      AND room_key='room' AND start_ts=$2 AND device_statistics='{"heater":"sensor.synthetic_replaced_energy"}'::jsonb`, [home, protectedAt])).rows,
      [{ device_energy_kwh: { heater: 5 } }]);
    // A reviewed unreliable physical meter epoch is excluded independently of
    // collector revision, while its raw readings and room thermometry survive.
    await db.exec(`CREATE TABLE energy_optimisation_zone_models(home_id uuid,customer_id uuid,room_key text,
      training_from timestamptz,training_to timestamptz,trained boolean,rejection_reason text,
      gain_c_per_wh numeric,cooling_constant_per_h numeric,last_attempted_at timestamptz,last_fit_attempt jsonb,
      heating_bands jsonb,model_revision bigint DEFAULT 1);
      CREATE FUNCTION private.advance_synthetic_zone_revision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.model_revision:=OLD.model_revision+1; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_zone_revision BEFORE UPDATE ON energy_optimisation_zone_models
        FOR EACH ROW EXECUTE FUNCTION private.advance_synthetic_zone_revision();
      CREATE TABLE private.energy_heating_calibration_revisions(revision text PRIMARY KEY,calibration jsonb);`);
    await db.exec(await Deno.readTextFile("supabase/migrations/20261119143000_exclude_reviewed_unreliable_heating_meters.sql"));
    const rejectedStatistic = "sensor.synthetic_replaced_energy";
    const policyFrom = protectedAt;
    const policyTo = new Date(Date.parse(policyFrom) + 3600_000).toISOString();
    const reliableFrom = new Date(Date.parse(policyTo) + 86_400_000).toISOString();
    const reliableTo = new Date(Date.parse(reliableFrom) + 3600_000).toISOString();
    const badBand = { revision: "synthetic-bad-fit", band_c: -10, training_from: policyFrom, training_to: policyTo };
    const goodBand = { revision: "synthetic-good-fit", band_c: 5, training_from: reliableFrom, training_to: reliableTo };
    const library = { active: [badBand, goodBand], candidates: [badBand, goodBand],
      reference_revision: "synthetic-current-reference", reference: { model: { gain_c_per_wh: .001 } },
      window_attempts: { "-10": "previous" }, window_evidence_updated_at: { "-10": start },
      general_attempt: { attempted_at: start }, pending_windows: 0 };
    await db.query(`INSERT INTO energy_optimisation_zone_models VALUES($1,$2,'room',$3,$4,true,NULL,.001,.1,now(),'{}',$5::jsonb,1),
      ($1,$2,'unrelated-room',$3,$4,true,NULL,.001,.1,now(),'{}',$5::jsonb,1)`,
      [home, customer, reliableFrom, reliableTo, JSON.stringify(library)]);
    await db.query("INSERT INTO private.energy_heating_calibration_revisions VALUES($1,$2::jsonb)",
      [badBand.revision, JSON.stringify(badBand)]);
    await db.query(`UPDATE energy_optimisation_device_operating_points SET operating_points=$1::jsonb
      WHERE home_id=$2 AND device_key='heater'`, [JSON.stringify({ method: "weather_heating_draw_v1", binding,
        points: [badBand, goodBand], reference: { revision: "older-unknown-window", points: [] },
        versioned: { attempted: { "-10": start }, evidence_updated_at: { "-10": start }, candidates: [badBand, goodBand] } }), home]);
    await db.query(`INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input,pending,generation,fence)
      VALUES($1,$2,'room','room','{}',false,1,0)`, [home, customer]);
    const excludedRow = { ...protectedRow, device_statistics: { heater: rejectedStatistic }, heater_energy_limits_w: {}, counter_processing_revision: 10 };
    await write(excludedRow);
    await write({ ...excludedRow, start: policyTo, device_energy_kwh: { heater: .2 } });
    const learningHeat = async (from = policyFrom, to = policyTo) => (await db.query(`SELECT heat_w,room_temperature_c
      FROM get_energy_room_thermal_intervals($1,$2,'room',$3,$4)`, [customer, home, from, to])).rows;
    assertEquals(await learningHeat(), [{ heat_w: 5000, room_temperature_c: 20 }]);
    await db.query(`INSERT INTO private.energy_heating_meter_exclusions(home_id,device_key,statistic_id,valid_from,valid_to,reason)
      VALUES($1,'heater',$2,$3,$4,'Synthetic reviewed meter fault')`, [home, rejectedStatistic, policyFrom, policyTo]);
    assertEquals(await learningHeat(), [{ heat_w: null, room_temperature_c: 20 }]);
    assertEquals((await db.query(`SELECT device_energy_kwh FROM energy_heating_observations
      WHERE home_id=$1 AND start_ts=$2 AND device_statistics=$3::jsonb`,
      [home, policyFrom, JSON.stringify({ heater: rejectedStatistic })])).rows,
      [{ device_energy_kwh: { heater: 5 } }], "reviewed rejection retains raw audit evidence");
    await write({ ...excludedRow, counter_processing_revision: 11, device_energy_kwh: { heater: 6 } });
    assertEquals(await learningHeat(), [{ heat_w: null, room_temperature_c: 20 }], "a new producer cannot override reviewed unreliability");
    const nextHour = new Date(Date.parse(policyTo) + 3600_000).toISOString();
    assertEquals(await learningHeat(policyTo, nextHour), [{ heat_w: 200, room_temperature_c: 20 }], "the reliable epoch boundary is half open");
    const currentRoom = async () => (await db.query<{ heating_bands: typeof library; trained: boolean; gain_c_per_wh: string | null; model_revision: number }>(
      "SELECT heating_bands,trained,gain_c_per_wh,model_revision FROM energy_optimisation_zone_models WHERE home_id=$1 AND room_key='room'", [home])).rows[0];
    assertEquals((await currentRoom()).heating_bands.active, [goodBand]);
    assertEquals((await currentRoom()).heating_bands.candidates, [goodBand]);
    assertEquals((await currentRoom()).heating_bands.reference_revision, library.reference_revision);
    assertEquals((await currentRoom()).trained, true, "a current reference trained after the fault is retained");
    assertEquals(Object.keys((await currentRoom()).heating_bands.window_attempts), []);
    assertEquals((await currentRoom()).heating_bands.pending_windows, 1);
    assertEquals((await db.query("SELECT model_revision FROM energy_optimisation_zone_models WHERE room_key='unrelated-room'")).rows,
      [{ model_revision: 1 }], "a meter review does not churn unrelated room revisions");
    assertEquals((await db.query("SELECT calibration FROM private.energy_heating_calibration_revisions WHERE revision=$1", [badBand.revision])).rows,
      [{ calibration: badBand }], "withdrawn calibration revisions remain archived");
    assertEquals((await db.query("SELECT pending,generation FROM private.energy_learning_jobs WHERE home_id=$1 AND owner_kind='room' AND owner_key='room'", [home])).rows,
      [{ pending: true, generation: 2 }]);
    const updatedDraw = (await db.query<{ operating_points: { points: unknown[]; versioned: { candidates: unknown[]; pending_bands: number }; reference?: unknown } }>(
      "SELECT operating_points FROM energy_optimisation_device_operating_points WHERE home_id=$1 AND device_key='heater'", [home])).rows[0].operating_points;
    assertEquals(updatedDraw.points, [goodBand]);
    assertEquals(updatedDraw.versioned.candidates, [goodBand]);
    assertEquals(updatedDraw.versioned.pending_bands, 1);
    assertEquals(updatedDraw.reference, undefined);
    const cleanElectricalReference = { ...goodBand, points: [] };
    await db.query("UPDATE energy_optimisation_device_operating_points SET operating_points=jsonb_set(operating_points,'{reference}',$1::jsonb) WHERE home_id=$2 AND device_key='heater'",
      [JSON.stringify(cleanElectricalReference), home]);
    await db.query("UPDATE private.energy_heating_meter_exclusions SET reason='Synthetic repeated review with unchanged epoch' WHERE home_id=$1 AND statistic_id=$2", [home, rejectedStatistic]);
    assertEquals((await db.query<{ reference: unknown }>(
      "SELECT operating_points->'reference' AS reference FROM energy_optimisation_device_operating_points WHERE home_id=$1 AND device_key='heater'", [home])).rows[0].reference,
      cleanElectricalReference, "an electrical reference with a known disjoint training window survives");
    const unchangedReviewRevision = (await currentRoom()).model_revision;
    await db.query("UPDATE private.energy_heating_meter_exclusions SET reason=reason WHERE home_id=$1 AND device_key='heater'", [home]);
    assertEquals((await currentRoom()).model_revision, unchangedReviewRevision);
    // Both ordinary electrical quarters and imported hours are masked, even
    // when an upload arrives after the review and declares a current binding.
    const rejectedBinding = `climate.synthetic|sensor.synthetic_power|${rejectedStatistic}`;
    await db.query(`INSERT INTO energy_optimisation_device_slots(device_id,home_id,customer_id,start_ts,energy_kwh,quality)
      VALUES($1,$2,$3,$4,.2,jsonb_build_object('weather_heating_binding',$5::text))`,
      [device, home, customer, policyFrom, rejectedBinding]);
    await db.query(`INSERT INTO energy_optimisation_outdoor_slots(home_id,customer_id,start_ts,temperature_c)
      VALUES($1,$2,$3,-8)`, [home, customer, policyFrom]);
    await db.query(`INSERT INTO private.energy_weather_heating_hourly_imports(device_id,home_id,customer_id,start_ts,binding,outdoor_c,watts)
      VALUES($1,$2,$3,$4,$5,-8,800)`, [device, home, customer, policyFrom, rejectedBinding]);
    assertEquals((await db.query<{ days: { hours: number }[] }>(
      "SELECT get_energy_weather_heating_days($1,$2,'heater',$3,$4,$5) AS days",
      [home, customer, rejectedBinding, policyFrom, policyTo])).rows[0].days.filter(row => row.hours > 0), []);
    assertEquals((await db.query<{ heater_quarters: unknown[] }>(
      "SELECT heater_quarters FROM get_energy_room_planning_history($1,$2,ARRAY['room'],$3,$4)",
      [customer, home, policyFrom, policyTo])).rows[0].heater_quarters, [], "rejected energy is missing from stored-warmth observations");
    // Dated source assignment identifies old electrical imports even though
    // today's device statistic is a replacement meter.
    const electricalFrom = new Date(Date.parse(start) - 30 * 86_400_000).toISOString();
    const electricalTo = new Date(Date.parse(electricalFrom) + 3600_000).toISOString();
    const physicalPast = "sensor.synthetic_unreliable_former_energy";
    await db.query(`INSERT INTO private.energy_heating_history_sources(home_id,room_key,target_source_key,target_device_statistics,
      observed_source_key,observed_temperature_entity_id,observed_device_statistics,valid_from,valid_to,basis)
      VALUES($1,'room',$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8,'Synthetic dated counter identity')`,
      [home, source, JSON.stringify({ heater: rejectedStatistic }), former, formerEntity,
        JSON.stringify({ heater: physicalPast }), electricalFrom, electricalTo]);
    await db.query(`INSERT INTO private.energy_weather_heating_hourly_imports(device_id,home_id,customer_id,start_ts,binding,outdoor_c,watts)
      VALUES($1,$2,$3,$4,$5,-8,700)`, [device, home, customer, electricalFrom, binding]);
    assertEquals((await draw(electricalFrom, electricalTo)).filter(r => r.hours > 0).length, 1);
    await db.query(`INSERT INTO private.energy_heating_meter_exclusions(home_id,device_key,statistic_id,valid_from,valid_to,reason)
      VALUES($1,'heater',$2,$3,$4,'Synthetic former meter reliability review')`, [home, physicalPast, electricalFrom, electricalTo]);
    assertEquals((await draw(electricalFrom, electricalTo)).filter(r => r.hours > 0), []);
    // A model whose general training also used excluded evidence cannot leak
    // back through the scalar reference after its active band is withdrawn.
    await db.query("UPDATE energy_optimisation_zone_models SET training_from=$1,training_to=$2,trained=true,gain_c_per_wh=.001,cooling_constant_per_h=.1,rejection_reason=NULL,heating_bands=$3::jsonb WHERE home_id=$4 AND room_key='room'",
      [electricalFrom, electricalTo, JSON.stringify(library), home]);
    await db.query("UPDATE energy_optimisation_device_operating_points SET operating_points=jsonb_set(operating_points,'{reference}',$1::jsonb) WHERE home_id=$2 AND device_key='heater'",
      [JSON.stringify({ revision: "synthetic-contaminated-reference", training_from: electricalFrom, training_to: electricalTo, points: [] }), home]);
    await db.query("UPDATE private.energy_heating_meter_exclusions SET reason='Synthetic additional review' WHERE home_id=$1 AND statistic_id=$2", [home, physicalPast]);
    assertEquals((await db.query<{ reference: unknown }>(
      "SELECT operating_points->'reference' AS reference FROM energy_optimisation_device_operating_points WHERE home_id=$1 AND device_key='heater'", [home])).rows[0].reference,
      null, "an electrical reference whose training overlaps is withdrawn");
    assertEquals((await currentRoom()).trained, false);
    assertEquals((await currentRoom()).gain_c_per_wh, null);
    assertEquals((await currentRoom()).heating_bands.reference_revision, null);
    assertEquals((await currentRoom()).heating_bands.reference, undefined);
    await db.query("DELETE FROM private.energy_heating_meter_exclusions WHERE home_id=$1 AND statistic_id=$2", [home, rejectedStatistic]);
    assertEquals(await learningHeat(), [{ heat_w: 6000, room_temperature_c: 20 }], "removing a review reconsiders retained raw evidence");
    await db.query(`INSERT INTO private.energy_heating_meter_exclusions(home_id,device_key,statistic_id,valid_from,valid_to,reason)
      VALUES($1,'heater','sensor.synthetic_different_physical_counter',$2,$3,'Synthetic unrelated physical source')`, [home, policyFrom, policyTo]);
    assertEquals(await learningHeat(), [{ heat_w: 6000, room_temperature_c: 20 }], "a different physical counter is isolated");
    await db.exec("SET ROLE service_role");
    await assertRejects(() => db.query("SELECT * FROM private.energy_heating_meter_processing"), Error, "permission denied");
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE anon");
    await assertRejects(intervals, Error, "permission denied");
    await assertRejects(draw, Error, "permission denied");
    await assertRejects(() => writeProbes([fact]), Error, "permission denied");
    await assertRejects(lineage, Error, "permission denied");
    await assertRejects(() => capture(), Error, "permission denied");
    await assertRejects(() => db.query("SELECT * FROM energy_heating_probe_observations"), Error, "permission denied");
  } finally { await db.close(); }
});
