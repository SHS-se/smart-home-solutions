import { assert, assertEquals, assertRejects } from "@std/assert";
import { prepareStoredRoomHeating, finalizeStoredRoomResponse, roomResponseEvidence, auxiliaryIntervalMean,
  bandObservations, readRoomQuarters, nativeRoomReadWindows } from "./room.ts";
import { learnRoomResponse } from "../device-learning/room/response-learning.ts";
import { compactCapture, evidenceStore } from "./room-evidence.fixture.ts";
import type { StoredDeviceModel } from "../device-model-store.ts";
import { thermalQuarter, type ThermalQuarterRow } from "../thermal-training.ts";
import type { RoomHeatingReference, RoomHeatingBands } from "../planner/heating-bands.ts";

const hour = 3_600_000, start = Date.UTC(2026, 0, 1);
const at = (n: number) => new Date(start + n * hour).toISOString();
const owner = { id: "job", home_id: "home", customer_id: "customer", owner_key: "room", generation: 1, fence: 1 };
const context = { binding: "synthetic-binding", observed_since: at(0) };
const clock = { historyTo: Date.parse(at(240)), wallNow: Date.parse(at(240)) };
const acceptedModel = { gain_c_per_wh: .003, cooling_constant_per_h: .03, background_gain_c_per_h: 0,
  thermal_capacity_wh_per_c: 333, heat_loss_w_per_c: 10, time_constant_h: 33, heating_rate_c_per_h: 1,
  r2: .9, sample_count: 10, residual_std_c: .1 };
const ranges = [{ from_at: at(0), to_at: at(120) }, { from_at: at(120), to_at: at(240) }];
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


Deno.test("chronological source extents survive retention and a late correction replaces only its own extent", async () => {
  const rows = [...history(start, 120), ...history(start + 120 * hour, 120, .002, 3)];
  const db = evidenceStore(rows, ranges);
  const step = (previous?: StoredDeviceModel) => prepareStoredRoomHeating(db, owner, context, previous, null, clock);
  const legacy = { model_revision: 1, heating_bands: { binding: context.binding, since: at(0), reference_revision: "accepted",
    reference: { scope: { kind: "general" }, model: acceptedModel }, active: [], candidates: [], attempted: {} } };
  for (const range of ranges) {
    const refreshed = await step(legacy);
    assertEquals(refreshed.kind, "refreshed");
    assertEquals(legacy.model_revision, 1, "private source acquisition does not advance accepted model revisions");
    assert(db.blocks.has(range.from_at));
  }
  const original = await step(legacy);
  assert(original.kind === "shared");
  const { rows: quarters, metadata } = original.work;
  assertEquals(quarters.map(r => r.start_ms), rows.map(r => Date.parse(r.start_ts)));
  const offline = learnRoomResponse(roomResponseEvidence(quarters, metadata.trainingView), 500);
  const published = finalizeStoredRoomResponse(metadata, quarters, offline);
  assert(offline.result.ok);
  assertEquals(offline.result.model.sample_count, 239);
  const accepted = { ...published.model, model_revision: 2 };
  const library = published.model.heating_bands as RoomHeatingBands;
  assertEquals(library.reference?.scope, { kind: "shared" });
  const idle = await step(accepted);
  assert(idle.kind === "model");
  assertEquals(idle.model.gain_c_per_wh, undefined);
  assertEquals((idle.model.heating_bands as RoomHeatingBands).reference_revision, library.reference_revision);

  // The old rows have expired from hot source tables. Change a later meter,
  // reconstruct only its extent, then fit from both archived extents again.
  const cold = db.blocks.get(ranges[0].from_at)!, warm = db.blocks.get(ranges[1].from_at)!;
  rows.splice(0, 120);
  rows[10].heat_w = null;
  db.correct(ranges[1]);
  const after = db.reads.length;
  assertEquals((await step(accepted)).kind, "refreshed");
  assertEquals(db.blocks.get(ranges[0].from_at), cold);
  assert(db.blocks.get(ranges[1].from_at)!.sha256 !== warm.sha256);
  assertEquals(db.reads.slice(after).filter(r => r.name === "get_energy_room_thermal_interval_capture").map(r => r.args.p_from), [at(119)], "read the dirty block and its one-hour resolution halo");
  const corrected = await step(accepted);
  assert(corrected.kind === "shared");
  assertEquals(corrected.work.rows.length, 240);
  assertEquals(corrected.work.rows[130].heat_w, null);
  assertEquals(corrected.work.metadata.evidence.sourceRevision, 2);
});

Deno.test("probe freshness spans the archive seam and the held-out tail cannot requalify training inputs", async () => {
  const rows = history(start);
  const source = "a".repeat(64);
  for (const [i, row] of rows.entries()) {
    const frozen = i >= 159 && i < 195;
    if (frozen) row.room_temperature_c = 20;
    row.temperature_source_key = source;
    row.probe_evidence = [{ source_key: source, area_key: "room", mean: row.room_temperature_c,
      unchanged: frozen, joint_unchanged: frozen, reported: null, unavailable: null, cohort_key: null },
      ...["b", "c", "d"].map(key => ({ source_key: key.repeat(64), area_key: key, mean: row.house_temperature_c,
        unchanged: false, joint_unchanged: false, reported: null, unavailable: null, cohort_key: null }))];
  }
  const seam = at(160); // The first two-thirds ends inside the freeze.
  const original = structuredClone(rows), db = evidenceStore(rows, [
    { from_at: at(0), to_at: seam }, { from_at: seam, to_at: at(240) },
  ]);
  const step = () => prepareStoredRoomHeating(db, owner, context, undefined, null, clock);
  await step(); await step();
  const result = await step();
  assert(result.kind === "shared");
  assertEquals(result.work.metadata.sourceFreshness?.room.inferred, 36);
  assert(result.work.rows.slice(159, 195).every(r => r.room_c === null));
  const training = roomResponseEvidence(result.work.rows, result.work.metadata.trainingView).trainingRows;
  assertEquals(training.length, 160);
  assertEquals(training[159].room_c, 20, "the short pre-cut flat spell still has its observed value in training");
  assertEquals(rows, original);
});

Deno.test("a failed read or concurrent correction cannot replace the canonical source block", async () => {
  const rows = history(start), db = evidenceStore(rows, ranges);
  const step = () => prepareStoredRoomHeating(db, owner, context, undefined, null, clock);
  db.fail("get_energy_room_thermal_interval_capture");
  await assertRejects(step, Error, "synthetic read failed");
  assertEquals(db.blocks.size, 0);
  db.fail(null);
  const rpc = db.rpc.bind(db);
  db.rpc = (name, args) => {
    if (name === "get_energy_room_operation_facts") db.correct(ranges[0]);
    return rpc(name, args);
  };
  assertEquals(await step(), { kind: "superseded" });
  assertEquals(db.blocks.size, 0);
  db.rpc = rpc;
  assertEquals((await step()).kind, "refreshed");
  assertEquals(db.blocks.size, 1);
});

Deno.test("an unidentifiable chronological capture retains its accepted reference", async () => {
  const db = evidenceStore([], ranges);
  const prior = { sourceRevision: 0, fromAt: at(0), toAt: at(12), implementation: "chronological_native_evidence_v1" };
  const accepted = { model_revision: 1, trained: true, heating_bands: { binding: context.binding, since: at(0),
    reference_revision: "accepted", reference: { scope: { kind: "shared" }, model: acceptedModel, learning_evidence: { source_evidence: prior } },
    active: [], candidates: [], attempted: {} } };
  const step = () => prepareStoredRoomHeating(db, owner, context, accepted, null, clock);
  await step(); await step();
  const result = await step();
  assert(result.kind === "shared");
  const { rows, metadata } = result.work;
  const fit = learnRoomResponse(roomResponseEvidence(rows, metadata.trainingView), 500);
  assert(!fit.result.ok);
  const { model, ledger } = finalizeStoredRoomResponse(metadata, rows, fit);
  assertEquals(ledger, null);
  assertEquals(model.trained, undefined);
  const library = model.heating_bands as RoomHeatingBands;
  assertEquals(library.reference_revision, "accepted");
  assertEquals(library.reference?.learning_evidence, { source_evidence: prior });
  assertEquals(library.shared_attempt?.evidence, metadata.evidence);
});


Deno.test("irradiance repair precedes capture and the replacement block uses its new source revision", async () => {
  const rows = history(start), db = evidenceStore(rows, ranges);
  const calls: string[] = [], gap = ranges[0];
  const points = rows.map((row, i) => ({ t: Date.parse(row.start_ts) + hour, v: Math.max(0, 200 * Math.sin(i * Math.PI / 12)) }));
  let repaired = false;
  const adapter = {
    from(name: string) {
      assertEquals(name, "energy_outdoor_forecast_cache");
      const query = { eq: () => query, maybeSingle: () => Promise.resolve({
        data: { points, expires_at: new Date(clock.wallNow + hour).toISOString() }, error: null,
      }) };
      return { select: () => query };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name === "get_energy_room_missing_irradiance_window") return { data: repaired ? null : gap, error: null };
      if (name === "repair_energy_heating_irradiance") {
        assertEquals(args.p_binding, context.binding);
        rows.slice(0, 120).forEach((row, i) => { row.solar_w_per_m2 = points[i].v; });
        repaired = true; db.correct(gap);
        return { data: 120, error: null };
      }
      return db.rpc(name, args);
    },
  };
  const step = await prepareStoredRoomHeating(adapter, owner, context, undefined, { latitude: 0, longitude: 0 }, clock);
  assertEquals(step.kind, "refreshed");
  assert(repaired);
  assert(calls.indexOf("repair_energy_heating_irradiance") < calls.indexOf("get_energy_room_thermal_interval_capture"));
  assertEquals(db.reads.find(r => r.name === "save_energy_room_evidence_block")?.args.p_source_revision, 2);
});
