import { learnRoomResponse, type LearnedRoomResponse, ROOM_RUN_POLICY } from "../device-learning/room/response-learning.ts";
import { ROOM_RUN_CONDITIONS, type RoomRunEvidence } from "../device-learning/room/run-calibration.ts";
import { harvestBandRuns, mergeHarvests, type HarvestedBandRuns } from "../device-learning/room/run-pool.ts";
import { decodeRoomBandFitCapture, encodeRoomBandFitCapture } from "./room-band-fit-capture.ts";
import { qualifyRoomOperationEvidence } from "../device-learning/room/operation-evidence.ts";
import { selectDoorwayExchange } from "../device-learning/room/doorway-exchange.ts";
import { readDoorwayProbes, type DoorwayProbeRow } from "../room-doorway-probes.ts";
/** Room-only observation loading. Unknown meter coverage is never an OFF sample. */
import { fitRoomsFromQuarters, TRAINING_WINDOW_DAYS, thermalQuarter, zoneModelRows, type ThermalQuarterRow } from "../thermal-training.ts";
import { roomIntervalHours, roomIntervalSeconds } from "../device-learning/room/mean-evidence.ts";
import { fitIndependentRoomBand, fitRoomMeans, ROOM_MEAN_IMPLEMENTATION, type RoomMeanQuarter, type RoomLearningEvidence } from "../device-learning/room/mean-observations.ts";
import { readPassiveHeatModel, readRoomPassiveHeat } from "../room-passive-heat-evidence.ts";
import { readPagedRows } from "../read-paged-rows.ts";
import { historicalIrradiancePoints, irradiancePoints, irradianceOnto } from "../solar-irradiance.ts";
import type { RoomHeatingContext, StoredDeviceModel } from "../device-model-store.ts";
import { generalRoomFitWarnings, heatingBand, readRoomHeatingBands, type RoomHeatingBands, type RoomHeatingReference } from "../planner/heating-bands.ts";
import { readThermalModel } from "../planner/models/room/read-model.ts";
import { isEquilibrium, type DynamicThermalZoneModel, type ThermalZoneModel } from "../planner/models/room/thermal.ts";
import { readRoomDoorwayModel, type RoomDoorwayModel } from "../planner/models/room/doorway-boundary.ts";
import { qualifyProbeFreshness, type ProbeFreshnessReport } from "../device-learning/room/source-freshness.ts";
import { decodeHeatingProbeCapture } from "../heating-probe-wire.ts";

const HOUR_MS = 3_600_000;

export async function readRoomQuarters(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, from: string, to: string, native = false,
) {
  if (!native) return await readPagedRows<ThermalQuarterRow>((first, last) =>
    db.rpc("get_energy_thermal_training_quarters", {
      p_customer_id: customerId, p_home_id: homeId, p_from: from, p_to: to,
    }).eq("room_key", roomKey).range(first, last));
  // Each bounded capture is one JSON response with a shared probe dictionary.
  // Logical hour boundaries own rows by their starts. Query one supported
  // native interval around the seam so complete fractional-start quarters and
  // the canonical fine/hour resolution choice survive internal batching.
  const chunks = nativeRoomReadWindows(from, to);
  const scopeFrom = Date.parse(from), scopeTo = Date.parse(to);
  const rows: ThermalQuarterRow[] = [];
  // A room owns one learning lane. Do not fan that single owner back out into
  // simultaneous database scans of the household's shared probe history.
  for (const [chunkFrom, chunkTo] of chunks) {
    const begin = Date.parse(chunkFrom), end = Date.parse(chunkTo);
    const { data, error } = await db.rpc("get_energy_room_thermal_interval_capture", {
      p_customer_id: customerId, p_home_id: homeId, p_room_key: roomKey,
      p_from: new Date(Math.max(scopeFrom, begin - HOUR_MS)).toISOString(),
      p_to: new Date(Math.min(scopeTo, end + HOUR_MS)).toISOString(),
    });
    if (error) throw new Error(`get_energy_room_thermal_interval_capture: ${error.message}`);
    rows.push(...decodeHeatingProbeCapture(data, roomKey).filter(row => {
      const start = Date.parse(row.start_ts);
      return start >= begin && start < end && start + (row.duration_s ?? 900) * 1000 <= scopeTo;
    }));
  }
  const { data: facts, error: factError } = await db.rpc("get_energy_room_operation_facts", {
    p_home_id: homeId, p_customer_id: customerId, p_room_key: roomKey, p_from: from, p_to: to,
  });
  if (factError) throw new Error(`get_energy_room_operation_facts: ${factError.message}`);
  if (!Array.isArray(facts)) throw new Error("Invalid room operation evidence");
  return qualifyRoomOperationEvidence(rows, facts);
}

export function nativeRoomReadWindows(from: string, to: string): [string, string][] {
  const hour = HOUR_MS, finish = Date.parse(to), windows: [string, string][] = [];
  let start = Date.parse(from);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) throw new Error("Invalid native history range");
  while (start < finish) {
    const end = Math.min(finish, Math.floor((start + 10 * 24 * hour) / hour) * hour);
    windows.push([new Date(start).toISOString(), new Date(end).toISOString()]);
    start = end;
  }
  return windows;
}

export interface HeatingFitWindow {
  window_key: string;
  band_c: number;
  from_at: string;
  to_at: string;
  fingerprint: string;
  evidence_updated_at: string;
}

// Revisit each completed band once to publish the selected response family
// and evaluate equilibrium forcing in its own temperature coordinates.
export const ROOM_WINDOW_IMPLEMENTATION = `${ROOM_MEAN_IMPLEMENTATION}:${ROOM_RUN_POLICY}:${ROOM_RUN_CONDITIONS}`;

function roomWindowVisitTimes(value: unknown, binding: string): Map<string, number> {
  const result = new Map<string, number>();
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !("binding" in value) || value.binding !== binding ||
    !("implementation" in value) || value.implementation !== ROOM_WINDOW_IMPLEMENTATION ||
    !("windows" in value) || !value.windows || typeof value.windows !== "object" || Array.isArray(value.windows)) return result;
  for (const [key, at] of Object.entries(value.windows)) {
    if (typeof at === "string" && Number.isFinite(Date.parse(at))) result.set(key, Date.parse(at));
  }
  return result;
}

function inputRevision(windows: HeatingFitWindow[]): string {
  return JSON.stringify(windows.map(window => [window.window_key, window.from_at, window.to_at, window.fingerprint])
    .sort((a, b) => a[0].localeCompare(b[0])));
}

/** Version of the shared capture metadata carried in private fit progress. */
export const ROOM_SHARED_METADATA_VERSION = 1;
export const SHARED_WINDOW_KEY = "shared";

/** A harvested band's place in the pool; the SQL owner checks the exact set. */
export interface PoolRef { window_key: string; sha256: string }

export interface RoomSharedMetadata {
  version: typeof ROOM_SHARED_METADATA_VERSION;
  implementation: string;
  homeId: string;
  customerId: string;
  roomKey: string;
  binding: string;
  baseRevision: number;
  attemptedAt: string;
  /** Capture origin: the earliest merged row start. */
  fromAt: string;
  historyTo: string;
  pool: PoolRef[];
  /** SQL completion reads its scope from window.window_key. */
  window: { window_key: typeof SHARED_WINDOW_KEY; band_c: 0; from_at: string; to_at: string; fingerprint: string; evidence_updated_at: string };
  library: RoomHeatingBands;
  ratedPowerW: number | null;
  roomName: string;
  sourceFreshness: ProbeFreshnessReport | null;
}

export interface RoomRunHarvestWork {
  window: HeatingFitWindow;
  /** Capture origin for the harvested rows. */
  fromAt: string;
  harvest: HarvestedBandRuns;
  ratedPowerW: number | null;
  sourceFreshness: ProbeFreshnessReport | null;
  /** Bookkeeping published after the pool entry is saved under the same fence. */
  model: Record<string, unknown>;
}

export type RoomHeatingPreparation =
  | { kind: "model"; model: Record<string, unknown> }
  | { kind: "harvest"; work: RoomRunHarvestWork }
  | { kind: "shared"; work: { metadata: RoomSharedMetadata; rows: RoomMeanQuarter[] } };

export interface RoomLearningClock { historyTo: number; wallNow: number }

/** A stored pool entry as the learner reads it back. */
export interface RoomRunPoolEntry extends PoolRef {
  band_c: number;
  from_at: string;
  harvested_at: string;
  capture: string;
  row_count: number;
  observed_runs: number;
  rated_power_w: number | null;
  source_freshness: ProbeFreshnessReport | null;
}

const samePool = (a: readonly PoolRef[] | undefined, b: readonly PoolRef[]) =>
  !!a && a.length === b.length && a.every((ref, i) => ref.window_key === b[i].window_key && ref.sha256 === b[i].sha256);

export function poolRefs(entries: readonly PoolRef[]): PoolRef[] {
  return entries.map(entry => ({ window_key: entry.window_key, sha256: entry.sha256 }))
    .sort((a, b) => a.window_key < b.window_key ? -1 : a.window_key > b.window_key ? 1 : 0);
}

function sumFreshness(parts: readonly (ProbeFreshnessReport | null)[]): ProbeFreshnessReport | null {
  let sum: ProbeFreshnessReport | null = null;
  for (const part of parts) {
    if (!part) continue;
    if (!sum) { sum = structuredClone(part); continue; }
    for (const scope of ["room", "house"] as const) for (const kind of ["inferred", "unavailable", "unverified"] as const) {
      sum[scope][kind] += part[scope][kind];
    }
  }
  return sum;
}

/** Offline and test callers compose one learner step from the same seams as
 * the worker: a harvest saves its pool entry, a shared capture fits in full. */
export async function fitStoredRoomHeating(...args: Parameters<typeof prepareStoredRoomHeating>): Promise<Record<string, unknown>> {
  const prepared = await prepareStoredRoomHeating(...args);
  if (prepared.kind === "model") return prepared.model;
  if (prepared.kind === "harvest") {
    const { work } = prepared, [db] = args;
    const capture = work.harvest.run_ids.length ? await encodeRoomBandFitCapture(work.harvest.rows, work.fromAt) : null;
    const { error } = await db.rpc("save_energy_room_run_harvest", {
      p_window_key: work.window.window_key, p_band_c: work.window.band_c, p_from_at: work.fromAt,
      p_capture_base64: capture?.base64 ?? null, p_sha256: capture?.sha256 ?? null, p_row_count: capture?.row_count ?? 0,
      p_run_ids: work.harvest.run_ids, p_observed_runs: work.harvest.observed_runs,
      p_rated_power_w: work.ratedPowerW, p_source_freshness: work.sourceFreshness,
    });
    if (error) throw new Error(`save_energy_room_run_harvest: ${error.message}`);
    return work.model;
  }
  const { metadata, rows } = prepared.work;
  return finalizeStoredRoomResponse(metadata, rows, learnRoomResponse(rows, metadata.ratedPowerW)).model;
}

/**
 * One step of the room's shared-response learning. Each 5 °C window whose
 * evidence changed is harvested once: its newest runs enter the private run
 * pool. When no harvest is due and the pool changed, the merged pool is
 * captured for the bounded numerical fit. Bands never own coefficients.
 */
export async function prepareStoredRoomHeating(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, context: RoomHeatingContext,
  previous: StoredDeviceModel | undefined, location: { latitude: number; longitude: number } | null, clock: RoomLearningClock,
  windowVisits?: unknown,
): Promise<RoomHeatingPreparation> {
  const current = readRoomHeatingBands(previous?.heating_bands);
  const now = clock.wallNow;
  const attemptedAt = new Date(now).toISOString();
  const historyTo = new Date(clock.historyTo).toISOString();
  const floor = new Date(clock.historyTo - 400 * 86_400_000).toISOString();
  const library: RoomHeatingBands = current?.binding === context.binding ? { ...current, since: context.observed_since &&
    Date.parse(context.observed_since) < Date.parse(current.since) ? context.observed_since : current.since } : {
    binding: context.binding, calibration_policy: ROOM_RUN_POLICY, since: context.observed_since ?? floor,
    reference_revision: null, active: [], candidates: [], attempted: {},
    ...(current?.reference_revision || current?.previous_reference_revision
      ? { previous_reference_revision: (current.reference_revision ?? current.previous_reference_revision)! } : {}),
  };
  // A legacy library keeps its accepted responses until the shared one publishes.
  library.calibration_policy = ROOM_RUN_POLICY;
  delete library.general_attempt; delete library.general_solar_pending; delete library.general_solar_retry_at;
  const pinnedFloor = new Date(Math.max(Date.parse(library.since), Date.parse(floor))).toISOString();
  const readWindows = async (to = historyTo): Promise<HeatingFitWindow[]> => {
    const { data, error } = await db.rpc("get_energy_room_heating_fit_windows", {
      p_home_id: homeId, p_customer_id: customerId, p_room_key: roomKey, p_from: pinnedFloor, p_to: to,
    });
    if (error) throw new Error(`get_energy_room_heating_fit_windows: ${error.message}`);
    return data;
  };
  const windows = (await readWindows()).sort((a, b) =>
    Date.parse(b.to_at) - Date.parse(a.to_at) || a.window_key.localeCompare(b.window_key));
  const harvested = (window: HeatingFitWindow) =>
    !!library.window_attempts?.[window.window_key]?.startsWith(`${ROOM_WINDOW_IMPLEMENTATION}:`) &&
    !(Date.parse(window.evidence_updated_at) > Date.parse(library.window_evidence_updated_at?.[window.window_key] ?? "1970-01-01"));
  const visits = roomWindowVisitTimes(windowVisits, context.binding);
  const lastVisit = (key: string): number | undefined => {
    const published = library.window_last_attempted_at?.[key];
    const recorded = published !== undefined ? Date.parse(published)
      : library.window_attempts?.[key] !== undefined ? 0 : undefined;
    const captured = visits.get(key);
    return captured === undefined ? recorded : recorded === undefined ? captured : Math.max(captured, recorded);
  };
  const solarReady = (retryAt?: string | null) => !(Date.parse(retryAt ?? "") > now);
  const pending = windows.filter(window => !harvested(window) ||
    (library.window_solar_pending?.[window.window_key] && solarReady(library.window_solar_retry_at?.[window.window_key])))
    .sort((a, b) => {
      const visitA = lastVisit(a.window_key), visitB = lastVisit(b.window_key);
      const attemptedA = visitA !== undefined, attemptedB = visitB !== undefined;
      // First visit every available seasonal window, then fair by last visit,
      // so a live newest window cannot starve winter evidence.
      return Number(attemptedA) - Number(attemptedB) || (attemptedA && attemptedB ? visitA - visitB : 0) ||
        Date.parse(b.to_at) - Date.parse(a.to_at) || a.window_key.localeCompare(b.window_key);
    });
  if (!windows.length) {
    // Keep the standard recent attempt and its explicit diagnostics when no
    // heating window exists; absence of recent heating never erases a model.
    const row = await fitStoredRoom(db, homeId, customerId, roomKey, location, clock, library.since, true, context.binding);
    return { kind: "model", model: { ...row, heating_bands: { ...library, pending_windows: 0 } } };
  }
  const bookkeeping = (heating_bands: RoomHeatingBands) => ({
    home_id: homeId, customer_id: customerId, room_key: roomKey, last_attempted_at: attemptedAt, heating_bands });
  if (pending.length) {
    let window = pending[0];
    const previousProgress = library.window_solar_progress?.[window.window_key];
    const solar = await repairNativeRoomSolar(db, homeId, customerId, roomKey, context.binding,
      location, window.from_at, window.to_at, now, previousProgress?.through_at, library.window_solar_retry_at?.[window.window_key]);
    const nextProgress = { from_at: window.from_at, to_at: window.to_at, through_at: solar.through_at ?? window.to_at };
    if (solar.patched) {
      const refreshed = (await readWindows()).find(candidate => candidate.window_key === window.window_key &&
        candidate.from_at === window.from_at && candidate.to_at === window.to_at);
      if (refreshed) window = refreshed;
    }
    const progressLibrary: RoomHeatingBands = { ...library,
      window_last_attempted_at: { ...library.window_last_attempted_at, [window.window_key]: attemptedAt },
      window_solar_pending: { ...library.window_solar_pending, [window.window_key]: solar.pending },
      window_solar_retry_at: { ...library.window_solar_retry_at, [window.window_key]: solar.retry_at },
      window_solar_progress: { ...library.window_solar_progress, [window.window_key]: nextProgress },
      // The remaining harvests plus the shared fit that follows them.
      pending_windows: pending.length - 1 + Number(solar.pending && solarReady(solar.retry_at)) + 1 };
    // An archive outage may not block the first harvest: harvest once without
    // the missing solar hours and retry at the daily cadence.
    if (solar.pending && (!solar.unavailable || harvested(window))) return { kind: "model", model: bookkeeping(progressLibrary) };
    const captured = await loadRoomObservations(db, homeId, customerId, roomKey, window.from_at, window.to_at, true);
    const after = (await readWindows(window.to_at)).find(candidate => candidate.window_key === window.window_key);
    if (!after || inputRevision([after]) !== inputRevision([window])) return { kind: "model", model: bookkeeping(
      { ...progressLibrary, pending_windows: Math.max(1, progressLibrary.pending_windows ?? 1) }) };
    const rows = captured.quarters.map(thermalQuarter).filter(row => row.start_ms >= Date.parse(library.since));
    return { kind: "harvest", work: {
      window, fromAt: window.from_at, harvest: harvestBandRuns(rows, window.band_c),
      ratedPowerW: captured.quarters.at(-1)?.active_power_w ?? null,
      sourceFreshness: captured.sourceFreshness ?? null,
      model: bookkeeping({ ...progressLibrary,
        window_attempts: { ...library.window_attempts, [window.window_key]: `${ROOM_WINDOW_IMPLEMENTATION}:${window.fingerprint}` },
        window_evidence_updated_at: { ...library.window_evidence_updated_at, [window.window_key]: window.evidence_updated_at } }),
    } };
  }
  const { data: stored, error } = await db.rpc("load_energy_room_run_pool", {
    p_home_id: homeId, p_customer_id: customerId, p_room_key: roomKey, p_binding: context.binding,
  });
  if (error) throw new Error(`load_energy_room_run_pool: ${error.message}`);
  // Harvested evidence outlives raw-history retention; rows older than the
  // pinned 400-day floor are dropped when merged.
  const entries = Array.isArray(stored) ? stored as RoomRunPoolEntry[] : [];
  const pool = poolRefs(entries);
  const attempt = library.shared_attempt;
  if (attempt?.implementation === ROOM_WINDOW_IMPLEMENTATION && samePool(attempt.pool, pool)) {
    return { kind: "model", model: bookkeeping({ ...library, pending_windows: 0 }) };
  }
  if (!entries.length) return { kind: "model", model: bookkeeping({ ...library, pending_windows: 0,
    shared_attempt: { implementation: ROOM_WINDOW_IMPLEMENTATION, pool, attempted_at: attemptedAt, status: "unidentified" } }) };
  const decoded = await Promise.all(entries.map(async entry => ({ harvested_at: entry.harvested_at,
    rows: await decodeRoomBandFitCapture(entry.capture, entry.from_at, entry.sha256) })));
  const rows = mergeHarvests(decoded).filter(row => row.start_ms >= Date.parse(pinnedFloor));
  const fromAt = new Date(rows.length ? rows[0].start_ms : Date.parse(pinnedFloor)).toISOString();
  const evidenceAt = windows.reduce((latest, window) => Date.parse(window.evidence_updated_at) > Date.parse(latest)
    ? window.evidence_updated_at : latest, "1970-01-01T00:00:00.000Z");
  const newest = [...entries].sort((a, b) => Date.parse(b.harvested_at) - Date.parse(a.harvested_at))[0];
  return { kind: "shared", work: { rows, metadata: {
    version: ROOM_SHARED_METADATA_VERSION, implementation: ROOM_WINDOW_IMPLEMENTATION,
    homeId, customerId, roomKey, binding: context.binding, baseRevision: previous?.model_revision ?? 0,
    attemptedAt, fromAt, historyTo, pool,
    window: { window_key: SHARED_WINDOW_KEY, band_c: 0, from_at: fromAt, to_at: historyTo,
      fingerprint: JSON.stringify(pool), evidence_updated_at: evidenceAt },
    library: { ...library, pending_windows: 1 },
    ratedPowerW: newest?.rated_power_w ?? null,
    roomName: typeof previous?.room_name === "string" ? previous.room_name : roomKey,
    sourceFreshness: sumFreshness(entries.map(entry => entry.source_freshness)),
  } } };
}

/** Scratch metadata is disposable; incompatible state must be captured again. */
export function parseRoomSharedMetadata(value: unknown): RoomSharedMetadata | null {
  if (!value || typeof value !== "object") return null;
  const row = value as RoomSharedMetadata;
  const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
  if (row.version !== ROOM_SHARED_METADATA_VERSION || row.implementation !== ROOM_WINDOW_IMPLEMENTATION ||
    ![row.homeId, row.customerId, row.roomKey, row.binding].every(value => typeof value === "string" && value.length > 0) ||
    !Number.isSafeInteger(row.baseRevision) || row.baseRevision < 0 ||
    !date(row.attemptedAt) || !date(row.fromAt) || !date(row.historyTo) ||
    !Array.isArray(row.pool) || !row.pool.every(ref => ref && typeof ref.window_key === "string" && typeof ref.sha256 === "string") ||
    row.window?.window_key !== SHARED_WINDOW_KEY ||
    !(row.ratedPowerW === null || typeof row.ratedPowerW === "number" && Number.isFinite(row.ratedPowerW)) ||
    typeof row.roomName !== "string") return null;
  const parsed = readRoomHeatingBands(row.library);
  if (!parsed || parsed.binding !== row.binding) return null;
  if (row.sourceFreshness !== null) {
    if (!row.sourceFreshness || ![row.sourceFreshness.room, row.sourceFreshness.house].every(part => part &&
      [part.inferred, part.unavailable, part.unverified].every(value => Number.isSafeInteger(value) && value >= 0))) return null;
  }
  return row;
}

/**
 * Publish the shared response. Success replaces the reference with the shared
 * response and empties the legacy bands; every ledger run was assessed against
 * the new revision. Failure keeps whatever response was accepted before.
 */
export function finalizeStoredRoomResponse(metadata: RoomSharedMetadata, rows: RoomMeanQuarter[],
  fit: LearnedRoomResponse): { model: Record<string, unknown>; ledger: RoomRunEvidence | null } {
  const { homeId, customerId, roomKey, attemptedAt, window, library, sourceFreshness, pool } = metadata;
  const learning = fit.result.learning_evidence;
  const attempt = { status: fit.result.ok ? "fitted" : "unidentified",
    issues: fit.result.ok ? fit.result.warnings ?? [] : [fit.result.reason], learning,
    ...(sourceFreshness ? { source_freshness: sourceFreshness } : {}) };
  const physical = fit.result.ok ? fit.result.model : null;
  const revision = physical ? crypto.randomUUID() : null;
  const trainingFrom = fit.run_ledger?.oldest_run_at ?? window.from_at;
  const trainingTo = fit.run_ledger?.newest_run_at ?? window.to_at;
  const dynamic = physical && !isEquilibrium(physical) ? physical : null;
  const scalar = dynamic ? Object.fromEntries(Object.entries(dynamic).filter(([key]) => key !== "response_family")) : physical ? {
    gain_c_per_wh: null, cooling_constant_per_h: null, background_gain_c_per_h: null,
    thermal_capacity_wh_per_c: null, heat_loss_w_per_c: null, time_constant_h: null, heating_rate_c_per_h: null,
    house_coupling_per_h: null, solar_gain_c_per_h_per_wm2: null, r2: physical.r2,
    residual_std_c: physical.residual_std_c, heat_lag_h: physical.heat_lag_h ?? null,
    prediction_error_c: physical.prediction_error_c ?? null, solar_mean_w_per_m2: physical.solar_mean_w_per_m2 ?? null,
  } : {};
  const sharedAttempt = { implementation: ROOM_WINDOW_IMPLEMENTATION, pool, attempted_at: attemptedAt,
    status: physical ? "fitted" as const : "unidentified" as const };
  const accepted = library.reference !== undefined || library.active.length > 0;
  const { diagnostics: _diagnostics, ...kept } = library;
  const heating_bands: RoomHeatingBands = physical && fit.result.ok
    ? { ...kept, reference: { model: physical, scope: { kind: "shared" }, training_from: trainingFrom, training_to: trainingTo,
      warnings: fit.result.warnings ?? [], learning_evidence: learning }, reference_revision: revision,
      active: [], candidates: [], attempted: {}, shared_attempt: sharedAttempt, pending_windows: 0 }
    : { ...library, shared_attempt: sharedAttempt, pending_windows: 0 };
  const ledger = fit.run_ledger ? { ...fit.run_ledger, assessed_against: revision } : null;
  return { ledger, model: { home_id: homeId, customer_id: customerId, room_key: roomKey, room_name: metadata.roomName,
    ...(!physical && !accepted ? { trained: false, rejection_reason: fit.result.ok ? "insufficient_heating_runs" : fit.result.reason,
      sample_count: rows.length, training_from: window.from_at, training_to: window.to_at } : {}),
    ...(physical ? { ...scalar, trained: true, rejection_reason: null, sample_count: physical.sample_count,
      fitted_at: attemptedAt, training_from: trainingFrom, training_to: trainingTo,
      passive_heat: null, doorway_exchange: null } : {}),
    last_attempted_at: attemptedAt, last_fit_attempt: attempt, heating_bands } };
}

function roomReference(model: ThermalZoneModel, row?: Record<string, unknown>): RoomHeatingReference {
  const warnings = generalRoomFitWarnings(row?.last_fit_attempt);
  return { model, ...(typeof row?.training_to === "string" ? { training_to: row.training_to } : {}),
    ...(warnings ? { warnings } : {}),
    scope: { kind: "general" }, ...(row?.passive_heat ? { passive_heat: row.passive_heat } : {}),
    ...(row?.doorway_exchange ? { doorway_exchange: row.doorway_exchange } : {}) };
}

export async function fitStoredRoom(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string,
  location: { latitude: number; longitude: number } | null,
  clock: RoomLearningClock,
  bindingSince?: string,
  native = false,
  heatingBinding?: string,
): Promise<Record<string, unknown>> {
  const trainingTo = new Date(clock.historyTo).toISOString();
  const trainingFrom = new Date(Math.max(clock.historyTo - TRAINING_WINDOW_DAYS * 86_400_000,
    bindingSince ? Date.parse(bindingSince) : -Infinity)).toISOString();
  if (native && heatingBinding) await repairNativeRoomSolar(db, homeId, customerId, roomKey, heatingBinding,
    location, trainingFrom, trainingTo, clock.wallNow);
  else if (!native) await repairRoomSolar(db, homeId, location, trainingFrom, trainingTo);
  const captured = await loadRoomObservations(db, homeId, customerId, roomKey, trainingFrom, trainingTo, native);
  return { ...await fitLoadedRoom(db, homeId, customerId, roomKey, trainingFrom, trainingTo, captured, native),
    last_attempted_at: new Date(clock.wallNow).toISOString() };
}

async function repairNativeRoomSolar(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, binding: string,
  location: { latitude: number; longitude: number } | null, from: string, to: string, now: number,
  after?: string, retryAt?: string | null,
): Promise<{ unavailable: boolean; pending: boolean; patched: number; through_at?: string; retry_at: string | null }> {
  if (!location) return { unavailable: false, pending: false, patched: 0, retry_at: null };
  // Thermal corrections may fit immediately while archive gaps wait for the
  // existing daily learning cadence. Never slide this deadline on such fits.
  if (retryAt && Date.parse(retryAt) > now) return {
    unavailable: true, pending: true, patched: 0, through_at: after, retry_at: retryAt,
  };
  const retry = () => new Date(now + 24 * 3_600_000).toISOString();
  const missing = async (cursor?: string): Promise<{ from_at: string; to_at: string } | null> => {
    const { data, error } = await db.rpc("get_energy_room_missing_irradiance_window", {
      p_home_id: homeId, p_customer_id: customerId, p_room_key: roomKey, p_binding: binding,
      p_from: from, p_to: to, p_after: cursor ?? null,
    });
    if (error) throw new Error(`get_energy_room_missing_irradiance_window: ${error.message}`);
    return data;
  };
  const gap = await missing(after);
  if (!gap) return { unavailable: false, pending: false, patched: 0, retry_at: null };
  const points = await historicalIrradiancePoints({ supabase: db, ...location,
    from: gap.from_at, to: gap.to_at, now: new Date(now) });
  if (points === null) return { unavailable: true, pending: true, patched: 0, through_at: gap.from_at, retry_at: retry() };
  let patched = 0;
  if (points.length) {
    const { data, error } = await db.rpc("repair_energy_heating_irradiance", {
      p_home_id: homeId, p_customer_id: customerId, p_room_key: roomKey, p_binding: binding,
      p_from: gap.from_at, p_to: gap.to_at, p_points: points,
    });
    if (error) throw new Error(`repair_energy_heating_irradiance: ${error.message}`);
    patched = Number(data) || 0;
  }
  const remaining = await missing(gap.to_at);
  // The gap RPC wraps to an earlier missing hour only after later ranges have
  // had their turn. A completed pass with provider holes is not ready work.
  const exhausted = remaining !== null && Date.parse(remaining.from_at) < Date.parse(gap.to_at);
  return { pending: remaining !== null, patched, through_at: gap.to_at,
    unavailable: exhausted, retry_at: exhausted ? retry() : null };
}

async function fitLoadedRoom(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, trainingFrom: string, trainingTo: string,
  { quarters, passive, doorways, sourceFreshness }: Awaited<ReturnType<typeof loadRoomObservations>>,
  native = false,
): Promise<Record<string, unknown>> {
  // A missing series is a statistical observation outcome, not a transport failure.
  if (!quarters.length) {
    const { data, error } = await db.from("energy_optimisation_devices").select("mapping_summary")
      .eq("home_id", homeId).eq("mapping_summary->>room_key", roomKey).is("retired_at", null).limit(1);
    if (error) throw new Error(error.message);
    const roomName = data?.[0]?.mapping_summary?.room_name;
    if (!roomName) throw new Error("Learning room no longer has a mapped device");
    return zoneModelRows([{ room_key: roomKey, room_name: roomName, result: fitRoomMeans([], null) }],
      { homeId, customerId, trainingFrom, trainingTo })[0];
  }
  // Native heating captures without a discoverable heating window cannot
  // bypass the run-qualified publisher through this legacy recent-fit path.
  const fits = native ? [{ room_key: roomKey, room_name: quarters[0].room_name,
    result: { ok: false as const, reason: "insufficient_heating_runs" as const, sample_count: quarters.length } }]
    : fitRoomsFromQuarters(quarters, passive);
  if (fits.length !== 1 || fits[0].room_key !== roomKey) throw new Error("Room observations crossed owner boundary");
  const row = zoneModelRows(fits, { homeId, customerId, trainingFrom, trainingTo })[0];
  if (sourceFreshness) row.last_fit_attempt = { ...row.last_fit_attempt as Record<string, unknown>, source_freshness: sourceFreshness };
  if (fits[0].result.ok) Object.assign(row, fitOptionalRoomResponses(row, quarters, doorways, fits[0].result.model));
  return row;
}

async function repairRoomSolar(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, location: { latitude: number; longitude: number } | null, trainingFrom: string, trainingTo: string,
) {
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
}

async function loadRoomObservations(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, trainingFrom: string, trainingTo: string, native = false,
) {
  const raw = await readRoomQuarters(db, homeId, customerId, roomKey, trainingFrom, trainingTo, native);
  const qualified = native ? qualifyProbeFreshness(raw) : null;
  // Source facts have served their purpose after qualification. Do not retain
  // the whole household's probe vectors while fitting one room's response.
  const quarters = qualified ? qualified.rows.map(({ probe_evidence: _facts, ...row }) => row) : raw;
  const sourceFreshness = qualified?.report;
  if (!quarters.length) return { quarters, passive: new Map<string, never>(), doorways: [], sourceFreshness };
  if (native) return { quarters, passive: new Map<string, never>(), doorways: [] as DoorwayProbeRow[], sourceFreshness };
  const [passive, doorways] = await Promise.all([
    readRoomPassiveHeat(db, customerId, homeId, [roomKey], trainingFrom, trainingTo),
    readDoorwayProbes(db, homeId, [roomKey], trainingFrom, trainingTo),
  ]);
  return { quarters, passive, doorways, sourceFreshness };
}

function fitOptionalRoomResponses(row: Record<string, unknown>, quarters: ThermalQuarterRow[],
  doorways: DoorwayProbeRow[], model: DynamicThermalZoneModel) {
    const passive_heat = row.passive_heat;
    let doorway_exchange: RoomDoorwayModel | null = null;
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

/** Auxiliary observations are quarter means; native hours need all four. */
export function auxiliaryIntervalMean(values: ReadonlyMap<number, number>, start: number, durationSeconds: number): number | undefined {
  const count = durationSeconds / 900;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const value = values.get(start + i * 900_000);
    if (value === undefined || !Number.isFinite(value)) return undefined;
    sum += value;
  }
  return sum / count;
}

export function bandObservations(rows: RoomMeanQuarter[], reference: RoomHeatingReference,
  source: { device_key: string; watts: ReadonlyMap<number, number> } | undefined, probes: DoorwayProbeRow[]) {
  rows.sort((a, b) => a.start_ms - b.start_ms);
  const passive = readPassiveHeatModel(reference.passive_heat);
  const indoor = isEquilibrium(reference.model) ? 0 : reference.model.house_coupling_per_h ?? 0;
  const doorway = readRoomDoorwayModel(reference.doorway_exchange, indoor);
  if (!doorway && !passive) return rows;
  const neighbors = doorway?.peers.flatMap(peer => {
    const probe = probes.find(candidate => candidate.room_source === doorway.source &&
      candidate.other_key === peer.key && candidate.other_source === peer.source);
    return probe ? [{ peer, temperatures: new Map(probe.quarters.map(([time, temperature]) => [time, temperature])) }] : [];
  });
  if (doorway && neighbors?.length !== doorway.peers.length) return rows.map(row => ({ ...row, band_forcing_c_per_h: null }));
  let delivered = 0, knownHours = 0, last = -Infinity;
  return rows.map(quarter => {
    let adjustment = 0;
    const hours = roomIntervalHours(quarter);
    const decay = passive ? Math.exp(-hours / passive.lag_h) : 0;
    const mean = passive ? -Math.expm1(-hours / passive.lag_h) * passive.lag_h / hours : 0;
    if (passive) {
      const watts = source?.device_key === passive.device_key
        ? auxiliaryIntervalMean(source.watts, quarter.start_ms, roomIntervalSeconds(quarter)) : undefined;
      if (quarter.start_ms !== last || watts === undefined) {
        knownHours = 0;
        delivered = 0;
      }
      last = quarter.start_ms + roomIntervalSeconds(quarter) * 1000;
      if (watts === undefined) return { ...quarter, band_forcing_c_per_h: null };
      adjustment = passive.direct_c_per_wh * watts + passive.delayed_c_per_wh * (mean * delivered + (1 - mean) * watts);
      delivered = decay * delivered + (1 - decay) * watts;
      knownHours += hours;
      // A missing meter interval leaves the delayed state unknown until its
      // initial contribution has decayed, independently of other observations.
      if (knownHours < passive.lag_h * 4) return { ...quarter, band_forcing_c_per_h: null };
    }
    if (neighbors && quarter.house_c != null) {
      for (const { peer, temperatures } of neighbors) {
        const temperature = auxiliaryIntervalMean(temperatures, quarter.start_ms, roomIntervalSeconds(quarter));
        if (temperature === undefined) return { ...quarter, band_forcing_c_per_h: null };
        adjustment += peer.weight * (temperature - quarter.house_c - peer.usual);
      }
    }
    return { ...quarter, band_forcing_c_per_h: adjustment };
  });
}
