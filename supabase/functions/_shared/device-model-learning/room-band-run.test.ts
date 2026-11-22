import { assert, assertEquals } from "@std/assert";
import { handleDeviceLearning } from "../device-learning-worker.ts";
import { syntheticRoomPlant } from "../device-learning/room/native-mean.fixture.ts";
import { ROOM_RESPONSE_CELL_COUNT as ROOM_BAND_FIT_CELL_COUNT } from "../device-learning/room/response-learning.ts";
import { fitStoredRoomHeating, parseRoomBandMetadata, ROOM_WINDOW_IMPLEMENTATION } from "./room.ts";
import type { StoredDeviceModel } from "../device-model-store.ts";
import type { RoomHeatingBands } from "../planner/heating-bands.ts";

/** Mimic JSONB key ordering as well as a JSON transport roundtrip. */
function jsonb<T>(value: T): T {
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, normalize(value)])) : input;
  return JSON.parse(JSON.stringify(normalize(value)));
}

function fixture(options: { unidentified?: boolean } = {}) {
  const source = syntheticRoomPlant([3600], 240).rows;
  const rows = source.map((row, i) => ({ room_key: "room", room_name: "Synthetic room", active_power_w: 500,
    start_ts: new Date(row.start_ms).toISOString(), duration_s: row.duration_s,
    // An unidentified synthetic room still has metered on/off events, but its
    // temperature is generated independently of the heater.
    room_temperature_c: options.unidentified ? 20 + .3 * Math.sin(i / 7) : row.room_c,
    outdoor_temperature_c: row.outdoor_c, house_temperature_c: row.house_c,
    solar_w_per_m2: row.solar_w_per_m2, heat_w: row.heat_w, cooling: row.cooling, probe_values: null }));
  const now = source.at(-1)!.start_ms + 3_600_000;
  let wallNow = now;
  let historyTo: string | null = new Date(now).toISOString();
  const context = { binding: "synthetic-binding", observed_since: rows[0].start_ts };
  const window = { window_key: "-10", band_c: -10, from_at: rows[0].start_ts,
    to_at: new Date(now).toISOString(), fingerprint: "synthetic-window", evidence_updated_at: new Date(now).toISOString() };
  const windows = [window];
  let visits: unknown = null;
  let model: StoredDeviceModel | undefined;
  let progress: { metadata: unknown; cells: unknown[]; cursor: number; base_revision: number } | null = null;
  let capture: string | null = null, fence = 0;
  let failRpc: string | null = null, loseReply: string | null = null, supersede: string | null = null;
  const reads: string[] = [], writes: Record<string, unknown>[] = [], failures: Record<string, unknown>[] = [];
  const batches: number[] = [];
  let resets = 0;
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      reads.push(name);
      if (name === failRpc) return { data: null, error: { message: "Synthetic interrupted request" } };
      if (name === supersede) { supersede = null; return { data: false, error: null }; }
      let data: unknown = null;
      switch (name) {
        case "verify_energy_learning_token": data = true; break;
        case "claim_energy_device_learning": data = { id: "job", home_id: "home", customer_id: "customer", owner_kind: "room",
          owner_key: "room", generation: 1, fence: ++fence, input: {}, room_fit_progress: jsonb(progress),
          room_history_to: historyTo,
          room_window_visits: jsonb(visits) }; break;
        case "capture_energy_device_models": data = { rooms: model ? [jsonb(model)] : [], devices: [], pool: null,
          room_heating: { room: context } }; break;
        case "get_energy_room_heating_context": data = context; break;
        case "get_energy_room_heating_fit_windows": data = windows; break;
        case "get_energy_room_thermal_interval_capture": data = { sources: [], rows: rows.filter(row =>
          row.start_ts >= String(args.p_from) && row.start_ts < String(args.p_to)) }; break;
        case "get_energy_room_operation_facts": data = []; break;
        case "get_energy_room_passive_heat": case "get_energy_doorway_probes": data = []; break;
        case "checkpoint_energy_room_fit": {
          // Only the immutable capture uses the single-step API now.
          assertEquals(args.p_fence, fence);
          assertEquals(args.p_revision, model?.model_revision ?? 0);
          assertEquals(progress, null);
          assertEquals(args.p_expected_cursor, -1);
          capture = String(args.p_capture_base64);
          progress = { metadata: jsonb(args.p_metadata), cells: [], cursor: 0, base_revision: Number(args.p_revision) };
          data = true; break;
        }
        case "checkpoint_energy_room_fit_cells": {
          // Mirrors the SQL compare-and-append: one fence, one prefix, one state.
          assert(progress);
          assertEquals(args.p_fence, fence);
          assertEquals(args.p_revision, model?.model_revision ?? 0);
          assertEquals(args.p_expected_cursor, progress.cursor);
          const metadata = progress.metadata as Record<string, unknown>;
          assertEquals(jsonb(args.p_expected_state), metadata.heat_state ?? null);
          const cells = args.p_cells as unknown[];
          assert(Array.isArray(cells) && progress.cursor + cells.length <= ROOM_BAND_FIT_CELL_COUNT);
          assert(cells.length > 0 || args.p_heat_state !== null, "a commit records progress");
          for (const cell of cells) progress.cells.push(jsonb(cell));
          progress.cursor += cells.length;
          if (args.p_heat_state === null) delete metadata.heat_state;
          else {
            assert(progress.cursor < ROOM_BAND_FIT_CELL_COUNT);
            assertEquals((args.p_heat_state as { index: number }).index, progress.cursor % 18);
            metadata.heat_state = jsonb(args.p_heat_state);
          }
          batches.push(cells.length);
          if (loseReply === name) { loseReply = null; return { data: null, error: { message: "Synthetic lost reply" } }; }
          data = true; break;
        }
        case "load_energy_room_fit_capture": data = capture; break;
        case "reset_energy_room_fit": resets++; progress = null; capture = null; data = true; break;
        case "complete_energy_room_fit":
          assertEquals(progress?.cursor, ROOM_BAND_FIT_CELL_COUNT);
          assertEquals(args.p_expected_cursor, ROOM_BAND_FIT_CELL_COUNT);
          // Fall through to the same accepted-model publication boundary.
        case "publish_energy_device_learning": {
          assertEquals(args.p_fence, fence);
          assertEquals(args.p_revision, model?.model_revision ?? 0);
          const patch = args.p_model as Record<string, unknown>;
          writes.push(jsonb(patch));
          model = jsonb({ ...model, ...patch, model_revision: (model?.model_revision ?? 0) + 1 });
          progress = null; capture = null; data = true; break;
        }
        case "fail_energy_device_learning": failures.push(args); break;
        case "release_energy_room_learning_lane":
          assertEquals(args, { p_job_id: "job", p_generation: 1, p_fence: fence });
          data = true; break;
        default: throw new Error(`Unexpected synthetic RPC ${name}`);
      }
      return { data, error: null };
    },
  };
  const tick = async () => {
    const response = await handleDeviceLearning(new Request("https://synthetic.test/learning", { method: "POST",
      headers: { "x-energy-learning-token": "synthetic" }, body: JSON.stringify({ job_id: "job" }) }), db, () => wallNow);
    assertEquals(reads.at(-1), "release_energy_room_learning_lane", "every handled checkpoint, reset, failure and publication relinquishes admission");
    return response;
  };
  const finishCell = async () => {
    const cursor = progress?.cursor;
    for (let iteration = 0; iteration < 1000; iteration++) {
      const response = await tick(); assertEquals(response.status, 200);
      if (progress?.cursor !== cursor) return response;
    }
    throw new Error("Synthetic room cell did not finish bounded iterations");
  };
  const bootstrap = async () => {
    for (let step = 0; step < 10000; step++) {
      const response = await tick();
      assertEquals(response.status, 200);
      if (writes.length) return response;
    }
    throw new Error("Synthetic general calibration did not finish");
  };
  return { db, tick, bootstrap, finishCell, rows, window, windows, context, now, reads, writes, failures, batches,
    get model() { return model; }, get progress() { return progress; }, get resets() { return resets; },
    fail: (name: string | null) => { failRpc = name; },
    loseReply: (name: string) => { loseReply = name; },
    supersede: (name: string) => { supersede = name; },
    corruptCapture: () => { capture = "corrupt"; },
    replaceModel: () => { assert(model); model.model_revision++; },
    setVisits: (value: unknown) => { visits = value; },
    setWallNow: (value: number) => { wallNow = value; },
    setHistoryTo: (value: string | null) => { historyTo = value; },
  };
}

Deno.test("a missing room horizon is a retriable owner failure preserving accepted models and staged work", async () => {
  for (const staged of [false, true]) {
    const f = fixture();
    assertEquals((await f.tick()).status, 200);
    if (staged) assertEquals((await f.tick()).status, 200);
    const model = structuredClone(f.model), progress = structuredClone(f.progress);
    f.setHistoryTo(null);
    assertEquals((await f.tick()).status, 500);
    assertEquals(f.failures.at(-1)?.p_error, "Room learning claim has no history horizon");
    assertEquals(f.model, model);
    assertEquals(f.progress, progress);
    assertEquals(f.reads.at(-1), "release_energy_room_learning_lane");
  }
});

Deno.test("a room traversal drains despite continuous newer observations and advancing wall time", async () => {
  const f = fixture(), rpc = f.db.rpc.bind(f.db), hour = 3_600_000;
  const historyReads: number[] = [];
  f.db.rpc = (name, args) => {
    if (name === "get_energy_room_heating_fit_windows") {
      const to = Date.parse(String(args.p_to)); historyReads.push(to);
      assert(to <= f.now, "the generation ceiling cannot follow the worker clock");
      const eligible = f.rows.filter(row => Date.parse(row.start_ts) >= Date.parse(String(args.p_from)) &&
        Date.parse(row.start_ts) + Number(row.duration_s) * 1000 <= to);
      return Promise.resolve({ data: eligible.length ? [{ ...f.window,
        to_at: new Date(Date.parse(eligible.at(-1)!.start_ts) + hour).toISOString(),
        fingerprint: `synthetic-count:${eligible.length}`,
      }] : [], error: null });
    }
    return rpc(name, args);
  };
  let completed = false;
  for (let step = 0; step < 1000; step++) {
    f.setWallNow(f.now + (step + 2) * hour);
    f.rows.push({ ...f.rows[0], start_ts: new Date(f.now + (step + 1) * hour).toISOString() });
    assertEquals((await f.tick()).status, 200);
    const library = f.model?.heating_bands as RoomHeatingBands | undefined;
    if (library?.active.length && library.pending_windows === 0) { completed = true; break; }
  }
  assert(completed, "future uploads must not keep the generation immediately runnable");
  assert(historyReads.length > 4);
  assertEquals(f.resets, 0);
  assert(f.rows.length > 240, "newer measured observations remain stored for a later generation");
});

Deno.test("pre-fix over-horizon scratch resets without changing accepted models or valid checkpoints", async () => {
  for (const overrun of [false, true]) {
    const f = fixture();
    // Simulate a legacy reader which used to expand discovery past the frozen
    // generation. An in-horizon capture is the unchanged control case.
    await f.bootstrap();
    if (overrun) f.window.to_at = new Date(f.now + 900_000).toISOString();
    await f.tick();
    assert(f.progress);
    const accepted = structuredClone(f.model), publications = f.writes.length;
    f.window.to_at = new Date(f.now).toISOString(); // The corrected SQL reader.
    assertEquals(await (await f.tick()).json(), overrun ? { superseded: true } : { checkpointed: true });
    assertEquals(f.model, accepted);
    assertEquals(f.writes.length, publications);
    assertEquals(f.resets, Number(overrun));
    if (overrun) {
      assertEquals(f.progress, null);
      assertEquals(await (await f.tick()).json(), { checkpointed: true });
      const envelope = f.progress?.metadata as { capture: unknown };
      assertEquals(parseRoomBandMetadata(envelope.capture)?.window.to_at, new Date(f.now).toISOString());
      assertEquals(f.resets, 1, "only the incompatible scratch is discarded");
    } else assert(f.progress, "a valid capture continues without recapture");
  }
});

Deno.test("the claimed private visit journal keeps a superseded window behind an unvisited candidate", async () => {
  const f = fixture();
  await f.bootstrap(); // Complete the same resumable general-response pipeline.
  await f.tick(); // Capture the first candidate.
  f.replaceModel();
  assertEquals(await (await f.tick()).json(), { superseded: true });
  f.windows.push({ ...f.window, window_key: "5", band_c: 5, fingerprint: "synthetic-other-window" });
  // This scheduling-only candidate must actually contain in-band ON events.
  for (const row of f.rows) row.outdoor_temperature_c = 7;
  f.setVisits({ binding: f.context.binding, implementation: ROOM_WINDOW_IMPLEMENTATION,
    windows: { [f.window.window_key]: new Date(f.now).toISOString() } });
  assertEquals(await (await f.tick()).json(), { checkpointed: true });
  const envelope = f.progress?.metadata as { capture: unknown };
  assertEquals(parseRoomBandMetadata(envelope.capture)?.window.window_key, "5");
  assertEquals(f.writes.length, 1, "visit scheduling never publishes an unfinished fit");
});

Deno.test("the real room worker checkpoints screening and final-fit cells without publishing partial bands and matches a direct fit", async () => {
  const f = fixture();
  assertEquals((await f.bootstrap()).status, 200); // Separate durable general fit.
  assertEquals(f.writes.length, 1);
  const expected = await fitStoredRoomHeating(f.db, "home", "customer", "room", f.context, f.model, null, { historyTo: f.now, wallNow: f.now });
  f.reads.length = 0;
  assertEquals(await (await f.tick()).json(), { checkpointed: true }); // Immutable capture only.
  const envelope = f.progress!.metadata as { row_count: number; observed_runs: number };
  assert(envelope.row_count < f.rows.length,"checkpoints must not reload the full raw history for every numerical step");
  assert(envelope.observed_runs > 10,"compaction preserves the discovered event count");
  assertEquals(f.rows.length,240,"working capture never prunes measured observations");
  const firstReads = f.reads.filter(name => name === "get_energy_room_thermal_interval_capture").length;
  assert(firstReads > 0);
  f.batches.length = 0;
  while ((f.progress?.cursor ?? 0) < ROOM_BAND_FIT_CELL_COUNT) {
    const cursor = f.progress!.cursor;
    assertEquals(await (await f.finishCell()).json(), { checkpointed: true });
    assert(f.progress!.cursor > cursor, "every commit carries at least one complete cell or partial state");
    assertEquals(f.writes.length, 1, "no partial band is ever published");
  }
  assertEquals(f.progress?.cursor, ROOM_BAND_FIT_CELL_COUNT);
  assertEquals(f.reads.filter(name => name === "get_energy_room_thermal_interval_capture").length, firstReads);
  assertEquals(await (await f.tick()).json(), { published: true });
  assertEquals(f.progress, null);
  assertEquals(f.writes.length, 2);
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "revision" ? "generated" : item));
  assertEquals(normalize(f.writes[1]), normalize(expected));
  // One capture load per fenced numerical commit, never one per cell.
  assertEquals(f.reads.filter(name => name === "load_energy_room_fit_capture").length,
    f.reads.filter(name => name === "checkpoint_energy_room_fit_cells").length);
  assertEquals(f.batches.reduce((sum, count) => sum + count, 0), ROOM_BAND_FIT_CELL_COUNT);
  assert(f.batches.length <= ROOM_BAND_FIT_CELL_COUNT);
  assertEquals(f.reads.filter(name => name === "get_energy_room_thermal_interval_capture").length, 2 * firstReads);
});

/** Run one band to publication, counting requests while it holds staged cells. */
async function publishBand(f: ReturnType<typeof fixture>) {
  let requests = 0;
  for (let step = 0; step < 1000; step++) {
    const staged = f.progress !== null;
    const response = await f.tick();
    if (staged && response.status === 200) requests++;
    if (response.status === 200 && (await response.json()).published) return requests;
  }
  throw new Error("Synthetic band did not publish");
}

Deno.test("an unidentified band drains its cells in a few fenced requests instead of one per cell", async () => {
  const f = fixture({ unidentified: true });
  await f.bootstrap();
  const expected = await fitStoredRoomHeating(f.db, "home", "customer", "room", f.context, f.model, null, { historyTo: f.now, wallNow: f.now });
  assertEquals(await (await f.tick()).json(), { checkpointed: true }); // Immutable capture.
  const accepted = f.writes.length;
  f.batches.length = 0; f.reads.length = 0;
  const requests = await publishBand(f);
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "revision" ? "generated" : item));
  assertEquals(normalize(f.writes.at(-1)), normalize(expected), "batching does not change what is fitted");
  assertEquals(f.writes.length, accepted + 1);
  const band = (f.model?.heating_bands as RoomHeatingBands);
  assertEquals(band.active, [], "the synthetic heater does not explain this room");
  // Previously 36 cell requests plus finalization; cheap cells now share commits.
  assert(f.batches.length <= 6, `unidentified band used ${f.batches.length} numerical commits`);
  assertEquals(requests, f.batches.length + 1);
  assertEquals(f.reads.filter(name => name === "claim_energy_device_learning").length, requests);
  assertEquals(f.reads.filter(name => name === "capture_energy_device_models").length, requests);
  assertEquals(f.reads.includes("checkpoint_energy_room_heat_iteration"), false);
});

Deno.test("an interrupted or lost batch commit resumes from the authoritative prefix with an unchanged fit", async () => {
  const reference = fixture();
  await reference.bootstrap(); await reference.tick();
  await publishBand(reference);
  for (const mode of ["interrupted", "lost", "superseded"] as const) {
    const f = fixture();
    await f.bootstrap(); await f.tick(); // Accepted general response, then the band capture.
    assertEquals(await (await f.tick()).json(), { checkpointed: true }); // One successful batch first.
    assert(f.progress && f.progress.cursor < ROOM_BAND_FIT_CELL_COUNT, "the failure happens inside the prefix");
    const accepted = structuredClone(f.model);
    const before = structuredClone(f.progress);
    if (mode === "interrupted") f.fail("checkpoint_energy_room_fit_cells");
    else if (mode === "lost") f.loseReply("checkpoint_energy_room_fit_cells");
    else f.supersede("checkpoint_energy_room_fit_cells");
    const response = await f.tick();
    f.fail(null);
    if (mode === "superseded") {
      assertEquals(await response.json(), { checkpointed: false, superseded: true }, "a stale fence or generation commits nothing");
      assertEquals(f.progress, before);
    } else {
      assertEquals(response.status, 500);
      assertEquals(f.failures.length, 1, "a transient commit failure is an ordinary retriable owner failure");
      if (mode === "interrupted") assertEquals(f.progress, before, "an uncommitted batch leaves the prefix untouched");
      else assert(f.progress!.cursor > before!.cursor || f.progress!.metadata !== before!.metadata,
        "a lost reply keeps the committed batch");
    }
    assertEquals(f.model, accepted, "no failure mode changes accepted models");
    await publishBand(f);
    assertEquals(f.resets, 0, "no failure mode discards valid staged cells");
    // Revision identifiers are generated per fixture; every fitted value must match.
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) =>
      key === "revision" || key === "reference_revision" ? "generated" : item));
    assertEquals(normalize(f.writes.at(-1)), normalize(reference.writes.at(-1)), `${mode} commit changes the fit`);
  }
});

Deno.test("interrupted cells resume, and a material source correction discards only the incomplete fit", async () => {
  const f = fixture();
  await f.bootstrap(); await f.bootstrap(); await f.tick();
  assert(f.progress !== null && f.progress.cursor < ROOM_BAND_FIT_CELL_COUNT, "the interruption happens inside the prefix");
  const accepted = structuredClone(f.model), staged = structuredClone(f.progress);
  f.fail("load_energy_room_fit_capture");
  assertEquals((await f.tick()).status, 500);
  assertEquals(f.progress, staged, "an interrupted request keeps the authoritative prefix and partial state");
  assertEquals(f.model, accepted);
  f.fail(null);
  while (f.progress && f.progress.cursor < ROOM_BAND_FIT_CELL_COUNT) await f.finishCell();
  f.window.fingerprint = "corrected-source";
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.resets, 1);
  assertEquals(f.model, accepted);
  assertEquals(f.progress, null);
});

Deno.test("changed effective readings without a native fingerprint change cannot mix fitting cells", async () => {
  const f = fixture();
  await f.bootstrap(); await f.tick();
  while (f.progress && f.progress.cursor < ROOM_BAND_FIT_CELL_COUNT) await f.finishCell();
  f.rows[80].heat_w = null;
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.writes.length, 1);
  assertEquals(f.progress, null);
});

Deno.test("a superseding model revision restarts scratch without rewriting accepted models", async () => {
  const f = fixture();
  await f.bootstrap(); await f.tick();
  f.replaceModel();
  const accepted = structuredClone(f.model);
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.progress, null);
  assertEquals(f.model, accepted);
  assertEquals((f.model?.heating_bands as RoomHeatingBands).active, []);
});

Deno.test("malformed private capture is discarded while an empty observation capture completes normally", async () => {
  const f = fixture();
  await f.bootstrap(); await f.tick();
  f.corruptCapture();
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.writes.length, 1);
  f.rows.splice(0);
  assertEquals(await (await f.tick()).json(), { published: true });
  assertEquals(f.progress, null);
  assertEquals(f.writes.length, 2);
  assertEquals((f.model?.heating_bands as RoomHeatingBands).active, []);
});

Deno.test("live running-power diagnostics cannot keep restarting a coherent thermal fit", async () => {
  const f = fixture();
  await f.bootstrap(); await f.tick();
  while (f.progress && f.progress.cursor < ROOM_BAND_FIT_CELL_COUNT) await f.finishCell();
  for (const row of f.rows) row.active_power_w = 510;
  assertEquals(await (await f.tick()).json(), { published: true });
  const band = (f.model?.heating_bands as RoomHeatingBands).active[0];
  assert(band);
  assert(band.model.response_family !== "equilibrium");
  assertEquals(band.model.heating_rate_c_per_h, band.model.gain_c_per_wh * 500);
  assertEquals(f.resets, 0);
});

Deno.test("lost admission release does not turn an accepted publication into a statistical failure", async () => {
  const f = fixture();
  f.fail("release_energy_room_learning_lane");
  assertEquals(await (await f.bootstrap()).json(), { published: true });
  assertEquals(f.writes.length, 1);
  assertEquals(f.reads.includes("fail_energy_device_learning"), false);
});
