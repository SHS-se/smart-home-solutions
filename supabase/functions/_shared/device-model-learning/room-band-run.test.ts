import { assert, assertEquals } from "@std/assert";
import { handleDeviceLearning } from "../device-learning-worker.ts";
import { syntheticRoomPlant } from "../device-learning/room/native-mean.fixture.ts";
import { ROOM_BAND_FIT_CELL_COUNT } from "../device-learning/room/mean-observations.ts";
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

function fixture() {
  const source = syntheticRoomPlant([3600], 240).rows;
  const rows = source.map(row => ({ room_key: "room", room_name: "Synthetic room", active_power_w: 500,
    start_ts: new Date(row.start_ms).toISOString(), duration_s: row.duration_s,
    room_temperature_c: row.room_c, outdoor_temperature_c: row.outdoor_c, house_temperature_c: row.house_c,
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
  let failRpc: string | null = null;
  const reads: string[] = [], writes: Record<string, unknown>[] = [], failures: Record<string, unknown>[] = [];
  let resets = 0;
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      reads.push(name);
      if (name === failRpc) return { data: null, error: { message: "Synthetic interrupted request" } };
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
          assertEquals(args.p_fence, fence);
          assertEquals(args.p_revision, model?.model_revision ?? 0);
          assertEquals(args.p_expected_cursor, progress?.cursor ?? -1);
          if (!progress) {
            capture = String(args.p_capture_base64);
            progress = { metadata: jsonb(args.p_metadata), cells: [], cursor: 0, base_revision: Number(args.p_revision) };
          } else {
            assertEquals(args.p_capture_base64, null); // No re-upload of history for every cell.
            progress.cells.push(jsonb(args.p_cell)); progress.cursor++;
            const metadata = progress.metadata as Record<string, unknown>; delete metadata.heat_state;
          }
          data = true; break;
        }
        case "checkpoint_energy_room_heat_iteration": {
          assert(progress);
          assertEquals(args.p_expected_cursor, progress.cursor);
          const metadata = progress.metadata as Record<string, unknown>;
          assertEquals(args.p_expected_state, metadata.heat_state ?? null);
          metadata.heat_state = jsonb(args.p_heat_state); data = true; break;
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
  return { db, tick, finishCell, rows, window, windows, context, now, reads, writes, failures,
    get model() { return model; }, get progress() { return progress; }, get resets() { return resets; },
    fail: (name: string | null) => { failRpc = name; },
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

Deno.test("the claimed private visit journal keeps a superseded window behind an unvisited candidate", async () => {
  const f = fixture();
  await f.tick(); // Persist the separate general attempt.
  await f.tick(); // Capture the first candidate.
  f.replaceModel();
  assertEquals(await (await f.tick()).json(), { superseded: true });
  f.windows.push({ ...f.window, window_key: "5", band_c: 5, fingerprint: "synthetic-other-window" });
  f.setVisits({ binding: f.context.binding, implementation: ROOM_WINDOW_IMPLEMENTATION,
    windows: { [f.window.window_key]: new Date(f.now).toISOString() } });
  assertEquals(await (await f.tick()).json(), { checkpointed: true });
  const envelope = f.progress?.metadata as { capture: unknown };
  assertEquals(parseRoomBandMetadata(envelope.capture)?.window.window_key, "5");
  assertEquals(f.writes.length, 1, "visit scheduling never publishes an unfinished fit");
});

Deno.test("the real room worker checkpoints eighteen cells without publishing partial bands and matches a direct fit", async () => {
  const f = fixture();
  assertEquals((await f.tick()).status, 200); // Separate general fit.
  assertEquals(f.writes.length, 1);
  const expected = await fitStoredRoomHeating(f.db, "home", "customer", "room", f.context, f.model, null, { historyTo: f.now, wallNow: f.now });
  f.reads.length = 0;
  assertEquals(await (await f.tick()).json(), { checkpointed: true }); // Immutable capture only.
  const firstReads = f.reads.filter(name => name === "get_energy_room_thermal_interval_capture").length;
  assert(firstReads > 0);
  for (let i = 0; i < ROOM_BAND_FIT_CELL_COUNT; i++) {
    assertEquals(await (await f.finishCell()).json(), { checkpointed: true });
    assertEquals(f.progress?.cursor, i + 1);
    assertEquals(f.writes.length, 1);
  }
  assertEquals(f.reads.filter(name => name === "get_energy_room_thermal_interval_capture").length, firstReads);
  assertEquals(await (await f.tick()).json(), { published: true });
  assertEquals(f.progress, null);
  assertEquals(f.writes.length, 2);
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "revision" ? "generated" : item));
  assertEquals(normalize(f.writes[1]), normalize(expected));
  assertEquals(f.reads.filter(name => name === "load_energy_room_fit_capture").length,
    f.reads.filter(name => name === "checkpoint_energy_room_heat_iteration").length + ROOM_BAND_FIT_CELL_COUNT);
  assertEquals(f.reads.filter(name => name === "get_energy_room_thermal_interval_capture").length, 2 * firstReads);
});

Deno.test("interrupted cells resume, and a material source correction discards only the incomplete fit", async () => {
  const f = fixture();
  await f.tick(); await f.tick(); await f.tick();
  const accepted = structuredClone(f.model);
  f.fail("load_energy_room_fit_capture");
  assertEquals((await f.tick()).status, 500);
  assert(f.progress !== null);
  assert(f.progress.cursor <= 1);
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
  await f.tick(); await f.tick();
  while (f.progress && f.progress.cursor < ROOM_BAND_FIT_CELL_COUNT) await f.finishCell();
  f.rows[80].heat_w = null;
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.writes.length, 1);
  assertEquals(f.progress, null);
});

Deno.test("a superseding model revision restarts scratch without rewriting accepted models", async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  f.replaceModel();
  const accepted = structuredClone(f.model);
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.progress, null);
  assertEquals(f.model, accepted);
  assertEquals((f.model?.heating_bands as RoomHeatingBands).active, []);
});

Deno.test("malformed private capture is discarded while an empty observation capture completes normally", async () => {
  const f = fixture();
  await f.tick(); await f.tick();
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
  await f.tick(); await f.tick();
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
  assertEquals(await (await f.tick()).json(), { published: true });
  assertEquals(f.writes.length, 1);
  assertEquals(f.reads.includes("fail_energy_device_learning"), false);
});
