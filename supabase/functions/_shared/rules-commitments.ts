import type { OptimisationSnapshot, PlannedSlot } from "./planner/planning-contracts.ts";
import type { ExecutionChange, ExecutionReplan } from "./execution-replan.ts";
import type { NativeOwnerMask, NativeCommand, ReadyProblem } from "./planner-wasm/ready-problem.ts";
import type { PublishedCommandReference, PublishedCommandSlot } from "./rules-planner.ts";

import { poolElectricalDemand } from "./planner/models/pool/electrical.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";

export type RetainedCommandSlot = Partial<PublishedCommandSlot> & { start: string };
const HOUR = 3_600_000, QUARTER = 900_000;
const emptyMask = (): NativeOwnerMask => ({pool: false, ev: false, battery: false});

export function nativeOwnerHeld(problem: ReadyProblem, i: number, owner: keyof NativeOwnerMask): boolean {
  return !!problem.fixed_commands?.[i] || !!problem.accepted?.[i] &&
    problem.slots[i].start_seconds < problem.locked_through_seconds && !problem.released?.[i]?.[owner];
}

/** Preserve only held components when composing a baseline or postprocessed request. */
export function applyNativeHolds(problem: ReadyProblem, i: number, proposed: NativeCommand): NativeCommand {
  const fixed = problem.fixed_commands?.[i];
  if (fixed) return structuredClone(fixed);
  const result = {...proposed};
  const unavailable = problem.unavailable?.[i];
  if (unavailable?.ev) result.ev_amps = 0;
  if (unavailable?.pool) result.pool_on = false;
  if (unavailable?.battery) { result.battery = "idle"; result.charge_limit_w = 0; result.discharge_limit_w = 0; }
  const old = problem.accepted?.[i];
  if (!old) return result;
  if (nativeOwnerHeld(problem, i, "ev")) result.ev_amps = old.ev_amps;
  if (nativeOwnerHeld(problem, i, "pool")) result.pool_on = old.pool_on;
  if (nativeOwnerHeld(problem, i, "battery")) {
    result.battery = old.battery; result.charge_limit_w = old.charge_limit_w; result.discharge_limit_w = old.discharge_limit_w;
  }
  return result;
}

export function commandOwner(snapshot: OptimisationSnapshot, model: OptimisationSnapshot["device_models"][number]): string {
  return snapshot.operating_scope?.device_owners[model.key] ??
    (model.category === "ev_charging" ? "$ev" : model.planning_service === "pool" ? "$pool" : model.key);
}

export function unavailableOwner(snapshot: OptimisationSnapshot, owner: string, start: string): boolean {
  const at = Date.parse(start), end = at + QUARTER;
  return (snapshot.execution_availability ?? []).some(change => change.owner === owner &&
    (change.status === "faulted" || change.status === "temporarily_absent" &&
      change.blocked_intervals.some(interval => Date.parse(interval.start) < end && Date.parse(interval.end) > at)));
}

/** One capture-anchored view owns both native and prepared-service commitments. */
export function compileCommitments(snapshot: OptimisationSnapshot, reference: PublishedCommandReference | null,
  request: ExecutionReplan | null | undefined) {
  const capture = Date.parse(snapshot.captured_at);
  const byStart = new Map(reference?.slots.map(slot => [Date.parse(slot.start), slot]));
  const original: PublishedCommandSlot[] = [];
  for (const slot of snapshot.slots) {
    if (Date.parse(slot.start) >= capture + HOUR || !reference) break;
    const prior = byStart.get(Date.parse(slot.start));
    if (!prior) break;
    original.push(prior);
  }
  const evidence: ExecutionChange[] = snapshot.execution_availability ?? [];
  const owners = new Set(evidence.filter(change => change.status !== "plan_deviation" && (change.status === "recovered" || change.status === "faulted" ||
    change.blocked_intervals.some(interval => Date.parse(interval.end) > capture && Date.parse(interval.start) < capture + HOUR)))
    .map(change => change.owner));
  // A delayed capture may follow the blocked source quarter. Its explicitly
  // requested repair still needs eligible destinations in the current held hour.
  for (const change of request?.changes ?? []) owners.add(change.owner);
  const slotOwners = original.map(() => new Set(owners));
  // An explicit absence of a pool instruction is not an OFF commitment. Once
  // evidence returns, the pool may plan again without unlocking other owners.
  original.forEach((slot, i) => { if (slot.pool_permitted === null) slotOwners[i].add("$pool"); });
  const warnings: PlanningWarning[] = [];
  if (snapshot.capabilities.pool && (reference?.pool_planning_basis === "empirical" || reference?.pool_planning_basis === "thermal")) {
    const members = snapshot.device_models.filter(model => model.planning_service === "pool");
    const own = members.filter(model => commandOwner(snapshot, model) === "$pool");
    const demand = poolElectricalDemand(snapshot);
    const watts = own.reduce((sum, model) => sum + (demand.member_w[model.key] ?? 0), 0);
    const corrections: Array<{start: string; before_w: number; after_w: number}> = [];
    original.forEach((slot, i) => {
      if (!(slot.pool_command_w! > 0)) return;
      // Empirical permissions reserved duty averages. Thermal commands already
      // name the full rating; their normal startup forecast is not a correction.
      // Independent circulation is never authority to release the heater.
      const before = reference.pool_planning_basis === "empirical"
        ? own.every(model => typeof slot.device_loads_w?.[model.key] === "number")
          ? own.reduce((sum, model) => sum + slot.device_loads_w![model.key], 0) : null
        : own.length === members.length ? slot.pool_command_w : null;
      if (before == null || !(watts > before + 1e-6)) return;
      slotOwners[i].add("$pool");
      corrections.push({start: slot.start, before_w: before, after_w: watts});
    });
    if (corrections.length) warnings.push(planningWarning("pool_commitment_power_corrected", "pool",
      "Accepted pool heating reserved less than its current physical demand.",
      "Only affected pool-ON commitments may move. Other accepted loads and bookings remain held.",
      {basis: reference.pool_planning_basis, intervals: JSON.stringify(corrections)}));
  }
  const released = slotOwners.map(owners => ({pool: owners.has("$pool"), ev: owners.has("$ev"), battery: owners.has("$battery")}));
  const retained: RetainedCommandSlot[] = original.map((slot, i) => {
    const owners = slotOwners[i];
    const next: RetainedCommandSlot = structuredClone(slot);
    if (owners.has("$ev")) {
      delete next.ev_target_current_a; delete next.ev_min_current_a; delete next.ev_max_current_a;
    }
    if (owners.has("$pool")) {
      delete next.pool_command_w; delete next.pool_permitted; delete next.pool_w;
    }
    if (owners.has("$battery")) { delete next.battery_command; delete next.battery_instruction; }
    for (const model of snapshot.device_models) if (owners.has(commandOwner(snapshot, model))) {
      if (next.device_commands) delete next.device_commands[model.key];
      if (next.device_loads_w) delete next.device_loads_w[model.key];
    }
    // The boiler permission is shared. Per-member commands remain authoritative;
    // only release its aggregate when every member belongs to the affected scope.
    const boilers = snapshot.device_models.filter(model => model.category === "hot_water");
    if (boilers.length && boilers.every(model => owners.has(commandOwner(snapshot, model)))) {
      delete next.boiler_permitted; delete next.boiler_expected_w; delete next.boiler_battery_allowed;
    }
    return next;
  });
  const unavailable = snapshot.slots.map(slot => {
    const mask = emptyMask();
    mask.ev = unavailableOwner(snapshot, "$ev", slot.start);
    mask.pool = unavailableOwner(snapshot, "$pool", slot.start);
    mask.battery = unavailableOwner(snapshot, "$battery", slot.start);
    return mask;
  });
  return {original, retained, released, unavailable, owners_by_slot: slotOwners.map(owners => [...owners]), warnings};
}

/** Independent publication check catches TS postprocessing that changes held requests. */
export function assertHeldCommands(snapshot: OptimisationSnapshot, original: PublishedCommandSlot[],
  released: readonly string[][], actual: PlannedSlot[]): void {
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const fields = { $ev: ["ev_target_current_a", "ev_min_current_a", "ev_max_current_a"],
    $pool: ["pool_command_w", "pool_permitted"], $battery: ["battery_command", "battery_instruction"] } as const;
  for (const [i, old] of original.entries()) {
    const owners = new Set(released[i]);
    for (const [owner, keys] of Object.entries(fields)) if (!owners.has(owner)) for (const key of keys) {
      if (old[key] !== undefined && !equal(old[key], actual[i]?.[key])) throw new Error(`Held ${owner} command changed at ${old.start}: ${key}`);
    }
    for (const model of snapshot.device_models) {
      const command = old.device_commands?.[model.key];
      if (!owners.has(commandOwner(snapshot, model)) && command?.type === model.control_type &&
        !equal(command, actual[i]?.device_commands?.[model.key])) throw new Error(`Held ${model.key} command changed at ${old.start}`);
    }
  }
}
