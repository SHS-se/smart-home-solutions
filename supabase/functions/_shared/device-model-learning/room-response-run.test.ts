import { evidenceStore } from "./room-evidence.fixture.ts";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { handleDeviceLearning } from "../device-learning-worker.ts";
import { syntheticRoomPlant, syntheticRoomResponseEvidence } from "../device-learning/room/native-mean.fixture.ts";
import { learnRoomResponse, ROOM_RESPONSE_CELL_COUNT } from "../device-learning/room/response-learning.ts";
import { parseRoomSharedMetadata } from "./room.ts";
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
    room_temperature_c: row.room_c,
    outdoor_temperature_c: row.outdoor_c, house_temperature_c: row.house_c,
    solar_w_per_m2: row.solar_w_per_m2, heat_w: row.heat_w, cooling: row.cooling }));
  const now = source.at(-1)!.start_ms + 3_600_000;
  let wallNow = now;
  let historyTo: string | null = new Date(now).toISOString();
  const context = { binding: "synthetic-binding", observed_since: rows[0].start_ts };
  const range = { from_at: rows[0].start_ts, to_at: new Date(now).toISOString() };
  const archive = evidenceStore(rows, [range]);
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
          room_history_to: historyTo }; break;
        case "capture_energy_device_models": data = { rooms: model ? [jsonb(model)] : [], devices: [], pool: null,
          room_heating: { room: context } }; break;
        case "get_energy_room_heating_context": data = context; break;
        case "save_energy_room_evidence_block":
          assertEquals(args.p_fence, fence);
          assertEquals(args.p_revision, model?.model_revision ?? 0);
          return await archive.rpc(name, args);
        case "get_energy_room_evidence_work": case "load_energy_room_evidence_blocks":
        case "get_energy_room_thermal_interval_capture": case "get_energy_room_operation_facts":
          return await archive.rpc(name, args);
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
          assert(Array.isArray(cells) && progress.cursor + cells.length <= ROOM_RESPONSE_CELL_COUNT);
          assert(cells.length > 0 || args.p_heat_state !== null, "a commit records progress");
          for (const cell of cells) progress.cells.push(jsonb(cell));
          progress.cursor += cells.length;
          if (args.p_heat_state === null) delete metadata.heat_state;
          else {
            assert(progress.cursor < ROOM_RESPONSE_CELL_COUNT);
            assertEquals((args.p_heat_state as { index: number }).index, progress.cursor % 18);
            metadata.heat_state = jsonb(args.p_heat_state);
          }
          batches.push(cells.length);
          if (loseReply === name) { loseReply = null; return { data: null, error: { message: "Synthetic lost reply" } }; }
          data = true; break;
        }
        case "load_energy_room_fit_capture": data = capture; break;
        case "reset_energy_room_fit": resets++; progress = null; capture = null; data = true; break;
        case "complete_energy_room_fit": {
          assertEquals(progress?.cursor, ROOM_RESPONSE_CELL_COUNT);
          assertEquals(args.p_expected_cursor, ROOM_RESPONSE_CELL_COUNT);
          const metadata = (progress!.metadata as { capture: { evidence: { sourceRevision: number; fromAt: string; toAt: string } } }).capture;
          const basis = metadata.evidence;
          if (basis.sourceRevision !== archive.sourceRevision({ from_at: basis.fromAt, to_at: basis.toAt })) {
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
  return { db, tick, finishCell, rows, source, range, archive, context, now, reads, writes, failures, batches,
    get model() { return model; }, get progress() { return progress; }, get resets() { return resets; },
    fail: (name: string | null) => { failRpc = name; },
    loseReply: (name: string) => { loseReply = name; },
    supersede: (name: string) => { supersede = name; },
    corruptCapture: () => { capture = "corrupt"; },
    replaceModel: () => { model = { ...model, home_id: "home", customer_id: "customer", room_key: "room", model_revision: (model?.model_revision ?? 0) + 1 }; },
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
  for (let step = 0; step < 1000; step++) {
    const response = await f.tick();
    assertEquals(response.status, 200);
    const body = await response.json();
    if (body.published && (f.model?.heating_bands as RoomHeatingBands | undefined)?.shared_attempt) return;
  }
  throw new Error("Synthetic shared response did not publish");
}
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) =>
  key === "revision" || key === "reference_revision" ? "generated" : item));

Deno.test("the worker checkpoints one chronological capture and publishes the same response as the offline learner", async () => {
  const f = fixture();
  assertEquals(await (await f.tick()).json(), { checkpointed: true });
  assertEquals([...f.archive.blocks.keys()], [f.range.from_at]);
  assertEquals(f.model, undefined, "source acquisition must not publish or revise a room model");
  assertEquals(f.writes.length, 0);
  assertEquals(await (await f.tick()).json(), { checkpointed: true });
  const envelope = f.progress!.metadata as { version: number; capture: unknown };
  assertEquals(envelope.version, 4);
  assertEquals(parseRoomSharedMetadata(envelope.capture)?.evidence.sourceRevision, 1);
  while (f.progress && f.progress.cursor < ROOM_RESPONSE_CELL_COUNT) {
    await f.finishCell();
    assertEquals(f.writes.length, 0, "no partial response is published");
  }
  assertEquals(await (await f.tick()).json(), { published: true });
  assertEquals(f.writes.length, 1);
  const library = f.model?.heating_bands as RoomHeatingBands;
  assertEquals(library.reference?.scope, { kind: "shared" });
  assertEquals(library.active, []);
  assertEquals(library.pending_windows, 0);
  const offline = learnRoomResponse(syntheticRoomResponseEvidence(f.source), 500);
  assert(offline.result.ok);
  assertEquals(library.reference?.model, offline.result.model);
  assertEquals(library.reference?.learning_evidence, offline.result.learning_evidence);
});

Deno.test("a pinned chronological generation finishes despite later uploads and advancing wall time", async () => {
  const f = fixture(), hour = 3_600_000;
  let completed = false;
  for (let step = 0; step < 1000; step++) {
    const begin = f.now + (step + 1) * hour;
    const range = { from_at: new Date(begin).toISOString(), to_at: new Date(begin + hour).toISOString() };
    f.setWallNow(begin + hour);
    f.rows.push({ ...f.rows[0], start_ts: range.from_at });
    f.archive.correct(range);
    assertEquals((await f.tick()).status, 200);
    const library = f.model?.heating_bands as RoomHeatingBands | undefined;
    if (library?.shared_attempt && library.pending_windows === 0) { completed = true; break; }
  }
  assert(completed);
  assert(f.archive.reads.filter(call => call.name === "get_energy_room_evidence_work")
    .every(call => Date.parse(String(call.args.p_to_at)) === f.now));
  assertEquals(f.resets, 0);
  assertEquals(f.model?.sample_count, f.source.length - 1);
  assert(f.rows.length > f.source.length);
});

Deno.test("an interrupted or lost batch commit resumes from the authoritative prefix with an unchanged fit", async () => {
  const reference = fixture();
  await publishShared(reference);
  for (const mode of ["interrupted", "lost", "superseded"] as const) {
    const f = fixture();
    await f.tick(); await f.tick(); // Archive refresh, then the frozen capture.
    assertEquals(await (await f.tick()).json(), { checkpointed: true }); // One successful batch first.
    assert(f.progress && f.progress.cursor < ROOM_RESPONSE_CELL_COUNT, "the failure happens inside the prefix");
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
      else assertNotEquals(f.progress, before, "a lost reply keeps the committed cells or updated iteration");
    }
    assertEquals(f.model, accepted, "no failure mode changes accepted models");
    await publishShared(f);
    assertEquals(f.resets, 0, "no failure mode discards valid staged cells");
    assertEquals(normalize((f.model?.heating_bands as RoomHeatingBands).reference),
      normalize((reference.model?.heating_bands as RoomHeatingBands).reference), `${mode} commit changes the fit`);
  }
});

Deno.test("a correction within the frozen horizon supersedes the completed fit", async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  while (f.progress && f.progress.cursor < ROOM_RESPONSE_CELL_COUNT) await f.finishCell();
  const accepted = structuredClone(f.model);
  f.archive.correct(f.range);
  assertEquals(await (await f.tick()).json(), { published: false, superseded: true });
  assertEquals(f.model, accepted);
  assertEquals(f.progress, null);
});

Deno.test("a source refresh whose fence was lost writes nothing", async () => {
  const f = fixture();
  f.supersede("save_energy_room_evidence_block");
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.writes.length, 0);
  assertEquals(f.archive.blocks.size, 0);
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
  assertEquals(f.writes.length, 0);
  // An old seasonal pool may already be past its eighteenth training/full cell.
  f.setProgress({ metadata: { version: 3, capture: { version: 1 } }, cells: [], cursor: 30, base_revision: f.model?.model_revision ?? 0 });
  assertEquals(await (await f.tick()).json(), { superseded: true });
  // A capture beyond the claim's history ceiling is not this generation's work.
  await f.tick();
  assert(f.progress);
  f.setHistoryTo(new Date(f.now - 3_600_000).toISOString());
  assertEquals(await (await f.tick()).json(), { superseded: true });
  assertEquals(f.writes.length, 0);
});

Deno.test("a changed source binding or malformed training qualification resets only numerical scratch", async () => {
  for (const mode of ["binding", "prefix"] as const) {
    const f = fixture();
    await f.tick(); await f.tick();
    const accepted = structuredClone(f.model), checkpoint = f.progress!;
    if (mode === "binding") f.context.binding = "replacement-source";
    else {
      const { capture } = checkpoint.metadata as { capture: { trainingView: {length:number;temperatures:unknown[]} } };
      capture.trainingView.temperatures = [[capture.trainingView.length, 21, 20]];
    }
    assertEquals(await (await f.tick()).json(), { superseded: true });
    assertEquals(f.progress, null);
    assertEquals(f.model, accepted);
  }
});

Deno.test("lost admission release does not turn an accepted publication into a statistical failure", async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  while (f.progress && f.progress.cursor < ROOM_RESPONSE_CELL_COUNT) await f.finishCell();
  f.fail("release_energy_room_learning_lane");
  assertEquals(await (await f.tick()).json(), { published: true });
  assertEquals(f.writes.length, 1);
  assertEquals(f.reads.includes("fail_energy_device_learning"), false);
});
