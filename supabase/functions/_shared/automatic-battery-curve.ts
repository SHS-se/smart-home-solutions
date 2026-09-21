/** Daily, bounded curve search. Trial curves never grade their own outcomes. */
import {
  type DispatchLimits,
  type DispatchResult,
  type DispatchSlot,
  type DispatchStore,
  scoreDispatch,
} from "./dispatch-plan.ts";
import type { OptimisationSnapshot } from "./energy-optimisation.ts";
import type { UtilityCurve } from "./store-value.ts";

export const AUTOMATIC_CURVE_VERSION = 1;
export interface AutomaticCurveRecord {
  version: number;
  configuration: string;
  published_prices: [string, number, number | null][];
  generated_from: string;
  curve: UtilityCurve;
  reference_curve: UtilityCurve;
  scope: "published_prices";
  optimality: "best_tested";
  candidates: number;
  objective_before_sek: number;
  objective_after_sek: number;
  published_bill_before_sek: number;
  published_bill_after_sek: number;
  published_until: string;
}

/** Measured state/forecast evolution replans dispatch, not the daily curve search. */
export function automaticCurveIdentity(
  snapshot: OptimisationSnapshot,
): Pick<AutomaticCurveRecord, "configuration" | "published_prices"> {
  const battery = snapshot.battery
    ? { ...snapshot.battery, soc: undefined }
    : null;
  const gap = snapshot.slots.findIndex((s) =>
    s.import_price_sek_per_kwh === null || s.export_price_sek_per_kwh === null
  );
  const published = gap < 0 ? snapshot.slots : snapshot.slots.slice(0, gap);
  return {
    configuration: JSON.stringify({
      battery,
      grid: snapshot.grid,
      policy: snapshot.policy,
      capabilities: snapshot.capabilities,
      curves: snapshot.value_curves,
      settings: snapshot.value_settings,
      pool_model: snapshot.pool_model,
      pool_volume: snapshot.pool?.volume_m3,
      devices: snapshot.device_models.map((model) => ({
        key: model.key,
        role: model.planning_role,
        service: model.planning_service,
        control_type: model.control_type,
        load_type: model.load_type,
      })),
      // Service IDs and multiplicity contain the moving horizon's dates.
      services: [
        ...new Set(snapshot.services.map((s) =>
          JSON.stringify({
            device: s.device,
            control: {
              ...s.control,
              expected_power_w_by_slot: undefined,
            },
          })
        )),
      ].sort(),
    }),
    published_prices: published.map(
      (s) => [
        s.start,
        s.import_price_sek_per_kwh!,
        s.export_price_sek_per_kwh,
      ],
    ),
  };
}

export function reusableAutomaticCurve(
  identity: ReturnType<typeof automaticCurveIdentity>,
  record: AutomaticCurveRecord,
): boolean {
  if (
    record.version !== AUTOMATIC_CURVE_VERSION ||
    record.configuration !== identity.configuration ||
    !identity.published_prices.length ||
    Date.parse(record.published_prices.at(-1)?.[0] ?? "") !==
      Date.parse(identity.published_prices.at(-1)![0])
  ) return false;
  const prices = new Map(
    record.published_prices.map((
      [start, buy, sell],
    ) => [Date.parse(start), [buy, sell]]),
  );
  return identity.published_prices.every(([start, buy, sell]) => {
    const prior = prices.get(Date.parse(start));
    return prior?.[0] === buy && prior?.[1] === sell;
  });
}

/** The incumbent plus twelve price-scaled slopes; the claim is best tested, not global. */
function candidates(reference: UtilityCurve, capacity: number): UtilityCurve[] {
  const peak = reference.points[0]?.sek_per_unit ?? 0;
  const curves = [reference];
  for (const head of [0.75, 1, 1.25]) {
    for (const tail of [0, 0.25, 0.5, 0.75]) {
      curves.push({
        unit: "kwh",
        points: [
          { at: 0, sek_per_unit: peak * head },
          { at: capacity, sek_per_unit: peak * head * tail },
        ],
      });
    }
  }
  return [
    ...new Map(curves.map((curve) => [JSON.stringify(curve), curve])).values(),
  ];
}

export function searchAutomaticBatteryCurve(input: {
  snapshot: OptimisationSnapshot;
  slots: DispatchSlot[];
  stores: DispatchStore[];
  limits: DispatchLimits;
  solve: (stores: DispatchStore[]) => DispatchResult;
}): AutomaticCurveRecord {
  const { snapshot, slots, stores, limits, solve } = input;
  const battery = stores.find((s) => s.key === "battery")!;
  const curves = candidates(battery.curve, battery.max_state!);
  const result = solve(stores);
  const before = scoreDispatch(slots, stores, limits, result);
  let best = before;
  let curve = battery.curve;
  // Existing measured states may already exceed a configured target (e.g. a
  // fully charged EV). Searching must not introduce additional violations or
  // turn that inherited condition into a new whole-home rejection rule.
  const inherited = new Set(
    before.infeasibilities.map((v) => JSON.stringify(v)),
  );
  for (const candidate of curves.slice(1)) {
    const trialStores = stores.map((s) =>
      s.key === "battery" ? { ...s, curve: candidate } : s
    );
    const trial = solve(trialStores);
    const score = scoreDispatch(slots, stores, limits, trial);
    if (
      trial.stopped_because === "iteration_cap" ||
      score.infeasibilities.some((v) => !inherited.has(JSON.stringify(v))) ||
      !Number.isFinite(score.total_sek) ||
      score.total_sek >= best.total_sek - 1e-7
    ) continue;
    best = score;
    curve = candidate;
  }
  return {
    version: AUTOMATIC_CURVE_VERSION,
    ...automaticCurveIdentity(snapshot),
    generated_from: snapshot.snapshot_id,
    curve,
    reference_curve: battery.curve,
    scope: "published_prices",
    optimality: "best_tested",
    candidates: curves.length,
    objective_before_sek: before.total_sek,
    objective_after_sek: best.total_sek,
    published_bill_before_sek: before.billable_sek,
    published_bill_after_sek: best.billable_sek,
    published_until: new Date(
      Date.parse(snapshot.slots[slots.length - 1].start) + 900_000,
    ).toISOString(),
  };
}
