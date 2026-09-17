/** Planner-owned reference and delegated recovery, never a second optimiser.
 *
 * Integer mWh is the canonical published reference. Native capabilities and
 * measured installation conversion remain local authority, not this forecast.
 */
import type { OptimisationPlan } from "./energy-optimisation.ts";
import type { BatteryProjectionRow } from "./battery-dispatch-projection.ts";

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
  operation: "hold" | "grid_charge" | "solar_charge" | "supply_house" | "export";
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

export interface BatteryExecutionContract {
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

function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}: nonnegative integer required`);
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
}): BatteryExecutionContract {
  const { plan, rows, pv_w, mode, scope_revision, feedback } = input;
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
  const intervals: ReferenceInterval[] = rows.map((row, i) => {
    const start = Date.parse(row.start), end = Date.parse(row.end);
    integer(start, "interval start"); integer(end, "interval end");
    if (end <= start || (i && row.start !== rows[i - 1].end)) throw new Error("noncontiguous exact intervals");
    const hours = (end - start) / 3_600_000;
    const slot = slots[i];
    const pv = pv_w[i];
    const net = row.house_w - row.unserved_w + row.charge_w - row.discharge_w + row.curtailed_w - pv;
    const energy = (w: number) => {
      if (!Number.isFinite(w) || w < 0) throw new Error("invalid gross flow");
      return integer(Math.round(w * hours * 1000), "reference energy");
    };
    const begin = Math.round(stored);
    stored = Math.min(maximum, Math.max(minimum, stored +
      (row.charge_w * battery.charge_efficiency - row.discharge_w / battery.discharge_efficiency) * hours * 1000));
    const command = slot.battery_command;
    if (!command) throw new Error("nominal native role missing");
    const operation = command.operation === "self_consumption"
      ? row.charge_w > 0 ? "solar_charge" : row.discharge_w > 0 ? "supply_house" : "hold"
      : command.operation;
    const result: ReferenceInterval = {
      start_ms: start, end_ms: end, stored_start_mwh: begin, stored_end_mwh: Math.round(stored),
      operation, target_kind: row.charge_w > 0 ? "stored_energy" : operation === "supply_house" ? "demand_following" : "permission",
      grid_charge_allowed: command.allow_grid_charge,
      export_allowed: command.allow_battery_export,
      charge_ac_limit_w: Math.floor(command.charge_limit_w),
      discharge_ac_limit_w: Math.floor(command.discharge_limit_w),
      follows_demand: operation === "supply_house",
      charge_ac_mwh: energy(row.charge_w), discharge_ac_mwh: energy(row.discharge_w),
      pv_mwh: energy(pv), load_mwh: energy(row.house_w), import_mwh: energy(Math.max(0, net)),
      export_mwh: energy(Math.max(0, -net)), curtailed_mwh: energy(row.curtailed_w),
      unserved_mwh: energy(row.unserved_w), rounding_mwh: 0,
    };
    result.rounding_mwh = result.pv_mwh + result.import_mwh + result.discharge_ac_mwh -
      result.load_mwh + result.unserved_mwh - result.charge_ac_mwh - result.export_mwh - result.curtailed_mwh;
    return result;
  });
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
    const id = `battery:${kind}:${deadline}`;
    const objective: ExecutionObjective = {
      id, kind, start_ms: intervals[first].start_ms, deadline_ms: deadline,
      target_mwh: intervals[last].stored_end_mwh,
      reason: kind === "stored_energy" ? "Store energy during the planner's selected charging window" :
        kind === "demand_following" ? "Supply the home's eligible demand during this window" : "Keep the planner's selected battery role",
    };
    objectives.push(objective);
    if (kind !== "stored_energy") continue;
    for (let j = first; j <= last; j++) {
      const row = rows[j];
      // Nominal device loads own their forecast headroom first. This quantity is
      // a conditional forecast allocation; HA rechecks real loads/pending writes.
      const nominalGrid = Math.max(0, row.house_w + row.charge_w - row.discharge_w - pv_w[j]);
      const gridRoom = Math.max(0, plan.grid.import_limit_w - nominalGrid);
      const extraAc = Math.min(Math.max(0, battery.charge_max_w - row.charge_w),
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
  return {
    schema: "battery-plan-execution-v1", id: `${plan.plan_id}:battery:${feedback.generation}`,
    plan_id: plan.plan_id, generation: feedback.generation, mode, scope_revision,
    model_revision: `${plan.model_version}:ac-constant-efficiency:${battery.charge_efficiency}:${battery.discharge_efficiency}`,
    energy_basis: "stored_energy_mwh", capacity_mwh: capacity, minimum_mwh: minimum, maximum_mwh: maximum,
    export_reserve_mwh: Math.max(minimum, Math.round(plan.policy.battery_export_reserve_soc * capacity)),
    valid_until_ms: Date.parse(plan.valid_until), source_receipt: feedback.source_receipt,
    previous_contract_id: feedback.previous_contract_id, intervals, objectives, recovery,
    dispositions: feedback.objectives.filter((r) => r.responsibility === "outstanding" || r.responsibility === "retained")
      .map(({ objective }) => {
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
}

/** Validate the external capture before solving; receipt ordering is local only. */
export function validateExecutionFeedback(value: ExecutionFeedback): void {
  integer(value.generation, "generation");
  integer(value.source_receipt, "source receipt");
  if (!value.generation || typeof value.scope_revision !== "string" || !value.scope_revision ||
      (value.previous_contract_id !== null && (typeof value.previous_contract_id !== "string" || !value.previous_contract_id)) ||
      !Array.isArray(value.objectives)) throw new Error("Invalid battery execution feedback identity");
  if (value.observed) {
    integer(value.observed.at_ms, "observed time"); integer(value.observed.stored_mwh, "observed storage");
    if (typeof value.observed.source !== "string" || !value.observed.source) throw new Error("Missing observation provenance");
  }
  const ids = new Set<string>();
  for (const row of value.objectives) {
    if (!row || typeof row.objective?.id !== "string" || !row.objective.id || ids.has(row.objective.id) ||
        !["stored_energy", "demand_following", "permission"].includes(row.objective.kind) ||
        !["outstanding", "retained", "incorporated", "retired"].includes(row.responsibility) ||
        typeof row.outcome !== "string") throw new Error("Invalid prior battery objective");
    integer(row.objective.deadline_ms, "objective deadline"); ids.add(row.objective.id);
  }
}
