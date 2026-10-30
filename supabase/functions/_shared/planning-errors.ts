import { PlanningInputError } from "./planner/input-error.ts";
import { DeviceModelError } from "./planner/device-models.ts";
export { PlanningInputError } from "./planner/input-error.ts";

/** Failure disposition belongs to the boundary that knows what failed. */
export type PlanningFailureDisposition = "retry" | "terminal" | "recapture";
export class PlanningError extends Error {
  constructor(message: string, readonly code: string, readonly status: number,
    readonly disposition: PlanningFailureDisposition) {
    super(message); this.name = "PlanningError";
  }
}
/** Unknown defects remain visible internal failures, never invented bad input. */
export function classifyPlanningFailure(error: unknown): PlanningError {
  if (error instanceof PlanningInputError || error instanceof DeviceModelError) {
    return new PlanningError(error.message, "invalid_snapshot", 400, "terminal");
  }
  return error instanceof PlanningError ? error : new PlanningError(
    error instanceof Error ? error.message : String(error), "planning_internal_error", 500, "retry");
}
