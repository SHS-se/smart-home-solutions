import type { OptimisationSnapshot, PlannedSlot } from "./planner/planning-contracts.ts";
import type { ExecutionChange, ExecutionReplan } from "./execution-replan.ts";
import type { NativeOwnerMask, NativeCommand, ReadyProblem } from "./planner-wasm/ready-problem.ts";
import type { NativeQuarter } from "./planner-wasm/core.ts";
import type { PreparedRulesInput, PublishedCommandReference, PublishedCommandSlot } from "./rules-planner.ts";

import { poolElectricalDemand } from "./planner/models/pool/electrical.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";

export type RetainedCommandSlot = Partial<PublishedCommandSlot> & { start: string };
const HOUR = 3_600_000, QUARTER = 900_000;
const emptyMask = (): NativeOwnerMask => ({pool: false, ev: false, battery: false});
// The app admits blocked battery work from 100 Wh. Use the same energy
// scale per retained charging run for a forecast-only correction.
const BATTERY_RESIZE_MAX_WH = 100;

export function nativeOwnerHeld(problem: ReadyProblem, i: number, owner: keyof NativeOwnerMask): boolean {
  return !!problem.fixed_commands?.[i] || !!problem.accepted?.[i] &&
    problem.slots[i].start_seconds < problem.locked_through_seconds && !problem.released?.[i]?.[owner];
}

/** Retain the selected charging run with only its proven, immaterial clips. */
export function resizeRetainedCharge(input: PreparedRulesInput, quarters: readonly NativeQuarter[]): PreparedRulesInput | null {
  const {problem} = input;
  const changes: Array<{index: number; start: string; before_w: number; after_w: number; lost_wh: number}> = [];
  let runLossWh = 0;
  for (const [i, old] of (problem.accepted ?? []).entries()) {
    if (!old || old.battery !== 'grid_charge' || !nativeOwnerHeld(problem, i, 'battery') ||
        input.fixed_slots[i] || problem.fixed_commands?.[i]) {
      runLossWh = 0;
      continue;
    }
    // One-watt command resolution is also used by native held allocation
    // validation. The next native solve verifies the revised hold exactly.
    const actual = quarters[i].charge_w;
    const resized = Math.ceil(actual);
    if (resized >= old.charge_limit_w) continue;
    if (resized <= 0) return null;
    const slot = problem.slots[i];
    const lostWh = (old.charge_limit_w - actual) * (slot.hours + Math.min(0, slot.start_seconds) / 3600);
    runLossWh += lostWh;
    if (runLossWh >= BATTERY_RESIZE_MAX_WH) return null;
    changes.push({index: i, start: input.held_reference[i].start, before_w: old.charge_limit_w, after_w: resized, lost_wh: lostWh});
  }
  if (!changes.length) return null;
  const accepted = [...problem.accepted!];
  const locked = [...input.locked_slots], reference = [...input.held_reference];
  for (const {index, after_w} of changes) {
    accepted[index] = {...accepted[index]!, charge_limit_w: after_w};
    for (const rows of [locked, reference]) {
      const old = rows[index];
      const command = old.battery_command!;
      const instruction = old.battery_instruction;
      rows[index] = {...old, battery_command: {...command, charge_limit_w: Math.min(command.charge_limit_w, after_w)},
        ...(instruction?.kind === 'grid_charge' ? {battery_instruction: {...instruction, charge_ac_w: after_w}} : {})};
    }
  }
  return {...input, problem: {...problem, accepted}, locked_slots: locked, held_reference: reference,
    snapshot: {...input.snapshot, planning_warnings: [...(input.snapshot.planning_warnings ?? []), planningWarning(
      'battery_commitment_resized', 'battery', 'The forecast calls for a small reduction in accepted battery charging.',
      'Only the affected charging intervals were reduced to fit the house import target.',
      {intervals: JSON.stringify(changes)})]}};
}

/** A proved impossible retained battery request may move; bookings and other owners may not. */
export function recoverRetainedBattery(input: PreparedRulesInput, issue: string): PreparedRulesInput | null {
  const conflict = /^committed_command_infeasible:(\d+):(native_battery_power_limit|shared_grid_limit)$/.exec(issue);
  if (!conflict) return null;
  const index = Number(conflict[1]);
  if (!input.problem.slots[index] || !input.problem.accepted?.[index] ||
      input.fixed_slots[index] || input.problem.fixed_commands?.[index] ||
      !nativeOwnerHeld(input.problem, index, 'battery')) return null;
  const released = input.released_owners_by_slot.map((owners, i) =>
    !input.fixed_slots[i] && !input.problem.fixed_commands?.[i] && nativeOwnerHeld(input.problem, i, 'battery')
      ? [...new Set([...owners, '$battery'])] : [...owners]);
  const locked = input.locked_slots.map((slot, i) => {
    const next = structuredClone(slot);
    if (released[i]?.includes('$battery')) { delete next.battery_command; delete next.battery_instruction; }
    return next;
  });
  const slots = input.problem.slots.map((slot, i) =>
    released[i]?.includes('$battery') && input.snapshot.slots[i].export_price_sek_per_kwh === null &&
      input.price_outlook.shadow_export_sek_per_kwh?.[i] == null
      ? {...slot, battery_export_allowed: false} : slot);
  return {...input, locked_slots: locked, released_owners_by_slot: released,
    problem: {...input.problem, slots, released: input.problem.accepted!.map((_slot, i) =>
      ({...(input.problem.released?.[i] ?? emptyMask()), battery: released[i]?.includes('$battery') ?? false}))},
    snapshot: {...input.snapshot, planning_warnings: [...(input.snapshot.planning_warnings ?? []), planningWarning(
      'battery_commitment_rescheduled', 'battery',
      'An accepted battery request cannot run from the current measured state and has been rescheduled.',
      'Only the battery’s remaining accepted work may move. Other devices and explicit bookings remain held.',
      {reason: issue, start: input.held_reference[index].start,
        released_intervals: JSON.stringify(input.held_reference.filter((_slot, i) =>
          !input.fixed_slots[i] && released[i]?.includes('$battery')).map(slot => slot.start))})]}};
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

/** The name a person knows a command owner by, never its internal key alone. */
export function ownerLabel(snapshot: OptimisationSnapshot, owner: string): string {
  if (owner === "$battery") return "Battery";
  if (owner === "$pool") return "Pool";
  if (owner === "$ev") return snapshot.ev_battery?.name || "EV charging";
  const names = snapshot.device_models.filter(model => commandOwner(snapshot, model) === owner).map(model => model.name);
  return names.length ? names.join(", ") : owner;
}

export function unavailableOwner(snapshot: OptimisationSnapshot, owner: string, start: string): boolean {
  const at = Date.parse(start), end = at + QUARTER;
  return (snapshot.execution_availability ?? []).some(change => change.owner === owner &&
    (change.status === "faulted" || change.status === "temporarily_absent" &&
      change.blocked_intervals.some(interval => Date.parse(interval.start) < end && Date.parse(interval.end) > at)));
}

/** A measured capacity ceiling covers only the opportunity for which it was observed. */
export function evCurrentCeiling(snapshot: OptimisationSnapshot, start: string): number | null {
  const at = Date.parse(start), end = at + QUARTER;
  const limits = (snapshot.execution_availability ?? []).flatMap(change =>
    change.status === 'capacity_limited' && change.blocked_intervals.some(interval =>
      Date.parse(interval.start) < end && Date.parse(interval.end) > at) ? [change.maximum_current_a] : []);
  return limits.length ? Math.min(...limits) : null;
}

/** One capture-anchored view owns both native and prepared-service commitments. */
export function compileCommitments(snapshot: OptimisationSnapshot, reference: PublishedCommandReference | null,
  request: ExecutionReplan | null | undefined, independent?: {battery: PublishedCommandReference | null}) {
  const capture = Date.parse(snapshot.captured_at);
  const byStart = new Map(reference?.slots.map(slot => [Date.parse(slot.start), slot]));
  // Existing no-battery planning semantics apply after explicit exclusion or
  // measurement isolation. Keep durable provenance outside this planning view.
  const batteryReference = independent ? (snapshot.capabilities.battery && snapshot.battery ? independent.battery : null) : reference;
  const batteryByStart = new Map(batteryReference?.slots.map(slot => [Date.parse(slot.start), slot]));
  const original: RetainedCommandSlot[] = [];
  const missing: string[][] = [];
  for (const slot of snapshot.slots) {
    const at = Date.parse(slot.start);
    if (at >= capture + HOUR) break;
    const prior = byStart.get(at), battery = batteryByStart.get(at);
    if (!independent) {
      if (!prior) break;
      original.push(prior); missing.push([]);
    } else {
      // Row alignment is the new capture's UTC grid. A missing owner's source
      // is an absent hold, never a synthetic OFF instruction from another owner.
      const row: RetainedCommandSlot = prior ? structuredClone(prior) : {start: slot.start, device_commands: {}};
      delete row.battery_command; delete row.battery_instruction;
      if (battery) {
        row.battery_command = battery.battery_command;
        if (battery.battery_instruction) row.battery_instruction = battery.battery_instruction;
      }
      original.push(row);
      missing.push([...(prior ? [] : ["$ev", "$pool"]), ...(battery ? [] : ["$battery"])]);
    }
  }
  const evidence: ExecutionChange[] = snapshot.execution_availability ?? [];
  const owners = new Set(evidence.filter(change => change.status !== "plan_deviation" && (change.status === "recovered" || change.status === "faulted" ||
    change.blocked_intervals.some(interval => Date.parse(interval.end) > capture && Date.parse(interval.start) < capture + HOUR)))
    .map(change => change.owner));
  // A delayed capture may follow the blocked source quarter. Its explicitly
  // requested repair still needs eligible destinations in the current held hour.
  for (const change of request?.changes ?? []) owners.add(change.owner);
  const slotOwners = original.map((_slot, i) => new Set([...owners, ...missing[i]]));
  // Explicit measurement isolation removes only that owner's executable
  // planning requests. Raw accepted-reference provenance remains independent
  // of whether an optional device is configured in this snapshot.
  for (const issue of snapshot.measurement_issues ?? []) {
    if (['battery', 'ev', 'pool'].includes(issue.device)) {
      for (const released of slotOwners) released.add('$' + issue.device);
    }
  }
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
  return {original, retained, released, unavailable, owners_by_slot: slotOwners.map((owners, i) => [...owners].filter(owner => !missing[i].includes(owner))), warnings};
}

/** Independent publication check catches TS postprocessing that changes held requests. */
export function assertHeldCommands(snapshot: OptimisationSnapshot, original: RetainedCommandSlot[],
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
