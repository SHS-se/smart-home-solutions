// deno run --allow-read scripts/audit-battery-valuation.ts /path/to/workbench.json
// A controlled comparison, not a replacement optimiser: keep the manual EV
// schedule and replenish its extra battery discharge to the planner's end state.
import {
  type DispatchSchedule,
  type DispatchStore,
  scoreDispatch,
} from "../supabase/functions/_shared/planner/dispatch-plan.ts";
import type { WorkbenchExport } from "../src/lib/energy-shift/plan-workbench.ts";

export function auditBatteryValuation(plan: WorkbenchExport) {
  const quarters = plan.quarters;
  const count = quarters.length;
  const version = plan.format === "shs.plan-workbench.v2"
    ? 2
    : plan.format === "shs.plan-workbench.v1"
    ? 1
    : 0;
  if (
    !version || !count ||
    plan.stores.length !== 2 || !plan.stores.some((s) => s.key === "ev") ||
    !plan.stores.some((s) => s.key === "battery")
  ) {
    throw new Error("This audit requires an EV-and-battery workbench export");
  }
  /**
   * The weights and coefficients the objective actually used, when the file
   * carries them.
   *
   * v1 forced this audit to infer the store model — constant efficiencies from
   * measured transitions, a terminal weight assumed for the battery, a usage
   * weight assumed at the horizon's end for the car. Every one of those is now
   * stated, so v2 reproduces the objective from the planner's own inputs rather
   * than from a reconstruction that happened to agree.
   */
  const stated = (key: string) =>
    version >= 2 ? plan.stores.find((s) => s.key === key) : undefined;
  const storeScore = (side: "planner" | "manual", key: string) => {
    const result = plan.scores[side].stores.find((s) => s.key === key);
    if (!result) throw new Error(`Missing ${side} ${key} score`);
    return result;
  };
  // v1 lacks the physical conversion coefficients. Recover them from measured
  // schedule transitions, require constant coefficients, then reproduce both
  // saved objective scores before using them. Do not guess missing physics.
  const rate = (key: string, direction: "charge" | "discharge") => {
    const rates: number[] = [];
    for (const side of ["planner", "manual"] as const) {
      for (let i = 0; i < count; i++) {
        const part = quarters[i][side];
        const watts =
          part[direction === "charge" ? "charge_w" : "discharge_w"][key];
        const other =
          part[direction === "charge" ? "discharge_w" : "charge_w"][key];
        if (watts <= 1 || other > 1e-6) continue;
        const after = i + 1 < count
          ? quarters[i + 1][side].state[key]
          : storeScore(side, key).end_state;
        rates.push(
          (after - part.state[key]) * (direction === "charge" ? 1 : -1) /
            (watts * 0.00025),
        );
      }
    }
    const value = rates[0];
    if (!(value > 0) || rates.some((r) => Math.abs(r - value) > 1e-6)) {
      throw new Error(
        `Cannot establish constant ${key} ${direction} efficiency`,
      );
    }
    return value;
  };
  const chargeEfficiency = rate("battery", "charge");
  const dischargeUnits = rate("battery", "discharge");
  const vehicleUnits = rate("ev", "charge");
  // A stated coefficient and a measured one must agree, or the file describes a
  // schedule its own physics could not have produced.
  if (version >= 2) {
    for (
      const [key, measured, series] of [
        ["battery", chargeEfficiency, "units_per_kwh_by_slot"],
        ["ev", vehicleUnits, "units_per_kwh_by_slot"],
        ["battery", dischargeUnits, "state_per_kwh_out_by_slot"],
      ] as const
    ) {
      const values = plan.stores.find((s) => s.key === key)
        ?.[series] as number[] | null | undefined;
      const first = values?.[0];
      if (typeof first === "number" && Math.abs(first - measured) > 1e-6) {
        throw new Error(
          `${key} ${series} states ${first} but the schedule moves at ${measured}`,
        );
      }
    }
  }
  const batteryScore = storeScore("planner", "battery");
  if (!(batteryScore.discharged_kwh > 0)) {
    throw new Error("No battery discharge to establish wear");
  }
  const wear = batteryScore.wear_sek /
    (batteryScore.discharged_kwh * dischargeUnits);
  const stores: DispatchStore[] = plan.stores.map((s) => ({
    key: s.key,
    curve: { unit: s.state_unit, points: s.curve },
    initial_state: s.initial_state,
    min_state: s.min_state ?? undefined,
    max_state: s.max_state ?? undefined,
    max_power_w: s.max_power_w,
    min_power_w: s.min_power_w,
    power_step_w: s.power_step_w,
    retention_per_slot: stated(s.key)?.retention_per_slot ?? 1,
    terminal_weight: stated(s.key)?.terminal_weight ??
      (s.key === "battery" ? 1 : 0),
    usage_weight: stated(s.key)?.usage_weight ??
      quarters.map((_, i) => (s.key === "ev" && i === count - 1 ? 1 : 0)),
    wear_sek_per_kwh: stated(s.key)?.wear_sek_per_kwh ?? 0,
    start_cost_sek: stated(s.key)?.start_cost_sek ?? 0,
    units_per_kwh: () => s.key === "battery" ? chargeEfficiency : vehicleUnits,
    drift: (state) => state,
    ...(s.key === "battery"
      ? {
        discharge: {
          max_power_w: s.discharge_max_power_w!,
          state_per_kwh_out: () => dischargeUnits,
          export_allowed: s.export_allowed!,
          cycling_cost_sek_per_unit: wear,
        },
      }
      : {}),
  }));
  const schedule = (side: "planner" | "manual"): DispatchSchedule => ({
    power_w: Object.fromEntries(
      stores.map((s) => [s.key, quarters.map((q) => q[side].charge_w[s.key])]),
    ),
    discharge_w: Object.fromEntries(
      stores.map(
        (s) => [s.key, quarters.map((q) => q[side].discharge_w[s.key])],
      ),
    ),
  });
  const score = (s: DispatchSchedule) =>
    scoreDispatch(quarters, stores, plan.limits, s);
  for (const side of ["planner", "manual"] as const) {
    const actual = score(schedule(side));
    const saved = plan.scores[side];
    for (
      const field of [
        "billable_sek",
        "wear_sek",
        "service_value_sek",
        "total_sek",
      ] as const
    ) {
      if (Math.abs(actual[field] - saved[field]) > 1e-6) {
        throw new Error(`Cannot reproduce ${side} ${field}`);
      }
    }
    if (actual.infeasibilities.length) {
      throw new Error(`${side} schedule is infeasible`);
    }
  }
  const candidate = schedule("manual");
  const manual = score(candidate);
  const state = [...manual.state.battery];
  let remaining = batteryScore.end_state - state[count];
  if (!(remaining > 0)) {
    throw new Error("Manual plan does not finish with less battery energy");
  }
  if (
    quarters.some((q) =>
      Math.abs(q.manual.charge_w.ev - q.planner.charge_w.ev) > 1e-6
    )
  ) {
    throw new Error(
      "EV schedules differ; this is not an equal-service comparison",
    );
  }
  const battery = stores.find((s) => s.key === "battery")!;
  const lastExtraDischarge = quarters.findLastIndex((q) =>
    q.manual.discharge_w.battery > q.planner.discharge_w.battery + 1e-6
  );
  const refillSlots = quarters.map((q, i) => ({ q, i }))
    .filter(({ i }) =>
      i > lastExtraDischarge && candidate.discharge_w.battery[i] === 0
    )
    .sort((a, b) =>
      a.q.import_price_sek_per_kwh - b.q.import_price_sek_per_kwh
    );
  const additions = [];
  for (const { q, i } of refillSlots) {
    // This probe uses grid replenishment without increasing the shaping cost.
    // It deliberately makes no claim of globally optimal replenishment.
    if (manual.export_w[i] > 1e-6) continue;
    const gridCeiling = Math.min(
      plan.limits.grid_import_limit_w,
      plan.limits.grid_import_shaping_w,
    );
    const room = Math.min(
      remaining,
      battery.max_state! - Math.max(...state.slice(i + 1)),
      (battery.max_power_w - candidate.power_w.battery[i]) * 0.00025 *
        chargeEfficiency,
      (gridCeiling - manual.import_w[i]) * 0.00025 * chargeEfficiency,
    );
    if (room <= 1e-9) continue;
    const acKwh = room / chargeEfficiency;
    candidate.power_w.battery[i] += acKwh / 0.00025;
    for (let j = i + 1; j <= count; j++) state[j] += room;
    additions.push({
      start: q.start,
      extra_charge_kwh: acKwh,
      import_price: q.import_price_sek_per_kwh,
    });
    remaining -= room;
    if (remaining < 1e-9) break;
  }
  if (remaining > 1e-6) {
    throw new Error(
      "Cannot restore the final state within the available headroom",
    );
  }
  const result = score(candidate);
  if (
    result.infeasibilities.length ||
    Math.abs(result.state.battery[count] - batteryScore.end_state) > 1e-6
  ) {
    throw new Error("Replenished plan failed physical validation");
  }
  const quoted = (side: "planner" | "manual" | "replenished") => {
    if (version < 2) return null;
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      if (!quarters[i].published_price) continue;
      const watts = side === "replenished"
        ? result.import_w[i] - result.export_w[i]
        : quarters[i][side].grid_w;
      const price = watts >= 0
        ? quarters[i].import_price_sek_per_kwh
        : quarters[i].export_price_sek_per_kwh;
      total += watts / 1_000 * 0.25 * price;
    }
    return total;
  };
  const quotedPlanner = quoted("planner");
  const quotedReplenished = quoted("replenished");
  return {
    note: version >= 2
      ? "Complete-horizon comparison; quoted-price figures cover only the quarters the market has published."
      : "Forecast comparison; v1 omits published-price flags, so quoted-price savings cannot be recomputed.",
    planner_bill_sek: plan.scores.planner.billable_sek,
    manual_bill_sek: manual.billable_sek,
    replenished_bill_sek: result.billable_sek,
    equal_end_state_bill_saving_sek: plan.scores.planner.billable_sek -
      result.billable_sek,
    equal_end_state_objective_saving_sek: plan.scores.planner.total_sek -
      result.total_sek,
    quoted_planner_bill_sek: quotedPlanner,
    quoted_manual_bill_sek: quoted("manual"),
    quoted_equal_end_state_saving_sek: quotedPlanner === null ||
        quotedReplenished === null
      ? null
      : quotedPlanner - quotedReplenished,
    final_battery_kwh: result.state.battery[count],
    final_ev_km: result.state.ev[count],
    infeasibilities: result.infeasibilities,
    additions,
  };
}

if (import.meta.main) {
  if (Deno.args.length !== 1) {
    throw new Error("Pass one workbench export JSON path");
  }
  console.log(
    JSON.stringify(
      auditBatteryValuation(JSON.parse(await Deno.readTextFile(Deno.args[0]))),
      null,
      2,
    ),
  );
}
