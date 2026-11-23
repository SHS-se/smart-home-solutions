import { assert, assertEquals } from "@std/assert";
import { handleDeviceLearning } from "../device-learning-worker.ts";
import { syntheticRoomPlant } from "../device-learning/room/native-mean.fixture.ts";
import { ROOM_RESPONSE_CELL_COUNT as ROOM_BAND_FIT_CELL_COUNT } from "../device-learning/room/response-learning.ts";
import { fitStoredRoomHeating, parseRoomSharedMetadata } from "./room.ts";
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
  const pool = new Map<string, Record<string, unknown>>();
  let harvests = 0;
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
        case "save_energy_room_run_harvest": {
          // Offline composition has no job; the worker writes under its fence.
          if (args.p_fence !== undefined) assertEquals(args.p_fence, fence);
          if ((args.p_run_ids as string[]).length) pool.set(String(args.p_window_key), {
            window_key: args.p_window_key, sha256: args.p_sha256, band_c: args.p_band_c, from_at: args.p_from_at,
            harvested_at: new Date(now + ++harvests * 1000).toISOString(), capture: args.p_capture_base64,
            row_count: args.p_row_count, observed_runs: args.p_observed_runs, rated_power_w: args.p_rated_power_w,
            source_freshness: args.p_source_freshness });
          else pool.delete(String(args.p_window_key));
          data = true; break;
        }
        case "load_energy_room_run_pool": data = jsonb([...pool.values()]); break;
        case "load_energy_room_fit_capture": data = capture; break;
        case "reset_energy_room_fit": resets++; progress = null; capture = null; data = true; break;
        case "complete_energy_room_fit": {
          assertEquals(progress?.cursor, ROOM_BAND_FIT_CELL_COUNT);
          assertEquals(args.p_expected_cursor, ROOM_BAND_FIT_CELL_COUNT);
          // Mirrors the SQL owner: the captured pool must be exactly the stored one.
          const captured = ((progress!.metadata as { capture: { pool: { window_key: string; sha256: string }[] } }).capture.pool);
          const current = [...pool.values()].map(entry => `${entry.window_key}:${entry.sha256}`).sort();
          if (JSON.stringify(captured.map(ref => `${ref.window_key}:${ref.sha256}`).sort()) !== JSON.stringify(current)) {
            progress = null; capture = null; data = false; break;
          }
        }
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
  return { db, tick, bootstrap, finishCell, rows, window, windows, context, now, reads, writes, failures, batches, pool,
    get model() { return model; }, get progress() { return progress; }, get resets() { return resets; },
    fail: (name: string | null) => { failRpc = name; },
    loseReply: (name: string) => { loseReply = name; },
    supersede: (name: string) => { supersede = name; },
    corruptCapture: () => { capture = "corrupt"; },
    replaceModel: () => { assert(model); model.model_revision++; },
    setVisits: (value: unknown) => { visits = value; },
    setWallNow: (value: number) => { wallNow = value; },
    setHistoryTo: (value: string | null) => { historyTo = value; },
    setProgress: (value: typeof progress) => { progress = value; },
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

/** Tick until the shared response (or its failed attempt) is published. */
async function publishShared(f: ReturnType<typeof fixture>) {
  let requests = 0;
  for (let step = 0; step < 1000; step++) {
    const staged = f.progress !== null;
    const response = await f.tick();
    if (staged && response.status === 200) requests++;
    const body = response.status === 200 ? await response.json() : null;
    if (body?.published && (f.model?.heating_bands as RoomHeatingBands | undefined)?.shared_attempt) return requests;
  }
  throw new Error("Synthetic shared response did not publish");
}
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) =>
  key === "revision" || key === "reference_revision" ? "generated" : item));

Deno.test("the worker harvests, checkpoints the shared fit without partial publication, and matches the offline composition", async () => {
  const f = fixture();
  assertEquals(await (await f.tick()).json(), { published: true }); // Harvest: pool entry plus bookkeeping.
  assertEquals([...f.pool.keys()], [f.window.window_key]);
  assertEquals((f.writes[0].heating_bands as RoomHeatingBands).reference, undefined, "a harvest publishes no response");
  assertEquals(await (await f.tick()).json(), { checkpointed: true }); // Immutable capture of the merged pool.
  const envelope = f.progress!.metadata as { capture: unknown };
  assertEquals(parseRoomSharedMetadata(envelope.capture)?.window.window_key, "shared");
  while (f.progress && f.progress.cursor < ROOM_BAND_FIT_CELL_COUNT) {
    await f.finishCell();
    assertEquals(f.writes.length, 1, "no partial response is ever published");
  }
  assertEquals(await (await f.tick()).json(), { published: true });
  assertEquals(f.writes.length, 2);
  const library = f.model?.heating_bands as RoomHeatingBands;
  assertEquals(library.reference?.scope, { kind: "shared" });
  assertEquals(library.active, []);
  assertEquals(library.pending_windows, 0);
  // The same seams composed offline give the same response.
  const g = fixture(), clock = { historyTo: g.now, wallNow: g.now };
  let offline = await fitStoredRoomHeating(g.db, "home", "customer", "room", g.context, undefined, null, clock);
  offline = { ...offline, ...await fitStoredRoomHeating(g.db, "home", "customer", "room", g.context,
    { ...offline, model_revision: 1 } as StoredDeviceModel, null, clock) };
  assertEquals(offline.gain_c_per_wh, f.writes[1].gain_c_per_wh);
  assertEquals(normalize((offline.heating_bands as RoomHeatingBands).reference),
    normalize(library.reference), "batching and checkpoints do not change what is fitted");
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
    if (library?.shared_attempt && library.pending_windows === 0) { completed = true; break; }
  }
  assert(completed, "future uploads must not keep the generation immediately runnable");
  assert(historyReads.length > 2);
  assertEquals(f.resets, 0);
  assert(f.rows.length > 240, "newer measured observations remain stored for a later generation");
});

Deno.test("an interrupted or lost batch commit resumes from the authoritative prefix with an unchanged fit", async () => {
  const reference = fixture();
  await publishShared(reference);
  for (const mode of ["interrupted", "lost", "superseded"] as const) {
    const f = fixture();
    await f.tick(); await f.tick(); // Harvest, then the shared capture.
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
    await publishShared(f);
    assertEquals(f.resets, 0, "no failure mode discards valid staged cells");
    assertEquals(normalize((f.model?.heating_bands as RoomHeatingBands).reference),
      normalize((reference.model?.heating_bands as RoomHeatingBands).reference), `${mode} commit changes the fit`);
  }
});

Deno.test("a harvest after the capture supersedes the completed fit instead of publishing a stale pool", async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  while (f.progress && f.progress.cursor < ROOM_BAND_FIT_CELL_COUNT) await f.finishCell();
  const accepted = structuredClone(f.model);
  f.pool.set("other", { ...f.pool.get(f.window.window_key)!, window_key: "other", sha256: "concurrent-harvest" });
  assertEquals(await (await f.tick()).json(), { published: false, superseded: true });
  assertEquals(f.model, accepted);
  assertEquals(f.progress, null);
});

Deno.test("a harvest whose fence was lost writes nothing", async () => {
  const f = fixture();
  f.supersede("save_energy_room_run_harvest");
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.writes.length, 0);
  assertEquals(f.pool.size, 0);
});

Deno.test("a superseding model revision restarts scratch without rewriting accepted models", async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  f.replaceModel();
  const accepted = structuredClone(f.model);
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.progress, null);
  assertEquals(f.model, accepted);
});

Deno.test("malformed, obsolete or over-horizon private captures are discarded without touching accepted models", async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  f.corruptCapture();
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.writes.length, 1);
  // A band capture from the previous learner (envelope 2) restarts as a shared attempt.
  f.setProgress({ metadata: { version: 2, capture: { version: 1 } }, cells: [], cursor: 0, base_revision: f.model!.model_revision });
  assertEquals(await (await f.tick()).json(), { superseded: true });
  // A capture beyond the claim's history ceiling is not this generation's work.
  await f.tick();
  assert(f.progress);
  f.setHistoryTo(new Date(f.now - 3_600_000).toISOString());
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.writes.length, 1);
});

Deno.test("lost admission release does not turn an accepted publication into a statistical failure", async () => {
  const f = fixture();
  f.fail("release_energy_room_learning_lane");
  assertEquals(await (await f.tick()).json(), { published: true });
  assertEquals(f.writes.length, 1);
  assertEquals(f.reads.includes("fail_energy_device_learning"), false);
});
