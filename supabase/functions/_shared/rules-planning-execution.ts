import { PlanningError } from "./planning-errors.ts";
import type { CapturedRulesInput } from "./rules-planning-capture.ts";
import { RULES_MODEL_VERSION } from "./rules-planner-identity.ts";
import { prepareRulesPlanningBasis, prepareRulesPlanningInput, generateRulesPlan } from "./rules-planner.ts";
import { prepareRoomBatch, prepareRoomProposals, prepareOwnedRoomProposals, type RoomPreparationProgress } from "./rules-room-services.ts";
import type { PlanningTrace } from "./planning-trace.ts";
import { applyConnectedRoomForecast, type ConnectedRoomCatalog, type ConnectedRoomProposalNetwork } from "./rules-connected-room-services.ts";
import type { NativeRoomNetworkOutput } from "./room-network-contract.ts";

/** Compile one captured basis using the existing room-first preparation. */
export function prepareCapturedRulesInput(capture: CapturedRulesInput, trace?: PlanningTrace) {
  if (capture.model_version !== RULES_MODEL_VERSION) throw new PlanningError("Captured rules planner version changed", "planner_upgraded", 409, "recapture");
  return prepareRulesPlanningInput(capture, capture.reference, capture.approved_policy, trace, capture.independent_references);
}

/** Hosted calls spend their CPU budget on at most one room and its final assembly. */
export function prepareCapturedRoomBatch(capture: CapturedRulesInput, previous: RoomPreparationProgress | null, trace?: PlanningTrace) {
  const { roomInputs, finish } = prepareRulesPlanningBasis(capture, capture.reference, capture.approved_policy, capture.independent_references);
  const progress = prepareRoomBatch(roomInputs, trace, previous);
  return progress.network_work || progress.forecast_pending || progress.next_room < (roomInputs.snapshot.thermal_zones?.length ?? 0)
    ? {room_progress: progress}
    : {prepared: finish(progress.services)};
}

/** Produce an immutable final-forecast request for the job-owned replica stage. */
export function prepareCapturedRoomProposals(capture: CapturedRulesInput, previous: RoomPreparationProgress | null, trace?: PlanningTrace) {
  const { roomInputs, finish } = prepareRulesPlanningBasis(capture, capture.reference, capture.approved_policy, capture.independent_references);
  const { progress, forecast } = prepareRoomProposals(roomInputs, trace, previous);
  if (forecast) return { forecast, room_progress: progress };
  return progress.forecast_pending || progress.next_room < (roomInputs.snapshot.thermal_zones?.length ?? 0)
    ? { room_progress: progress }
    : { prepared: finish(progress.services) };
}

/** The job holds complete execution arguments. Proposal reads carry just the network's physical headers. */
export function prepareOwnedRulesProposals(capture: CapturedRulesInput, network: ConnectedRoomProposalNetwork | undefined,
  previous: RoomPreparationProgress | null, trace?: PlanningTrace) {
  const { roomInputs, finish } = prepareRulesPlanningBasis(capture, capture.reference, capture.approved_policy, capture.independent_references);
  const { progress, catalog } = prepareOwnedRoomProposals({ ...roomInputs, proposal_network: network }, previous, trace);
  if (catalog || progress.forecast_pending || progress.next_room < (roomInputs.snapshot.thermal_zones?.length ?? 0)) {
    return { progress, catalog };
  }
  return { prepared: finish(progress.services) };
}

/** The canonical barrier already owns selection; this restores its actual
 * commands and demand into the existing room-first household preparation. */
export function applyCapturedConnectedForecast(capture: CapturedRulesInput, progress: RoomPreparationProgress,
  context: ConnectedRoomCatalog["context"], output: NativeRoomNetworkOutput,
  counts: { trajectories: number; replayed_paths: number; replicates: Array<{ trajectories: number }> }, trace?: PlanningTrace) {
  if (progress.snapshot_id !== capture.snapshot.snapshot_id || progress.next_room !== (capture.snapshot.thermal_zones?.length ?? 0)) {
    throw new PlanningError("Connected forecast does not match completed room proposals", "invalid_snapshot", 400, "retry");
  }
  const { roomInputs, finish } = prepareRulesPlanningBasis(capture, capture.reference, capture.approved_policy, capture.independent_references);
  applyConnectedRoomForecast(roomInputs, progress.services, context, output, counts);
  return finish(progress.services);
}

/** Local execution uses the same ordered stages as the isolated remote requests. */
export function executeRulesPlanning(capture: CapturedRulesInput, trace?: PlanningTrace) {
  return generateRulesPlan(prepareCapturedRulesInput(capture, trace), trace);
}
