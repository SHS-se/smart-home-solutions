import { assert, assertEquals } from "@std/assert";
import { prepareStoredRoomHeating, finalizeStoredRoomBand, fitStoredRoomHeating, recaptureStoredRoomBand,
  parseRoomBandMetadata, ROOM_WINDOW_IMPLEMENTATION, type HeatingFitWindow } from "./room.ts";
import { fitIndependentRoomBand } from "../device-learning/room/mean-observations.ts";
import { heatingBand, type RoomHeatingBands } from "../planner/heating-bands.ts";
import type { ThermalQuarterRow } from "../thermal-training.ts";
import type { StoredDeviceModel } from "../device-model-store.ts";

const hour = 3_600_000, start = Date.UTC(2026, 0, 1), now = start + 300 * hour;
const context = { binding: "synthetic-heater-binding", observed_since: new Date(start).toISOString() };
/** Independent synthetic minute integration, not a captured household replay. */
function fixture(passive = false) {
  let temperature = 20;
  const rows: ThermalQuarterRow[] = Array.from({ length: 240 }, (_, i) => {
    const heat = i % 11 < 4 ? 500 : 0, outdoor = -7 + Math.sin(i / 13), house = 21 + Math.cos(i / 19);
    let sum = 0;
    for (let minute = 0; minute < 60; minute++) {
      const rate = .002 * heat + .03 * (outdoor - temperature) + .02 * (house - temperature) + .02;
      sum += temperature + rate / 120;
      temperature += rate / 60;
    }
    return { room_key: "room", room_name: "Synthetic room", start_ts: new Date(start + i * hour).toISOString(),
      duration_s: 3600, source: "recorder_hour_mean", room_temperature_c: sum / 60, house_temperature_c: house,
      outdoor_temperature_c: outdoor, heat_w: heat, active_power_w: 500, solar_w_per_m2: null, cooling: false };
  });
  const window: HeatingFitWindow = { window_key: "band:-10", band_c: -10, from_at: rows[0].start_ts,
    to_at: new Date(start + rows.length * hour).toISOString(), fingerprint: "synthetic-native-input",
    evidence_updated_at: new Date(now - hour).toISOString() };
  const reference = { model: { gain_c_per_wh: .002, cooling_constant_per_h: .03, background_gain_c_per_h: .02,
    thermal_capacity_wh_per_c: 500, heat_loss_w_per_c: 15, time_constant_h: 20,
    heating_rate_c_per_h: 1, r2: .9, sample_count: 240, residual_std_c: .1, house_coupling_per_h: .02 },
    scope: { kind: "general" as const }, training_to: new Date(now).toISOString(),
    ...(passive ? { passive_heat: { device_key: "synthetic-passive", direct_c_per_wh: .001,
      delayed_c_per_wh: .001, lag_h: 1 } } : {}) };
  const library: RoomHeatingBands = { binding: context.binding, since: context.observed_since,
    reference_revision: "existing-general", reference, active: [], candidates: [], attempted: {},
    general_attempt: { implementation: ROOM_WINDOW_IMPLEMENTATION, evidence_updated_at: window.evidence_updated_at,
      from_at: window.from_at, to_at: window.to_at } };
  const previous: StoredDeviceModel = { model_revision: 7, trained: true, heating_bands: library };
  const calls: string[] = [];
  let afterCapture = () => {};
  let passiveWatts = 100;
  const db = { rpc(name: string, args: Record<string, unknown>) {
    calls.push(name);
    if (name === "get_energy_room_heating_fit_windows") {
      assertEquals(args.p_room_key, "room");
      return Promise.resolve({ data: [{ ...window }], error: null });
    }
    if (name === "get_energy_room_thermal_interval_capture") {
      const selected = rows.filter(row => row.start_ts >= String(args.p_from) && row.start_ts < String(args.p_to));
      const data = { sources: [], rows: selected.map(row => ({ ...row, probe_values: null })) };
      afterCapture();
      return Promise.resolve({ data, error: null });
    }
    if (name === "get_energy_room_operation_facts") return Promise.resolve({ data: [], error: null });
    if (name === "get_energy_room_passive_heat") return Promise.resolve({ data: passive ? [{
      room_key: "room", device_key: "synthetic-passive", quarters: Array.from({ length: rows.length * 4 },
        (_, i) => [start + i * hour / 4, passiveWatts]),
    }] : [], error: null });
    if (name === "get_energy_doorway_probes") return Promise.resolve({ data: [], error: null });
    throw new Error(`Unexpected RPC ${name}`);
  } };
  return { rows, window, previous, calls, db, afterCapture: (callback: () => void) => { afterCapture = callback; },
    passiveWatts: (value: number) => { passiveWatts = value; } };
}
async function prepare(f = fixture()) {
  const prepared = await prepareStoredRoomHeating(f.db, "home", "customer", "room", context, f.previous, null, now);
  assert(prepared.kind === "band");
  return prepared.work;
}
function withoutNewRevision(row: Record<string, unknown>) {
  const copy = structuredClone(row), library = copy.heating_bands as RoomHeatingBands;
  for (const band of library.active) band.revision = "generated-band-revision";
  return copy;
}

Deno.test("band preparation captures corrected observations without publishing or altering the installed model", async () => {
  const f = fixture(true), original = structuredClone(f.previous);
  const { metadata, rows } = await prepare(f);
  assertEquals(f.previous, original);
  assertEquals(metadata.baseRevision, 7);
  assertEquals(metadata.progressLibrary.active, []);
  assertEquals(metadata.progressLibrary.window_attempts, undefined);
  assertEquals(metadata.window.fingerprint, f.window.fingerprint);
  assertEquals(rows.length, 240);
  assertEquals(rows[0].band_forcing_c_per_h, null); // Initial passive state is unknown.
  assert((rows[10].band_forcing_c_per_h ?? 0) > 0);
  assertEquals(parseRoomBandMetadata(JSON.parse(JSON.stringify(metadata))), metadata);
});

Deno.test("direct adapter and explicit capture-fit-finalize composition publish identical numerical results", async () => {
  const f = fixture(), { metadata, rows } = await prepare(f);
  const fit = fitIndependentRoomBand(rows, outdoor => heatingBand(outdoor) === metadata.window.band_c, metadata.ratedPowerW);
  const completed = finalizeStoredRoomBand(metadata, rows, fit);
  const direct = await fitStoredRoomHeating(f.db, "home", "customer", "room", context, f.previous, null, now);
  assertEquals(withoutNewRevision(completed), withoutNewRevision(direct));
  assertEquals((completed.heating_bands as RoomHeatingBands).active.length, 1);
});

Deno.test("recapture checks the pinned native window before and after reading and never moves its bounds", async () => {
  const f = fixture(), { metadata, rows } = await prepare(f);
  const same = await recaptureStoredRoomBand(f.db, "home", "customer", "room", metadata);
  assert(same.kind === "band");
  assertEquals(same.work.rows, rows);
  assertEquals(same.work.metadata, metadata);
  const captures = f.calls.filter(name => name === "get_energy_room_thermal_interval_capture").length;
  f.window.fingerprint = "corrected-input";
  assertEquals(await recaptureStoredRoomBand(f.db, "home", "customer", "room", metadata), { kind: "superseded" });
  assertEquals(f.calls.filter(name => name === "get_energy_room_thermal_interval_capture").length, captures);
  f.window.fingerprint = metadata.window.fingerprint;
  f.afterCapture(() => { f.window.evidence_updated_at = new Date(now).toISOString(); });
  assertEquals(await recaptureStoredRoomBand(f.db, "home", "customer", "room", metadata), { kind: "superseded" });
});

Deno.test("recapture exposes changed auxiliary inputs and running power for the worker's exact digest comparison", async () => {
  const f = fixture(true), { metadata, rows } = await prepare(f);
  f.passiveWatts(200);
  f.rows.at(-1)!.active_power_w = 600;
  const changed = await recaptureStoredRoomBand(f.db, "home", "customer", "room", metadata);
  assert(changed.kind === "band");
  assertEquals(changed.work.metadata.attemptedAt, metadata.attemptedAt);
  assertEquals(changed.work.metadata.ratedPowerW, 600);
  assert(changed.work.rows[10].band_forcing_c_per_h !== rows[10].band_forcing_c_per_h);
  assertEquals(metadata.ratedPowerW, 500);
});

Deno.test("malformed or obsolete scratch metadata is discarded without touching accepted models", async () => {
  const { metadata } = await prepare();
  for (const patch of [ { version: 2 }, { implementation: "obsolete" }, { baseRevision: null },
    { baseRevision: -1 }, { library: null }, { ratedPowerW: Infinity }, { sourceFreshness: {} },
    { window: { ...metadata.window, to_at: "invalid" } },
    { reference: { ...metadata.reference, scope: null } },
    { reference: { ...metadata.reference, scope: { kind: "band", band_c: -10 } } } ]) {
    assertEquals(parseRoomBandMetadata({ ...metadata, ...patch }), null);
  }
  const f = fixture();
  assertEquals(await recaptureStoredRoomBand(f.db, "wrong-home", "customer", "room", metadata), { kind: "superseded" });
  assertEquals(f.calls, []);
});
