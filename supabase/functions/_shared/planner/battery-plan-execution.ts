import { PlanningInputError } from "./input-error.ts";
/** Planner-owned reference and delegated recovery, never a second optimiser.
 *
 * Integer mWh is the canonical published reference. Native capabilities and
 * measured installation conversion remain local authority, not this forecast.
 */
import type { OptimisationPlan } from "./planning-contracts.ts";
import type { BatteryProjectionRow } from "./planning-contracts.ts";
import type { BatteryDemand, BatteryInstruction } from "./battery-instruction.ts";

export interface ExecutionFeedback {
  scope_revision?: string;
  observed?: { at_ms: number; stored_mwh: number; source: string } | null;
  balance?: unknown;
  reason?: string | null;
  pending_effects?: unknown[];
  generation: number;
  source_receipt: number;
  previous_contract_id: string | null;
  objectives: Array<{
    objective: { id: string; deadline_ms: number; kind: string };
    responsibility: string;
    outcome: string;
  }>;
}

export interface ReferenceInterval {
  start_ms: number;
  end_ms: number;
  stored_start_mwh: number;
  stored_end_mwh: number;
  operation:
    | "hold"
    | "idle"
    | "grid_charge"
    | "solar_charge"
    | "supply_house"
    | "export";
  target_kind: "stored_energy" | "demand_following" | "permission";
  grid_charge_allowed: boolean;
  export_allowed: boolean;
  charge_ac_limit_w: number;
  discharge_ac_limit_w: number;
  follows_demand: boolean;
  charge_ac_mwh: number;
  discharge_ac_mwh: number;
  pv_mwh: number;
  load_mwh: number;
  import_mwh: number;
  export_mwh: number;
  curtailed_mwh: number;
  unserved_mwh: number;
  rounding_mwh: number;
}

export interface ExecutionObjective {
  id: string;
  kind: "stored_energy" | "demand_following" | "permission";
  start_ms: number;
  deadline_ms: number;
  target_mwh: number;
  reason: string;
}

export interface RecoveryInstruction {
  objective_id: string;
  start_ms: number;
  end_ms: number;
  max_correction_mwh: number;
  extra_charge_dc_w: number;
  order: number;
  resource_id: string;
  rule: "nominal_first_then_earliest";
  reason: string;
}

/** Contract v2 interval: the stated instruction plus its accounting reference. */
export interface ReferenceIntervalV2 {
  start_ms: number;
  end_ms: number;
  stored_start_mwh: number;
  stored_end_mwh: number;
  target_kind: ReferenceInterval["target_kind"];
  instruction: BatteryInstruction;
  charge_ac_mwh: number;
  discharge_ac_mwh: number;
  pv_mwh: number;
  load_mwh: number;
  import_mwh: number;
  export_mwh: number;
  curtailed_mwh: number;
  unserved_mwh: number;
  rounding_mwh: number;
}

export type BatteryExecutionContract = BatteryExecutionContractV1 | BatteryExecutionContractV2;

export interface BatteryExecutionContractV2 extends Omit<BatteryExecutionContractV1, "schema" | "intervals"> {
  schema: "battery-plan-execution-v2";
  intervals: ReferenceIntervalV2[];
  demand: BatteryDemand;
}

export interface BatteryExecutionContractV1 {
  schema: "battery-plan-execution-v1";
  id: string;
  plan_id: string;
  generation: number;
  mode: "controlling" | "control_verification";
  scope_revision: string;
  model_revision: string;
  energy_basis: "stored_energy_mwh";
  capacity_mwh: number;
  minimum_mwh: number;
  maximum_mwh: number;
  export_reserve_mwh: number;
  valid_until_ms: number;
  source_receipt: number;
  previous_contract_id: string | null;
  intervals: ReferenceInterval[];
  objectives: ExecutionObjective[];
  recovery: RecoveryInstruction[];
  dispositions: Array<{
    objective_id: string;
    outcome: "retained" | "incorporated" | "retired";
    replacement_id: string | null;
    reason: string;
  }>;
}

function integer(value: number, label: string, ErrorType: new (message: string) => Error = Error): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ErrorType(`${label}: nonnegative integer required`);
  }
  return value;
}

/** Materialise after final device scheduling, using exact pre-display rows. */
export function buildBatteryExecutionContract(input: {
  plan: OptimisationPlan;
  rows: BatteryProjectionRow[];
  pv_w: number[];
  mode: BatteryExecutionContract["mode"];
  scope_revision: string;
  feedback: ExecutionFeedback;
  /** Schema 10: state each slot's instruction over this demand (contract v2). */
  demand?: BatteryDemand;
}): BatteryExecutionContract {
  const { plan, rows, pv_w, mode, scope_revision, feedback, demand } = input;
  const battery = plan.battery;
  if (!battery || plan.status !== "ready" || !scope_revision || !rows.length) {
    throw new Error("ready battery plan and explicit execution scope required");
  }
  integer(feedback.generation, "request generation");
  integer(feedback.source_receipt, "receipt prefix");
  if (new Set(feedback.objectives.map((r) => r.objective.id)).size !== feedback.objectives.length) {
    throw new Error("duplicate previous objective identity");
  }
  const slots = plan.plans.priority.slots;
  if (slots.length !== rows.length || pv_w.length !== rows.length) throw new Error("exact final rows differ from the selected plan");
  const capacity = Math.round(battery.capacity_kwh * 1e6);
  const minimum = Math.round(battery.min_soc * capacity);
  const maximum = Math.round(battery.max_soc * capacity);
  let stored = battery.soc * battery.capacity_kwh * 1e6;
  const gross: Array<{ charge_w: number; discharge_w: number }> = [];
  const intervals: ReferenceInterval[] = rows.map((row, i) => {
    const start = Date.parse(row.start), end = Date.parse(row.end);
    integer(start, "interval start"); integer(end, "interval end");
    if (end <= start || (i && row.start !== rows[i - 1].end)) throw new Error("noncontiguous exact intervals");
    const hours = (end - start) / 3_600_000;
    const slot = slots[i];
    const pv = pv_w[i];
    const command = slot.battery_command;
    if (!command) throw new Error("nominal native role missing");
    const instruction = slot.battery_instruction;
    if (demand && !instruction) throw new Error("stated battery instruction missing");
    const operation = instruction ? ({ idle: "idle", hold: "hold", solar_charge: "solar_charge", grid_charge: "grid_charge",
        supply: "supply_house", export: "export" } as const)[instruction.kind]
      : command.operation === "self_consumption"
      ? row.charge_w > 0 ? "solar_charge" : row.discharge_w > 0 ? "supply_house" : "hold"
      : command.operation;
    // The stated role is what HA executes. A direction it forbids is solver
    // residue the instruction already floored away (an idle quarter can carry
    // milliwatts of charge), so the reference must not state that energy.
    const charge_w = operation === "idle" || operation === "export" ? 0 : row.charge_w;
    const discharge_w = operation === "supply_house" || operation === "export" ? row.discharge_w : 0;
    gross.push({ charge_w, discharge_w });
    const net = row.house_w - row.unserved_w + charge_w - discharge_w + row.curtailed_w - pv;
    const energy = (w: number) => {
      if (!Number.isFinite(w) || w < 0) throw new Error("invalid gross flow");
      return integer(Math.round(w * hours * 1000), "reference energy");
    };
    const begin = Math.round(stored);
    stored = Math.min(maximum, Math.max(minimum, stored +
      (charge_w * battery.charge_efficiency - discharge_w / battery.discharge_efficiency) * hours * 1000));
    const result: ReferenceInterval = {
      start_ms: start, end_ms: end, stored_start_mwh: begin, stored_end_mwh: Math.round(stored),
      operation, target_kind: charge_w > 0 ? "stored_energy" : operation === "supply_house" ? "demand_following" : "permission",
      grid_charge_allowed: command.allow_grid_charge,
      export_allowed: command.allow_battery_export,
      charge_ac_limit_w: Math.floor(command.charge_limit_w),
      discharge_ac_limit_w: Math.floor(command.discharge_limit_w),
      // A ceiling below the served residual is a deliberate partial allocation:
      // the planner bought the rest from the grid, so execution stays capped.
      follows_demand: operation === "supply_house" &&
        command.discharge_limit_w + 0.01 >= Math.max(0, row.house_w - row.unserved_w - pv),
      charge_ac_mwh: energy(charge_w), discharge_ac_mwh: energy(discharge_w),
      pv_mwh: energy(pv), load_mwh: energy(row.house_w), import_mwh: energy(Math.max(0, net)),
      export_mwh: energy(Math.max(0, -net)), curtailed_mwh: energy(row.curtailed_w),
      unserved_mwh: energy(row.unserved_w), rounding_mwh: 0,
    };
    result.rounding_mwh = result.pv_mwh + result.import_mwh + result.discharge_ac_mwh -
      result.load_mwh + result.unserved_mwh - result.charge_ac_mwh - result.export_mwh - result.curtailed_mwh;
    return result;
  });
  const liveObjectives = feedback.objectives.filter((r) =>
    r.responsibility === "outstanding" || r.responsibility === "retained");
  const objectives: ExecutionObjective[] = [];
  const recovery: RecoveryInstruction[] = [];
  // A contiguous charging window has one state objective and its original end.
  // Delegation stays inside that selected window: no cheaper-quarter search is
  // performed by the controller, and no later expensive purchase is authorised.
  for (let i = 0; i < intervals.length;) {
    const first = i;
    const kind = intervals[i].target_kind;
    while (i + 1 < intervals.length && intervals[i + 1].target_kind === kind &&
      intervals[i + 1].operation === intervals[first].operation) i++;
    const last = i++;
    const deadline = intervals[last].end_ms;
    // A window can disappear, be incorporated, and later return. Only a live
    // responsibility retains its identity; a closed obligation must not revive.
    const prior = liveObjectives.find(({ objective }) =>
      objective.kind === kind && objective.deadline_ms === deadline);
    const id = prior?.objective.id ?? `battery:${kind}:${deadline}:${plan.plan_id}:${feedback.generation}`;
    const objective: ExecutionObjective = {
      id, kind, start_ms: intervals[first].start_ms, deadline_ms: deadline,
      target_mwh: intervals[last].stored_end_mwh,
      reason: kind === "stored_energy" ? "Store energy during the planner's selected charging window" :
        kind === "demand_following" ? "Supply the home's eligible demand during this window" : "Keep the planner's selected battery role",
    };
    objectives.push(objective);
    if (kind !== "stored_energy") continue;
    for (let j = first; j <= last; j++) {
      const row = rows[j], { charge_w, discharge_w } = gross[j];
      // Nominal device loads own their forecast headroom first. This quantity is
      // a conditional forecast allocation; HA rechecks real loads/pending writes.
      const nominalGrid = Math.max(0, row.house_w + charge_w - discharge_w - pv_w[j]);
      const gridRoom = Math.max(0, plan.grid.import_limit_w - nominalGrid);
      const extraAc = Math.min(Math.max(0, battery.charge_max_w - charge_w),
        intervals[j].grid_charge_allowed ? gridRoom : 0);
      const extraDc = Math.floor(extraAc * battery.charge_efficiency);
      if (!extraDc) continue;
      recovery.push({
        objective_id: id, start_ms: intervals[j].start_ms, end_ms: intervals[j].end_ms,
        max_correction_mwh: Math.min(objective.target_mwh - minimum,
          Math.floor(extraDc * (intervals[j].end_ms - intervals[j].start_ms) / 3600)),
        extra_charge_dc_w: extraDc, order: j, resource_id: "household:battery-recovery",
        rule: "nominal_first_then_earliest",
        reason: "Use remaining allocated headroom in the original charging window",
      });
    }
  }
  const contract: BatteryExecutionContractV1 = {
    schema: "battery-plan-execution-v1", id: `${plan.plan_id}:battery:${feedback.generation}`,
    plan_id: plan.plan_id, generation: feedback.generation, mode, scope_revision,
    model_revision: `${plan.model_version}:ac-constant-efficiency:${battery.charge_efficiency}:${battery.discharge_efficiency}`,
    energy_basis: "stored_energy_mwh", capacity_mwh: capacity, minimum_mwh: minimum, maximum_mwh: maximum,
    export_reserve_mwh: Math.max(minimum, Math.round(plan.policy.battery_export_reserve_soc * capacity)),
    valid_until_ms: Date.parse(plan.valid_until), source_receipt: feedback.source_receipt,
    previous_contract_id: feedback.previous_contract_id, intervals, objectives, recovery,
    dispositions: liveObjectives.map(({ objective }) => {
      const same = objectives.find((o) => o.id === objective.id && o.deadline_ms === objective.deadline_ms);
      if (same) return { objective_id: objective.id, outcome: "retained" as const,
        replacement_id: null, reason: "Original objective and deadline remain in the revised reference" };
      const next = objectives.find((o) => o.kind === objective.kind);
      return next ? { objective_id: objective.id, outcome: "incorporated" as const, replacement_id: next.id,
        reason: "Replanned from observed state; historical delivery and missed deadlines remain recorded" } :
        { objective_id: objective.id, outcome: "retired" as const, replacement_id: null,
          reason: "Revised strategy no longer requests this objective; this is not measured fulfilment" };
    }),
  };
  if (!demand) return contract;
  // The slot's instruction is copied verbatim: HA executes what the plan view shows.
  return { ...contract, schema: "battery-plan-execution-v2", demand,
    intervals: intervals.map((row, i) => ({ start_ms: row.start_ms, end_ms: row.end_ms,
      stored_start_mwh: row.stored_start_mwh, stored_end_mwh: row.stored_end_mwh, target_kind: row.target_kind,
      instruction: slots[i].battery_instruction!, charge_ac_mwh: row.charge_ac_mwh, discharge_ac_mwh: row.discharge_ac_mwh,
      pv_mwh: row.pv_mwh, load_mwh: row.load_mwh, import_mwh: row.import_mwh, export_mwh: row.export_mwh,
      curtailed_mwh: row.curtailed_mwh, unserved_mwh: row.unserved_mwh, rounding_mwh: row.rounding_mwh })) };
}

/** Validate the external capture before solving; receipt ordering is local only. */
export function validateExecutionFeedback(value: ExecutionFeedback): void {
  integer(value.generation, "generation", PlanningInputError);
  integer(value.source_receipt, "source receipt", PlanningInputError);
  if (!value.generation || typeof value.scope_revision !== "string" || !value.scope_revision ||
      (value.previous_contract_id !== null && (typeof value.previous_contract_id !== "string" || !value.previous_contract_id)) ||
      !Array.isArray(value.objectives)) throw new PlanningInputError("Invalid battery execution feedback identity");
  if (value.observed) {
    integer(value.observed.at_ms, "observed time", PlanningInputError); integer(value.observed.stored_mwh, "observed storage", PlanningInputError);
    if (typeof value.observed.source !== "string" || !value.observed.source) throw new PlanningInputError("Missing observation provenance");
  }
  const ids = new Set<string>();
  for (const row of value.objectives) {
    if (!row || typeof row.objective?.id !== "string" || !row.objective.id || ids.has(row.objective.id) ||
        !["stored_energy", "demand_following", "permission"].includes(row.objective.kind) ||
        !["outstanding", "retained", "incorporated", "retired"].includes(row.responsibility) ||
        typeof row.outcome !== "string") throw new PlanningInputError("Invalid prior battery objective");
    integer(row.objective.deadline_ms, "objective deadline", PlanningInputError); ids.add(row.objective.id);
  }
}
