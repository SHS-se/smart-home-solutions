import { advanceConnectedProcessInference, beginConnectedProcessInference, connectedProcessResponse, CONNECTED_PROCESS_REPLICAS,
  type ConnectedProcessProgress } from "../device-learning/room/connected-process.ts";
import type { ConnectedFitProgress, ConnectedRoomFit } from "../device-learning/room/connected-response.ts";
import type { RoomMeanQuarter } from "../device-learning/room/mean-observations.ts";
import type { ConnectedProcessBelief, ConnectedRoomResponse } from "../planner/models/room/connected-exchange.ts";
import { OwnedPlanningArtifactError, packOwnedPlanningValue, unpackOwnedPlanningValue } from "../owned-planning-codec.ts";

type Member = ConnectedProcessBelief["hypotheses"][number];
type Work = NonNullable<ConnectedProcessProgress["work"]>;
type Priors = Omit<ConnectedProcessBelief, "replicas" | "hypotheses">;
export interface RoomReplicaTiming { unpack_ms?: number; pack_ms?: number }
interface SharedProcess {
  result: ConnectedRoomFit & { response: ConnectedRoomResponse };
  priors: Priors;
  numerical_failures: number;
}

interface Replica { index: number; row: number; done: boolean; blob: string }
interface RowWindow { base64: string; sha256: string; from_at: string; row_from: number; total_rows: number }
export type ProcessClaim =
  | { kind: "replica"; model: ConnectedRoomResponse; priors: Priors; replica: Replica; window: RowWindow }
  | { kind: "finish"; shared: SharedProcess; replicas: Replica[] }
  | { kind: "result"; result: ConnectedRoomFit };

export type ConnectedFitTurn =
  | { kind: "optimizer"; state: ConnectedFitProgress }
  | { kind: "result"; result: ConnectedRoomFit }
  | { kind: "start_process"; shared: SharedProcess; replicas: Replica[] }
  | { kind: "replica"; replica: Replica };

type Clock = [through: number, observations: number, storedHeat: number, identified: boolean];
type PackedMember = [multiplicity: number, logWeight: number, edgeIds: number[], clockId: number, temperature: number,
  rates: number[], centers: number[] | null, covariance: number[][], hazardId: number];
interface PackedWork {
  through_ms: number; parent: number; copy: number; rng_state: number;
  children: PackedMember[]; candidates: [number, number][];
  continuation?: { child: PackedMember | number; potential: number };
}
interface Packet {
  descriptor: ConnectedProcessBelief["replicas"][number]; failures: number;
  edges: Member["incoming"]; clocks: Clock[]; hazards: Member["hazards"][];
  members: PackedMember[]; work?: PackedWork;
}

// Many members descend from the same regime. Store each distinct parameter set
// and common clock once, retaining full precision and covariance in both directions.
function dictionary<T>() {
  const entries: T[] = [], indices = new Map<string, number>();
  return { entries, index(value: T): number {
    const key = JSON.stringify(value), found = indices.get(key);
    if (found !== undefined) return found;
    indices.set(key, entries.length);
    return entries.push(value) - 1;
  } };
}

async function packReplica(descriptor: Packet["descriptor"], members: Member[], failures: number, work?: Work): Promise<string> {
  const edges = dictionary<Member["incoming"][number]>(), clocks = dictionary<Clock>(), hazards = dictionary<Member["hazards"]>();
  const pack = (member: Member): PackedMember => {
    const p = member.posterior;
    return [member.multiplicity, member.log_weight, member.incoming.map(edges.index),
      clocks.index([p.through_ms, p.observations, p.stored_heat_c, member.thermal_state_identified]),
      p.temperature_c, p.log_rates, p.log_centers ?? null, p.covariance, hazards.index(member.hazards)];
  };
  const packet: Packet = { descriptor, failures, edges: edges.entries, clocks: clocks.entries,
    hazards: hazards.entries, members: members.map(pack) };
  if (work) {
    const c = work.continuation;
    packet.work = { through_ms: work.through_ms, parent: work.parent, copy: work.copy, rng_state: work.rng_state,
      children: work.children.map(pack), candidates: work.candidates.map(({ child, log_weight }) => [child, log_weight]),
      ...(c ? { continuation: { child: c.retained ?? pack(c.child), potential: c.potential } } : {}) };
  }
  return await packOwnedPlanningValue(packet);
}

async function unpackReplica(replica: Replica, index: number) {
  const packet = await unpackOwnedPlanningValue<Packet>(replica.blob);
  try { return restoreReplica(packet, index); }
  catch { throw new OwnedPlanningArtifactError("Unreadable connected fit replica"); }
}

function restoreReplica(packet: Packet, index: number) {
  const descriptor = packet.descriptor;
  if (!Number.isSafeInteger(descriptor.rng_state) || !Number.isSafeInteger(descriptor.particles) || descriptor.particles < 1 ||
    !Number.isFinite(descriptor.log_evidence) || !Number.isSafeInteger(packet.failures) || packet.failures < 0 ||
    !Array.isArray(packet.members) || !packet.members.length) throw new Error("Invalid replica descriptor");
  const unpack = ([multiplicity, log_weight, edgeIds, clockId, temperature_c, log_rates, centers, covariance, hazardId]: PackedMember): Member => {
    const [through_ms, observations, stored_heat_c, thermal_state_identified] = packet.clocks[clockId];
    const incoming = edgeIds.map(id => packet.edges[id]), hazards = packet.hazards[hazardId];
    const dimensions = 2 + log_rates.length + (centers?.length ?? 0);
    if (incoming.some(edge => !edge) || hazards.length !== incoming.length || !Number.isSafeInteger(multiplicity) || multiplicity < 1 ||
      !Number.isFinite(log_weight) || covariance.length !== dimensions || covariance.some(row => row.length !== dimensions)) {
      throw new Error("Invalid replica member");
    }
    return { replica: index, multiplicity, log_weight, incoming, thermal_state_identified, hazards, posterior: { through_ms, observations,
        temperature_c, stored_heat_c, log_rates, ...(centers === null ? {} : { log_centers: centers }), covariance } };
  };
  let work: Work | undefined;
  if (packet.work) {
    const w = packet.work, children = w.children.map(unpack), c = w.continuation;
    if (w.candidates.some(([child]) => !children[child]) || typeof c?.child === "number" && !children[c.child]) {
      throw new Error("Invalid in-flight child reference");
    }
    work = { through_ms: w.through_ms, replica: index, parent: w.parent, copy: w.copy, rng_state: w.rng_state,
      children, candidates: w.candidates.map(([child, log_weight]) => ({ child, log_weight })),
      ...(c ? { continuation: { potential: c.potential, ...(typeof c.child === "number"
        ? { retained: c.child, child: children[c.child] } : { child: unpack(c.child) }) } } : {}) };
  }
  return { descriptor: packet.descriptor, failures: packet.failures, members: packet.members.map(unpack), work };
}

/** The body fit has finished. Numerical replicas have independent random streams.
 * At a mid-row split earlier replicas already own the next native-row boundary. */
export async function checkpointConnectedFit(next: ConnectedFitProgress, rows: RoomMeanQuarter[], timing: RoomReplicaTiming = {}): Promise<ConnectedFitTurn> {
  if (next.stage === "complete") {
    if (!next.result) throw new Error("Missing completed connected fit");
    return { kind: "result", result: next.result };
  }
  if (next.stage !== "process_posterior") return { kind: "optimizer", state: next };
  if (!next.result?.response) throw new Error("Missing fitted connected response");
  const process = next.processPosterior ?? beginConnectedProcessInference(next.result.response, rows);
  const { hypotheses, replicas: descriptors, ...priors } = process.belief;
  const started = performance.now();
  const replicas = await Promise.all(descriptors.map(async (descriptor, index) => {
    const row = process.cursor + Number(process.work !== undefined && index < process.work.replica);
    const work = process.work?.replica === index ? process.work : undefined;
    return { index, row, done: row === rows.length && !work, blob: await packReplica(descriptor,
      hypotheses.filter(member => member.replica === index), 0, work) };
  }));
  timing.pack_ms = Math.round(performance.now() - started);
  return { kind: "start_process", shared: { result: { ...next.result, response: process.model }, priors,
    numerical_failures: process.numerical_failures }, replicas };
}

export async function advanceRoomFitReplica(claim: Extract<ProcessClaim, { kind: "replica" }>, rows: RoomMeanQuarter[],
  milliseconds: number, timing: RoomReplicaTiming = {}): Promise<Extract<ConnectedFitTurn, { kind: "replica" }>> {
  const started = performance.now();
  const { model, priors, window, replica } = claim;
  if (replica.done || !rows.length || window.row_from !== replica.row || replica.row + rows.length > window.total_rows) {
    throw new OwnedPlanningArtifactError("Invalid connected fit observation page");
  }
  const { descriptor, members, failures, work } = await unpackReplica(replica, 0);
  timing.unpack_ms = Math.round(performance.now() - started);
  // The kernel uses an index local to this array. Restore the global ordinal
  // only when assembling the four descriptors and their ordered populations.
  const previous: ConnectedProcessProgress = { version: 2, model, cursor: 0, complete: false, numerical_failures: failures,
    belief: { ...priors, replicas: [descriptor], hypotheses: members }, identified: [], ...(work ? { work } : {}) };
  const last = rows.at(-1)!;
  const next = advanceConnectedProcessInference(rows, previous, last.start_ms + (last.duration_s ?? 900) * 1000,
    Math.max(1, milliseconds - (performance.now() - started)));
  const row = replica.row + next.cursor;
  const packing = performance.now();
  const blob = await packReplica(next.belief.replicas[0], next.belief.hypotheses, next.numerical_failures, next.work);
  timing.pack_ms = Math.round(performance.now() - packing);
  return { kind: "replica", replica: { index: replica.index, row, done: next.complete && row === window.total_rows,
    blob } };
}

export async function finishConnectedFit(claim: Exclude<ProcessClaim, { kind: "replica" }>, rows: number): Promise<ConnectedRoomFit> {
  if (claim.kind === "result") return claim.result;
  const { shared, replicas } = claim;
  if (replicas.length !== CONNECTED_PROCESS_REPLICAS || replicas.some((replica, index) => !replica.done || replica.index !== index || replica.row !== rows)) {
    throw new OwnedPlanningArtifactError("Incomplete connected fit replicas");
  }
  const parts = await Promise.all(replicas.map((replica, index) => unpackReplica(replica, index)));
  const response = connectedProcessResponse({ version: 2, model: shared.result.response, cursor: rows, complete: true,
    identified: [], numerical_failures: shared.numerical_failures + parts.reduce((sum, part) => sum + part.failures, 0),
    belief: { ...shared.priors, replicas: parts.map(part => part.descriptor), hypotheses: parts.flatMap(part => part.members) } });
  return { ...shared.result, response, learning: { ...shared.result.learning, process_inference: response.evidence.process_inference } };
}
