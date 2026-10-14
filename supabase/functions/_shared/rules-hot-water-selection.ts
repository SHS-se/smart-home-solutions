import type { createWasmPlanner, NativeQuarter, SolveOutcome } from "./planner-wasm/core.ts";
import { endCredit } from "./planner-wasm/end-credit.ts";
import type { ReadyProblem } from "./planner-wasm/ready-problem.ts";
import type { PreparedRulesInput } from "./rules-planner.ts";
import { hotWaterPermission, planHotWaterDemand } from "./planner/hot-water-demand.ts";

type Selection = Extract<SolveOutcome, { kind: "selected" }>["selection"];
type Core = ReturnType<typeof createWasmPlanner>;
interface Candidate { input: PreparedRulesInput; selection: Selection; deferred: Record<string, number> }
// Search work, not a delivery deadline or a bound on observations. Included in
// the artifact source identity. Every trial projects the complete trajectory.
const MASK_TRIALS = 64;
const MIN_GAIN_SEK = .001;

/** Pool/EV commands fix their states and points. Only the native cash, wear
 * and final storage credit change when their household water load changes. */
export function projectedAccount(problem: ReadyProblem, quarters: NativeQuarter[], original: Selection["account"]): Selection["account"] {
  const cash = quarters.reduce((sum, q) => sum + q.cost, 0);
  const wear = quarters.reduce((sum, q) => sum + q.wear, 0);
  const credit = endCredit(problem.end_credit, problem.initial, quarters.at(-1)!).credit_sek;
  return { ...original, cash_sek: cash, wear_sek: wear, credit_sek: credit,
    score_sek: original.points - (cash + wear - credit) };
}

/** Water eligibility and the physical trajectory are selected together. The
 * measured-load gate remains in HA's gross-appliance frame; the battery's
 * actual charging/discharging participates through native economic projection.
 */
export function refineHotWater(core: Core, input: PreparedRulesInput, native: Selection): Candidate {
  if (!input.boiler_services.length) return { input, selection: native, deferred: {} };
  const evaluate = (source: Candidate, eligible: boolean[], level_mode?: "all_loads"): Candidate | undefined => {
    const p = source.input;
    const other = p.base_w.map((w, i) => w + Object.values(p.passive_w).reduce((sum, values) => sum + values[i], 0) +
      source.selection.quarters[i].pool_w + source.selection.quarters[i].ev_w);
    let quarters = source.selection.quarters;
    let permissionPrefix: boolean[] = [];
    let sitePolicies: ReturnType<typeof planHotWaterDemand>["site_policies"] | undefined;
    // A candidate owns its site-load level. Translate that fixed level using
    // the candidate's actual battery flows; publish only a coherent trajectory.
    // Resolve changed permissions in causal prefix order: future water cannot
    // change an earlier battery flow. Every fixed prefix is checked against its
    // own projection. An unsettled search proposal is declined, not published.
    for (let iteration = 0; iteration < 8; iteration++) {
      const water = planHotWaterDemand({ services: p.boiler_services, slots: p.snapshot.slots,
        hours: p.problem.slots.map(s => s.hours + Math.min(0, s.start_seconds) / 3600),
        other_house_w: other, locked: p.locked_slots, eligible, level_mode,
        battery_offset_w: quarters.map(q => q.charge_w - q.discharge_w), site_policies: sitePolicies, permission_prefix: permissionPrefix });
      sitePolicies = water.site_policies;
      const problem = { ...p.problem, slots: p.problem.slots.map((s, i) => ({ ...s, base_w: s.base_w - p.boiler_w[i] + water.expected_w[i] })) };
      const projection = core.project(problem, source.selection.commands).outcome;
      if (projection.kind === "failed") return undefined;
      const checked = planHotWaterDemand({ services: p.boiler_services, slots: p.snapshot.slots,
        hours: p.problem.slots.map(s => s.hours + Math.min(0, s.start_seconds) / 3600),
        other_house_w: other, locked: p.locked_slots, eligible,
        battery_offset_w: projection.quarters.map(q => q.charge_w - q.discharge_w), site_policies: sitePolicies, permission_prefix: permissionPrefix });
      for (let i = p.locked_slots.length; i < permissionPrefix.length; i++) {
        const policy = checked.policies[i];
        const previous = i === 0 || checked.permitted[i - 1];
        const actual = !checked.eligible[i] ? false : policy ? hotWaterPermission(policy, other[i] + (previous ? checked.rated_w[i] : 0), previous) : true;
        if (actual !== checked.permitted[i]) return undefined;
      }
      if (checked.expected_w.every((w, i) => w === water.expected_w[i]) &&
        checked.permitted.every((permit, i) => permit === water.permitted[i])) {
        const updated = { ...p, problem, boiler_w: checked.expected_w, boiler_permitted: checked.permitted,
          boiler_policies: checked.policies, boiler_deferred_kwh: checked.deferred_kwh, boiler_eligible: checked.eligible };
        return { input: updated, deferred: checked.deferred_kwh_by_service,
          selection: { ...source.selection, quarters: projection.quarters,
            account: projectedAccount(problem, projection.quarters, source.selection.account) } };
      }
      const firstChanged = checked.permitted.findIndex((permit, i) => permit !== water.permitted[i]);
      if (firstChanged >= 0) permissionPrefix = checked.permitted.slice(0, firstChanged + 1);
      quarters = projection.quarters;
    }
    return undefined;
  };
  const servesWork = (proposed: Candidate, reference: Candidate) =>
    Object.entries(proposed.deferred).every(([id, kwh]) => kwh <= reference.deferred[id] + 1e-9);
  const improve = (start: Candidate): Candidate => {
    let best = start, trials = 0;
    const indices = input.snapshot.slots.flatMap((_s, i) => i >= input.locked_slots.length && start.input.boiler_policies[i] ? [i] : []);
    // Prices order proposals only. A battery/PV quarter is accepted according
    // to its complete projection, including the energy left in every store.
    indices.sort((a, b) => start.input.problem.slots[b].import_price - start.input.problem.slots[a].import_price || a - b);
    for (const from of indices) {
      for (const length of [4, 1, 8, 2]) {
        if (trials++ >= MASK_TRIALS) return best;
        const eligible = [...best.input.boiler_eligible];
        const value = !eligible[from];
        for (let i = from; i < Math.min(from + length, eligible.length); i++) {
          if (i >= input.locked_slots.length) eligible[i] = value;
        }
        const proposals = [evaluate(best, eligible), evaluate(best, eligible, "all_loads")];
        // Do not make apparent savings by dropping forecast electrical work.
        // Unresolved work is a forecast diagnostic, never hard infeasibility.
        for (const proposed of proposals) {
          if (proposed && servesWork(proposed, best) &&
            proposed.selection.account.score_sek > best.selection.account.score_sek + MIN_GAIN_SEK) best = proposed;
        }
      }
    }
    return best;
  };
  const seed = evaluate({ input, selection: native, deferred: {} }, input.boiler_eligible, "all_loads");
  if (!seed) throw new Error("Hot-water selected-load projection exceeds native equipment limits");
  const valleys = evaluate(seed, input.boiler_eligible);
  let best = improve(valleys ?? seed);
  // Give battery/pool/EV selection one opportunity to respond to the newly
  // selected water timing. Re-evaluate water against its actual chosen loads.
  const response = core.solve(best.input.problem).outcome;
  if (response.kind === "selected") {
    const coordinated = evaluate({ input: best.input, selection: response.selection, deferred: best.deferred }, best.input.boiler_eligible);
    if (coordinated) {
      const proposed = improve(coordinated);
      if (servesWork(proposed, best) &&
        proposed.selection.account.score_sek > best.selection.account.score_sek + MIN_GAIN_SEK) best = proposed;
    }
  }
  return best;
}
