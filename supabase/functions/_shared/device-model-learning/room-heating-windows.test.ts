import { assert, assertEquals, assertRejects } from "@std/assert";
import { fitStoredRoomHeating as runRoomPhase, prepareStoredRoomHeating, ROOM_WINDOW_IMPLEMENTATION, auxiliaryIntervalMean, bandObservations, readRoomQuarters, nativeRoomReadWindows } from "./room.ts";
import type { StoredDeviceModel } from "../device-model-store.ts";
import { thermalQuarter, type ThermalQuarterRow } from "../thermal-training.ts";
import type { RoomHeatingBands, RoomHeatingReference } from "../planner/heating-bands.ts";
import type { HeatingProbeCapture } from "../heating-probe-wire.ts";


/** Tests of band scheduling first drain the separate initial general phase. */
async function fitStoredRoomHeating(...args: Parameters<typeof runRoomPhase>) {
  const first = await runRoomPhase(...args);
  const library = first.heating_bands as RoomHeatingBands;
  const previous = args[5]?.heating_bands as RoomHeatingBands | undefined;
  if (library.general_attempt?.implementation === ROOM_WINDOW_IMPLEMENTATION &&
      (!previous || previous.binding !== library.binding || previous.general_attempt?.implementation !== ROOM_WINDOW_IMPLEMENTATION) &&
      !library.window_attempts && library.pending_windows) {
    const next = [...args] as Parameters<typeof runRoomPhase>;
    next[5] = { ...args[5], ...first, model_revision: 1 };
    return { ...first, ...await runRoomPhase(...next) };
  }
  return first;
}

const now = Date.UTC(2026, 10, 18), hour = 3_600_000;
const context = { binding: "synthetic-binding", observed_since: "2025-10-01T00:00:00Z" };
interface Window { window_key: string; band_c: number; from_at: string; to_at: string; fingerprint: string; evidence_updated_at: string }

/** Synthetic hourly means integrated independently with one-minute steps. */
function history(start: number, count = 240, gain = .002, weather = -7): ThermalQuarterRow[] {
  let temperature = 20;
  return Array.from({ length: count }, (_, i) => {
    const outdoor = weather + .5 * Math.sin(i / 13), house = 21 + .2 * Math.cos(i / 19);
    const watts = i % 11 < 3 ? 500 : 0;
    let sum = 0;
    for (let minute = 0; minute < 60; minute++) {
      const rate = gain * watts + .02 * (house - temperature) + .03 * (outdoor - temperature) + .02;
      sum += temperature + rate / 120;
      temperature += rate / 60;
    }
    return { room_key: "room", room_name: "Synthetic room", active_power_w: 500,
      start_ts: new Date(start + i * hour).toISOString(), duration_s: 3600,
      source: "recorder_hour_mean", room_temperature_c: sum / 60, house_temperature_c: house,
      outdoor_temperature_c: outdoor, heat_w: watts, solar_w_per_m2: null, cooling: false };
  });
}
function window(rows: ThermalQuarterRow[], key: string, band = -10): Window {
  return { window_key: key, band_c: band, from_at: rows[0].start_ts,
    to_at: new Date(Date.parse(rows.at(-1)!.start_ts) + hour).toISOString(), fingerprint: `fingerprint:${key}`, evidence_updated_at: new Date(now - hour).toISOString() };
}
function compactCapture(rows: ThermalQuarterRow[]): HeatingProbeCapture {
  const sources: HeatingProbeCapture["sources"] = [];
  const indices = new Map<string, number>();
  const flag = (value: boolean | null) => value === null ? 0 : value ? 2 : 1;
  return { sources, rows: rows.map(({ probe_evidence, ...row }) => ({ ...row,
    probe_values: probe_evidence?.map(probe => {
      const { source_key, area_key, cohort_key } = probe;
      const key = JSON.stringify([source_key, area_key, cohort_key]);
      let index = indices.get(key);
      if (index === undefined) {
        index = sources.length;
        indices.set(key, index);
        sources.push({ source_key, area_key, cohort_key });
      }
      return [index, probe.mean, flag(probe.unchanged) + flag(probe.joint_unchanged) * 4 +
        flag(probe.reported) * 16 + flag(probe.unavailable) * 64];
    }) ?? null,
  })) };
}
function database(windows: Window[], rows: ThermalQuarterRow[]) {
  const reads: string[] = [];
  let failure: string | undefined;
  return {
    reads, fail: (name: string) => { failure = name; },
    rpc(name: string, args: Record<string, unknown>) {
      reads.push(name);
      const error = name === failure ? { message: "synthetic read failed" } : null;
      if (name === "get_energy_room_heating_fit_windows") return Promise.resolve({ data: windows.map(window => ({ ...window })), error });
      if (name === "get_energy_room_thermal_interval_capture") {
        assertEquals(args.p_room_key, "room");
        const selected = rows.filter(row => row.start_ts >= String(args.p_from) && row.start_ts < String(args.p_to));
        return Promise.resolve({ data: compactCapture(selected), error });
      }
      if (["get_energy_room_passive_heat", "get_energy_doorway_probes"].includes(name)) return Promise.resolve({ data: [], error });
      throw new Error(`Unexpected RPC ${name}`);
    },
    from(name: string) {
      assertEquals(name, "energy_optimisation_devices");
      return { select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ limit: () => Promise.resolve({
        data: [{ mapping_summary: { room_name: "Synthetic room" } }], error: null,
      }) }) }) }) }) };
    },
  };
}
const stored = (row: Record<string, unknown>): StoredDeviceModel => ({ ...row, model_revision: 1 });
const bands = (row: Record<string, unknown>) => row.heating_bands as RoomHeatingBands;

Deno.test("the ordinary historical band worker qualifies source freezes before fitting and records the reason", async () => {
  const rows = history(Date.UTC(2026, 0, 1));
  const source = "a".repeat(64);
  for (let i = 0; i < rows.length; i++) {
    const frozen = i >= 120 && i < 155;
    if (frozen) rows[i].room_temperature_c = 20;
    rows[i].temperature_source_key = source;
    rows[i].probe_evidence = [{ source_key: source, area_key: "room", mean: rows[i].room_temperature_c,
      unchanged: frozen, joint_unchanged: frozen, reported: null, unavailable: null, cohort_key: null },
      ...["b", "c", "d"].map(key => ({ source_key: key.repeat(64), area_key: key, mean: rows[i].house_temperature_c,
        unchanged: false, joint_unchanged: false, reported: null, unavailable: null, cohort_key: null }))];
  }
  const before = structuredClone(rows);
  const result = await fitStoredRoomHeating(database([window(rows, "-10:2026-01")], rows),
    "home", "customer", "room", context, undefined, null, now);
  const diagnosis = bands(result).diagnostics?.[-10] as { source_freshness: { room: { inferred: number } } };
  assertEquals(diagnosis.source_freshness.room.inferred, 35);
  assertEquals(bands(result).active.map(band => band.band_c), [-10]);
  assertEquals(rows, before); // Original temperature observations and known heat remain untouched.
});

Deno.test("a failed recent window cannot prevent historical bootstrap and bands from the same range", async () => {
  const recent = history(Date.UTC(2026, 10, 16), 3), winter = history(Date.UTC(2026, 0, 1));
  const cold = window(winter, "-10:2026-01"), newest = window(recent, "-10:2026-11");
  const db = database([cold, newest], [...winter, ...recent]);
  const failed = await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined, null, now);
  assertEquals(failed.trained, false);
  assertEquals(bands(failed).window_attempts, { [newest.window_key]: `${ROOM_WINDOW_IMPLEMENTATION}:${newest.fingerprint}` });
  assertEquals(bands(failed).pending_windows, 1);
  newest.fingerprint = "new-live-quarter"; newest.evidence_updated_at = new Date(now).toISOString(); // Live arrivals must not starve older windows.
  const fitted = await fitStoredRoomHeating(db, "home", "customer", "room", context, stored(failed), null, now);
  assertEquals({ ...failed, ...fitted }.trained, false);
  assertEquals(bands(fitted).pending_windows, 2); // The changed general evidence is also due.
  assertEquals(bands(fitted).reference, undefined);
  assertEquals(bands(fitted).active.map(band => band.band_c), [-10]);
  // Each selected band reads its observations once per invocation.
  assertEquals(db.reads.filter(name => name === "get_energy_room_thermal_interval_capture").length, 5);
});

Deno.test("unfinished newest-window work cannot starve a winter band that has never been visited", async () => {
  const recent = history(Date.UTC(2026, 10, 16), 3, .002, 2), winter = history(Date.UTC(2026, 0, 1));
  const cold = window(winter, "-10"), newest = window(recent, "0", 0);
  const db = database([cold, newest], [...winter, ...recent]);
  const initial = await runRoomPhase(db, "home", "customer", "room", context, undefined, null, now);
  const previous = stored({ ...initial, heating_bands: { ...bands(initial),
    window_last_attempted_at: { [newest.window_key]: new Date(now - 60_000).toISOString() },
    window_solar_pending: { [newest.window_key]: true },
  } });
  newest.fingerprint = "synthetic-live-arrival";
  newest.evidence_updated_at = new Date(now).toISOString();
  const prepared = await prepareStoredRoomHeating(db, "home", "customer", "room", context, previous, null, now);
  assertEquals(prepared.kind, "band");
  assert(prepared.kind === "band");
  assertEquals(prepared.work.metadata.window.window_key, cold.window_key);
  assertEquals(prepared.work.metadata.library.window_attempts, undefined, "a scheduling turn is not a completed fit");
  assertEquals(prepared.work.metadata.progressLibrary.window_solar_pending?.[newest.window_key], true);
});

Deno.test("a superseded capture yields to unvisited and older windows without marking its fit complete", async () => {
  const recent = history(Date.UTC(2026, 10, 16), 3, .002, 2), winter = history(Date.UTC(2026, 0, 1));
  const cold = window(winter, "-10"), newest = window(recent, "0", 0);
  const db = database([cold, newest], [...winter, ...recent]);
  const initial = await runRoomPhase(db, "home", "customer", "room", context, undefined, null, now);
  const previous = stored(initial);
  newest.fingerprint = "synthetic-upload-during-capture";
  newest.evidence_updated_at = new Date(now).toISOString();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const visits = { binding: context.binding, implementation: ROOM_WINDOW_IMPLEMENTATION,
    windows: { [newest.window_key]: at(1) } };
  const prepare = async (journal: unknown, model = previous) => {
    const prepared = await prepareStoredRoomHeating(db, "home", "customer", "room", context, model, null, now, journal);
    assert(prepared.kind === "band");
    return prepared.work.metadata;
  };

  const afterReset = await prepare(visits);
  assertEquals(afterReset.window.window_key, cold.window_key);
  assertEquals(afterReset.library.window_last_attempted_at, undefined);
  assertEquals(afterReset.progressLibrary.window_attempts, undefined);
  assertEquals(afterReset.progressLibrary.window_evidence_updated_at, undefined);

  const olderColdVisit = stored({ ...initial, heating_bands: { ...bands(initial),
    window_last_attempted_at: { [cold.window_key]: at(2), [newest.window_key]: at(3) },
  } });
  assertEquals((await prepare(undefined, olderColdVisit)).window.window_key, newest.window_key);
  assertEquals((await prepare(visits, olderColdVisit)).window.window_key, cold.window_key);

  for (const ineligible of [
    { ...visits, binding: "previous-sensor-binding" },
    { ...visits, implementation: "previous-fitting-algorithm" },
    { ...visits, windows: { [newest.window_key]: "invalid timestamp" } },
  ]) assertEquals((await prepare(ineligible)).window.window_key, newest.window_key);
});

Deno.test("late older measurements refit a completed window without a newer final timestamp", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10:2026-01");
  const db = database([candidate], rows);
  const first = await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined, null, now);
  const revision = bands(first).active[0].revision;
  const nothing = await fitStoredRoomHeating(db, "home", "customer", "room", context, stored(first), null, now);
  assertEquals(bands(nothing).active[0].revision, revision);
  candidate.fingerprint = "filled-older-hole"; candidate.evidence_updated_at = new Date(now).toISOString();
  rows[80].heat_w = null;
  const updated = await fitStoredRoomHeating(db, "home", "customer", "room", context, stored(first), null, now);
  assert(bands(updated).active[0].revision !== revision);
  assertEquals(bands(updated).window_attempts?.[candidate.window_key], `${ROOM_WINDOW_IMPLEMENTATION}:${candidate.fingerprint}`);
});

Deno.test("historical windows add bands while retaining installed reference coefficients and revision", async () => {
  const recent = history(Date.UTC(2026, 10, 1), 240, .004, 7);
  const warm = window(recent, "5:2026-11", 5);
  const current = await fitStoredRoomHeating(database([warm], recent), "home", "customer", "room", context, undefined, null, now);
  const revision = bands(current).reference_revision;
  delete bands(current).reference!.training_to; // Existing libraries predate this metadata.
  const winter = history(Date.UTC(2026, 0, 1)), cold = window(winter, "-10:2026-01");
  const older = await fitStoredRoomHeating(database([cold, warm], [...winter, ...recent]),
    "home", "customer", "room", context, stored(current), null, now);
  assertEquals(older.gain_c_per_wh, undefined); // Publication merges unchanged installed coefficients.
  assertEquals(bands(older).reference_revision, revision);
  assertEquals(bands(older).reference?.training_to, warm.to_at);
  assertEquals(bands(older).active.map(band => band.band_c), [-10, 5]);
});

Deno.test("a failed history read never marks its window attempted", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10:2026-01");
  const db = database([candidate], rows);
  for (const operation of ["get_energy_room_heating_fit_windows", "get_energy_room_thermal_interval_capture"]) {
    db.fail(operation);
    await assertRejects(async () => await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined, null, now),
      Error, `${operation}: synthetic read failed`);
  }
});

Deno.test("absent heating windows retain the standard recent-fit diagnostic", async () => {
  const row = await fitStoredRoomHeating(database([], []), "home", "customer", "room", context, undefined, null, now);
  assertEquals(row.trained, false);
  assertEquals(bands(row).pending_windows, 0);
  assertEquals((row.last_fit_attempt as { status: string }).status, "unidentified");
});

Deno.test("an identified band publishes independently without masquerading as a failed general reference", async () => {
  // Independent synthetic weather ranges have conflicting heater responses;
  // only the cold range identifies a physically positive heating coefficient.
  const start = Date.UTC(2026, 0, 1);
  const warm = history(start, 240, -.002, 7), cold = history(start + 241 * hour, 120, .002, -7);
  const rows = [...warm, ...cold], candidate = window(rows, "-10:2026-01");
  const db = database([candidate], rows);
  const general = await runRoomPhase(db, "home", "customer", "room", context, undefined, null, now);
  assertEquals(general.trained, false);
  assertEquals(general.rejection_reason, "singular");
  assertEquals(bands(general).active, []);

  const fitted = await runRoomPhase(db, "home", "customer", "room", context, stored(general), null, now);
  const generalFields = ["trained", "rejection_reason", "sample_count"];
  assertEquals(generalFields.filter(field => Object.hasOwn(fitted, field)), []);
  const published = { ...general, ...fitted };
  assertEquals(published.trained, false);
  assertEquals(published.rejection_reason, general.rejection_reason);
  assertEquals(published.sample_count, general.sample_count);
  assertEquals(bands(fitted).reference, undefined);
  assertEquals(bands(fitted).active.map(band => band.band_c), [-10]);
  const diagnostic = fitted.last_fit_attempt as { status: string; issues: string[] };
  assertEquals(diagnostic.status, "general_unidentified");
  assert(diagnostic.issues.includes("general_unidentified"));
});

Deno.test("algorithm revision changes rerun identical completed evidence windows", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10:2026-01");
  const db = database([candidate], rows);
  const prior = await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined, null, now);
  const revision = bands(prior).active[0].revision;
  bands(prior).window_attempts![candidate.window_key] = `old-implementation:${candidate.fingerprint}`;
  const updated = await fitStoredRoomHeating(db, "home", "customer", "room", context, stored(prior), null, now);
  assert(bands(updated).active[0].revision !== revision);
});

Deno.test("verified earlier history for a new source is not fenced by the previous source start", async () => {
  const recent = history(Date.UTC(2026, 10, 1), 240, .004, 7), warm = window(recent, "5:2026-11", 5);
  const current = await fitStoredRoomHeating(database([warm], recent), "home", "customer", "room",
    { ...context, observed_since: recent[0].start_ts }, undefined, null, now);
  const winter = history(Date.UTC(2026, 0, 1)), cold = window(winter, "-10:2026-01");
  const changed = await fitStoredRoomHeating(database([cold], winter), "home", "customer", "room",
    { binding: "new-verified-source", observed_since: winter[0].start_ts }, stored(current), null, now);
  assertEquals(bands(changed).since, winter[0].start_ts);
  assertEquals(bands(changed).binding, "new-verified-source");
  assertEquals(bands(changed).active.map(band => band.band_c), [-10]);
  assertEquals(bands(changed).previous_reference_revision, bands(current).reference_revision!);
});

Deno.test("historical solar repair is source-qualified, precedes fitting, and records enriched fingerprint", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10:2026-01");
  const base = database([candidate], rows), calls: string[] = [];
  const points = rows.slice(0, -1).map((row, index) => ({ t: Date.parse(row.start_ts) + hour,
    v: Math.max(0, 200 * Math.sin(index * Math.PI / 12)) }));
  const db = {
    ...base,
    from(name: string) {
      if (name !== "energy_outdoor_forecast_cache") return base.from(name);
      const query = { eq: () => query, maybeSingle: () => Promise.resolve({
        data: { points, expires_at: new Date(now + hour).toISOString() }, error: null,
      }) };
      return { select: () => query };
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name !== "repair_energy_heating_irradiance") return base.rpc(name, args);
      assertEquals(args.p_binding, context.binding);
      assertEquals(args.p_room_key, "room");
      assert(Date.parse(String(args.p_from)) <= Date.parse(candidate.from_at));
      assertEquals(args.p_to, candidate.to_at);
      assertEquals(args.p_points, points);
      const missing = rows.filter(row => row.solar_w_per_m2 === null);
      for (const row of missing) row.solar_w_per_m2 = points.find(point => point.t === Date.parse(row.start_ts) + hour)?.v ?? null;
      const patched = missing.filter(row => row.solar_w_per_m2 !== null).length;
      if (patched) candidate.fingerprint = "enriched-solar-fingerprint";
      return Promise.resolve({ data: patched, error: null });
    },
  };
  const fitted = await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined,
    { latitude: 0, longitude: 0 }, now);
  assert(calls.indexOf("repair_energy_heating_irradiance") < calls.indexOf("get_energy_room_thermal_interval_capture"));
  assertEquals(calls.filter(name => name === "get_energy_room_heating_fit_windows").length, 6);
  assertEquals(bands(fitted).window_attempts?.[candidate.window_key], `${ROOM_WINDOW_IMPLEMENTATION}:enriched-solar-fingerprint`);
  assertEquals(bands(fitted).pending_windows, 0);
  assertEquals(rows.at(-1)!.solar_w_per_m2, null); // Provider gap is never zero-filled.
});

Deno.test("archive outages leave fitting available and retry independently of unchanged observations", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10:2026-01");
  const base = database([candidate], rows);
  let unavailable = true;
  const db = { ...base, from(name: string) {
    if (name !== "energy_outdoor_forecast_cache") return base.from(name);
    if (unavailable) throw new Error("Synthetic archive cache unavailable");
    const query = { eq: () => query, maybeSingle: () => Promise.resolve({
      data: { points: [], expires_at: new Date(now + hour).toISOString() }, error: null,
    }) };
    return { select: () => query };
  } };
  const first = await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined,
    { latitude: 0, longitude: 0 }, now);
  assertEquals(first.trained, true);
  assertEquals(bands(first).pending_windows, 2);
  assertEquals(bands(first).window_solar_pending?.[candidate.window_key], true);
  unavailable = false; // A successful empty archive remains a documented data gap.
  const second = await fitStoredRoomHeating(db, "home", "customer", "room", context, stored(first),
    { latitude: 0, longitude: 0 }, now);
  assertEquals(bands(second).pending_windows, 1);
  assertEquals(bands(second).window_solar_pending?.[candidate.window_key], false);
  const general = await runRoomPhase(db, "home", "customer", "room", context, stored({ ...first, ...second }),
    { latitude: 0, longitude: 0 }, now);
  assertEquals(bands(general).pending_windows, 0);
  assertEquals(bands(general).general_solar_pending, false);
  assert(rows.every(row => row.solar_w_per_m2 === null));
});

Deno.test("retention expiry alone never replaces a fitted winter band", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10");
  const db = database([candidate], rows);
  const first = await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined, null, now);
  const reads = db.reads.length, revision = bands(first).active[0].revision;
  candidate.from_at = rows[48].start_ts;
  candidate.fingerprint = "oldest-observations-expired";
  const retained = await fitStoredRoomHeating(db, "home", "customer", "room", context, stored(first), null, now);
  assertEquals(bands(retained).active[0].revision, revision);
  assertEquals(db.reads.slice(reads), ["get_energy_room_heating_fit_windows"]);
  assertEquals(bands(retained).pending_windows, 0);
  candidate.evidence_updated_at = new Date(now).toISOString();
  const corrected = await fitStoredRoomHeating(db, "home", "customer", "room", context, stored(first), null, now);
  assert(bands(corrected).active[0].revision !== revision);
});

Deno.test("pooled historical solar drains bounded chunks before fitting with no silent time truncation", async () => {
  const winter = history(Date.UTC(2025, 10, 1)), autumn = history(Date.UTC(2026, 10, 1));
  const rows = [...winter, ...autumn], candidate = window(rows, "-10");
  const base = database([candidate], rows), requested: string[] = [];
  const db = { ...base, from(name: string) {
    if (name !== "energy_outdoor_forecast_cache") return base.from(name);
    const query = { eq: (key: string, value: string) => {
      if (key === "provider") requested.push(value);
      return query;
    }, maybeSingle: () => Promise.resolve({
      data: { points: [], expires_at: new Date(now + hour).toISOString() }, error: null,
    }) };
    return { select: () => query };
  } };
  let previous: StoredDeviceModel | undefined, result: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) {
    result = await fitStoredRoomHeating(db, "home", "customer", "room", context, previous,
      { latitude: 0, longitude: 0 }, now + i);
    previous = stored({ ...previous, ...result });
    if (!bands(result).pending_windows) break;
    assertEquals(base.reads.filter(name => name === "get_energy_room_thermal_interval_capture").length, 3); // Three bounded chunks for the initial general phase only.
    assertEquals(bands(result).window_attempts, undefined);
  }
  assertEquals(bands(result).pending_windows, 0);
  assertEquals(previous!.trained, true);
  assert(requested.length > 10);
  const windows = requested.slice(1).map(key => key.match(/analysis_(\d+)_(\d+)$/)!.slice(1).map(Number));
  assertEquals(windows[0][0], Date.parse(candidate.from_at));
  assertEquals(windows.at(-1)![1], Date.parse(candidate.to_at));
  for (let i = 0; i < windows.length; i++) {
    assert(windows[i][1] - windows[i][0] <= 31 * 24 * hour);
    if (i) assertEquals(windows[i][0], windows[i - 1][1]);
  }
  assertEquals(bands(result).active[0].training_from, candidate.from_at);
  assertEquals(bands(result).active[0].training_to, candidate.to_at);
});


Deno.test("native auxiliary means require every underlying quarter and never stretch one reading", () => {
  const start = Date.UTC(2026, 0, 1), quarter = hour / 4;
  const watts = new Map([0, 1, 2, 3].map(i => [start + i * quarter, i * 100]));
  assertEquals(auxiliaryIntervalMean(watts, start, 3600), 150);
  assertEquals(auxiliaryIntervalMean(watts, start, 900), 0);
  watts.delete(start + quarter);
  assertEquals(auxiliaryIntervalMean(watts, start, 3600), undefined);
  assertEquals(auxiliaryIntervalMean(watts, start, 900), 0);
});

Deno.test("native band forcing averages complete peer quarters and rejects incomplete passive or peer history", () => {
  const start = Date.UTC(2026, 0, 1), observation = thermalQuarter(history(start, 1)[0]);
  const reference = { model: { house_coupling_per_h: 1 }, doorway_exchange: {
    source: "room-source", peers: [{ key: "peer", source: "peer-source", weight: .1, usual: 0, persistence: .9 }],
  } } as RoomHeatingReference;
  const probe = { room_key: "room", room_source: "room-source", other_key: "peer", other_source: "peer-source",
    quarters: [20, 22, 24, 26].map((value, i): [number, number] => [start + i * hour / 4, value]) };
  assertEquals(bandObservations([observation], reference, undefined, [probe])[0].band_forcing_c_per_h,
    .1 * (23 - observation.house_c!));
  probe.quarters.pop();
  assertEquals(bandObservations([observation], reference, undefined, [probe])[0].band_forcing_c_per_h, null);
  assertEquals(bandObservations([observation], reference, undefined, [])[0].band_forcing_c_per_h, null);
  delete reference.doorway_exchange;
  reference.passive_heat = { device_key: "meter", direct_c_per_wh: .001, delayed_c_per_wh: .001, lag_h: .1 };
  const watts = new Map([0, 1, 2, 3].map(i => [start + i * hour / 4, 100]));
  assert((bandObservations([observation], reference, { device_key: "meter", watts }, [])[0].band_forcing_c_per_h ?? 0) > 0);
  watts.delete(start + hour / 4);
  assertEquals(bandObservations([observation], reference, { device_key: "meter", watts }, [])[0].band_forcing_c_per_h, null);
});

Deno.test("general learning is a bounded independent phase and bands take priority over subsequent refreshes", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10");
  const db = database([candidate], rows);
  const first = await runRoomPhase(db, "home", "customer", "room", context, undefined, null, now);
  assertEquals(first.trained, true);
  assertEquals(bands(first).active.length, 0);
  assertEquals(bands(first).reference?.scope, { kind: "general" });
  assertEquals(bands(first).pending_windows, 1);
  const general = bands(first).general_attempt!;
  assertEquals(Date.parse(general.to_at) - Date.parse(general.from_at), 21 * 24 * hour);
  assertEquals(db.reads.filter(name => name === "get_energy_room_thermal_interval_capture").length, 3);
  const second = await runRoomPhase(db, "home", "customer", "room", context, stored(first), null, now);
  assertEquals(bands(second).active.length, 1);
  assertEquals(bands(second).reference_revision, bands(first).reference_revision);
  assertEquals(bands(second).pending_windows, 0);
  candidate.evidence_updated_at = new Date(now).toISOString();
  candidate.fingerprint = "corrected-meter-coverage";
  for (const row of rows) row.heat_w = null;
  const third = await runRoomPhase(db, "home", "customer", "room", context, stored({ ...first, ...second }), null, now);
  assertEquals(bands(third).general_attempt, general); // Band attempted first.
  assertEquals(bands(third).active[0].revision, bands(second).active[0].revision);
  assertEquals(bands(third).pending_windows, 1);
  const fourth = await runRoomPhase(db, "home", "customer", "room", context, stored({ ...first, ...third }), null, now);
  assertEquals(bands(fourth).reference_revision, bands(first).reference_revision); // Failed general cannot erase it.
  assertEquals(fourth.trained, undefined);
  assertEquals(bands(fourth).general_attempt?.evidence_updated_at, candidate.evidence_updated_at);
  assertEquals(bands(fourth).pending_windows, 0);
});

Deno.test("native history chunks stay hour-aligned and preserve original partial endpoints", () => {
  const from = "2025-10-01T00:15:00.000Z", to = "2025-11-03T04:45:00.000Z";
  const windows = nativeRoomReadWindows(from, to);
  assertEquals(windows[0][0], from);
  assertEquals(windows.at(-1)![1], to);
  for (let i = 0; i < windows.length; i++) {
    assert(Date.parse(windows[i][1]) - Date.parse(windows[i][0]) <= 10 * 24 * hour);
    if (i) {
      assertEquals(windows[i][0], windows[i - 1][1]);
      assertEquals(Date.parse(windows[i][0]) % hour, 0);
    }
  }
});

Deno.test("native chunk captures preserve mixed interval durations and read each bounded window once", async () => {
  const start = Date.UTC(2025, 9, 1), end = start + 25 * 24 * hour;
  const rows = Array.from({ length: 25 * 24 }, (_, i) => i % 3 ? [
    { start_ts: new Date(start + i * hour).toISOString(), duration_s: 3600 },
  ] : Array.from({ length: 4 }, (_, q) => ({ start_ts: new Date(start + i * hour + q * hour / 4).toISOString(), duration_s: 900 }))).flat();
  const calls: { from: string; to: string }[] = [];
  let running = 0, maxRunning = 0;
  const model = history(start, 1)[0];
  const db = { async rpc(name: string, args: Record<string, string>) {
    assertEquals(name, "get_energy_room_thermal_interval_capture");
    assertEquals(args.p_room_key, "room");
    const selected = rows.filter(row => row.start_ts >= args.p_from &&
      Date.parse(row.start_ts) + row.duration_s * 1000 <= Date.parse(args.p_to))
      .map(row => ({ ...model, ...row, duration_s: row.duration_s as 900 | 3600 }));
    running++; maxRunning = Math.max(maxRunning, running);
    calls.push({ from: args.p_from, to: args.p_to });
    await Promise.resolve();
    running--;
    return { data: compactCapture(selected), error: null };
  } };
  const captured = await readRoomQuarters(db, "home", "customer", "room", new Date(start).toISOString(), new Date(end).toISOString(), true);
  assertEquals(captured.map(row => ({ start_ts: row.start_ts, duration_s: Number(row.duration_s) })), rows);
  assertEquals(new Set(captured.map(row => row.start_ts)).size, rows.length);
  assertEquals(maxRunning, 1, "one admitted room must not multiply database history scans");
  assertEquals(new Set(calls.map(call => call.from)).size, 3);
  assertEquals(calls.length, 3);
});

Deno.test("material changes during a bounded band capture keep its revision pending instead of publishing mixed inputs", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10");
  const base = database([candidate], rows);
  const general = await runRoomPhase(base, "home", "customer", "room", context, undefined, null, now);
  let corrected = false;
  const db = { ...base, rpc(name: string, args: Record<string, unknown>) {
    if (name === "get_energy_room_thermal_interval_capture" && !corrected) {
      corrected = true;
      candidate.fingerprint = "concurrent-meter-correction";
      candidate.evidence_updated_at = new Date(now).toISOString();
    }
    return base.rpc(name, args);
  } };
  const changed = await runRoomPhase(db, "home", "customer", "room", context, stored(general), null, now);
  assertEquals(bands(changed).active, []);
  assertEquals(bands(changed).window_attempts, undefined);
  assert((bands(changed).pending_windows ?? 0) > 0);
  const retried = await runRoomPhase(db, "home", "customer", "room", context, stored({ ...general, ...changed }), null, now);
  assertEquals(bands(retried).active.length, 1);
  assertEquals(bands(retried).window_attempts?.[candidate.window_key], `${ROOM_WINDOW_IMPLEMENTATION}:${candidate.fingerprint}`);
});

Deno.test("newer uploads outside a fixed historical capture cannot starve its band publication", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10"), snapshot = { ...candidate };
  const base = database([candidate], rows);
  const general = await runRoomPhase(base, "home", "customer", "room", context, undefined, null, now);
  let arrived = false;
  const db = { ...base, rpc(name: string, args: Record<string, unknown>) {
    if (name === "get_energy_room_thermal_interval_capture" && !arrived) {
      arrived = true;
      candidate.to_at = new Date(Date.parse(snapshot.to_at) + hour).toISOString();
      candidate.fingerprint = "newer-data-beyond-captured-end";
      candidate.evidence_updated_at = new Date(now).toISOString();
    }
    if (name === "get_energy_room_heating_fit_windows" && args.p_to === snapshot.to_at) {
      return Promise.resolve({ data: [{ ...snapshot }], error: null });
    }
    return base.rpc(name, args);
  } };
  const fitted = await runRoomPhase(db, "home", "customer", "room", context, stored(general), null, now);
  assertEquals(bands(fitted).active.length, 1);
  assertEquals(bands(fitted).active[0].training_to, snapshot.to_at);
  assertEquals(bands(fitted).window_attempts?.[candidate.window_key], `${ROOM_WINDOW_IMPLEMENTATION}:${snapshot.fingerprint}`);
  assertEquals(bands(fitted).window_evidence_updated_at?.[candidate.window_key], snapshot.evidence_updated_at);
});

Deno.test("an older isolated backfill cannot replace a newer installed general response", async () => {
  const recent = history(Date.UTC(2026, 10, 1), 240, .004, 7), warm = window(recent, "5", 5);
  const current = await fitStoredRoomHeating(database([warm], recent), "home", "customer", "room", context, undefined, null, now);
  const winter = history(Date.UTC(2026, 0, 1)), cold = window(winter, "-10");
  const db = database([cold], winter);
  cold.evidence_updated_at = new Date(now).toISOString();
  const band = await runRoomPhase(db, "home", "customer", "room", context, stored(current), null, now);
  assertEquals(bands(band).active.map(b => b.band_c), [-10, 5]);
  const drained = await runRoomPhase(db, "home", "customer", "room", context, stored({ ...current, ...band }), null, now);
  assertEquals(bands(drained).pending_windows, 0);
  assertEquals(bands(drained).reference_revision, bands(current).reference_revision);
  assertEquals(bands(drained).reference, bands(current).reference);
  assertEquals(drained.gain_c_per_wh, undefined);
});
