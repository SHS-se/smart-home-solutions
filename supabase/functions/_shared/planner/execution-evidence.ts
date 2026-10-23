/** Immutable execution evidence shared by capture, planning and delivery. */
export interface ExecutionChange {
  owner: string;
  status: "temporarily_absent" | "faulted" | "recovered";
  cause: string;
  blocked_intervals: Array<{ start: string; end: string }>;
}
export interface ExecutionReplan {
  request_id: string;
  accepted_plan_id: string;
  observed_at: string;
  changes: ExecutionChange[];
}
