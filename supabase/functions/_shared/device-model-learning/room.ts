import { roomResponseTrainingLength } from "../device-learning/room/chronological-evidence.ts";
import type { LearnedMeasuredRoomResponse } from "../device-learning/room/measured-response.ts";
import { ROOM_MEASURED_POLICY, ROOM_MEASUREMENT_METHOD, type MeasuredRoomLedger } from "../planner/models/room/measured-evidence.ts";
import { decodeRoomEvidenceCapture, encodeRoomEvidenceCapture, qualifyRoomEvidenceBlocks, type DecodedRoomEvidenceBlock } from "./room-evidence-capture.ts";
import { qualifyRoomOperationEvidence } from "../device-learning/room/operation-evidence.ts";
import { ROOM_LEARNER_VERSION } from "../room-learner-version.ts";
import { selectDoorwayExchange } from "../device-learning/room/doorway-exchange.ts";
import { readDoorwayProbes, type DoorwayProbeRow } from "../room-doorway-probes.ts";
/** Room-only observation loading. Unknown meter coverage is never an OFF sample. */
import { fitRoomsFromQuarters, TRAINING_WINDOW_DAYS, thermalQuarter, zoneModelRows, type ThermalQuarterRow } from "../thermal-training.ts";
import { roomIntervalHours, roomIntervalSeconds } from "../device-learning/room/mean-evidence.ts";
import { fitIndependentRoomBand, fitRoomMeans, type RoomMeanQuarter, type RoomLearningEvidence } from "../device-learning/room/mean-observations.ts";
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

/** Source archives are independent of fitting policy and derived estimates. */
export const ROOM_SOURCE_IMPLEMENTATION = "chronological_native_evidence_v1";
export const ROOM_RESPONSE_IMPLEMENTATION = `${ROOM_SOURCE_IMPLEMENTATION}:${ROOM_MEASURED_POLICY}:${ROOM_MEASUREMENT_METHOD}:state_carrying_forecast_v1`;
export const ROOM_SHARED_METADATA_VERSION = 2;

export interface RoomEvidenceBasis {
  sourceRevision: number;
  fromAt: string;
  toAt: string;
  implementation: string;
}
export interface RoomTrainingView {
  length: number;
  /** Only training-only freshness decisions differing from the full view. */
  temperatures: [index: number, roomC: number | null, houseC: number | null][];
}
export interface RoomSharedMetadata {
  version: typeof ROOM_SHARED_METADATA_VERSION;
  implementation: string;
  homeId: string;
  customerId: string;
  roomKey: string;
  binding: string;
  baseRevision: number;
  attemptedAt: string;
  fromAt: string;
  historyTo: string;
  evidence: RoomEvidenceBasis;
  trainingView: RoomTrainingView;
  library: RoomHeatingBands;
  /** Exact accepted JSON: readers normalize nullable fields, publication must not. */
  acceptedReference?: unknown;
  ratedPowerW: number | null;
  roomName: string;
  sourceFreshness: ProbeFreshnessReport | null;
}
export interface RoomLearningOwner {
  id: string;
  home_id: string;
  customer_id: string;
  owner_key: string;
  generation: number;
  fence: number;
}
export interface RoomLearningClock { historyTo: number; wallNow: number }
export type RoomHeatingPreparation =
  | { kind: "model"; model: Record<string, unknown> }
  | { kind: "refreshed" }
  | { kind: "superseded" }
  | { kind: "shared"; work: { metadata: RoomSharedMetadata; rows: RoomMeanQuarter[]; policyFingerprint: string } };
interface EvidenceWork {
  source_revision: number;
  policy_fingerprint: string;
  next: { from_at: string; to_at: string; solar_retry_at?: string | null; solar_after?: string | null } | null;
}
interface EvidenceBlock {
  from_at: string; to_at: string; sha256: string; row_count: number; capture: string;
}
export const isRoomPolicyFingerprint = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const sameEvidence = (a: RoomEvidenceBasis | undefined, b: RoomEvidenceBasis) => a !== undefined &&
  a.sourceRevision === b.sourceRevision && a.fromAt === b.fromAt && a.toAt === b.toAt && a.implementation === b.implementation;

/** Restore the separately qualified chronological training prefix. Its sparse
 * deltas describe source qualification, never corrections to measured history. */
export function roomResponseEvidence(rows: RoomMeanQuarter[], view: RoomTrainingView) {
  const trainingRows = rows.slice(0, view.length).map(row => ({ ...row }));
  for (const [index, room_c, house_c] of view.temperatures) Object.assign(trainingRows[index], { room_c, house_c });
  return { fullRows: rows, trainingRows };
}

/** One owner refreshes one dirty source extent, or captures the complete
 * chronological archive. Uploads only mark source dirt. Every supported
 * transition remains available, independently of complete heating events. */
export async function prepareStoredRoomHeating(
  // deno-lint-ignore no-explicit-any
  db: any, owner: RoomLearningOwner, context: RoomHeatingContext,
  previous: StoredDeviceModel | undefined, location: { latitude: number; longitude: number } | null, clock: RoomLearningClock,
): Promise<RoomHeatingPreparation> {
  const { home_id: homeId, customer_id: customerId, owner_key: roomKey } = owner;
  const current = readRoomHeatingBands(previous?.heating_bands);
  const storedLibrary = previous?.heating_bands;
  const acceptedReference = current?.binding === context.binding && current.reference &&
    storedLibrary && typeof storedLibrary === "object" && "reference" in storedLibrary
    ? storedLibrary.reference : undefined;
  const historyTo = new Date(clock.historyTo).toISOString(), attemptedAt = new Date(clock.wallNow).toISOString();
  const floorMs = clock.historyTo - 400 * 86_400_000;
  const since = current?.binding === context.binding
    ? new Date(Math.min(Date.parse(current.since), Date.parse(context.observed_since ?? current.since))).toISOString()
    : context.observed_since ?? new Date(floorMs).toISOString();
  const fromAt = new Date(Math.max(floorMs, Date.parse(since))).toISOString();
  // Remove the retired window traversal state while retaining accepted revisions.
  const { window_attempts: _attempts, window_last_attempted_at: _visits, window_solar_pending: _solar,
    window_solar_retry_at: _retry, window_evidence_updated_at: _updates, window_solar_progress: _progress,
    general_attempt: _general, general_solar_pending: _generalSolar, general_solar_retry_at: _generalRetry,
    ...retained } = current?.binding === context.binding ? current : {
      binding: context.binding, since, reference_revision: null, active: [], candidates: [], attempted: {},
      ...(current?.reference_revision || current?.previous_reference_revision
        ? { previous_reference_revision: (current.reference_revision ?? current.previous_reference_revision)! } : {}),
    };
  const library: RoomHeatingBands = { ...retained, since, calibration_policy: ROOM_MEASURED_POLICY };
  const bookkeeping = (): RoomHeatingPreparation => ({ kind: "model", model: {
    home_id: homeId, customer_id: customerId, room_key: roomKey, last_attempted_at: attemptedAt,
    heating_bands: { ...library, ...(acceptedReference !== undefined ? { reference: acceptedReference } : {}), pending_windows: 0 },
  } });
  const scope = { p_home_id: homeId, p_customer_id: customerId, p_room_key: roomKey, p_binding: context.binding,
    p_from_at: fromAt, p_to_at: historyTo, p_implementation: ROOM_SOURCE_IMPLEMENTATION };
  const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data as T;
  };
  const readWork = async () => {
    const work = await rpc<EvidenceWork>("get_energy_room_evidence_work", scope);
    if (!work || !isRoomPolicyFingerprint(work.policy_fingerprint) || !Number.isSafeInteger(work.source_revision) || work.source_revision < 0 ||
      (work.next !== null && (!work.next || !Number.isFinite(Date.parse(work.next.from_at)) || !Number.isFinite(Date.parse(work.next.to_at))))) {
      throw new Error("Invalid chronological room evidence work");
    }
    return work;
  };
  if (Date.parse(fromAt) >= clock.historyTo) return bookkeeping();
  let work = await readWork();
  if (work.next) {
    const range = work.next;
    const solar = await repairNativeRoomSolar(db, homeId, customerId, roomKey, context.binding, location,
      range.from_at, range.to_at, clock.wallNow, range.solar_after ?? undefined, range.solar_retry_at);
    // Irradiance repair changes canonical source evidence. Capture its new clock
    // before the history read and let the database fence concurrent corrections.
    if (solar.patched) work = await readWork();
    const readTo = new Date(Date.parse(range.to_at) + HOUR_MS).toISOString();
    const rows = (await readRoomQuarters(db, homeId, customerId, roomKey,
      new Date(Date.parse(range.from_at) - HOUR_MS).toISOString(), readTo, true))
      .filter(row => Date.parse(row.start_ts) >= Date.parse(range.from_at) && Date.parse(row.start_ts) < Date.parse(range.to_at));
    const capture = await encodeRoomEvidenceCapture(rows, range.from_at, range.to_at);
    const saved = await rpc<boolean>("save_energy_room_evidence_block", {
      p_job_id: owner.id, p_generation: owner.generation, p_fence: owner.fence, p_revision: previous?.model_revision ?? 0,
      p_binding: context.binding, p_source_revision: work.source_revision,
      p_from_at: range.from_at, p_to_at: range.to_at, p_implementation: ROOM_SOURCE_IMPLEMENTATION,
      p_capture_base64: capture.base64, p_sha256: capture.sha256, p_row_count: capture.row_count,
      p_solar_retry_at: solar.pending ? solar.retry_at : null,
      p_solar_after: solar.pending ? solar.through_at ?? range.from_at : null,
    });
    return { kind: saved ? "refreshed" : "superseded" };
  }
  const evidence: RoomEvidenceBasis = { sourceRevision: work.source_revision, fromAt, toAt: historyTo, implementation: ROOM_SOURCE_IMPLEMENTATION };
  // A changed learner refits the same evidence; an unchanged one has nothing to add.
  if (library.shared_attempt?.implementation === ROOM_RESPONSE_IMPLEMENTATION &&
    (library.shared_attempt as { learner_version?: string }).learner_version === ROOM_LEARNER_VERSION &&
    sameEvidence(library.shared_attempt.evidence, evidence)) {
    return bookkeeping();
  }
  const blocks = await rpc<EvidenceBlock[]>("load_energy_room_evidence_blocks", scope);
  if (!Array.isArray(blocks)) throw new Error("Invalid chronological room evidence blocks");
  const decoded: DecodedRoomEvidenceBlock[] = [];
  // Consume the transport owners as we decode; qualification sorts the
  // disjoint extents chronologically after reconstruction.
  for (let block = blocks.pop(); block; block = blocks.pop()) {
    const rows = await decodeRoomEvidenceCapture(block.capture, block.from_at, block.to_at, block.sha256);
    if (rows.length !== block.row_count) throw new Error("Room evidence block row count mismatch");
    decoded.push({ from_at: block.from_at, to_at: block.to_at, rows });
  }
  const qualified = qualifyRoomEvidenceBlocks(decoded, roomKey, fromAt, historyTo);
  const rows = qualified.quarters.map(thermalQuarter);
  const length = roomResponseTrainingLength(rows.map(row => row.duration_s ?? 900));
  const trainingTo = length ? new Date(rows[length - 1].start_ms + roomIntervalSeconds(rows[length - 1]) * 1000).toISOString() : fromAt;
  const training = length ? qualifyRoomEvidenceBlocks(decoded, roomKey, fromAt, trainingTo).quarters : [];
  // Horizon clipping above owns complete intervals. Training follows the exact
  // prefix even when an interval straddles the chosen endpoint elsewhere.
  if (training.length !== length) throw new Error("Room evidence training prefix mismatch");
  const ratedPowerW = qualified.quarters.at(-1)?.active_power_w ?? null;
  const roomName = qualified.quarters.at(-1)?.room_name ?? (typeof previous?.room_name === "string" ? previous.room_name : roomKey);
  const temperatures: RoomTrainingView["temperatures"] = [];
  training.forEach((row, index) => {
    if (row.room_temperature_c !== rows[index].room_c || row.house_temperature_c !== rows[index].house_c) {
      temperatures.push([index, row.room_temperature_c, row.house_temperature_c]);
    }
  });
  // Numerical capture has no use for raw probe vectors or duplicate transport
  // rows. Drop their owners before the checkpoint encoder allocates its buffer.
  decoded.length = 0;
  training.length = 0;
  qualified.quarters.length = 0;
  return { kind: "shared", work: { rows, policyFingerprint: work.policy_fingerprint, metadata: {
    version: ROOM_SHARED_METADATA_VERSION, implementation: ROOM_RESPONSE_IMPLEMENTATION,
    homeId, customerId, roomKey, binding: context.binding, baseRevision: previous?.model_revision ?? 0,
    attemptedAt, fromAt, historyTo, evidence, trainingView: { length, temperatures }, library,
    ratedPowerW, roomName, ...(acceptedReference !== undefined ? { acceptedReference } : {}),
    sourceFreshness: qualified.sourceFreshness,
  } } };
}

/** Scratch is disposable; incompatible or corrupt qualifications are captured again. */
export function parseRoomSharedMetadata(value: unknown): RoomSharedMetadata | null {
  if (!value || typeof value !== "object") return null;
  const row = value as RoomSharedMetadata;
  const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
  const finite = (v: unknown): v is number | null => v === null || typeof v === "number" && Number.isFinite(v);
  if (row.version !== ROOM_SHARED_METADATA_VERSION || row.implementation !== ROOM_RESPONSE_IMPLEMENTATION ||
    ![row.homeId, row.customerId, row.roomKey, row.binding].every(v => typeof v === "string" && v.length > 0) ||
    !Number.isSafeInteger(row.baseRevision) || row.baseRevision < 0 || !date(row.attemptedAt) || !date(row.fromAt) || !date(row.historyTo) ||
    !row.evidence || !Number.isSafeInteger(row.evidence.sourceRevision) || row.evidence.sourceRevision < 0 ||
    row.evidence.fromAt !== row.fromAt || row.evidence.toAt !== row.historyTo || row.evidence.implementation !== ROOM_SOURCE_IMPLEMENTATION ||
    !row.trainingView || !Number.isSafeInteger(row.trainingView.length) || row.trainingView.length < 0 ||
    !Array.isArray(row.trainingView.temperatures) || !row.trainingView.temperatures.every((entry, index, all) =>
      Array.isArray(entry) && entry.length === 3 && Number.isSafeInteger(entry[0]) && entry[0] >= 0 && entry[0] < row.trainingView.length &&
      (index === 0 || entry[0] > all[index - 1][0]) && finite(entry[1]) && finite(entry[2])) ||
    !finite(row.ratedPowerW) || typeof row.roomName !== "string") return null;
  const library = readRoomHeatingBands(row.library);
  if (!library || library.binding !== row.binding) return null;
  const accepted = row.acceptedReference;
  if (library.reference && accepted === undefined) return null;
  if (accepted !== undefined && (!library.reference || !accepted || typeof accepted !== "object" ||
    !("model" in accepted) || !readThermalModel(accepted.model))) return null;
  if (row.sourceFreshness !== null && (!row.sourceFreshness || ![row.sourceFreshness.room, row.sourceFreshness.house].every(part =>
    part && [part.inferred, part.unavailable, part.unverified].every(v => Number.isSafeInteger(v) && v >= 0)))) return null;
  return row;
}

/** A failed attempt retains the accepted response; only a complete numerical
 * fit publishes a new shared model and its revision-scoped assessments. */
export function finalizeStoredRoomResponse(metadata: RoomSharedMetadata, rows: RoomMeanQuarter[],
  fit: LearnedMeasuredRoomResponse): { model: Record<string, unknown>; ledger: MeasuredRoomLedger | null } {
  const { homeId, customerId, roomKey, attemptedAt, library, sourceFreshness, evidence } = metadata;
  const learning = fit.result.learning_evidence;
  const attempt = { status: fit.result.ok ? "fitted" : "unidentified",
    issues: fit.result.ok ? fit.result.warnings ?? [] : [fit.result.reason], learning,
    ...(sourceFreshness ? { source_freshness: sourceFreshness } : {}) };
  const physical = fit.result.ok ? fit.result.model : null;
  const revision = physical ? crypto.randomUUID() : null;
  const trainingFrom = rows.length ? new Date(rows[0].start_ms).toISOString() : metadata.fromAt;
  const trainingTo = rows.length ? new Date(rows.at(-1)!.start_ms + roomIntervalSeconds(rows.at(-1)!)*1000).toISOString() : metadata.historyTo;
  const dynamic = physical && !isEquilibrium(physical) ? physical : null;
  // The complete response, including gain's weather coordinate, lives in the
  // revisioned reference JSON. The scalar table has no weather-gain columns.
  const scalar = dynamic ? Object.fromEntries(Object.entries(dynamic).filter(([key]) =>
    !["response_family", "gain_reference_outdoor_c", "gain_outdoor_slope_per_c"].includes(key))) : physical ? {
    gain_c_per_wh: null, cooling_constant_per_h: null, background_gain_c_per_h: null,
    thermal_capacity_wh_per_c: null, heat_loss_w_per_c: null, time_constant_h: null, heating_rate_c_per_h: null,
    house_coupling_per_h: null, solar_gain_c_per_h_per_wm2: null, r2: physical.r2,
    residual_std_c: physical.residual_std_c, heat_lag_h: physical.heat_lag_h ?? null,
    prediction_error_c: physical.prediction_error_c ?? null, solar_mean_w_per_m2: physical.solar_mean_w_per_m2 ?? null,
  } : {};
  const shared_attempt = { implementation: ROOM_RESPONSE_IMPLEMENTATION, learner_version: ROOM_LEARNER_VERSION, evidence, attempted_at: attemptedAt,
    status: physical ? "fitted" as const : "unidentified" as const };
  const accepted = library.reference !== undefined || library.active.length > 0;
  const { diagnostics: _diagnostics, ...kept } = library;
  const heating_bands: RoomHeatingBands = physical && fit.result.ok
    ? { ...kept, reference: { model: physical, scope: { kind: "shared" }, training_from: trainingFrom, training_to: trainingTo,
      warnings: fit.result.warnings ?? [], learning_evidence: { ...learning, source_evidence: evidence } }, reference_revision: revision,
      active: [], candidates: [], attempted: {}, shared_attempt, pending_windows: 0 }
    : { ...library, shared_attempt, pending_windows: 0 };
  const ledger = fit.run_ledger ? { ...fit.run_ledger, assessed_against: revision ?? library.reference_revision ?? null } : null;
  return { ledger, model: { home_id: homeId, customer_id: customerId, room_key: roomKey, room_name: metadata.roomName,
    ...(!physical && !accepted ? { trained: false, rejection_reason: fit.result.ok ? "insufficient_samples" : fit.result.reason,
      sample_count: rows.length, training_from: trainingFrom, training_to: trainingTo } : {}),
    ...(physical ? { ...scalar, trained: true, rejection_reason: null, sample_count: physical.sample_count,
      fitted_at: attemptedAt, training_from: trainingFrom, training_to: trainingTo, passive_heat: null, doorway_exchange: null } : {}),
    last_attempted_at: attemptedAt, last_fit_attempt: attempt,
    heating_bands: !physical && metadata.acceptedReference !== undefined
      ? { ...heating_bands, reference: metadata.acceptedReference } : heating_bands } };
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
