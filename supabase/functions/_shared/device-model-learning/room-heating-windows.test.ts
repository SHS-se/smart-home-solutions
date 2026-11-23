import { assert, assertEquals, assertRejects } from "@std/assert";
import { fitStoredRoomHeating as runRoomPhase, prepareStoredRoomHeating, ROOM_WINDOW_IMPLEMENTATION, auxiliaryIntervalMean, bandObservations, readRoomQuarters, nativeRoomReadWindows } from "./room.ts";
import type { StoredDeviceModel } from "../device-model-store.ts";
import { thermalQuarter, type ThermalQuarterRow } from "../thermal-training.ts";
import type { RoomHeatingBands } from "../planner/heating-bands.ts";
import type { HeatingProbeCapture } from "../heating-probe-wire.ts";


/** One learner step, as the worker would publish it. */
const fitStoredRoomHeating = runRoomPhase;

/** Drain harvests and the shared fit; returns every published step, newest last. */
async function drain(db: ReturnType<typeof database>, previous: StoredDeviceModel | undefined, clock = { historyTo: now, wallNow: now }) {
  const steps: Record<string, unknown>[] = [];
  let current = previous;
  for (let i = 0; i < 40; i++) {
    const row = await runRoomPhase(db, "home", "customer", "room", context, current, null, clock);
    steps.push(row);
    current = { ...current, ...row, model_revision: (current?.model_revision ?? 0) + 1 } as StoredDeviceModel;
    if (!(row.heating_bands as RoomHeatingBands | undefined)?.pending_windows) break;
  }
  return { steps, model: current! };
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
  const pool = new Map<string, Record<string, unknown>>();
  let harvests = 0;
  return {
    reads, pool, fail: (name: string) => { failure = name; },
    rpc(name: string, args: Record<string, unknown>) {
      reads.push(name);
      const error = name === failure ? { message: "synthetic read failed" } : null;
      if (name === "save_energy_room_run_harvest") {
        // Mirrors the SQL owner: one entry per band window, replaced by its next harvest.
        if ((args.p_run_ids as string[]).length) pool.set(String(args.p_window_key), {
          window_key: args.p_window_key, sha256: args.p_sha256, band_c: args.p_band_c, from_at: args.p_from_at,
          harvested_at: new Date(now + ++harvests * 1000).toISOString(), capture: args.p_capture_base64,
          row_count: args.p_row_count, observed_runs: args.p_observed_runs, rated_power_w: args.p_rated_power_w,
          source_freshness: args.p_source_freshness });
        else pool.delete(String(args.p_window_key));
        return Promise.resolve({ data: true, error });
      }
      if (name === "load_energy_room_run_pool") return Promise.resolve({ data: [...pool.values()], error });
      if (name === "get_energy_room_heating_fit_windows") return Promise.resolve({ data: windows.map(window => ({ ...window })), error });
      if (name === "get_energy_room_missing_irradiance_window") {
        const missing = rows.filter(row => row.solar_w_per_m2 === null &&
          row.start_ts >= String(args.p_from) && Date.parse(row.start_ts) + Number(row.duration_s) * 1000 <= Date.parse(String(args.p_to)));
        const next = missing.find(row => args.p_after == null || row.start_ts >= String(args.p_after)) ?? missing[0];
        const from = next ? Math.floor(Date.parse(next.start_ts) / hour) * hour : 0;
        const last = missing.filter(row => Date.parse(row.start_ts) >= from &&
          Date.parse(row.start_ts) + Number(row.duration_s) * 1000 <= from + 31 * 24 * hour).at(-1);
        return Promise.resolve({ data: last ? { from_at: new Date(from).toISOString(),
          to_at: new Date(Date.parse(last.start_ts) + Number(last.duration_s) * 1000).toISOString() } : null, error });
      }
      if (name === "get_energy_room_thermal_interval_capture") {
        assertEquals(args.p_room_key, "room");
        const selected = rows.filter(row => row.start_ts >= String(args.p_from) && row.start_ts < String(args.p_to));
        return Promise.resolve({ data: compactCapture(selected), error });
      }
      if (["get_energy_room_operation_facts", "get_energy_room_passive_heat", "get_energy_doorway_probes"].includes(name)) return Promise.resolve({ data: [], error });
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

Deno.test("a failed history read never marks its window attempted", async () => {
  const rows = history(Date.UTC(2026, 0, 1)), candidate = window(rows, "-10:2026-01");
  const db = database([candidate], rows);
  for (const operation of ["get_energy_room_heating_fit_windows", "get_energy_room_thermal_interval_capture", "get_energy_room_operation_facts"]) {
    db.fail(operation);
    await assertRejects(async () => await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined, null, { historyTo: now, wallNow: now }),
      Error, `${operation}: synthetic read failed`);
  }
});

Deno.test("absent heating windows retain the standard recent-fit diagnostic", async () => {
  const row = await fitStoredRoomHeating(database([], []), "home", "customer", "room", context, undefined, null, { historyTo: now, wallNow: now });
  assertEquals(row.trained, false);
  assertEquals(bands(row).pending_windows, 0);
  assertEquals((row.last_fit_attempt as { status: string }).status, "unidentified");
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
    if (name === "get_energy_room_operation_facts") return { data: [], error: null };
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

Deno.test("complete intervals crossing internal chunk seams survive once without widening the global scope", async () => {
  const start = Date.UTC(2025, 9, 1), seam = start + 10 * 24 * hour;
  for (const partialStart of [false, true]) {
    const from = start + (partialStart ? hour / 4 : 0), to = seam + hour + 21 * 60_000;
    const model = history(start, 1)[0];
    // Independently generated synthetic legacy quarter, with an exact
    // fractional timestamp whose complete end crosses the batching seam.
    const crossing = { ...model, start_ts: new Date(seam - hour / 4 + 123).toISOString(), duration_s: 900 as const };
    const inputs: ThermalQuarterRow[] = [
      { ...model, start_ts: new Date(start).toISOString(), duration_s: 3600 },
      ...Array.from({ length: 3 }, (_, q) => ({ ...model,
        start_ts: new Date(start + q * hour / 4).toISOString(), duration_s: 900 as const })),
      { ...model, start_ts: new Date(seam - hour).toISOString(), duration_s: 3600 },
      ...Array.from({ length: 3 }, (_, q) => ({ ...model,
        start_ts: new Date(seam - hour + q * hour / 4).toISOString(), duration_s: 900 as const })),
      crossing,
      { ...model, start_ts: new Date(seam).toISOString(), duration_s: 3600 },
      { ...model, start_ts: new Date(to - 5 * 60_000).toISOString(), duration_s: 900 },
    ];
    // This reader exposes the same native-hour-over-incomplete-fine choice
    // as the canonical SQL. Extra rows outside the global start could change it.
    const canonical = (begin: number, end: number) => {
      const eligible = inputs.filter(row => Date.parse(row.start_ts) >= begin &&
        Date.parse(row.start_ts) + row.duration_s! * 1000 <= end);
      const coarse = eligible.filter(row => row.duration_s === 3600 && eligible.filter(fine =>
        fine.duration_s === 900 && Math.floor(Date.parse(fine.start_ts) / hour) * hour === Date.parse(row.start_ts)).length < 4);
      return eligible.filter(row => row.duration_s === 3600 ? coarse.includes(row) : !coarse.some(hourRow =>
        Date.parse(hourRow.start_ts) <= Date.parse(row.start_ts) &&
        Date.parse(row.start_ts) < Date.parse(hourRow.start_ts) + hour))
        .sort((a, b) => Date.parse(a.start_ts) - Date.parse(b.start_ts));
    };
    const calls: { from: number; to: number }[] = [];
    const db = { async rpc(name: string, args: Record<string, string>) {
      if (name === "get_energy_room_operation_facts") return { data: [], error: null };
      assertEquals(name, "get_energy_room_thermal_interval_capture");
      const begin = Date.parse(args.p_from), end = Date.parse(args.p_to);
      assert(begin >= from && end <= to, "query overlap is bounded by the actual frozen scope");
      calls.push({ from: begin, to: end });
      return { data: compactCapture(canonical(begin, end)), error: null };
    } };
    const captured = await readRoomQuarters(db, "home", "customer", "room", new Date(from).toISOString(), new Date(to).toISOString(), true);
    assertEquals(captured.map(row => row.start_ts), canonical(from, to).map(row => row.start_ts));
    assertEquals(captured.filter(row => row.start_ts === crossing.start_ts).length, 1);
    assertEquals(captured.filter(row => Date.parse(row.start_ts) >= seam - hour && Date.parse(row.start_ts) < seam)
      .map(row => row.duration_s), [900, 900, 900, 900], "complete fine evidence wins over its native hour across the seam");
    assertEquals(calls.length, 2, "overlap adds no extra round trips");
    assertEquals(new Set(captured.map(row => row.start_ts)).size, captured.length);
  }
});

Deno.test("missing native heating windows cannot install an unchecked recent-fit scalar model", async () => {
  const rows = history(now - 240 * hour);
  const result = await runRoomPhase(database([],rows),"home","customer","room",context,undefined,null,{historyTo:now,wallNow:now});
  assertEquals(result.trained,false);
  assertEquals(result.rejection_reason,"insufficient_heating_runs");
  assertEquals(result.gain_c_per_wh,null);
  assertEquals(bands(result).reference,undefined);
});

const clock = { historyTo: now, wallNow: now };
/** Two seasons of the same synthetic room: one constant heater gain and loss. */
function seasons() {
  const cold = history(Date.UTC(2026, 0, 1), 240, .002, -7), warm = history(Date.UTC(2026, 2, 1), 240, .002, 3);
  return { cold, warm, rows: [...cold, ...warm], windows: [window(cold, "-10", -10), window(warm, "0", 0)] };
}

Deno.test("each band window is harvested once, then one shared response fitted across both seasons replaces the bands", async () => {
  const { rows, windows } = seasons();
  const legacy = { binding: context.binding, calibration_policy: "recent_independent_runs_v1", since: context.observed_since,
    reference_revision: "legacy-general", active: [{ revision: "11111111-1111-4111-8111-111111111111", band_c: -10,
      observed_min_c: -8, observed_max_c: -6, training_from: rows[0].start_ts, training_to: rows[200].start_ts,
      model: { gain_c_per_wh: .003, cooling_constant_per_h: .03, background_gain_c_per_h: 0, thermal_capacity_wh_per_c: 333,
        heat_loss_w_per_c: 10, time_constant_h: 33, heating_rate_c_per_h: 1, r2: .9, sample_count: 10, residual_std_c: .1 } }],
    candidates: [], attempted: {} };
  const db = database(windows, rows);
  const { steps, model } = await drain(db, stored({ heating_bands: legacy }));
  // Both windows are harvested before the shared fit; harvests publish only bookkeeping.
  assertEquals(steps.length, 3);
  for (const step of steps.slice(0, 2)) {
    assertEquals(bands(step).active.length, 1, "legacy responses stay in service until the shared one publishes");
    assert(bands(step).pending_windows! > 0);
  }
  assertEquals([...db.pool.keys()].sort(), ["-10", "0"]);
  const published = bands(steps[2]);
  assertEquals(published.reference?.scope, { kind: "shared" });
  assertEquals(published.active, []);
  assertEquals(published.shared_attempt?.status, "fitted");
  assertEquals(published.pending_windows, 0);
  assert(typeof published.reference_revision === "string" && published.reference_revision !== "legacy-general");
  assertEquals(steps[2].trained, true);
  assert(Math.abs(Number(steps[2].gain_c_per_wh) - .002) < .0004, `gain ${steps[2].gain_c_per_wh}`);
  // With nothing new, the next request is idle and leaves the accepted response alone.
  const idle = await fitStoredRoomHeating(db, "home", "customer", "room", context, model, null, clock);
  assertEquals(bands(idle).reference_revision, published.reference_revision);
  assertEquals(bands(idle).pending_windows, 0);
  assertEquals(idle.gain_c_per_wh, undefined, "an idle step publishes no coefficients");
});

Deno.test("harvesting qualifies source freezes before the shared fit and records the reason", async () => {
  const { rows, windows } = seasons();
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
  const { steps } = await drain(database(windows, rows), undefined);
  const attempt = steps.at(-1)!.last_fit_attempt as { source_freshness: { room: { inferred: number } } };
  assertEquals(attempt.source_freshness.room.inferred, 35);
  assertEquals(rows, before, "original temperature observations and known heat remain untouched");
});

Deno.test("an unvisited winter window is harvested before a revisited live window", async () => {
  const { rows, windows } = seasons();
  const warm = windows[1];
  const library = { binding: context.binding, calibration_policy: "seasonal_independent_runs_v1", since: context.observed_since,
    reference_revision: null, active: [], candidates: [], attempted: {},
    window_attempts: { [warm.window_key]: `${ROOM_WINDOW_IMPLEMENTATION}:stale` },
    window_evidence_updated_at: { [warm.window_key]: new Date(now - 10 * hour).toISOString() },
    window_last_attempted_at: { [warm.window_key]: new Date(now - 5 * hour).toISOString() } };
  const db = database(windows, rows);
  const first = await fitStoredRoomHeating(db, "home", "customer", "room", context, stored({ heating_bands: library }), null, clock);
  assertEquals(Object.keys(bands(first).window_attempts ?? {}).sort(), ["-10", "0"]);
  assertEquals(bands(first).window_attempts?.["-10"], `${ROOM_WINDOW_IMPLEMENTATION}:fingerprint:-10`);
  assertEquals([...db.pool.keys()], ["-10"]);
});

Deno.test("late older measurements and an algorithm revision re-harvest a completed window", async () => {
  const { rows, windows } = seasons();
  const db = database(windows, rows);
  const { model } = await drain(db, undefined);
  const revision = bands(model).reference_revision;
  // A correction inside the cold window, without any newer final timestamp.
  windows[0].evidence_updated_at = new Date(now).toISOString();
  windows[0].fingerprint = "corrected";
  for (const row of rows.slice(0, 240)) row.room_temperature_c = row.room_temperature_c! + .01;
  const before = bands(model).shared_attempt!.pool;
  const { steps } = await drain(db, model);
  assertEquals(bands(steps[0]).window_attempts?.["-10"], `${ROOM_WINDOW_IMPLEMENTATION}:corrected`);
  // The changed pool is refitted; an unresolved refit keeps the accepted response.
  const attempt = bands(steps.at(-1)!).shared_attempt!;
  assert(attempt.pool.find(ref => ref.window_key === "-10")!.sha256 !== before.find(ref => ref.window_key === "-10")!.sha256);
  assert(attempt.status === "fitted" ? bands(steps.at(-1)!).reference_revision !== revision
    : bands(steps.at(-1)!).reference_revision === revision);
  // An implementation change re-harvests every window even when evidence is identical.
  const old = { ...bands(model), window_attempts: { "-10": "previous-implementation:fingerprint:-10", "0": "previous-implementation:fingerprint:0" } };
  const again = await fitStoredRoomHeating(db, "home", "customer", "room", context, stored({ ...model, heating_bands: old }), null, clock);
  assert(bands(again).window_attempts?.["-10"]?.startsWith(`${ROOM_WINDOW_IMPLEMENTATION}:`) ||
    bands(again).window_attempts?.["0"]?.startsWith(`${ROOM_WINDOW_IMPLEMENTATION}:`));
});

Deno.test("a band read that changes during harvest records no harvest and stays pending", async () => {
  const { rows, windows } = seasons();
  const base = database(windows, rows);
  let corrected = false;
  const db = { ...base, rpc(name: string, args: Record<string, unknown>) {
    if (name === "get_energy_room_thermal_interval_capture" && !corrected) {
      // Whichever window is being read is corrected while it is read.
      corrected = true;
      for (const candidate of windows) {
        candidate.fingerprint = `${candidate.fingerprint}:concurrent-meter-correction`;
        candidate.evidence_updated_at = new Date(now).toISOString();
      }
    }
    return base.rpc(name, args);
  } };
  const changed = await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined, null, clock);
  assertEquals(bands(changed).window_attempts, undefined);
  assert((bands(changed).pending_windows ?? 0) > 0);
  assertEquals(base.pool.size, 0);
});

Deno.test("retention expiry keeps harvested winter evidence in the shared response", async () => {
  const { rows, windows } = seasons();
  const db = database(windows, rows);
  const { model } = await drain(db, undefined);
  const revision = bands(model).reference_revision;
  // Raw winter history ages out: its window disappears, its harvest does not.
  windows.splice(0, 1);
  rows.splice(0, 240);
  const after = await fitStoredRoomHeating(db, "home", "customer", "room", context, model, null, clock);
  assertEquals(bands(after).reference_revision, revision);
  assertEquals(bands(after).pending_windows, 0);
  assert(db.pool.has("-10"));
});

Deno.test("solar repair precedes each harvest read and records the enriched fingerprint", async () => {
  const { rows, windows } = seasons();
  const candidate = windows[0];
  const base = database(windows, rows), calls: string[] = [];
  const points = rows.map((row, index) => ({ t: Date.parse(row.start_ts) + hour,
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
      const missing = rows.filter(row => row.solar_w_per_m2 === null && row.start_ts >= String(args.p_from) && row.start_ts < String(args.p_to));
      for (const row of missing) row.solar_w_per_m2 = points.find(point => point.t === Date.parse(row.start_ts) + hour)?.v ?? null;
      const patched = missing.filter(row => row.solar_w_per_m2 !== null).length;
      if (patched && args.p_to === candidate.to_at) candidate.fingerprint = "enriched-solar-fingerprint";
      return Promise.resolve({ data: patched, error: null });
    },
  };
  const first = await fitStoredRoomHeating(db, "home", "customer", "room", context, undefined, { latitude: 0, longitude: 0 }, clock);
  assert(calls.indexOf("repair_energy_heating_irradiance") < calls.indexOf("get_energy_room_thermal_interval_capture"));
  const key = Object.keys(bands(first).window_attempts ?? {})[0];
  assert(bands(first).window_attempts?.[key]?.startsWith(`${ROOM_WINDOW_IMPLEMENTATION}:`));
  if (key === candidate.window_key) assertEquals(bands(first).window_attempts?.[key], `${ROOM_WINDOW_IMPLEMENTATION}:enriched-solar-fingerprint`);
});

Deno.test("an unidentified shared fit keeps the previously accepted response in service", async () => {
  const { rows, windows } = seasons();
  // Temperature generated independently of the heater: no gain can be identified.
  rows.forEach((row, i) => { row.room_temperature_c = 20 + .3 * Math.sin(i / 7); });
  const legacy = { binding: context.binding, calibration_policy: "recent_independent_runs_v1", since: context.observed_since,
    reference_revision: "legacy-general", reference: { model: { gain_c_per_wh: .003, cooling_constant_per_h: .03, background_gain_c_per_h: 0,
      thermal_capacity_wh_per_c: 333, heat_loss_w_per_c: 10, time_constant_h: 33, heating_rate_c_per_h: 1, r2: .9, sample_count: 10,
      residual_std_c: .1 }, scope: { kind: "general" } }, active: [], candidates: [], attempted: {} };
  const { steps } = await drain(database(windows, rows), stored({ trained: true, heating_bands: legacy }));
  const last = bands(steps.at(-1)!);
  assertEquals(last.shared_attempt?.status, "unidentified");
  assertEquals(last.reference_revision, "legacy-general");
  assertEquals(last.reference?.scope, { kind: "general" });
  assertEquals(steps.at(-1)!.trained, undefined, "the accepted response's training state is untouched");
});
