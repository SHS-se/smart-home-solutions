import { PlanningError } from "./planning-errors.ts";
import type { CapturedRulesInput } from "./rules-planning-capture.ts";
import { RULES_MODEL_VERSION } from "./rules-planner-identity.ts";
import { prepareRulesPlanningBasis, prepareRulesPlanningInput, generateRulesPlan } from "./rules-planner.ts";
import { prepareRoomBatch, type RoomPreparationProgress } from "./rules-room-services.ts";
import type { PlanningTrace } from "./planning-trace.ts";

/** Compile one captured basis using the existing room-first preparation. */
export function prepareCapturedRulesInput(capture: CapturedRulesInput, trace?: PlanningTrace) {
  if (capture.model_version !== RULES_MODEL_VERSION) throw new PlanningError("Captured rules planner version changed", "planner_upgraded", 409, "recapture");
  return prepareRulesPlanningInput(capture, capture.reference, capture.approved_policy, trace, capture.independent_references);
}

/** Hosted calls spend their CPU budget on at most one room and its final assembly. */
export function prepareCapturedRoomBatch(capture: CapturedRulesInput, previous: RoomPreparationProgress | null, trace?: PlanningTrace) {
  const { roomInputs, finish } = prepareRulesPlanningBasis(capture, capture.reference, capture.approved_policy, capture.independent_references);
  const progress = prepareRoomBatch(roomInputs, trace, previous);
  return progress.next_room < (roomInputs.snapshot.thermal_zones?.length ?? 0)
    ? {room_progress: progress}
    : {prepared: finish(progress.services)};
}

/** Local execution uses the same ordered stages as the isolated remote requests. */
export function executeRulesPlanning(capture: CapturedRulesInput, trace?: PlanningTrace) {
  return generateRulesPlan(prepareCapturedRulesInput(capture, trace), trace);
}
