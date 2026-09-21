/** Compact search continuation: scalar trials plus only the active auction. */
import {
  balancedBatteryCurve,
  type DispatchWorkbench,
  dispatchWorkbench,
} from "./energy-optimisation.ts";
import {
  type DispatchAuctionSolver,
  type DispatchInfeasibility,
  type DispatchResult,
  scoreDispatch,
} from "./dispatch-plan.ts";
import {
  advanceAuctions,
  type PlanningBudget,
} from "./energy-planning-step.ts";
import type { EnergyPlanningContinuation } from "./energy-planning-protocol.ts";
import {
  type CostCurveEvaluation,
  type CostCurveInput,
  costCurveKey,
  type CostCurveRecord,
  costCurveSearch,
} from "./battery-cost-curve.ts";
import type { UtilityCurve } from "./store-value.ts";

export interface CostCurveProgress {
  evaluations: CostCurveEvaluation[];
  current?: EnergyPlanningContinuation;
  inherited_infeasibilities?: DispatchInfeasibility[];
}
export type CostCurveStep = { done: true; record: CostCurveRecord } | {
  done: false;
  progress: CostCurveProgress;
};

function trial(
  input: CostCurveInput,
  curve: UtilityCurve,
  completed: DispatchResult[],
) {
  let index = 0;
  const pending = new Error("cost_curve_trial_pending");
  let problem: Parameters<DispatchAuctionSolver> | undefined;
  try {
    const workbench = dispatchWorkbench(
      {
        ...input.snapshot,
        battery_curve_mode: "custom",
        battery_cost_curve: undefined,
        value_curves: { ...input.snapshot.value_curves, battery: curve },
      },
      [],
      undefined,
      new Date(input.now),
      "published",
      (...args) => {
        if (index < completed.length) {
          return structuredClone(completed[index++]);
        }
        problem = args;
        throw pending;
      },
    );
    if (!workbench) {
      throw new Error("No measured battery is available for curve selection");
    }
    if (index !== completed.length) {
      throw new Error("Price-curve continuation does not match its input");
    }
    if (workbench.stopped_because === "iteration_cap") {
      throw new Error("Price-curve dispatch reached its iteration cap");
    }
    return { done: true as const, workbench };
  } catch (error) {
    if (error !== pending || !problem) throw error;
    return { done: false as const, problem };
  }
}

export async function costCurveStep(
  input: CostCurveInput,
  progress: CostCurveProgress = { evaluations: [] },
  budget?: PlanningBudget,
): Promise<CostCurveStep> {
  const key = await costCurveKey(input);
  const balanced = balancedBatteryCurve(input.snapshot, new Date(input.now));
  if (!balanced || !input.snapshot.battery) {
    throw new Error("No measured battery is available for curve selection");
  }
  const battery = input.snapshot.battery;
  const capacity = (battery.max_soc - battery.min_soc) * battery.capacity_kwh;
  const seeds = input.snapshot.value_curves?.battery
    ? [input.snapshot.value_curves.battery, balanced]
    : [balanced];
  let scale = Math.max(
    0,
    ...seeds.flatMap((s) => s.points.map((p) => p.sek_per_unit)),
  );
  for (const slot of input.snapshot.slots) {
    if (Date.parse(slot.start) + 900_000 <= Date.parse(input.now)) continue;
    if (
      slot.import_price_sek_per_kwh === null ||
      slot.export_price_sek_per_kwh === null
    ) break;
    scale = Math.max(
      scale,
      Math.abs(slot.import_price_sek_per_kwh) / battery.charge_efficiency,
      Math.abs(slot.export_price_sek_per_kwh) / battery.charge_efficiency,
    );
  }
  const search = costCurveSearch(capacity, scale, seeds);
  let proposal = search.next();
  for (const prior of progress.evaluations) {
    if (
      proposal.done === true ||
      JSON.stringify(
          proposal.value.points.map((p) => [p.at, p.sek_per_unit]),
        ) !==
        JSON.stringify(prior.curve.points.map((p) => [p.at, p.sek_per_unit]))
    ) {
      throw new Error(
        "Price-curve evaluation history does not match its frozen input",
      );
    }
    proposal = search.next(prior.bill_sek);
  }
  let evaluations = progress.evaluations;
  let inherited = progress.inherited_infeasibilities;
  let current = progress.current ?? { completed: [] };
  for (;;) {
    if (proposal.done === true) {
      if (current.completed.length || current.checkpoint) {
        throw new Error("Unexpected unfinished price-curve trial");
      }
      const published = input.snapshot.slots.filter((s) =>
        Date.parse(s.start) + 900_000 > Date.parse(input.now)
      );
      const gap = published.findIndex((s) =>
        s.import_price_sek_per_kwh === null ||
        s.export_price_sek_per_kwh === null
      );
      const last = (gap < 0 ? published : published.slice(0, gap)).at(-1)!;
      return {
        done: true,
        record: {
          key,
          curve: proposal.value.curve,
          source_snapshot_id: input.snapshot.snapshot_id,
          evaluations: evaluations.length,
          bill_before_sek: evaluations[0].bill_sek,
          bill_after_sek: proposal.value.bill_sek,
          published_until: new Date(Date.parse(last.start) + 900_000)
            .toISOString(),
        },
      };
    }
    const candidate = proposal.value;
    let workbench: DispatchWorkbench | undefined;
    const stage = advanceAuctions(
      (completed) => {
        const result = trial(input, candidate, completed);
        if (result.done) workbench = result.workbench;
        return result;
      },
      current,
      budget,
    );
    if (!stage.done) {
      return {
        done: false,
        progress: {
          evaluations,
          inherited_infeasibilities: inherited,
          current: {
            completed: [...current.completed, ...stage.completed],
            ...(stage.checkpoint ? { checkpoint: stage.checkpoint } : {}),
          },
        },
      };
    }
    if (!workbench) {
      throw new Error("Completed price-curve trial has no dispatch");
    }
    const score = scoreDispatch(
      workbench.slots,
      workbench.stores,
      workbench.limits,
      workbench.planned,
    );
    if (!evaluations.length) inherited = score.infeasibilities;
    const inheritedKeys = new Set(
      (inherited ?? []).map((v) =>
        JSON.stringify([v.slot, v.store_key, v.message])
      ),
    );
    if (
      score.infeasibilities.some((v) =>
        !inheritedKeys.has(JSON.stringify([v.slot, v.store_key, v.message]))
      )
    ) {
      throw new Error(
        "Price-curve trial introduced a physical dispatch infeasibility",
      );
    }
    // No wear, starts, shaping, comfort or terminal inventory enters ranking.
    const bill = score.billable_quoted_sek;
    evaluations = [...evaluations, { curve: candidate, bill_sek: bill }];
    current = { completed: [] };
    proposal = search.next(bill);
    if (proposal.done !== true && (!budget || !budget.allowsAuction())) {
      return {
        done: false,
        progress: { evaluations, inherited_infeasibilities: inherited },
      };
    }
  }
}
