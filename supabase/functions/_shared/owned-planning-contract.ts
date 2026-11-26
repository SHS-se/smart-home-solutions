/** Compact orchestration wire. Numerical artifacts never pass through ingestion. */
export const OWNED_PLANNING_REVISION = "owned_replicas_v1";
export interface OwnedPlanningOwner { home_id: string; job_id: string; fence: number }
export type OwnedPlanningAction = { kind: "advance" } | { kind: "replica"; replica: 0 | 1 | 2 | 3 };
export interface OwnedPlanningDispatch {
  phase: "capture" | "prepare" | "catalog" | "integrate" | "qualify" | "solve" | "assemble" | "seal" | "ready";
  cursor: number;
  target: number;
  round: number;
  replicas: Array<0 | 1 | 2 | 3>;
}
export interface OwnedPlanningResponse { dispatch: OwnedPlanningDispatch | null; busy?: boolean }
