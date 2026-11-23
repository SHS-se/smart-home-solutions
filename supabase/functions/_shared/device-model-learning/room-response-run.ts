import { ROOM_RESPONSE_CELL_COUNT, prepareRoomResponse, advanceRoomResponseCells, finalizeRoomResponse } from "../device-learning/room/response-learning.ts";
import { captureDeviceModels, type ModelDatabase, type RoomHeatingContext } from "../device-model-store.ts";
import {
  parseRoomHeatFitState, parseRoomBandFitCells, type RoomMeanQuarter,
} from "../device-learning/room/mean-observations.ts";
import { decodeRoomResponseFitCapture, encodeRoomResponseFitCapture } from "./room-band-fit-capture.ts";
import {
  ROOM_RESPONSE_IMPLEMENTATION, finalizeStoredRoomResponse, parseRoomSharedMetadata, roomResponseEvidence,
  fitStoredRoom, isRoomPolicyFingerprint, prepareStoredRoomHeating, type RoomLearningClock, type RoomLearningOwner, type RoomSharedMetadata,
} from "./room.ts";

/** Envelope 4: every chronological transition plus its independently qualified training view. */
export const ROOM_FIT_CAPTURE_VERSION = 4;
/** Total numerical work per request, shared by all cells it completes. */
export const ROOM_FIT_NUMERIC_BUDGET_MS = 650;
interface RoomLearningClaim extends RoomLearningOwner {
  room_history_to: string | null;
  room_fit_progress?: unknown;
  input: { location?: { latitude: number; longitude: number } | null };
}
type RoomLearningStep = { kind: "model"; model: Record<string, unknown>; revision: number }
  | { kind: "handled"; result: { checkpointed?: boolean; published?: boolean; superseded?: boolean } };

function roomLearningClock(historyTo: string | null, wallNow: number): RoomLearningClock {
  const parsed = typeof historyTo === "string" ? Date.parse(historyTo) : NaN;
  if (!Number.isFinite(parsed)) throw new Error("Room learning claim has no history horizon");
  return { historyTo: parsed, wallNow };
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// PostgreSQL policy changes and review boundaries have microsecond precision.
function auditMicros(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const time = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.(\d{1,6}))?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  const ms = Date.parse(value);
  if (!time || !Number.isFinite(ms)) return null;
  return BigInt(ms) * 1000n + BigInt((time[1] ?? "").padEnd(6, "0").slice(3));
}

const operationWitnessFields = new Set(["id", "home_id", "customer_id", "room_key", "binding", "kind", "basis", "from_at", "to_at", "created_at"]);

/** A pre-policy v4 capsule can adopt the current reviewed policy exactly once.
 * Check every captured operation witness and every known heater reading against
 * the scoped review rows returned with that fingerprint in one SQL snapshot. */
function auditedPolicy(value: unknown, metadata: RoomSharedMetadata, rows: readonly RoomMeanQuarter[]) {
  if (!object(value) || !isRoomPolicyFingerprint(value.policy_fingerprint) ||
    !Array.isArray(value.operation_facts) || !Array.isArray(value.exclusions)) return null;
  const captured = auditMicros(metadata.attemptedAt), sourcePolicy = auditMicros(value.source_policy_at);
  if (captured === null || sourcePolicy === null || sourcePolicy > captured) return null;
  const facts = new Map<string, { from: bigint; to: bigint; created: bigint; record: Record<string, unknown> }>();
  for (const fact of value.operation_facts) {
    if (!object(fact) || Object.keys(fact).some(key => !operationWitnessFields.has(key)) ||
      typeof fact.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(fact.id) ||
      facts.has(fact.id) || fact.home_id !== metadata.homeId || fact.customer_id !== metadata.customerId ||
      fact.room_key !== metadata.roomKey || fact.binding !== metadata.binding || fact.kind !== "heating_off_fan" ||
      (fact.basis !== "customer_assertion" && fact.basis !== "source_capability")) return null;
    const from = auditMicros(fact.from_at), to = auditMicros(fact.to_at), created = auditMicros(fact.created_at);
    if (from === null || to === null || created === null || from >= to || (fact.basis === "customer_assertion" && created > captured)) return null;
    facts.set(fact.id, { from, to, created, record: fact });
  }
  const exclusions: { from: bigint; to: bigint }[] = [];
  for (const exclusion of value.exclusions) {
    if (!object(exclusion)) return null;
    const from = auditMicros(exclusion.from_at), to = auditMicros(exclusion.to_at);
    if (from === null || to === null || from >= to) return null;
    exclusions.push({ from, to });
  }
  exclusions.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
  const witnesses = new Set<Record<string, unknown>>();
  let i = 0;
  const ordered = exclusions.length ? rows.toSorted((a, b) => a.start_ms - b.start_ms) : rows;
  for (const row of ordered) {
    if (!row.operation_fact && (row.heat_w === null || !exclusions.length)) continue;
    const from = BigInt(row.start_ms) * 1000n, to = from + BigInt(row.duration_s ?? 900) * 1_000_000n;
    if (row.operation_fact) {
      const witness = facts.get(row.operation_fact);
      if (!witness || witness.created > captured || witness.from > from || witness.to < to) return null;
      witnesses.add(witness.record);
    }
    if (row.heat_w === null) continue;
    while (i < exclusions.length && exclusions[i].to <= from) i++;
    if (i < exclusions.length && exclusions[i].from < to) return null;
  }
  return { fingerprint: value.policy_fingerprint, witnesses: [...witnesses] };
}

function roomFitRpc(db: ModelDatabase, claim: RoomLearningClaim, revision: number) {
  const basis = { p_job_id: claim.id, p_generation: claim.generation, p_fence: claim.fence, p_revision: revision };
  return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await db.rpc(name, { ...basis, ...args });
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  };
}

/** The claim transaction has checked progress against the live room binding
 * and model revision. Each numerical RPC repeats the write fence. Fresh
 * acquisition alone needs household model discovery and historical context. */
export async function runRoomLearning(db: ModelDatabase, claim: RoomLearningClaim, wallNow: number): Promise<RoomLearningStep> {
  const clock = roomLearningClock(claim.room_history_to, wallNow);
  if (claim.room_fit_progress != null) return await resumeRoomFit(db, claim, clock, claim.room_fit_progress);
  const models = await captureDeviceModels(db, claim.home_id);
  const previous = models.rooms.find(model => model.room_key === claim.owner_key);
  const revision = previous?.model_revision ?? 0;
  const captured = models.roomHeating?.[claim.owner_key];
  const location = claim.input.location ?? null;
  if (!captured) {
    const model = await fitStoredRoom(db, claim.home_id, claim.customer_id, claim.owner_key, location, clock);
    return { kind: "model", model, revision };
  }
  const history = await db.rpc("get_energy_room_heating_context", { p_home_id: claim.home_id, p_room_key: claim.owner_key });
  if (history.error) throw new Error(history.error.message);
  const context: RoomHeatingContext = history.data ?? captured;
  const prepared = await prepareStoredRoomHeating(db, claim, context, previous, location, clock);
  if (prepared.kind === "model") return { ...prepared, revision };
  if (prepared.kind === "refreshed") return { kind: "handled", result: { checkpointed: true } };
  if (prepared.kind === "superseded") return { kind: "handled", result: { superseded: true } };
  const { metadata, rows, policyFingerprint } = prepared.work;
  const capture = await encodeRoomResponseFitCapture(rows, metadata.fromAt);
  const rpc = roomFitRpc(db, claim, revision);
  const saved = await rpc("checkpoint_energy_room_fit", {
    p_expected_cursor: -1,
    p_metadata: { version: ROOM_FIT_CAPTURE_VERSION, runtime: Deno.version.v8, capture: metadata,
      sha256: capture.sha256, row_count: capture.row_count, policy_fingerprint: policyFingerprint },
    p_capture_base64: capture.base64, p_cell: null,
  });
  return { kind: "handled", result: { checkpointed: saved === true, ...(saved === true ? {} : { superseded: true }) } };
}

async function resumeRoomFit(db: ModelDatabase, claim: RoomLearningClaim, clock: RoomLearningClock,
  progress: unknown): Promise<RoomLearningStep> {
  if (!object(progress) || !Number.isInteger(progress.cursor) || Number(progress.cursor) < 0) throw new Error("Invalid room fit progress cursor");
  const revision = progress.base_revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid room fit base revision");
  const rpc = roomFitRpc(db, claim, revision);
  const reset = async (cursor: number): Promise<RoomLearningStep> => {
    await rpc("reset_energy_room_fit", { p_expected_cursor: cursor });
    return { kind: "handled", result: { superseded: true } };
  };
  if (Number(progress.cursor) > ROOM_RESPONSE_CELL_COUNT) return await reset(Number(progress.cursor));
  const cursor = Number(progress.cursor), envelope = progress.metadata;
  const metadata = object(envelope) ? parseRoomSharedMetadata(envelope.capture) : null;
  if (!object(envelope) || envelope.version !== ROOM_FIT_CAPTURE_VERSION || envelope.runtime !== Deno.version.v8 || !metadata ||
    metadata.implementation !== ROOM_RESPONSE_IMPLEMENTATION || ("policy_fingerprint" in envelope && !isRoomPolicyFingerprint(envelope.policy_fingerprint)) ||
    metadata.homeId !== claim.home_id || metadata.customerId !== claim.customer_id || metadata.roomKey !== claim.owner_key ||
    metadata.baseRevision !== revision ||
    Date.parse(metadata.historyTo) > clock.historyTo ||
    typeof envelope.sha256 !== "string" || !Number.isSafeInteger(envelope.row_count) || Number(envelope.row_count) < 0 ||
    metadata.trainingView.length > Number(envelope.row_count)) return await reset(cursor);
  let cells;
  try {
    if (!Array.isArray(progress.cells) || progress.cells.length > ROOM_RESPONSE_CELL_COUNT) return await reset(cursor);
    cells = parseRoomBandFitCells(progress.cells);
  }
  catch { return await reset(cursor); }
  if (cells.length !== cursor) return await reset(cursor);
  const encoded = await rpc("load_energy_room_fit_capture", {});
  if (encoded === null) return await reset(cursor);
  if (typeof encoded !== "string") throw new Error("Invalid room fit capture response");
  let rows;
  try { rows = await decodeRoomResponseFitCapture(encoded, metadata.fromAt, envelope.sha256); }
  catch { return await reset(cursor); }
  if (rows.length !== envelope.row_count) return await reset(cursor);
  if (!("policy_fingerprint" in envelope)) {
    const sha = { p_expected_sha: envelope.sha256 };
    const audit = await rpc("get_energy_room_fit_policy_audit", sha);
    if (audit === null) return { kind: "handled", result: { superseded: true } };
    const policy = auditedPolicy(audit, metadata, rows);
    if (policy === null) return await reset(cursor);
    const saved = await rpc("certify_energy_room_fit_policy", { ...sha, p_policy_fingerprint: policy.fingerprint,
      p_operation_witnesses: policy.witnesses });
    return { kind: "handled", result: saved === true ? { checkpointed: true } : { superseded: true } };
  }
  let prepared;
  try { prepared = prepareRoomResponse(roomResponseEvidence(rows, metadata.trainingView), metadata.ratedPowerW); }
  catch { return await reset(cursor); }
  if (cursor < ROOM_RESPONSE_CELL_COUNT) {
    let heatState;
    try { heatState = parseRoomHeatFitState(envelope.heat_state, cursor); }
    catch { return await reset(cursor); }
    // One bounded numerical budget per request across as many cells as it
    // completes, then one fenced write of them and the next partial state.
    const batch = advanceRoomResponseCells(prepared, cells, heatState, ROOM_FIT_NUMERIC_BUDGET_MS);
    const saved = await rpc("checkpoint_energy_room_fit_cells", {
      p_expected_cursor: cursor, p_expected_state: envelope.heat_state ?? null,
      p_cells: batch.cells, p_heat_state: batch.state,
    });
    return { kind: "handled", result: { checkpointed: saved === true, ...(saved === true ? {} : { superseded: true }) } };
  }
  // Publication checks the captured policy, binding and model revision.
  // Ordinary observation corrections remain queued for the next fit.
  const fit = finalizeRoomResponse(prepared, cells);
  const final = finalizeStoredRoomResponse(metadata, rows, fit);
  const published = await rpc("complete_energy_room_fit", { p_expected_cursor: cursor, p_model: final.model, p_run_ledger: final.ledger });
  return { kind: "handled", result: { published: published === true, ...(published === true ? {} : { superseded: true }) } };
}
