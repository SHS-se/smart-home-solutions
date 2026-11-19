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
import { publishRoomHeatingBandFit } from "../device-learning/room/heating-bands.ts";
import { heatingBand, readRoomHeatingBands, type RoomHeatingBands, type RoomHeatingReference } from "../planner/heating-bands.ts";
import { readThermalModel } from "../planner/models/room/read-model.ts";
import { type ThermalZoneModel } from "../planner/models/room/thermal.ts";
import { readRoomDoorwayModel, type RoomDoorwayModel } from "../planner/models/room/doorway-boundary.ts";
import { qualifyProbeFreshness, type ProbeFreshnessReport } from "../device-learning/room/source-freshness.ts";
import { decodeHeatingProbeCapture } from "../heating-probe-wire.ts";

export async function readRoomQuarters(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, from: string, to: string, native = false,
) {
  if (!native) return await readPagedRows<ThermalQuarterRow>((first, last) =>
    db.rpc("get_energy_thermal_training_quarters", {
      p_customer_id: customerId, p_home_id: homeId, p_from: from, p_to: to,
    }).eq("room_key", roomKey).range(first, last));
  // Each bounded capture is one JSON response with a shared probe dictionary.
  // Internal hour boundaries preserve the choice between quarters and native hours.
  const chunks = nativeRoomReadWindows(from, to);
  const rows: ThermalQuarterRow[] = [];
  // A room owns one learning lane. Do not fan that single owner back out into
  // simultaneous database scans of the household's shared probe history.
  for (const [from, to] of chunks) {
    const { data, error } = await db.rpc("get_energy_room_thermal_interval_capture", {
      p_customer_id: customerId, p_home_id: homeId, p_room_key: roomKey, p_from: from, p_to: to,
    });
    if (error) throw new Error(`get_energy_room_thermal_interval_capture: ${error.message}`);
    rows.push(...decodeHeatingProbeCapture(data, roomKey));
  }
  return rows;
}

export function nativeRoomReadWindows(from: string, to: string): [string, string][] {
  const hour = 3_600_000, finish = Date.parse(to), windows: [string, string][] = [];
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

// Revisit completed attempts after the broad source-epoch qualification repair
// and the compact, full-dependency SQL fingerprint change.
export const ROOM_WINDOW_IMPLEMENTATION = `${ROOM_MEAN_IMPLEMENTATION}:pooled_band_general_freshness_v5`;

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

export interface RoomBandMetadata {
  version: 1;
  implementation: string;
  homeId: string;
  customerId: string;
  roomKey: string;
  binding: string;
  baseRevision: number;
  attemptedAt: string;
  pinnedFloor: string;
  window: HeatingFitWindow;
  library: RoomHeatingBands;
  progressLibrary: RoomHeatingBands;
  reference: RoomHeatingReference | null;
  ratedPowerW: number | null;
  lastAt: string;
  sourceFreshness: ProbeFreshnessReport | null;
}

export type RoomBandWork = { metadata: RoomBandMetadata; rows: RoomMeanQuarter[] };
export type RoomHeatingPreparation =
  | { kind: "model"; model: Record<string, unknown> }
  | { kind: "band"; work: RoomBandWork };

/** Synchronous/offline callers compose the same capture and completion seams. */
export async function fitStoredRoomHeating(...args: Parameters<typeof prepareStoredRoomHeating>): Promise<Record<string, unknown>> {
  const prepared = await prepareStoredRoomHeating(...args);
  if (prepared.kind === "model") return prepared.model;
  const { metadata, rows } = prepared.work;
  const fit = fitIndependentRoomBand(rows, outdoor => heatingBand(outdoor) === metadata.window.band_c, metadata.ratedPowerW);
  return finalizeStoredRoomBand(metadata, rows, fit);
}

export async function prepareStoredRoomHeating(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, context: RoomHeatingContext,
  previous: StoredDeviceModel | undefined, location: { latitude: number; longitude: number } | null, now: number,
  windowVisits?: unknown,
): Promise<RoomHeatingPreparation> {
  const current = readRoomHeatingBands(previous?.heating_bands);
  const attemptedAt = new Date(now).toISOString();
  const floor = new Date(now - 400 * 86_400_000).toISOString();
  const library: RoomHeatingBands = current?.binding === context.binding ? { ...current, since: context.observed_since &&
    Date.parse(context.observed_since) < Date.parse(current.since) ? context.observed_since : current.since } : {
    binding: context.binding, since: context.observed_since ?? floor,
    reference_revision: null, active: [], candidates: [], attempted: {},
    ...(current?.reference_revision || current?.previous_reference_revision
      ? { previous_reference_revision: (current.reference_revision ?? current.previous_reference_revision)! } : {}),
  };
  const narrowReference = library.reference?.scope?.kind === "band";
  const previousModel = previous?.trained && !narrowReference && (!current || current.binding === context.binding)
    ? readThermalModel(library.reference?.model ?? previous) : null;
  if (narrowReference) { library.reference = undefined; library.reference_revision = null; }
  const installed = library.reference ? { ...library.reference,
    training_to: library.reference.training_to ?? (typeof previous?.training_to === "string" ? previous.training_to : undefined) }
    : previousModel ? roomReference(previousModel, previous) : undefined;
  const readWindows = async (to = attemptedAt,
    from = new Date(Math.max(Date.parse(library.since), Date.parse(floor))).toISOString()): Promise<HeatingFitWindow[]> => {
    const { data, error } = await db.rpc("get_energy_room_heating_fit_windows", {
      p_home_id: homeId, p_customer_id: customerId, p_room_key: roomKey,
      p_from: from, p_to: to,
    });
    if (error) throw new Error(`get_energy_room_heating_fit_windows: ${error.message}`);
    return data;
  };
  const windows = (await readWindows()).sort((a, b) =>
    Date.parse(b.to_at) - Date.parse(a.to_at) || a.window_key.localeCompare(b.window_key));
  const evidenceChanged = (window: HeatingFitWindow) =>
    !library.window_attempts?.[window.window_key]?.startsWith(`${ROOM_WINDOW_IMPLEMENTATION}:`) ||
    Date.parse(window.evidence_updated_at) > Date.parse(library.window_evidence_updated_at?.[window.window_key] ?? "1970-01-01");
  // Capturing a window counts as a scheduling visit even if its numerical
  // scratch is later superseded. This private journal is not fitted evidence.
  const visits = roomWindowVisitTimes(windowVisits, context.binding);
  const lastVisit = (key: string): number | undefined => {
    const published = library.window_last_attempted_at?.[key];
    const recorded = published !== undefined ? Date.parse(published)
      : library.window_attempts?.[key] !== undefined ? 0 : undefined;
    const captured = visits.get(key);
    return captured === undefined ? recorded : recorded === undefined ? captured : Math.max(captured, recorded);
  };
  const pending = windows.filter(window => evidenceChanged(window) || library.window_solar_pending?.[window.window_key])
    .sort((a, b) => {
      const visitA = lastVisit(a.window_key), visitB = lastVisit(b.window_key);
      const attemptedA = visitA !== undefined, attemptedB = visitB !== undefined;
      // First visit every available seasonal window. Later corrected inputs
      // and unfinished solar traversals are fair by last attempt, so a live
      // newest window cannot starve winter before its first completed fit.
      return Number(attemptedA) - Number(attemptedB) || (attemptedA && attemptedB ? visitA - visitB : 0) ||
        Date.parse(b.to_at) - Date.parse(a.to_at) || a.window_key.localeCompare(b.window_key);
    });
  if (!windows.length) {
    // Keep the standard recent attempt and its explicit diagnostics when no
    // heating window exists; absence of recent heating never erases a model.
    const row = await fitStoredRoom(db, homeId, customerId, roomKey, location, now, library.since, true, context.binding);
    const model = row.trained ? readThermalModel(row) : null;
    return { kind: "model", model: { ...row, heating_bands: { ...library, pending_windows: 0,
      ...(model ? { reference_revision: crypto.randomUUID(), reference: roomReference(model, row) } : {}) } } };
  }
  const latest = windows[0];
  const evidenceAt = windows.reduce((latest, window) => Date.parse(window.evidence_updated_at) > Date.parse(latest)
    ? window.evidence_updated_at : latest, "1970-01-01T00:00:00.000Z");
  // Historical backfill can fill seasonal bands without moving the general
  // reference backwards to an older household state.
  const generalDue = (!installed?.training_to || Date.parse(latest.to_at) >= Date.parse(installed.training_to)) &&
    (library.general_attempt?.implementation !== ROOM_WINDOW_IMPLEMENTATION ||
      Date.parse(evidenceAt) > Date.parse(library.general_attempt.evidence_updated_at) || library.general_solar_pending === true);
  const firstBootstrap = !installed && library.general_attempt?.implementation !== ROOM_WINDOW_IMPLEMENTATION;
  const oldestBandVisit = pending.length ? lastVisit(pending[0].window_key) : undefined;
  const generalVisit = library.general_attempt?.attempted_at
    ? Date.parse(library.general_attempt.attempted_at) : 0;
  // Bootstrap once, then first-visit every seasonal band. After that the
  // general fit shares the same oldest-visit queue: live band arrivals must
  // not indefinitely prevent the recent general reference from refreshing.
  const generalTurn = !pending.length || (oldestBandVisit !== undefined && generalVisit <= oldestBandVisit);
  if (generalDue && (firstBootstrap || generalTurn)) {
    const to = latest.to_at, from = new Date(Math.max(Date.parse(library.since), Date.parse(floor),
      Date.parse(to) - TRAINING_WINDOW_DAYS * 86_400_000)).toISOString();
    const solar = await repairNativeRoomSolar(db, homeId, customerId, roomKey, context.binding, location, from, to, now);
    let updatedAt = evidenceAt;
    if (solar.patched) {
      const refreshed = await readWindows();
      if (refreshed[0]?.to_at === to) updatedAt = refreshed.reduce((latest, window) =>
        Date.parse(window.evidence_updated_at) > Date.parse(latest) ? window.evidence_updated_at : latest, updatedAt);
    }
    const before = inputRevision(await readWindows(to, from));
    const captured = await loadRoomObservations(db, homeId, customerId, roomKey, from, to, true);
    if (before !== inputRevision(await readWindows(to, from))) return { kind: "model", model: {
      home_id: homeId, customer_id: customerId, room_key: roomKey, last_attempted_at: attemptedAt,
      heating_bands: { ...library, pending_windows: pending.length + 1 },
    } };
    const row = await fitLoadedRoom(db, homeId, customerId, roomKey, from, to, captured);
    const model = row.trained ? readThermalModel(row) : null;
    const reference = model ? roomReference(model, row) : installed;
    return { kind: "model", model: { ...(model || !installed ? row : {}), home_id: homeId, customer_id: customerId, room_key: roomKey,
      last_attempted_at: attemptedAt, last_fit_attempt: row.last_fit_attempt,
      heating_bands: { ...library,
        ...(reference ? { reference, reference_revision: model ? crypto.randomUUID() : library.reference_revision } : {}),
        general_attempt: { implementation: ROOM_WINDOW_IMPLEMENTATION, evidence_updated_at: updatedAt, from_at: from, to_at: to, attempted_at: attemptedAt },
        general_solar_pending: solar.unavailable,
        pending_windows: pending.length + Number(solar.unavailable),
      } } };
  }
  if (!pending.length) return { kind: "model", model: { home_id: homeId, customer_id: customerId, room_key: roomKey,
    last_attempted_at: attemptedAt, heating_bands: { ...library, pending_windows: 0 } } };

  let window = pending[0];
  const previousProgress = library.window_solar_progress?.[window.window_key];
  const progress = library.window_solar_pending?.[window.window_key] && previousProgress ? previousProgress : {
    from_at: window.from_at, through_at: window.from_at, to_at: window.to_at,
  };
  // Complete a fixed archive traversal despite live arrivals; a later evidence
  // revision starts another traversal and picks up late/corrected older rows.
  const from = new Date(Math.max(Date.parse(progress.through_at), Date.parse(window.from_at))).toISOString();
  const to = new Date(Math.min(Date.parse(progress.to_at), Date.parse(from) + 31 * 86_400_000)).toISOString();
  const solar = location && Date.parse(to) > Date.parse(from)
    ? await repairNativeRoomSolar(db, homeId, customerId, roomKey, context.binding, location, from, to, now)
    : { unavailable: false, patched: 0 };
  const nextProgress = { ...progress, through_at: solar.unavailable ? progress.through_at : to };
  const solarPending = Boolean(location) && (solar.unavailable || Date.parse(to) < Date.parse(progress.to_at));
  if (solar.patched) {
    // Record only a fingerprint for the exact captured bounds. New arrivals
    // outside this snapshot remain eligible for the next independent attempt.
    const refreshed = (await readWindows()).find(candidate => candidate.window_key === window.window_key &&
      candidate.from_at === window.from_at && candidate.to_at === window.to_at);
    if (refreshed) window = refreshed;
  }
  const progressLibrary = { ...library,
    window_last_attempted_at: { ...library.window_last_attempted_at, [window.window_key]: attemptedAt },
    window_solar_pending: { ...library.window_solar_pending, [window.window_key]: solarPending },
    window_solar_progress: { ...library.window_solar_progress, [window.window_key]: nextProgress },
    pending_windows: pending.length - 1 + Number(solarPending) + Number(generalDue) };
  // Keep an installed model while bounded archive chunks drain. An outage may
  // not block initial learning: fit once without missing solar and retry later.
  if (solarPending && (!solar.unavailable || !evidenceChanged(window))) return { kind: "model", model: {
    home_id: homeId, customer_id: customerId, room_key: roomKey, last_attempted_at: attemptedAt,
    heating_bands: progressLibrary,
  } };
  const captured = await loadRoomObservations(db, homeId, customerId, roomKey, window.from_at, window.to_at, true);
  const after = (await readWindows(window.to_at)).find(candidate => candidate.window_key === window.window_key);
  if (!after || inputRevision([after]) !== inputRevision([window])) return { kind: "model", model: {
    home_id: homeId, customer_id: customerId, room_key: roomKey, last_attempted_at: attemptedAt,
    heating_bands: { ...progressLibrary, pending_windows: Math.max(1, progressLibrary.pending_windows) },
  } };
  const reference = installed ?? null;
  const rows = correctedBandRows(captured, roomKey, reference, library.since);
  return { kind: "band", work: { rows, metadata: {
    version: 1, implementation: ROOM_WINDOW_IMPLEMENTATION,
    homeId, customerId, roomKey, binding: context.binding, baseRevision: previous?.model_revision ?? 0,
    attemptedAt, pinnedFloor: new Date(Math.max(Date.parse(library.since), Date.parse(floor))).toISOString(),
    window, library, progressLibrary, reference,
    ratedPowerW: captured.quarters.at(-1)?.active_power_w ?? null,
    lastAt: captured.quarters.at(-1)?.start_ts ?? window.to_at,
    sourceFreshness: captured.sourceFreshness ?? null,
  } } };
}

/** Scratch metadata is disposable; incompatible state must be captured again. */
export function parseRoomBandMetadata(value: unknown): RoomBandMetadata | null {
  if (!value || typeof value !== "object") return null;
  const row = value as RoomBandMetadata;
  const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
  if (row.version !== 1 || row.implementation !== ROOM_WINDOW_IMPLEMENTATION ||
    ![row.homeId, row.customerId, row.roomKey, row.binding].every(value => typeof value === "string" && value.length > 0) ||
    !Number.isSafeInteger(row.baseRevision) || row.baseRevision < 0 ||
    !date(row.attemptedAt) || !date(row.pinnedFloor) || !date(row.lastAt) ||
    !(row.ratedPowerW === null || typeof row.ratedPowerW === "number" && Number.isFinite(row.ratedPowerW))) return null;
  const window = row.window;
  if (!window || typeof window.window_key !== "string" || !window.window_key ||
    typeof window.fingerprint !== "string" || !window.fingerprint ||
    !Number.isFinite(window.band_c) || heatingBand(window.band_c) !== window.band_c ||
    !date(window.from_at) || !date(window.to_at) || !date(window.evidence_updated_at) ||
    Date.parse(window.from_at) >= Date.parse(window.to_at) || Date.parse(row.pinnedFloor) > Date.parse(window.from_at)) return null;
  for (const value of [row.library, row.progressLibrary]) {
    const parsed = readRoomHeatingBands(value);
    if (!parsed || parsed.binding !== row.binding || parsed.active.length !== value.active.length ||
      parsed.candidates.length !== value.candidates.length || value.reference !== undefined &&
      (!parsed.reference || value.reference?.scope !== undefined && value.reference.scope?.kind !== "general")) return null;
  }
  if (row.reference !== null && (!row.reference || !readThermalModel(row.reference.model) ||
    row.reference.scope !== undefined && row.reference.scope?.kind !== "general" ||
    row.reference.training_to !== undefined && !date(row.reference.training_to))) return null;
  if (row.sourceFreshness !== null) {
    if (!row.sourceFreshness || ![row.sourceFreshness.room, row.sourceFreshness.house].every(part => part &&
      [part.inferred, part.unavailable, part.unverified].every(value => Number.isSafeInteger(value) && value >= 0))) return null;
  }
  return row;
}

/** Re-read the same qualified inputs, without advancing scheduling or solar work. */
export async function recaptureStoredRoomBand(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, metadata: RoomBandMetadata,
): Promise<{ kind: "band"; work: RoomBandWork } | { kind: "superseded" }> {
  if (!parseRoomBandMetadata(metadata) || metadata.homeId !== homeId || metadata.customerId !== customerId ||
    metadata.roomKey !== roomKey) return { kind: "superseded" };
  const { window } = metadata;
  const matches = async () => {
    const { data, error } = await db.rpc("get_energy_room_heating_fit_windows", {
      p_home_id: homeId, p_customer_id: customerId, p_room_key: roomKey,
      p_from: metadata.pinnedFloor, p_to: window.to_at,
    });
    if (error) throw new Error(`get_energy_room_heating_fit_windows: ${error.message}`);
    const found = (data as HeatingFitWindow[]).find(candidate => candidate.window_key === window.window_key);
    return found !== undefined && inputRevision([found]) === inputRevision([window]) &&
      found.band_c === window.band_c && found.evidence_updated_at === window.evidence_updated_at;
  };
  if (!await matches()) return { kind: "superseded" };
  const captured = await loadRoomObservations(db, homeId, customerId, roomKey, window.from_at, window.to_at, true);
  if (!await matches()) return { kind: "superseded" };
  return { kind: "band", work: {
    rows: correctedBandRows(captured, roomKey, metadata.reference, metadata.library.since),
    metadata: { ...metadata, ratedPowerW: captured.quarters.at(-1)?.active_power_w ?? null,
      lastAt: captured.quarters.at(-1)?.start_ts ?? window.to_at, sourceFreshness: captured.sourceFreshness ?? null },
  } };
}

function correctedBandRows(captured: Awaited<ReturnType<typeof loadRoomObservations>>, roomKey: string,
  reference: RoomHeatingReference | null, since: string): RoomMeanQuarter[] {
  const observations = captured.quarters.map(thermalQuarter);
  const corrected = reference ? bandObservations(observations, reference, captured.passive.get(roomKey), captured.doorways) : observations;
  return corrected.filter(row => row.start_ms >= Date.parse(since));
}

export function finalizeStoredRoomBand(metadata: RoomBandMetadata, rows: RoomMeanQuarter[],
  fit: ReturnType<typeof fitIndependentRoomBand>): Record<string, unknown> {
  const { homeId, customerId, roomKey, attemptedAt, window, library, progressLibrary, reference, lastAt, sourceFreshness } = metadata;
  let bands = publishRoomHeatingBandFit(progressLibrary, rows, window.band_c, Date.parse(lastAt), fit);
  const diagnostic = bands.diagnostics?.[window.band_c] as {
    status: string; issues: string[]; learning?: RoomLearningEvidence;
  } | undefined;
  const attempt = { ...(diagnostic ?? { status: "unidentified", issues: ["insufficient_data"] }),
    ...(sourceFreshness ? { source_freshness: sourceFreshness } : {}) };
  // The separate general attempt owns the scalar model and its rejection/sample
  // fields. A band-only publication preserves them even without a reference.
  const diagnosticAttempt = reference ? attempt : { ...attempt, status: "general_unidentified",
    bands_fitted: bands.active.length, issues: [...new Set([...attempt.issues, "general_unidentified"])] };
  bands = { ...bands, ...(reference ? { reference, reference_revision: library.reference_revision ?? crypto.randomUUID() } : {}),
    diagnostics: { ...bands.diagnostics, [window.band_c]: attempt },
    window_attempts: { ...library.window_attempts, [window.window_key]: `${ROOM_WINDOW_IMPLEMENTATION}:${window.fingerprint}` },
    window_evidence_updated_at: { ...library.window_evidence_updated_at, [window.window_key]: window.evidence_updated_at } };
  // Pooled independent bands evolve without repeatedly fitting a general model
  // across all 400 days or replacing its installed reference coefficients.
  return { home_id: homeId, customer_id: customerId, room_key: roomKey,
    last_attempted_at: attemptedAt, last_fit_attempt: diagnosticAttempt, heating_bands: bands };
}

function roomReference(model: ThermalZoneModel, row?: Record<string, unknown>): RoomHeatingReference {
  return { model, ...(typeof row?.training_to === "string" ? { training_to: row.training_to } : {}),
    scope: { kind: "general" }, ...(row?.passive_heat ? { passive_heat: row.passive_heat } : {}),
    ...(row?.doorway_exchange ? { doorway_exchange: row.doorway_exchange } : {}) };
}

export async function fitStoredRoom(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string,
  location: { latitude: number; longitude: number } | null,
  now: number = Date.now(),
  bindingSince?: string,
  native = false,
  heatingBinding?: string,
): Promise<Record<string, unknown>> {
  const trainingTo = new Date(now).toISOString();
  const trainingFrom = new Date(Math.max(now - TRAINING_WINDOW_DAYS * 86_400_000,
    bindingSince ? Date.parse(bindingSince) : -Infinity)).toISOString();
  if (native && heatingBinding) await repairNativeRoomSolar(db, homeId, customerId, roomKey, heatingBinding,
    location, trainingFrom, trainingTo, now);
  else if (!native) await repairRoomSolar(db, homeId, location, trainingFrom, trainingTo);
  const captured = await loadRoomObservations(db, homeId, customerId, roomKey, trainingFrom, trainingTo, native);
  return await fitLoadedRoom(db, homeId, customerId, roomKey, trainingFrom, trainingTo, captured);
}

async function repairNativeRoomSolar(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, binding: string,
  location: { latitude: number; longitude: number } | null, from: string, to: string, now: number,
): Promise<{ unavailable: boolean; patched: number }> {
  if (!location) return { unavailable: false, patched: 0 };
  const points = await historicalIrradiancePoints({ supabase: db, ...location, from, to, now: new Date(now) });
  if (points === null) return { unavailable: true, patched: 0 };
  if (!points.length) return { unavailable: false, patched: 0 };
  const { data, error } = await db.rpc("repair_energy_heating_irradiance", {
    p_home_id: homeId, p_customer_id: customerId, p_room_key: roomKey, p_binding: binding,
    p_from: from, p_to: to, p_points: points,
  });
  if (error) throw new Error(`repair_energy_heating_irradiance: ${error.message}`);
  return { unavailable: false, patched: Number(data) || 0 };
}

async function fitLoadedRoom(
  // deno-lint-ignore no-explicit-any
  db: any, homeId: string, customerId: string, roomKey: string, trainingFrom: string, trainingTo: string,
  { quarters, passive, doorways, sourceFreshness }: Awaited<ReturnType<typeof loadRoomObservations>>,
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
  const fits = fitRoomsFromQuarters(quarters, passive);
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
  const [passive, doorways] = await Promise.all([
    readRoomPassiveHeat(db, customerId, homeId, [roomKey], trainingFrom, trainingTo),
    readDoorwayProbes(db, homeId, [roomKey], trainingFrom, trainingTo),
  ]);
  return { quarters, passive, doorways, sourceFreshness };
}

function fitOptionalRoomResponses(row: Record<string, unknown>, quarters: ThermalQuarterRow[],
  doorways: DoorwayProbeRow[], model: ThermalZoneModel) {
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
  const indoor = reference.model.house_coupling_per_h ?? 0;
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
