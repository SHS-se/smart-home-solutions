/** Immutable execution evidence shared by capture, planning and delivery. */
export interface AvailabilityChange {
  owner: string;
  status: "temporarily_absent" | "faulted" | "recovered";
  cause: string;
  blocked_intervals: Array<{ start: string; end: string }>;
}
/** A measured model miss requests correction without declaring failed equipment. */
export interface PlanDeviation {
  owner: string;
  status: "plan_deviation";
  cause: "battery_energy_shortfall" | "pool_temperature_shortfall";
  affected_intervals: Array<{ start: string; end: string }>;
  /** Stored kWh for battery; water degrees Celsius for pool. */
  magnitude: number;
  persistence_ms: number;
}
/** Working equipment with less current available in an observed absolute interval. */
export interface CapacityLimited {
  owner: '$ev';
  status: 'capacity_limited';
  cause: 'house_import_capacity';
  maximum_current_a: number;
  blocked_intervals: Array<{ start: string; end: string }>;
}
export type ExecutionChange = AvailabilityChange | PlanDeviation | CapacityLimited;
export const changeIntervals = (change: ExecutionChange) =>
  change.status === "plan_deviation" ? change.affected_intervals : change.blocked_intervals;
export interface ExecutionReplan {
  request_id: string;
  accepted_plan_id: string;
  observed_at: string;
  changes: ExecutionChange[];
}
