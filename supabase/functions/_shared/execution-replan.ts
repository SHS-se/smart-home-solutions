import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { OperatingScope } from "./planner/operating-scope.ts";
import type { PublishedCommandReference, PublishedCommandSlot } from "./rules-planner.ts";
import { HA_UUID } from "./ha-api-contract.ts";

import { changeIntervals, type ExecutionChange, type ExecutionReplan } from "./planner/execution-evidence.ts";
export type { ExecutionChange, ExecutionReplan } from "./planner/execution-evidence.ts";
export class ExecutionReplanError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message); this.name = "ExecutionReplanError";
  }
}
const invalid = (detail: string): never => { throw new ExecutionReplanError("invalid_execution_replan", detail); };
const record = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === "object" && !Array.isArray(raw);
const timestamp = (raw: unknown): raw is string => typeof raw === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(raw) && Number.isFinite(Date.parse(raw));
const exactKeys = (raw: Record<string, unknown>, keys: string[]) => Object.keys(raw).sort().join() === [...keys].sort().join();

export function parseExecutionChanges(raw: unknown): ExecutionChange[] {
  if (!Array.isArray(raw)) return invalid("Execution changes must be an array");
  const owners = new Set<string>();
  return raw.map((change): ExecutionChange => {
    if (!record(change) || typeof change.owner !== "string" || !change.owner.trim() ||
        change.owner !== change.owner.trim() || owners.has(change.owner) ||
        typeof change.cause !== "string" || !change.cause.trim()) return invalid("Each execution change requires one distinct owner, status, cause and blocked intervals");
    const deviation = change.status === "plan_deviation";
    const field = deviation ? "affected_intervals" : "blocked_intervals";
    if (!exactKeys(change, deviation ? ["owner", "status", "cause", field, "magnitude", "persistence_ms"] : ["owner", "status", "cause", field]) ||
        !["temporarily_absent", "faulted", "recovered", "plan_deviation"].includes(String(change.status)) || !Array.isArray(change[field])) {
      return invalid("Each execution change requires one distinct owner, status, cause and blocked intervals");
    }
    if (deviation && (!(typeof change.magnitude === "number" && Number.isFinite(change.magnitude) && change.magnitude > 0) ||
        !(typeof change.persistence_ms === "number" && Number.isSafeInteger(change.persistence_ms) && change.persistence_ms >= 0) ||
        !(change.owner === "$battery" && change.cause === "battery_energy_shortfall" ||
          change.owner === "$pool" && change.cause === "pool_temperature_shortfall"))) return invalid("Plan deviation requires a matching owner, metric, magnitude and persistence");
    owners.add(change.owner);
    const intervals = (change[field] as unknown[]).map(interval => {
      if (!record(interval) || !exactKeys(interval, ["start", "end"]) || !timestamp(interval.start) ||
          !timestamp(interval.end) || Date.parse(interval.start) >= Date.parse(interval.end)) {
        return invalid("Blocked intervals require ordered ISO start and end timestamps");
      }
      return { start: interval.start, end: interval.end };
    });
    if (change.status === "recovered" && intervals.length !== 0) {
      return invalid("Recovery has no blocked intervals");
    }
    if (deviation) return { owner: change.owner, status: "plan_deviation", cause: change.cause as "battery_energy_shortfall" | "pool_temperature_shortfall",
      affected_intervals: intervals, magnitude: change.magnitude as number, persistence_ms: change.persistence_ms as number };
    return { owner: change.owner, status: change.status as "temporarily_absent" | "faulted" | "recovered", cause: change.cause, blocked_intervals: intervals };
  });
}

export function parseExecutionReplan(raw: unknown): ExecutionReplan {
  if (!record(raw) || !exactKeys(raw, ["request_id", "accepted_plan_id", "observed_at", "changes"]) ||
      typeof raw.request_id !== "string" || !HA_UUID.test(raw.request_id) ||
      typeof raw.accepted_plan_id !== "string" || !HA_UUID.test(raw.accepted_plan_id) || !timestamp(raw.observed_at)) {
    return invalid("Execution replan requires request and accepted plan UUIDs, observed_at and changes");
  }
  const changes = parseExecutionChanges(raw.changes);
  if (!changes.length) return invalid("An execution replan requires changed execution evidence");
  return { request_id: raw.request_id, accepted_plan_id: raw.accepted_plan_id, observed_at: raw.observed_at, changes };
}

export function executionOwnerKeys(snapshot: OptimisationSnapshot): Set<string> {
  return new Set(["$ev", "$pool", "$battery", ...snapshot.device_models.map(model => model.key)]);
}

/** Ordinary captures carry only current unresolved conditions, under physical authority. */
export function validateExecutionAvailability(snapshot: OptimisationSnapshot): void {
  const changes = parseExecutionChanges(snapshot.execution_availability ?? []);
  const known = executionOwnerKeys(snapshot);
  for (const change of changes) {
    if (!known.has(change.owner) || (change.status === "recovered" || change.status === "plan_deviation") ||
        (snapshot.schema_version >= 9 && snapshot.operating_scope?.modes[change.owner] !== "controlling")) {
      return invalid(`Execution availability owner ${change.owner} must be known, controlling and unresolved`);
    }
  }
}

/** Executable positive work, not hypothetical forecast consumption, grants a scoped release. */
export function ownerHasAcceptedWork(owner: string, slot: PublishedCommandSlot, snapshot: OptimisationSnapshot): boolean {
  if (owner === "$ev") return slot.ev_target_current_a > 0;
  if (owner === "$pool") return (slot.pool_command_w ?? slot.pool_w) > 0;
  if (owner === "$battery") {
    const instruction = slot.battery_instruction;
    if (instruction) {
      switch (instruction.kind) {
        case "idle": return false;
        case "grid_charge": return instruction.charge_ac_w > 0;
        case "export": return instruction.discharge_ac_w > 0;
        case "hold": case "solar_charge": return instruction.charge_ac_limit_w > 0;
        case "supply": return instruction.charge_ac_limit_w > 0 || instruction.discharge_ac_limit_w > 0;
      }
    }
    const command = slot.battery_command;
    return !!command && command.operation !== "idle" &&
      (command.charge_limit_w > 0 || command.discharge_limit_w > 0);
  }
  return snapshot.device_models.filter(model => (snapshot.operating_scope?.device_owners[model.key] ?? model.key) === owner)
    .some(model => {
      const command = slot.device_commands?.[model.key];
      if (!command) return false;
      switch (command.type) {
        case "switch_schedule": return command.on_seconds > 0;
        case "permit_inhibit": return command.permitted;
        case "variable_power": return command.value > 0;
        case "setpoint": return true;
        case "unavailable": return false;
      }
    });
}

type ExecutionReference = PublishedCommandReference & {
  operating_scope?: OperatingScope;
  execution_availability?: ExecutionChange[];
};
export function validateExecutionReplan(request: ExecutionReplan, reference: ExecutionReference | null,
  snapshot: OptimisationSnapshot): ExecutionReplan {
  if (!reference || reference.plan_id !== request.accepted_plan_id) {
    throw new ExecutionReplanError("execution_reference_changed", "Execution evidence must name the current HA-accepted reference plan", 409);
  }
  const owners = executionOwnerKeys(snapshot);
  for (const change of request.changes) {
    if (change.status !== "recovered" && !changeIntervals(change).length) {
      return invalid(`Execution change owner ${change.owner} must name its blocked accepted opportunity`);
    }
    if (!owners.has(change.owner) || snapshot.operating_scope?.modes[change.owner] !== "controlling" ||
        reference.operating_scope?.modes[change.owner] !== "controlling") {
      return invalid(`Execution change owner ${change.owner} must be known and controlling in the accepted plan and capture`);
    }
    if (change.status === "plan_deviation") {
      const comparable = change.owner === "$pool" ? !!snapshot.pool : !!snapshot.battery;
      if (!comparable || !reference.slots.some(slot => change.affected_intervals.some(interval =>
        Date.parse(interval.start) < Date.parse(slot.start) + snapshot.slot_minutes * 60_000 && Date.parse(interval.end) > Date.parse(slot.start)))) {
        return invalid("Plan deviation must name an accepted owner trajectory and affected interval");
      }
      continue;
    }
    const recovery = change.status === "recovered" && reference.execution_availability?.some(previous => previous.owner === change.owner && previous.status !== "recovered");
    const work = reference.slots.some(slot => ownerHasAcceptedWork(change.owner, slot, snapshot) &&
      (change.status === "recovered" || change.blocked_intervals.some(interval =>
        Date.parse(interval.start) < Date.parse(slot.start) + snapshot.slot_minutes * 60_000 && Date.parse(interval.end) > Date.parse(slot.start))));
    if (!work && !recovery) return invalid(`Execution change owner ${change.owner} does not name accepted work or a suppressed objective recovering`);
  }
  return request;
}

/** Used by ingest before either ordinary snapshot suppression/refresh gate. */
export function shouldAdmitPlanningSnapshot(input: {
  hasAcceptedPlan: boolean; pendingManual: boolean; newPublishedPrices: boolean; executionReplan: ExecutionReplan | null;
}): boolean {
  return !input.hasAcceptedPlan || input.pendingManual || input.newPublishedPrices || input.executionReplan !== null;
}
