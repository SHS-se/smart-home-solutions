import { selectDoorwayExchange } from "../device-learning/room/doorway-exchange.ts";
import { readDoorwayProbes, type DoorwayProbeRow } from "../room-doorway-probes.ts";
/** Room-only observation loading. Unknown meter coverage is never an OFF sample. */
import { fitRoomsFromQuarters, TRAINING_WINDOW_DAYS, thermalQuarter, zoneModelRows, type ThermalQuarterRow } from "../thermal-training.ts";
import { fitRoomMeans, type RoomMeanQuarter } from "../device-learning/room/mean-observations.ts";
import { readPassiveHeatModel, readRoomPassiveHeat } from "../room-passive-heat-evidence.ts";
import { readPagedRows } from "../read-paged-rows.ts";
import { irradiancePoints, irradianceOnto } from "../solar-irradiance.ts";
import type { RoomHeatingContext, StoredDeviceModel } from "../device-model-store.ts";
import { advanceRoomHeatingBands } from "../device-learning/room/heating-bands.ts";
import { readRoomHeatingBands, type RoomHeatingBands } from "../planner/heating-bands.ts";
import { readThermalModel } from "../planner/models/room/read-model.ts";
import { SLOT_HOURS, type ThermalZoneModel } from "../planner/models/room/thermal.ts";
import { readRoomDoorwayModel } from "../planner/models/room/doorway-boundary.ts";

async function readRoomQuarters(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, from: string, to: string,
) {
  return await readPagedRows<ThermalQuarterRow>((first, last) => db.rpc("get_energy_thermal_training_quarters", {
    p_customer_id: customerId, p_home_id: homeId, p_from: from, p_to: to,
  }).eq("room_key", roomKey).range(first, last));
}

export async function fitStoredRoomHeating(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, context: RoomHeatingContext,
  previous: StoredDeviceModel | undefined, location: { latitude: number; longitude: number } | null, now: number,
): Promise<Record<string, unknown>> {
  const current = readRoomHeatingBands(previous?.heating_bands);
  const attemptedAt = new Date(now).toISOString();
  const library: RoomHeatingBands = current?.binding === context.binding ? current : {
    binding: context.binding,
    since: context.observed_since && (!current || Date.parse(context.observed_since) > Date.parse(current.since))
      ? context.observed_since : attemptedAt,
    reference_revision: null, active: [], candidates: [], attempted: {},
    ...(current?.reference_revision || current?.previous_reference_revision
      ? { previous_reference_revision: (current.reference_revision ?? current.previous_reference_revision)! } : {}),
  };
  // Adopt the installed general fit once. An identified mapping change starts
  // a fresh reference so incompatible coefficients cannot enter a new band.
  const reference = previous?.trained && (!current || library.reference_revision) ? readThermalModel(previous) : null;
  if (!reference) {
    const row = await fitStoredRoom(db, homeId, customerId, roomKey, location, now, library.since);
    return { ...row, heating_bands: row.trained ? { ...library, reference_revision: crypto.randomUUID() } : library };
  }
  const seeded = library.reference_revision ? library : { ...library, reference_revision: crypto.randomUUID() };
  const since = new Date(Math.max(Date.parse(seeded.since), now - TRAINING_WINDOW_DAYS * 86_400_000)).toISOString();
  const { row, quarters, passive, doorways } = await readRoomAttempt(db, homeId, customerId, roomKey, location, now, undefined, reference);
  const observations = bandObservations(quarters.map(thermalQuarter), previous, reference, passive.get(roomKey), doorways);
  const { passive_heat, doorway_exchange } = row;
  const discovered = previous?.passive_heat || previous?.doorway_exchange || seeded.active.length || seeded.candidates.length ? {} : {
    ...(passive_heat ? { passive_heat } : {}),
    ...(doorway_exchange ? { doorway_exchange } : {}),
  };
  let bands = Object.keys(discovered).length
    ? { ...seeded, reference_revision: crypto.randomUUID() }
    : advanceRoomHeatingBands(seeded, observations.filter(quarter => quarter.start_ms >= Date.parse(since)), reference,
      quarters[0]?.active_power_w ?? null);
  if (bands.reference_revision === seeded.reference_revision && bands.active === seeded.active && bands.candidates === seeded.candidates) {
    bands = await fitHistoricalBand(db, homeId, customerId, roomKey, bands, previous, reference, now);
  }
  return { home_id: homeId, customer_id: customerId, room_key: roomKey, last_attempted_at: attemptedAt,
    last_fit_attempt: row.last_fit_attempt, ...discovered,
    heating_bands: bands,
  };
}

async function fitHistoricalBand(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, library: RoomHeatingBands,
  previous: StoredDeviceModel | undefined, reference: ThermalZoneModel, now: number,
) {
  const day = 86_400_000;
  const historyStart = Math.max(Date.parse(library.since), now - 400 * day);
  const recentStart = now - TRAINING_WINDOW_DAYS * day;
  if (historyStart >= recentStart) return library;
  const { data, error } = await db.rpc("get_energy_room_heating_band_history", {
    p_home_id: homeId, p_room_key: roomKey, p_from: new Date(historyStart).toISOString(),
    p_to: new Date(recentStart).toISOString(),
  });
  if (error) throw new Error(error.message);
  const windows = data as { band_c: number; last_at: string }[];
  const next = windows.filter(({ band_c, last_at }) => Date.parse(last_at) >
    Date.parse(library.attempted[band_c] ?? library.since)).sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))[0];
  if (!next) return library;
  const end = Date.parse(next.last_at) + 900_000;
  const from = new Date(Math.max(historyStart, end - TRAINING_WINDOW_DAYS * day)).toISOString();
  const to = new Date(end).toISOString();
  const quarters = await readRoomQuarters(db, homeId, customerId, roomKey, from, to);
  const [passive, doorways] = await Promise.all([
    readRoomPassiveHeat(db, customerId, homeId, [roomKey], from, to), readDoorwayProbes(db, homeId, [roomKey], from, to),
  ]);
  const observations = bandObservations(quarters.map(thermalQuarter), previous, reference, passive.get(roomKey), doorways);
  return advanceRoomHeatingBands(library, observations, reference, quarters[0]?.active_power_w ?? null,
    { band: next.band_c, split: end - 4 * day, lastAt: next.last_at });
}

export async function fitStoredRoom(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string,
  location: { latitude: number; longitude: number } | null,
  now: number = Date.now(),
  bindingSince?: string,
): Promise<Record<string, unknown>> {
  return (await readRoomAttempt(db, homeId, customerId, roomKey, location, now, bindingSince)).row;
}

async function readRoomAttempt(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string,
  location: { latitude: number; longitude: number } | null, now: number, bindingSince?: string,
  reference?: ThermalZoneModel,
) {
  const trainingTo = new Date(now).toISOString();
  const trainingFrom = new Date(Math.max(now - TRAINING_WINDOW_DAYS * 86_400_000,
    bindingSince ? Date.parse(bindingSince) : -Infinity)).toISOString();
  if (location) {
    const points = await irradiancePoints({ supabase: db, ...location });
    if (points) {
      const { data, error } = await db.from("energy_optimisation_outdoor_slots")
        .select("customer_id, home_id, start_ts, temperature_c, device_token_id")
        .eq("home_id", homeId).is("solar_w_per_m2", null).gte("start_ts", trainingFrom).lt("start_ts", trainingTo)
        .order("start_ts").limit(250);
      if (error) throw new Error(error.message);
      const solar = irradianceOnto(points, (data ?? []).map((row: { start_ts: string }) => row.start_ts));
      const rows = (data ?? []).map((row: Record<string, unknown>, i: number) => ({ ...row, solar_w_per_m2: solar[i] }))
        .filter((row: { solar_w_per_m2: number | null }) => row.solar_w_per_m2 !== null);
      if (rows.length) {
        const { error } = await db.from("energy_optimisation_outdoor_slots").upsert(rows, { onConflict: "home_id,start_ts" });
        if (error) throw new Error(error.message);
      }
    }
  }
  const quarters = await readRoomQuarters(db, homeId, customerId, roomKey, trainingFrom, trainingTo);
  // A missing series is a statistical observation outcome, not a transport failure.
  if (!quarters.length) {
    const { data, error } = await db.from("energy_optimisation_devices").select("mapping_summary")
      .eq("home_id", homeId).eq("mapping_summary->>room_key", roomKey).is("retired_at", null).limit(1);
    if (error) throw new Error(error.message);
    const roomName = data?.[0]?.mapping_summary?.room_name;
    if (!roomName) throw new Error("Learning room no longer has a mapped device");
    const row = zoneModelRows([{ room_key: roomKey, room_name: roomName,
      result: fitRoomMeans([], null) }],
    { homeId, customerId, trainingFrom, trainingTo })[0];
    return { row, quarters, passive: new Map(), doorways: [] };
  }
  const [passive, doorways] = await Promise.all([
    readRoomPassiveHeat(db, customerId, homeId, [roomKey], trainingFrom, trainingTo),
    readDoorwayProbes(db, homeId, [roomKey], trainingFrom, trainingTo),
  ]);
  const fits = fitRoomsFromQuarters(quarters, passive);
  if (fits.length !== 1 || fits[0].room_key !== roomKey) throw new Error("Room observations crossed owner boundary");
  const row = zoneModelRows(fits, { homeId, customerId, trainingFrom, trainingTo })[0];
  if (fits[0].result.ok) Object.assign(row, fitOptionalRoomResponses(row, quarters, doorways, reference ?? fits[0].result.model));
  return { row, quarters, passive, doorways };
}

function fitOptionalRoomResponses(row: Record<string, unknown>, quarters: ThermalQuarterRow[],
  doorways: DoorwayProbeRow[], model: ThermalZoneModel) {
    const passive_heat = row.passive_heat;
    let doorway_exchange = null;
    if (!passive_heat && doorways.length) {
      const observations = quarters.map(thermalQuarter).sort((a, b) => a.start_ms - b.start_ms);
      const local = new Map(observations.map(q => [q.start_ms, q.room_c]));
      const peers = doorways.map(doorway => ({
        key: doorway.other_key,
        source: doorway.other_source,
        observed: new Map(doorway.quarters.flatMap(([time, peer, receiver]) =>
          receiver !== undefined && Math.abs((local.get(time) ?? Infinity) - receiver) < 0.0001
            ? [[time, peer] as const] : [])),
      }));
      const responses = selectDoorwayExchange(observations, peers, model);
      if (responses.length) doorway_exchange = { source: doorways[0].room_source, peers: responses };
    }
    return { ...(passive_heat !== undefined ? { passive_heat } : {}), doorway_exchange };
}

function bandObservations(rows: RoomMeanQuarter[], previous: StoredDeviceModel | undefined, model: ThermalZoneModel,
  source: { device_key: string; watts: ReadonlyMap<number, number> } | undefined, probes: DoorwayProbeRow[]) {
  rows.sort((a, b) => a.start_ms - b.start_ms);
  const passive = readPassiveHeatModel(previous?.passive_heat);
  const indoor = model.house_coupling_per_h ?? 0;
  const doorway = readRoomDoorwayModel(previous?.doorway_exchange, indoor);
  if (!doorway && !passive) return rows;
  const neighbors = doorway?.peers.flatMap(peer => {
    const probe = probes.find(candidate => candidate.room_source === doorway.source &&
      candidate.other_key === peer.key && candidate.other_source === peer.source);
    return probe ? [{ peer, temperatures: new Map(probe.quarters.map(([time, temperature]) => [time, temperature])) }] : [];
  });
  const decay = passive ? Math.exp(-SLOT_HOURS / passive.lag_h) : 0;
  const mean = passive ? -Math.expm1(-SLOT_HOURS / passive.lag_h) * passive.lag_h / SLOT_HOURS : 0;
  let delivered = 0, knownHours = 0, last = -Infinity;
  return rows.map(quarter => {
    let adjustment = 0;
    if (passive) {
      const watts = source?.device_key === passive.device_key ? source.watts.get(quarter.start_ms) : undefined;
      if (quarter.start_ms - last !== 900_000 || watts === undefined) {
        knownHours = 0;
        delivered = 0;
      }
      last = quarter.start_ms;
      if (watts === undefined) return { ...quarter, band_forcing_c_per_h: null };
      adjustment = passive.direct_c_per_wh * watts + passive.delayed_c_per_wh * (mean * delivered + (1 - mean) * watts);
      delivered = decay * delivered + (1 - decay) * watts;
      knownHours += SLOT_HOURS;
      // A missing meter interval leaves the delayed state unknown until its
      // initial contribution has decayed, independently of other observations.
      if (knownHours < passive.lag_h * 4) return { ...quarter, band_forcing_c_per_h: null };
    }
    if (neighbors && quarter.house_c != null) {
      for (const { peer, temperatures } of neighbors) {
        const temperature = temperatures.get(quarter.start_ms);
        if (temperature === undefined) return { ...quarter, band_forcing_c_per_h: null };
        adjustment += peer.weight * (temperature - quarter.house_c - peer.usual);
      }
    }
    return { ...quarter, band_forcing_c_per_h: adjustment };
  });
}
