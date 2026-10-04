// Marginal-value dispatch with lookahead.
//
// This replaces the placement rule that produced the defects in
// ENERGY_OPTIMISATION_ARCHITECTURE.md §1.6.1. The old scheduler sized each
// service as a fixed `required_kwh` and placed it as one **contiguous block**
// at the cheapest window in the horizon. Three consequences followed, all
// visible in real plans:
//
//   - a block could not be split, so a car needing five hours could not take
//     three hours of today's surplus and two of tomorrow's;
//   - the block was spread at minimum current, making it long, and the longest
//     low-average-cost window is often days out in the smooth modelled price
//     tail rather than today;
//   - whichever service had the earlier deadline claimed today's solar first,
//     so the car was costed against what the pool had already taken.
//
// Here there are no blocks and no required energy. Every store is a physical
// state with a concave utility curve (§8.2), and in every slot the planner asks
// one question: is a kilowatt-hour worth more to some store than it costs?
// Demand is therefore visible in every slot, and a store that is already
// satisfied simply stops bidding.
//
// **The lookahead.** Pricing each slot in isolation would be myopic: it could
// not know that tomorrow is cloudy and today's surplus should be banked. So
// candidates in *every* slot compete simultaneously on (value − cost), and the
// value of energy delivered early is discounted by how much of it survives to
// the moment it is wanted. That discount is what makes "overheat the pool
// before a cloudy day" a real trade rather than free storage: some of what goes
// in early leaks back out, and the arithmetic says how much.

import {
  marginalValue,
  type UtilityCurve,
  valueOfMove,
} from "./store-value.ts";

export const SLOT_HOURS = 0.25;

/**
 * How many auction/settlement rounds a plan may take to reach a fixed point.
 *
 * Each round strictly re-prices what the last one left, and the observed
 * capsules settle in well under half of this. The cap exists so a horizon that
 * will not converge still ships a schedule and says so, rather than spinning.
 */
const MAX_SETTLE_ROUNDS = 24;

export interface DispatchSlot {
  /** Remaining physical duration; standalone quarter problems omit it. */
  duration_hours?: number;
  pv_w: number;
  /** Base load plus anything not being scheduled here. */
  fixed_load_w: number;
  import_price_sek_per_kwh: number;
  export_price_sek_per_kwh: number;
  /**
   * Whether this quarter is inside the window the plan commits to.
   *
   * Absent means the caller is not distinguishing, and every quarter is treated
   * as indicative — which is what the dispatch tests want.
   */
  binding?: boolean;
  /** Whether the market has actually published this quarter's price. */
  published_price?: boolean;
}

/** Immutable response of an executable command profile, owned by its device model. */
export interface DispatchInputResponse {
  project(commands: number[], hours: number[]): { draw_w: number[]; gain_fraction: number[] };
  afterPrefix(commands: number[], hours: number[]): DispatchInputResponse;
}

export interface DispatchStore {
  input_response?: DispatchInputResponse;
  /** How the curve was derived, carried through to the plan for whoever inspects it; the dispatch does not read it. */
  derivation?: unknown;
  /** Aligned physical durations, including a partially elapsed first quarter. */
  slot_hours?: number[];
  /** Internal candidate construction: specified quarters are held for comparison.
   * This profile is not a device setting or a runtime duration obligation.
   */
  fixed_charge_w_by_slot?: (number | null)[];
  key: string;
  curve: UtilityCurve;
  /** Measured state now, in the curve's own units. */
  initial_state: number;
  max_power_w: number;
  /** Smallest executable non-zero input power. */
  min_power_w?: number;
  /** Executable power increment above `min_power_w`. */
  power_step_w?: number;
  /**
   * Smallest power a two-sided store may be *asked* for, in watts.
   *
   * Not an executable limit like `min_power_w`: the pack runs at any power the
   * house or the sun produces. It bounds what the plan commands as a size —
   * a grid charge, or a discharge that deliberately leaves some import — so
   * neither reaches the inverter as a trickle limit (user requirement,
   * 19 September 2026). Taking surplus solar and covering the whole residual
   * load are permissions rather than sizes: the command sends the pack's own
   * limit and it follows the sun or the house, at any power. Enforced once the
   * search is done, so energy transfers still price every pair continuously.
   */
  min_sized_power_w?: number;
  /** Cost of starting a run: cycling wear, and lost efficiency on restart. */
  start_cost_sek?: number;
  /** Confirmed charging at the horizon boundary; unknown telemetry does not waive a start. */
  initially_charging?: boolean;
  /** Wear cost per kWh passed through the store. */
  wear_sek_per_kwh?: number;
  /**
   * Fraction of an added unit still present one slot later.
   *
   * 1 is lossless. A pool sits near 0.99, so a degree added two days early is
   * largely gone by the deadline — which is exactly why the planner must not
   * treat early and late delivery as equivalent.
   */
  retention_per_slot: number;
  /**
   * When this store's state is actually wanted, as weights summing to 1.
   *
   * This is what separates a service with a deadline from a store that must
   * simply stay warm. A vehicle's weight concentrates at departure; a pool's
   * spreads across the hours somebody might swim. It is also where the
   * distribution over an *uncertain* departure belongs, rather than a single
   * declared time nobody wants to maintain (§8.4).
   */
  usage_weight: number[];
  /**
   * Weight on state still held *after* the horizon ends. The terminal value.
   *
   * Without this the backward pass gives the final slot a retention of zero,
   * so a store concludes that energy it is holding at the edge is worthless and
   * dumps it — the exact horizon-edge artefact §8.4 exists to prevent, and the
   * reason end-of-day SOC targets were ever invented. A house battery sets this
   * to 1 and no usage weight at all: its curve is already the forward-looking
   * replacement cost, so what matters is simply that charge kept to the end is
   * still worth what the curve says.
   */
  terminal_weight?: number;
  /**
   * Value added energy by where it will sit, not only by where it lands.
   *
   * A bid is priced at the state standing in its own quarter, and energy bought
   * later never lowers that: with the afternoon already bought, the night
   * before it still saw a cold pool and bid as hard, quarter after quarter
   * backwards, until one run held 61 kWh for a pool that wanted 15. Settlement
   * then found the run under water as a whole, released all of it, and the
   * next round bought it again: the plan that shipped heated nothing.
   *
   * With this set, a unit is worth at most the average of what the curve says
   * at every state it will sit on from its quarter to the end, each hour
   * counting alike and the time after the horizon counting as this many hours,
   * less what leaks on the way. A dip before heat already bought still bids,
   * for the hours the dip lasts; heat stacked on heat already bought does not.
   */
  sustained_value_tail_hours?: number;
  /** Physical units gained per kWh delivered, at this state and slot. */
  units_per_kwh: (state: number, index: number) => number;
  /** State one slot later with no energy delivered: losses, ambient drift. */
  drift: (state: number, index: number) => number;
  /** Hard bounds on the state, if it has any. */
  min_state?: number;
  max_state?: number;
  /**
   * Present only for a store that can give energy back to the house.
   *
   * The house battery is the one two-sided store, and unifying it with the
   * sinks is what makes the comparison in §8.9 complete. Before this, charging
   * was decided by marginal value while discharging was decided by a separate
   * greedy rule in the simulator, so the two could disagree: the planner could
   * fill the battery from surplus in the afternoon on the grounds that stored
   * energy was valuable, and the simulator could empty it an hour later to
   * cover a load it valued at nothing. One mechanism cannot contradict itself.
   */
  discharge?: {
    max_power_w: number;
    /** State consumed per kWh actually delivered to the house. */
    state_per_kwh_out: (state: number, index: number) => number;
    /** Whether discharging into export is permitted, not merely to cover load. */
    export_allowed: boolean;
    export_allowed_by_slot?: boolean[];
    export_min_state?: number;
    /** Cycling cost per unit of state, already embedded in the utility curve.
     * Balanced transfers leave terminal utility unchanged, so pay it explicitly. */
    cycling_cost_sek_per_unit?: number;
  };
}

export interface DispatchLimits {
  grid_import_limit_w: number;
  grid_export_limit_w: number;
  /**
   * Grid import above which drawing more starts to cost something beyond the
   * energy, in watts. Below it nothing is shaped, so ordinary household load —
   * which the plan cannot move anyway — is left entirely alone.
   */
  grid_import_shaping_w: number;
  /**
   * What a kilowatt of import above that threshold adds to every kilowatt-hour
   * drawn in the same quarter, SEK/kWh per kW.
   *
   * §8.16's shadow price on power, and requirements 1, 2 and 4 all come out of
   * its being *convex*: the marginal cost rises with the power already
   * committed, so spreading a given energy across more quarters is cheaper than
   * concentrating it, backing off is automatic when another load has taken the
   * room, and covering a little of every quarter beats covering all of a few.
   * None of those three is written down anywhere.
   *
   * Zero disables this shaping term; continuity and equipment costs remain.
   */
  peak_shaping_sek_per_kwh_per_kw: number;
  /** Soft preferences, not invoiced costs. Used by the service-preserving refinement. */
  grid_ramp_sek_per_kw?: number;
  /** Applies only to equipment with an explicit heat-pump start cost. */
  load_start_preference_sek?: number;
}

export interface DispatchAllocationDiagnostic {
  store_key: string;
  direction: "charge" | "discharge";
  trigger: "economic_winner";
  allocation_order: number;
  /** Power/state were changed by the service-preserving cost refinement. */
  cost_refined?: boolean;
  /** Power was rounded onto the store's minimum active power, or to rest. */
  minimum_adjusted?: boolean;
  fixed_profile?: boolean;
  run_start_index: number;
  run_slots: number;
  power_w: number;
  state_before: number;
  state_after: number;
  state_unit: string;
  retention_factor: number;
  average_value_sek_per_kwh: number;
  energy_cost_sek_per_kwh: number;
  wear_cost_sek_per_kwh: number;
  start_cost_sek: number;
  net_value_sek: number;
  run_net_value_sek: number;
  solar_w: number;
  grid_w: number;
  discharge_destination: "load" | "export" | "mixed" | null;
  /** Joint storage transactions, priced together rather than against reserve value. */
  energy_transfers?: {
    charge_index: number;
    discharge_index: number;
    charged_kwh: number;
    discharged_kwh: number;
    saving_sek: number;
    grid_charged_kwh: number;
  }[];
}

export interface DispatchBatteryDiagnostic {
  action: "charge" | "discharge" | "hold";
  reason:
    | "profitable_charge"
    | "profitable_discharge"
    | "retained_value_exceeds_import"
    | "charge_value_below_export"
    | "state_floor"
    | "state_ceiling"
    | "future_state_constraint"
    | "load_added_after_dispatch"
    | "balanced";
  state_before: number;
  state_after: number;
  state_unit: string;
  /** Power the comparison covered; zero only when there was nothing to trade. */
  comparison_power_w: number;
  power_w: number;
  comparison_price_sek_per_kwh: number | null;
  stored_value_sek_per_kwh: number | null;
  wear_cost_sek_per_kwh: number;
  net_value_sek: number | null;
}

export interface DispatchResult {
  responsive_search?: { evaluations: number; stopped_because: "work_budget" | "neighborhood_exhausted" };
  power_w: Record<string, number[]>;
  /** Energy returned to the house, per store. Zero for a pure sink. */
  discharge_w: Record<string, number[]>;
  state: Record<string, number[]>;
  import_w: number[];
  export_w: number[];
  /** Accepted bids, recorded in the quarter where their power is applied. */
  allocations: DispatchAllocationDiagnostic[][];
  /** The battery comparison in every quarter, including an explicit hold. */
  battery: (DispatchBatteryDiagnostic | null)[];
  /** Why the last candidate was refused, for explaining a plan. */
  stopped_because:
    | "no_profitable_candidate"
    | "iteration_cap"
    | "settle_cap"
    | "settle_cycle";
  iterations: number;
}

/** Continuous storage with no intermediate utility can move equal stored energy. */
function supportsEnergyTransfers(store: DispatchStore): boolean {
  if (store.fixed_charge_w_by_slot) return false;
  return store.discharge !== undefined && store.retention_per_slot === 1 &&
    store.usage_weight.every((weight) => weight === 0) &&
    (store.min_power_w ?? 0) === 0 && (store.power_step_w ?? 0) === 0 &&
    (store.start_cost_sek ?? 0) === 0;
}

/** A two-sided store's smallest commandable size one way, never above what it can do. */
export function sizedMinimumW(
  store: DispatchStore,
  direction: "charge" | "discharge",
): number {
  const minimum = store.min_sized_power_w ?? 0;
  if (!(minimum > 0) || !store.discharge) return 0;
  return Math.min(
    minimum,
    direction === "charge" ? store.max_power_w : store.discharge.max_power_w,
  );
}

/**
 * The surplus a quarter can charge from before it buys anything.
 *
 * `otherChargeW` is every other store's draw in the quarter; what is left of
 * the sun after the house and them is what a charge can take as a permission.
 */
function surplusChargeW(
  slot: DispatchSlot,
  otherChargeW: number,
): number {
  return Math.max(0, slot.pv_w - slot.fixed_load_w - otherChargeW);
}

/** What the house still needs once the sun and any other store have spoken. */
function residualLoadW(
  slot: DispatchSlot,
  otherChargeW: number,
  otherReturnedW: number,
): number {
  return Math.max(
    0,
    slot.fixed_load_w + otherChargeW - Math.max(0, slot.pv_w) - otherReturnedW,
  );
}

/**
 * Whether a flow is commanded at its own size, rather than as a permission.
 *
 * `batteryCommand` sends solar capture as the pack's whole charge limit and
 * full house supply as "follow demand"; only a grid charge, a partial
 * discharge and an export carry a size. The floor applies to those alone, so
 * the sun still fills the pack a hundred watts at a time and the pack still
 * covers a small house on its own.
 */
function sizedFlow(
  watts: number,
  charging: boolean,
  permittedW: number,
): boolean {
  if (watts <= GRID_NOISE_W) return false;
  return charging
    ? watts > permittedW + COMMAND_EPSILON_W
    : Math.abs(watts - permittedW) > COMMAND_EPSILON_W;
}

/** Sized, and below the floor the household set for a sized request. */
function belowSizedMinimum(
  watts: number,
  floorW: number,
  charging: boolean,
  permittedW: number,
): boolean {
  return watts + 1e-6 < floorW && sizedFlow(watts, charging, permittedW);
}

/** The tolerance `batteryCommand` classifies an operation within. */
const COMMAND_EPSILON_W = 0.01;

/** Room for adding state at one quarter and removing it at another. */
function transferRoom(
  state: number[],
  charge: number,
  low: number,
  high: number,
): number[] {
  const room = new Array<number>(state.length - 1).fill(0);
  let highest = -Infinity;
  for (let other = charge + 1; other < room.length; other += 1) {
    highest = Math.max(highest, state[other]);
    room[other] = high - highest;
  }
  let lowest = Infinity;
  for (let other = charge - 1; other >= 0; other -= 1) {
    lowest = Math.min(lowest, state[other + 1]);
    room[other] = lowest - low;
  }
  return room;
}

/**
 * Midpoint of the bracket a 24-probe bisection of `saving` over
 * [0, `maximumW`] ends with: the power where the marginal saving reaches zero.
 *
 * When `nonIncreasing`, one evaluation often settles every probe. Each term of
 * a transfer's marginal saving moves one way with the transferred power, and
 * correctly rounded arithmetic preserves that order, so the computed saving
 * cannot rise between two probes. A positive saving at the top of the bracket
 * is then positive at every probe, and one that is not positive at the lowest
 * probe is not positive at any: both walks below reproduce the probe sequence
 * exactly. The transfer scan bisects every charge/discharge pair on every
 * transfer, so this was the largest single cost in a stage that outran a
 * planning worker's CPU limit.
 */
function bisectedLevel(
  maximumW: number,
  saving: (outW: number) => number,
  nonIncreasing: boolean,
): number {
  let low = 0, high = maximumW;
  if (nonIncreasing) {
    if (saving(high) > 0) {
      for (let step = 0; step < 24; step += 1) low = (low + high) / 2;
      return (low + high) / 2;
    }
    let lowest = high;
    for (let step = 0; step < 24; step += 1) lowest = (low + lowest) / 2;
    if (saving(lowest) <= 0) return (low + lowest) / 2;
  }
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (saving(middle) > 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * How much of a unit delivered at `index` survives to when it is wanted.
 *
 * Precomputed per store, and the whole of the lookahead. A store whose usage
 * weight lies mostly in the past has nothing left to gain and stops bidding; a
 * store whose usage is imminent values delivery now almost fully; a store whose
 * usage is days away discounts delivery now by its own leak rate.
 */
function retentionBySlot(store: DispatchStore, slots: number): number[] {
  const retention = new Array(slots).fill(0);
  const decay = Math.min(1, Math.max(0, store.retention_per_slot));
  // Walk backwards so each slot reuses the next one's tail in O(1).
  //   R[t] = w[t+1] + decay * R[t+1]
  let tail = store.terminal_weight ?? 0;
  for (let index = slots - 1; index >= 0; index -= 1) {
    const nextWeight = store.usage_weight[index + 1] ?? 0;
    tail = nextWeight + Math.pow(decay, hoursAt(store, index) / SLOT_HOURS) * tail;
    retention[index] = tail;
  }
  return retention;
}

const hoursAt = (store: DispatchStore, index: number): number => store.slot_hours?.[index] ?? SLOT_HOURS;

/** The physical transition before applying the store's state bounds. */
function nextState(
  store: DispatchStore,
  current: number,
  chargeW: number,
  dischargeW: number,
  index: number,
): number {
  const gained = chargeW / 1_000 * hoursAt(store, index) *
    store.units_per_kwh(current, index);
  const spent = dischargeW > 0
    ? dischargeW / 1_000 * hoursAt(store, index) *
      (store.discharge?.state_per_kwh_out(current, index) ?? 0)
    : 0;
  return store.drift(current + gained - spent, index);
}

/**
 * The band a schedule may move a store within during one quarter.
 *
 * A bound limits what the schedule does to a store, not where the store may
 * be. A car measured above its charge limit, a pool the weather warmed past its
 * stop temperature and a pack below a cut-off raised after it discharged are
 * realistic states: leaving them alone is feasible. The band therefore widens
 * to wherever the store goes on its own, and only charge that raises it
 * further above its ceiling, or discharge that lowers it further below its
 * floor, falls outside.
 */
function transitionBand(
  store: DispatchStore,
  current: number,
  index: number,
): { floor: number; ceiling: number } {
  const passive = store.drift(current, index);
  return {
    floor: Math.min(store.min_state ?? -Infinity, passive),
    ceiling: Math.max(store.max_state ?? Infinity, passive),
  };
}

/** The state a transition lands on once the schedule's band is applied. */
function boundedState(
  store: DispatchStore,
  current: number,
  next: number,
  index: number,
): number {
  if (
    next >= (store.min_state ?? -Infinity) &&
    next <= (store.max_state ?? Infinity)
  ) return next;
  const { floor, ceiling } = transitionBand(store, current, index);
  return Math.min(ceiling, Math.max(floor, next));
}

/** Project a store's state through the horizon under a power schedule. */
function project(
  store: DispatchStore,
  powerW: number[],
  dischargeW: number[],
  from: number,
  state: number[],
): void {
  for (let index = from; index < powerW.length; index += 1) {
    const next = nextState(
      store,
      state[index],
      powerW[index],
      dischargeW[index],
      index,
    );
    state[index + 1] = boundedState(store, state[index], next, index);
  }
}

/**
 * Suffix extremes of a state trajectory.
 *
 * A discharge at one slot lowers the state in every later slot, so it is only
 * feasible if the *lowest* state still to come can absorb it. Checking the
 * running minimum is what stops the planner promising energy it will already
 * have spent, which a per-slot bound check silently permits.
 */
function suffixBounds(
  state: number[],
  min: number[],
  max: number[],
): void {
  let runningMin = Infinity;
  let runningMax = -Infinity;
  for (let index = state.length - 1; index >= 0; index -= 1) {
    runningMin = Math.min(runningMin, state[index]);
    runningMax = Math.max(runningMax, state[index]);
    min[index] = runningMin;
    max[index] = runningMax;
  }
}

/**
 * Charge power a store can still absorb, from the room left in its state.
 *
 * The binding state is the *highest* the trajectory still reaches, not the one
 * standing in this slot: charging here raises every later slot too, so a store
 * that fills up tomorrow afternoon has no room this morning either. That makes
 * this the exact mirror of the suffix minimum the discharge side already
 * checks, and its absence is why a pack with 6 kWh of room was issued a plan
 * that bought 12 kWh from the grid — `project` clamped the state silently
 * while the schedule kept the command, so the plan asked the inverter for
 * charging it could not take and the summary counted imports never made.
 */
function chargeRoomW(
  store: DispatchStore,
  highestState: number,
  unitsPerKwh: number,
  index: number,
): number {
  if (store.max_state === undefined) return Infinity;
  const roomUnits = store.max_state - highestState;
  if (roomUnits <= 0) return 0;
  return roomUnits / unitsPerKwh / hoursAt(store, index) * 1_000;
}

/**
 * Blended cost of adding `addedW` in one slot, in SEK per kWh.
 *
 * Surplus PV is charged at the **export** price, not zero: consuming it forgoes
 * the revenue it would otherwise earn, and that opportunity cost is the whole
 * reason self-consumption is a decision rather than a reflex. Anything beyond
 * the surplus is charged at the import price.
 */
function energyCostSekPerKwh(
  slot: DispatchSlot,
  occupiedW: number,
  addedW: number,
  limits: DispatchLimits,
  returnedW = 0,
): number {
  if (addedW <= 0) return 0;
  const surplusW = Math.max(0, slot.pv_w - slot.fixed_load_w - occupiedW);
  const solarW = Math.min(addedW, surplusW);
  const gridW = addedW - solarW;
  return (
        solarW * slot.export_price_sek_per_kwh +
        gridW * slot.import_price_sek_per_kwh
      ) / addedW +
    peakSekPerKwh(limits, gridImportW(slot, occupiedW, returnedW), gridW);
}

/** What the house is already drawing from the grid in this quarter. */
function gridImportW(
  slot: DispatchSlot,
  occupiedW: number,
  returnedW: number,
): number {
  return Math.max(
    0,
    slot.fixed_load_w + occupiedW - Math.max(0, slot.pv_w) - returnedW,
  );
}

/** How far one import figure sits above the shaping threshold, in kW. */
function overThresholdKw(limits: DispatchLimits, importW: number): number {
  return Math.max(0, importW - limits.grid_import_shaping_w) / 1_000;
}

/**
 * What raising this quarter's import by `addedW` costs beyond the energy.
 *
 * The integral of the marginal price across the interval, not the average of
 * its endpoints. The two agree while both ends sit above the threshold, and
 * they disagree across the kink — which is most of the interesting cases,
 * because a quarter that starts below the threshold pays nothing until it
 * crosses. Averaging the endpoints there overcharges the crossing block, and
 * over-credits the mirror case below by as much as five times.
 */
function peakSekPerKwh(
  limits: DispatchLimits,
  importBeforeW: number,
  addedW: number,
): number {
  const rate = limits.peak_shaping_sek_per_kwh_per_kw;
  if (!(rate > 0) || addedW <= 0) return 0;
  const before = overThresholdKw(limits, importBeforeW);
  const after = overThresholdKw(limits, importBeforeW + addedW);
  return rate * (after * after - before * before) / (2 * (addedW / 1_000));
}

/**
 * What lowering this quarter's import by `removedW` is worth beyond the energy.
 *
 * The mirror of `peakSekPerKwh`, and the reason a battery too small to cover a
 * dear evening spreads across all of it: a kilowatt taken off the top of a high
 * quarter is worth more than one taken off a low quarter, so covering a little
 * of every quarter beats covering all of a few (§8.16 requirement 4).
 */
function peakReliefSekPerKwh(
  limits: DispatchLimits,
  importBeforeW: number,
  removedW: number,
): number {
  const rate = limits.peak_shaping_sek_per_kwh_per_kw;
  if (!(rate > 0) || removedW <= 0) return 0;
  const before = overThresholdKw(limits, importBeforeW);
  const after = overThresholdKw(
    limits,
    Math.max(0, importBeforeW - removedW),
  );
  // Capped by construction at the whole triangle above the threshold, which is
  // what makes a store spread: once a quarter has been brought down to the
  // threshold there is no more relief to be had in it, and the next kilowatt is
  // worth more somewhere still above it. The averaged form went on paying —
  // 1.44 SEK for a 9.6 kW discharge whose real relief was 0.30 — so emptying
  // the pack into one quarter looked nearly five times better than it was.
  return rate * (before * before - after * after) / (2 * (removedW / 1_000));
}

/** Power still available in a slot before the import limit binds. */
function headroomW(
  slot: DispatchSlot,
  limits: DispatchLimits,
  occupiedW: number,
  returnedW = 0,
): number {
  const availableW = limits.grid_import_limit_w + Math.max(0, slot.pv_w) +
    returnedW - slot.fixed_load_w - occupiedW;
  return Math.max(0, availableW);
}

/**
 * Whether a store may buy grid energy in this quarter to sell back later.
 *
 * Nord Pool publishes one day ahead and the rest of the horizon is a shaped
 * prior. The prior is flatter than any real day and never as cheap, so the last
 * published quarters always look like the bargain of the week — one deployed
 * plan bought at a published 0.905 SEK/kWh to discharge into a modelled 1.8,
 * spending inside its binding window against a forecast. Export already refuses
 * to act without a published price; buying holds the same line.
 *
 * Outside the binding window the plan is indicative and will be regenerated, so
 * it may reason about the prior freely. Inside it, the round trip needs a sell
 * leg the market has actually quoted.
 */
// The suffix excludes the current quarter: a purchase cannot be its own sell leg.
// Prices are immutable for this auction, so this O(n) pass replaces every scan.
function publishedSellPrices(slots: DispatchSlot[]): number[] {
  const prices = new Array<number>(slots.length);
  let highest = -Infinity;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    prices[index] = highest;
    if (slots[index].published_price === true) {
      highest = Math.max(highest, slots[index].import_price_sek_per_kwh);
    }
  }
  return prices;
}

/**
 * Allocate energy to the stores that value it above its cost.
 *
 * Greedy on the best (value − cost) surplus across every store and every slot
 * at once. Greedy is not a shortcut here: with concave utility, the highest
 * marginal bid is always the right next allocation, and taking them in that
 * order is what lets a cheap sunny slot two days out lose to an expensive slot
 * today when the store needs the energy sooner — or win when it does not.
 *
 * What greedy alone does not give is a self-consistent result: each bid is
 * priced against the state trajectory as it stood at the time, and later
 * allocations move that trajectory. The settling pass after the auction
 * re-prices every commitment where it actually lands and releases what no
 * longer pays, so the plan that ships is the plan that was priced.
 *
 * Priority is nowhere in this function, because priority is an output. What the
 * old scheduler encoded as a fixed order — pool before car, both before
 * battery — falls out of comparing marginal values, and reverses on its own
 * when a car is nearly full or a pool has fallen out of its band (§8.9).
 * Complete schedules are compared so early purchases do not lock out solar.
 */
/**
 * What one schedule is worth, judged the way the planner judges its own.
 *
 * The objective in §8.2 was, until now, a closure inside `planDispatch` that
 * only ever ran on schedules `planDispatch` had just produced. That made one
 * question unanswerable: is a plan bad because the *objective* is wrong, or
 * because the *search* failed to find the best schedule the objective allows?
 * Scoring an arbitrary schedule separates them. A hand-built plan that scores
 * better than the planner's proves the search left money on the table; one that
 * scores worse while still looking better to a human indicts a utility curve.
 *
 * Both sides must be judged by the same arithmetic or the comparison says
 * nothing, so `planDispatch` selects on this function rather than on a private
 * copy of it.
 */
export interface DispatchSchedule {
  /** Charge power per store per slot. Missing stores are treated as idle. */
  power_w: Record<string, number[]>;
  /** Discharge power per store per slot. Missing stores are treated as idle. */
  discharge_w: Record<string, number[]>;
  /**
   * Quarters in which a store may sell into the grid despite its contract.
   *
   * A pack whose `export_allowed` is false is not physically incapable of it —
   * the household has simply not agreed to it. Asking "what would it be worth
   * if I did, in this hour" is a legitimate question to put to the objective,
   * and refusing to price it would make the answer unavailable. Absent means
   * the contract stands.
   */
  allow_export?: boolean[];
}

/**
 * Grid flow below which a figure is arithmetic noise rather than power.
 *
 * A 72-hour projection accumulates float error, and a quarter that balances
 * exactly comes out as 1.1e-13 W. A sub-microwatt is not a quantity any meter
 * or inverter represents, so reporting it as an export — or letting it trip the
 * export contract — describes the arithmetic rather than the house.
 */
export const GRID_NOISE_W = 1e-6;

export interface DispatchScoreStore {
  key: string;
  state_unit: string;
  charged_kwh: number;
  discharged_kwh: number;
  end_state: number;
  /** Utility delivered, already weighted by usage and terminal weight. */
  service_value_sek: number;
  wear_sek: number;
  start_sek: number;
  runs: number;
}

export interface DispatchScore {
  /** Physical interval-average electricity; schedule.power_w remains executable commands. */
  draw_w: Record<string, number[]>;
  /**
   * The objective. **Lower is better** — it is a cost net of service delivered,
   * and it is routinely negative on a plan that delivers more than it spends.
   */
  total_sek: number;
  import_sek: number;
  /** Revenue, stated positive and subtracted from the total. */
  export_sek: number;
  peak_sek: number;
  continuity_sek: number;
  start_sek: number;
  wear_sek: number;
  /** Utility delivered across every store, subtracted from the total. */
  service_value_sek: number;
  /**
   * What the plan costs in money: energy bought less energy sold, and nothing
   * else.
   *
   * The objective is deliberately not this — it is cost net of the service
   * delivered, because minimising cost alone is degenerate (§8.1). But that
   * makes `total_sek` depend on the utility curves, and a household comparing
   * two plans is entitled to the half of the answer that does not.
   *
   * Wear and start costs are excluded because nobody invoices them, and the
   * peak term with them: §8.16's shadow price on power is a stated shaping
   * choice, not a tariff, and there is no demand charge on this grid today.
   * Each is reported separately above.
   */
  billable_sek: number;
  /**
   * The part of that the market has actually quoted.
   *
   * Two thirds of a 72-hour horizon is priced against a shaped prior (§1.4.3),
   * so the whole-horizon figure is a forecast wearing a currency symbol. This
   * one is money.
   */
  billable_quoted_sek: number;
  grid_import_kwh: number;
  grid_export_kwh: number;
  import_w: number[];
  export_w: number[];
  state: Record<string, number[]>;
  stores: DispatchScoreStore[];
  /**
   * Physical or contractual rules the schedule breaks.
   *
   * A hand-built plan must not be allowed to win by charging a full battery or
   * exceeding the service fuse, and `project` clamps a state silently, so an
   * infeasible schedule would otherwise score as though the clamp were free.
   */
  infeasibilities: DispatchInfeasibility[];
}

/**
 * One broken rule, carrying the quarter it happens in.
 *
 * The quarter is structured rather than written into the sentence so a reader
 * can be *taken* to it: "slot 58" is a number nobody holds, and a plan is
 * corrected by looking at 10:30 in the schedule, not by counting quarters.
 */
export interface DispatchInfeasibility {
  /** Index into the horizon's quarters. */
  slot: number;
  /** The store that broke the rule, or null when the house did. */
  store_key: string | null;
  /** What went wrong, with no slot reference of its own. */
  message: string;
}

/** Maximal blocks of consecutive slots the store is drawing in. */
function runsOf(powerW: number[]): { start: number; slots: number }[] {
  const runs: { start: number; slots: number }[] = [];
  let start = -1;
  for (let index = 0; index <= powerW.length; index += 1) {
    const on = index < powerW.length && (powerW[index] ?? 0) > 1e-9;
    if (on && start < 0) start = index;
    if (!on && start >= 0) {
      runs.push({ start, slots: index - start });
      start = -1;
    }
  }
  return runs;
}

export function scoreDispatch(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  schedule: DispatchSchedule,
  /**
   * Quarters to *account for*. Omitted means the whole horizon.
   *
   * Only the arithmetic narrows. The trajectory is always projected from the
   * first quarter, because a day does not start with an empty battery — asking
   * what Tuesday cost means asking what it cost given where Monday left the
   * house, and a window that re-projected from its own edge would answer a
   * question about a different home.
   *
   * Terminal value belongs to the window that contains the horizon's end, and
   * to no other: it prices what the house is left holding, which is not a thing
   * Tuesday can be credited with when Wednesday is still to come.
   */
  range?: { from: number; to: number },
): DispatchScore {
  return scoreDispatchWithReuse(slots, stores, limits, schedule, range);
}

// Only refinement uses this: exactly one store's power changes between trials.
// Other trajectories, hardware checks and store accounts remain identical.
function scoreDispatchWithReuse(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  schedule: DispatchSchedule,
  range?: { from: number; to: number },
  reuse?: { previous: DispatchScore; changedKey: string },
): DispatchScore {
  const count = slots.length;
  const from = Math.max(0, range?.from ?? 0);
  const to = Math.min(count, range?.to ?? count);
  const zeros = () => new Array<number>(count).fill(0);
  const infeasibilities: DispatchInfeasibility[] = [];
  const powerByKey: Record<string, number[]> = {};
  const drawByKey: Record<string, number[]> = {};
  const dischargeByKey: Record<string, number[]> = {};
  const stateByKey: Record<string, number[]> = {};

  for (const store of stores) {
    const inputPower = schedule.power_w[store.key];
    const inputDischarge = schedule.discharge_w[store.key];
    const power = inputPower?.length === count
      ? inputPower
      : (inputPower ?? zeros()).slice(0, count);
    const discharge = inputDischarge?.length === count
      ? inputDischarge
      : (inputDischarge ?? zeros()).slice(0, count);
    while (power.length < count) power.push(0);
    while (discharge.length < count) discharge.push(0);
    store.fixed_charge_w_by_slot?.forEach((watts, index) => {
      if (watts !== null && Math.abs(power[index] - watts) > 1e-6) {
        infeasibilities.push({ slot: index, store_key: store.key, message: "Candidate changed a specified store profile" });
      }
    });
    powerByKey[store.key] = power;
    const response = store.input_response?.project(power, slots.map((slot) => slot.duration_hours ?? SLOT_HOURS));
    drawByKey[store.key] = response?.draw_w ?? power;
    dischargeByKey[store.key] = discharge;
    if (reuse && store.key !== reuse.changedKey) {
      stateByKey[store.key] = reuse.previous.state[store.key];
      continue;
    }

    // Project the trajectory unclamped so a schedule that overfills or drains a
    // store is reported rather than quietly bounded into feasibility. A state
    // the store reaches on its own is not the schedule's doing (see
    // `transitionBand`), so it is carried forward and never reported.
    const low = store.min_state ?? -Infinity;
    const high = store.max_state ?? Infinity;
    const state = new Array<number>(count + 1).fill(store.initial_state);
    for (let index = 0; index < count; index += 1) {
      const next = nextState(
        store,
        state[index],
        power[index] * (response?.gain_fraction[index] ?? 1),
        discharge[index],
        index,
      );
      if (next < low - 1e-6 || next > high + 1e-6) {
        const { floor, ceiling } = transitionBand(store, state[index], index);
        if (next < floor - 1e-6 || next > ceiling + 1e-6) {
          infeasibilities.push({
            slot: index + 1,
            store_key: store.key,
            message: `${store.key} reaches ${
              next.toFixed(2)
            } ${store.curve.unit}, outside ${low}–${high}`,
          });
        }
      }
      state[index + 1] = boundedState(store, state[index], next, index);
    }
    stateByKey[store.key] = state;

    const minimum = store.min_power_w ?? 0;
    const step = store.power_step_w ?? 0;
    for (let index = 0; index < count; index += 1) {
      const watts = power[index];
      if (watts > store.max_power_w + 1e-6) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message: `${store.key} draws ${Math.round(watts)} W, above its ${
            Math.round(store.max_power_w)
          } W maximum`,
        });
      }
      if (watts > 1e-9 && watts + 1e-6 < minimum) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message: `${store.key} draws ${Math.round(watts)} W, below the ${
            Math.round(minimum)
          } W it can execute`,
        });
      }
      if (
        watts > 1e-9 && step > 0 &&
        Math.abs(
            (watts - minimum) / step - Math.round((watts - minimum) / step),
          ) >
          1e-6
      ) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message: `${store.key} draws ${Math.round(watts)} W, off its ${
            Math.round(step)
          } W increment`,
        });
      }
      const out = discharge[index];
      if (out > 1e-9 && !store.discharge) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message: `${store.key} returns ${
            Math.round(out)
          } W but cannot discharge`,
        });
      } else if (out > (store.discharge?.max_power_w ?? 0) + 1e-6) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message: `${store.key} returns ${Math.round(out)} W, above its ${
            Math.round(store.discharge?.max_power_w ?? 0)
          } W maximum`,
        });
      }
    }
  }

  const occupiedW = zeros();
  const returnedW = zeros();
  for (const store of stores) {
    for (let index = 0; index < count; index += 1) {
      occupiedW[index] += drawByKey[store.key][index];
      returnedW[index] += dischargeByKey[store.key][index];
    }
  }

  // A sized request under the store's floor, which needs the quarter's whole
  // balance to recognise: what the sun leaves over, and what the house still
  // wants, decide whether a flow carries a size at all.
  for (const store of stores) {
    const chargeFloor = sizedMinimumW(store, "charge");
    const dischargeFloor = sizedMinimumW(store, "discharge");
    if (chargeFloor <= 0 && dischargeFloor <= 0) continue;
    if (reuse && store.key !== reuse.changedKey) continue;
    const power = powerByKey[store.key];
    const discharge = dischargeByKey[store.key];
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index];
      const otherChargeW = occupiedW[index] - power[index];
      if (
        belowSizedMinimum(
          power[index],
          chargeFloor,
          true,
          surplusChargeW(slot, otherChargeW),
        )
      ) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message: `${store.key} draws ${
            Math.round(power[index])
          } W from the grid, below its ${Math.round(chargeFloor)} W minimum`,
        });
      }
      if (
        belowSizedMinimum(
          discharge[index],
          dischargeFloor,
          false,
          residualLoadW(slot, otherChargeW, returnedW[index] - discharge[index]),
        )
      ) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message: `${store.key} returns ${
            Math.round(discharge[index])
          } W, below its ${Math.round(dischargeFloor)} W minimum`,
        });
      }
    }
  }

  const importW = zeros();
  const exportW = zeros();
  for (let index = 0; index < count; index += 1) {
    const raw = slots[index].pv_w + returnedW[index] -
      slots[index].fixed_load_w - occupiedW[index];
    const net = Math.abs(raw) < GRID_NOISE_W ? 0 : raw;
    if (net >= 0) {
      exportW[index] = Math.min(net, limits.grid_export_limit_w);
    } else {
      importW[index] = -net;
    }
    if (importW[index] > limits.grid_import_limit_w + 1e-6) {
      infeasibilities.push({
        slot: index,
        store_key: null,
        message: `the house imports ${
          Math.round(importW[index])
        } W, above the ${Math.round(limits.grid_import_limit_w)} W connection`,
      });
    }
  }

  for (const store of stores) {
    if (!store.discharge) continue;
    for (let index = 0; index < count; index += 1) {
      const permitted = store.discharge.export_allowed &&
        (store.discharge.export_allowed_by_slot?.[index] ?? true);
      const reserved = stateByKey[store.key][index + 1] >=
        (store.discharge.export_min_state ?? -Infinity) - 1e-6;
      if (
        !store.discharge.export_allowed_by_slot &&
        schedule.allow_export?.[index]
      ) continue;
      if (
        dischargeByKey[store.key][index] > 1e-9 &&
        exportW[index] > GRID_NOISE_W &&
        (!permitted || !reserved)
      ) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message:
            `${store.key} discharges into export without permission, price eligibility or reserved energy`,
        });
      }
    }
  }

  let importSek = 0;
  let peakSek = 0;
  let exportSek = 0;
  let quotedSek = 0;
  let gridImportKwh = 0;
  let gridExportKwh = 0;
  for (let index = from; index < to; index += 1) {
    const importKwh = importW[index] / 1_000 * (slots[index].duration_hours ?? SLOT_HOURS);
    const exportKwh = exportW[index] / 1_000 * (slots[index].duration_hours ?? SLOT_HOURS);
    gridImportKwh += importKwh;
    gridExportKwh += exportKwh;
    const bought = importKwh * slots[index].import_price_sek_per_kwh;
    const sold = exportKwh * slots[index].export_price_sek_per_kwh;
    importSek += bought;
    peakSek += importKwh * peakSekPerKwh(limits, 0, importW[index]);
    exportSek += sold;
    if (slots[index].published_price) quotedSek += bought - sold;
  }

  let continuitySek = 0;
  for (let index = Math.max(1, from); index < to; index += 1) {
    continuitySek += Math.abs(importW[index] - importW[index - 1]) / 1_000 *
      (limits.grid_ramp_sek_per_kw ?? 0);
  }
  const scored: DispatchScoreStore[] = [];
  let serviceValueSek = 0;
  let wearSek = 0;
  let startSek = 0;
  for (const store of stores) {
    if (reuse && store.key !== reuse.changedKey) {
      const account = reuse.previous.stores.find((value) =>
        value.key === store.key
      )!;
      serviceValueSek += account.service_value_sek;
      wearSek += account.wear_sek;
      startSek += account.start_sek;
      const starts = account.runs - (from === 0 && store.initially_charging &&
          powerByKey[store.key][0] > GRID_NOISE_W
        ? 1
        : 0);
      continuitySek += (store.start_cost_sek ?? 0) > 0
        ? starts * (limits.load_start_preference_sek ?? 0)
        : 0;
      scored.push(account);
      continue;
    }
    const power = powerByKey[store.key];
    const discharge = dischargeByKey[store.key];
    const state = stateByKey[store.key];
    const draw = drawByKey[store.key];
    let storeValue = to === count
      ? (store.terminal_weight ?? 0) *
        valueOfMove(store.curve, store.initial_state, state[count])
      : 0;
    let storeWear = 0;
    let chargedKwh = 0;
    let dischargedKwh = 0;
    for (let index = from; index < to; index += 1) {
      const usageWeight = store.usage_weight[index] ?? 0;
      if (usageWeight !== 0) {
        storeValue += usageWeight *
          valueOfMove(store.curve, store.initial_state, state[index]);
      }
      storeWear += hoursAt(store, index) / 1_000 *
        ((draw[index] + discharge[index]) * (store.wear_sek_per_kwh ?? 0) +
          (discharge[index] > 0 &&
              (store.discharge?.cycling_cost_sek_per_unit ?? 0) !== 0
            ? discharge[index] *
              store.discharge!.state_per_kwh_out(state[index], index) *
              store.discharge!.cycling_cost_sek_per_unit!
            : 0));
      chargedKwh += draw[index] / 1_000 * hoursAt(store, index);
      dischargedKwh += discharge[index] / 1_000 * hoursAt(store, index);
    }
    const runs = runsOf(power).filter(
      (run) => run.start >= from && run.start < to,
    );
    const starts = runs.length -
      (runs[0]?.start === 0 && store.initially_charging ? 1 : 0);
    const storeStart = starts * (store.start_cost_sek ?? 0);
    continuitySek += (store.start_cost_sek ?? 0) > 0
      ? starts * (limits.load_start_preference_sek ?? 0)
      : 0;
    serviceValueSek += storeValue;
    wearSek += storeWear;
    startSek += storeStart;
    scored.push({
      key: store.key,
      state_unit: store.curve.unit,
      charged_kwh: chargedKwh,
      discharged_kwh: dischargedKwh,
      end_state: state[count],
      service_value_sek: storeValue,
      wear_sek: storeWear,
      start_sek: storeStart,
      runs: runs.length,
    });
  }

  return {
    draw_w: drawByKey,
    total_sek: importSek + peakSek + continuitySek - exportSek + startSek +
      wearSek -
      serviceValueSek,
    import_sek: importSek,
    export_sek: exportSek,
    peak_sek: peakSek,
    continuity_sek: continuitySek,
    start_sek: startSek,
    wear_sek: wearSek,
    service_value_sek: serviceValueSek,
    billable_sek: importSek - exportSek,
    billable_quoted_sek: quotedSek,
    grid_import_kwh: gridImportKwh,
    grid_export_kwh: gridExportKwh,
    import_w: importW,
    export_w: exportW,
    state: stateByKey,
    stores: scored,
    infeasibilities,
  };
}

/** What refinement's search compares every trial against. */
type RefinementCost = Pick<
  DispatchScore,
  "billable_sek" | "wear_sek" | "start_sek" | "peak_sek" | "continuity_sek"
>;

/** Where a paused cost refinement resumes: the next source quarter to try. */
export interface RefinementCursor {
  sweep: number;
  /** Index into the auction's stores. */
  store: number;
  from: number;
  /** Whether this sweep has already accepted an exchange. */
  improved: boolean;
  changed: string[];
  /** Each store's service value before refinement; no exchange may lower it. */
  service_floor: number[];
  /** Cost of the schedule as refined so far. */
  cost: RefinementCost;
}

/** Improve real operating cost without selling away the service the auction chose.
 * Neighbouring charge and discharge exchanges keep delivered energy, enforce every physical
 * bound through the independent scorer, and may not lower any store's utility.
 * Thus a generated curve cannot pay for a more expensive refinement. This is
 * bounded local search, not a claim of global optimality or minimum runtime.
 */
export function refineDispatchCosts(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  schedule: DispatchSchedule,
): Set<string> {
  const search = refineDispatchCostSteps(slots, stores, limits, schedule);
  let step = search.next();
  while (!step.done) step = search.next();
  return step.value;
}

/**
 * `refineDispatchCosts`, able to stop before any source quarter once
 * `budgetSpent` says so, and to resume from the cursor it yielded then. The
 * schedule it has refined so far is `schedule` itself, which the caller
 * carries alongside the cursor.
 */
export function* refineDispatchCostSteps(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  schedule: DispatchSchedule,
  cursor?: RefinementCursor,
  budgetSpent?: () => boolean,
): Generator<RefinementCursor, Set<string>> {
  const changed = new Set<string>(cursor?.changed);
  let current = scoreDispatch(slots, stores, limits, schedule);
  if (cursor) {
    // Rescoring reproduces the refined schedule's trajectories, imports and
    // store accounts exactly, but not always the cost the search last
    // accepted: the incremental scorer counts a run starting in the first
    // quarter from a different noise floor. That cost is the bar each trial
    // must clear, so it is carried rather than recomputed.
    current = { ...current, ...cursor.cost };
  } else if (current.infeasibilities.length) {
    return changed;
  }
  const serviceFloor = cursor?.service_floor ??
    current.stores.map((store) => store.service_value_sek);
  const sellPrices = publishedSellPrices(slots);
  const cost = (score: DispatchScore) =>
    score.billable_sek + score.wear_sek +
    score.start_sek + score.peak_sek + score.continuity_sek;
  let firstStore = cursor?.store ?? 0;
  let firstFrom = cursor?.from ?? 0;
  let improved = cursor?.improved ?? false;
  let searched = false;
  for (let sweep = cursor?.sweep ?? 0; sweep < 8; sweep += 1) {
    const startStore = firstStore;
    firstStore = 0;
    for (
      let storeIndex = startStore;
      storeIndex < stores.length;
      storeIndex += 1
    ) {
      const store = stores[storeIndex];
      const startFrom = firstFrom;
      firstFrom = 0;
      const power = schedule.power_w[store.key];
      if (!power) continue;
      const sizedFloor = sizedMinimumW(store, "charge");
      const executable = (power: number, index: number) => {
        const minimum = store.min_power_w ?? 0;
        const step = store.power_step_w ?? 0;
        if (sizedFloor > 0) {
          const otherChargeW = stores.reduce(
            (sum, other) =>
              sum +
              (other === store ? 0 : schedule.power_w[other.key]?.[index] ?? 0),
            0,
          );
          if (
            belowSizedMinimum(
              power,
              sizedFloor,
              true,
              surplusChargeW(slots[index], otherChargeW),
            )
          ) return false;
        }
        return power <= 1e-9 || (power + 1e-6 >= minimum &&
          (step <= 0 || Math.abs(
                (power - minimum) / step -
                  Math.round((power - minimum) / step),
              ) <= 1e-6));
      };
      for (let from = startFrom; from < slots.length; from += 1) {
        // One source quarter per call guarantees progress.
        if (searched && budgetSpent?.()) {
          yield {
            sweep,
            store: storeIndex,
            from,
            improved,
            changed: [...changed],
            service_floor: serviceFloor,
            cost: {
              billable_sek: current.billable_sek,
              wear_sek: current.wear_sek,
              start_sek: current.start_sek,
              peak_sek: current.peak_sek,
              continuity_sek: current.continuity_sek,
            },
          };
          searched = false;
        }
        searched = true;
        for (const releasing of [false, true]) {
          if (releasing && !supportsEnergyTransfers(store)) continue;
          const flow = releasing ? schedule.discharge_w[store.key] : power;
          if (!flow || flow[from] <= GRID_NOISE_W ||
            (releasing && current.export_w[from] <= GRID_NOISE_W)) continue;
          for (
            let to = Math.max(0, from - 4);
            to <= Math.min(slots.length - 1, from + 4);
            to += 1
          ) {
            if (
              from === to ||
              (releasing
                  ? power[to]
                  : schedule.discharge_w[store.key]?.[to] ?? 0) > 0
            ) {
              continue;
            }
            if (
              !releasing &&
              store.units_per_kwh(current.state[store.key][to], to) <= 0
            ) {
              continue;
            }
            if (
              !releasing && store.discharge &&
              slots[to].binding && !slots[from].binding
            ) {
              continue;
            }
            const beforeFrom = flow[from];
            const beforeTo = flow[to];
            const fromUnits = releasing
              ? store.discharge!.state_per_kwh_out(
                current.state[store.key][from],
                from,
              )
              : 1;
            const toUnits = releasing
              ? store.discharge!.state_per_kwh_out(
                current.state[store.key][to],
                to,
              )
              : 1;
            if (fromUnits <= 0 || toUnits <= 0) continue;
            const ratio = hoursAt(store, from) * fromUnits /
              (hoursAt(store, to) * toUnits);
            const maxPower = releasing
              ? store.discharge!.max_power_w
              : store.max_power_w;
            // Re-time sales while retaining this quarter's house supply.
            const room = Math.min(beforeFrom, (maxPower - beforeTo) / ratio,
              releasing ? current.export_w[from] : Infinity);
            if (room <= GRID_NOISE_W) continue;
            // Full moves merge relay runs; equalisation smooths variable loads.
            const equalise = Math.max(
              0,
              (releasing
                ? current.import_w[to] - current.import_w[from]
                : current.import_w[from] - current.import_w[to]) / (1 + ratio),
            );
            const levels = new Set([room, Math.min(room, equalise)]);
            if (releasing) {
              // Selling excess and supplying the house have different prices.
              // Test the grid-balance boundaries as well as the full exchange;
              // moving all discharge would otherwise buy back the house supply.
              levels.add(Math.min(room, current.export_w[from]));
              levels.add(Math.min(room, current.import_w[to] / ratio));
            }
            if ((store.power_step_w ?? 0) > 0) {
              levels.add(store.power_step_w!);
            }
            let best = current;
            let accepted = 0;
            for (const watts of levels) {
              flow[from] = beforeFrom;
              flow[to] = beforeTo;
              if (watts <= GRID_NOISE_W || watts > room + GRID_NOISE_W) {
                continue;
              }
              if (!releasing && store.discharge && slots[to].binding) {
                const roundTrip =
                  store.units_per_kwh(current.state[store.key][to], to) /
                  store.discharge.state_per_kwh_out(
                    current.state[store.key][to],
                    to,
                  );
                const spare = Math.max(
                  0,
                  slots[to].pv_w - slots[to].fixed_load_w -
                    stores.reduce(
                      (sum, other) =>
                        sum + (schedule.power_w[other.key]?.[to] ?? 0),
                      0,
                    ),
                );
                if (
                  watts * ratio > spare + GRID_NOISE_W &&
                  !(sellPrices[to] >
                    slots[to].import_price_sek_per_kwh / roundTrip)
                ) continue;
              }
              if (
                !releasing && (!executable(beforeFrom - watts, from) ||
                  !executable(beforeTo + watts * ratio, to))
              ) continue;
              flow[from] = beforeFrom - watts;
              flow[to] = beforeTo + watts * ratio;
              const candidate = scoreDispatchWithReuse(
                slots,
                stores,
                limits,
                schedule,
                undefined,
                {
                  previous: current,
                  changedKey: store.key,
                },
              );
              if (
                candidate.infeasibilities.length === 0 &&
                (!releasing || Math.abs(
                      candidate.state[store.key].at(-1)! -
                        current.state[store.key].at(-1)!,
                    ) < 1e-8) &&
                candidate.stores.every((value, index) =>
                  value.service_value_sek >= serviceFloor[index] - 1e-8
                ) &&
                cost(candidate) < cost(best) - 1e-7
              ) {
                best = candidate;
                accepted = watts;
              }
            }
            flow[from] = beforeFrom - accepted;
            flow[to] = beforeTo + accepted * ratio;
            if (accepted > 0) {
              current = best;
              changed.add(store.key);
              improved = true;
            }
          }
        }
      }
    }
    if (!improved) break;
    improved = false;
  }
  return changed;
}

/** Quarters either side of a rounded flow searched for an offsetting change. */
const MINIMUM_OFFSET_WINDOW = 16;

/**
 * Round every flow a two-sided store makes below its minimum active power to
 * rest or to that minimum, whichever the objective prefers.
 *
 * The search prices power continuously, so it leaves trickles wherever a
 * saving ran out part-way through a quarter: the tail of an evening discharge,
 * a top-up that holds night import flat. Each is worth a few öre. The energy a
 * rounding adds or removes may be offset in a nearby quarter, or in any active
 * quarter before the state bound the rounding alone would break, so the
 * trajectory stays inside the pack; every candidate is judged by the same
 * scorer a finished plan is.
 *
 * An offset only ever lands on rest or at least the minimum, so no step creates
 * a trickle, and each step settles one, smallest first. A flow that nothing can
 * settle without breaking a physical bound is left for the scorer to report,
 * rather than breaking the bound to honour a preference.
 *
 * Mutates `schedule`; returns the quarters it changed, per store.
 */
export function enforceMinimumSizedPower(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  schedule: DispatchSchedule,
): Map<string, Set<number>> {
  const adjusted = new Map<string, Set<number>>();
  if (
    !stores.some((store) =>
      sizedMinimumW(store, "charge") > 0 ||
      sizedMinimumW(store, "discharge") > 0
    )
  ) return adjusted;
  const count = slots.length;
  // Candidates answer to physical feasibility alone: the rule being enforced
  // would otherwise refuse every intermediate schedule of its own repair.
  const physical = stores.map((store) =>
    (store.min_sized_power_w ?? 0) > 0
      ? { ...store, min_sized_power_w: 0 }
      : store
  );
  const sellPrices = publishedSellPrices(slots);
  let current = scoreDispatch(slots, physical, limits, schedule);
  for (const store of stores) {
    const chargeFloor = sizedMinimumW(store, "charge");
    const dischargeFloor = sizedMinimumW(store, "discharge");
    const power = schedule.power_w[store.key];
    const out = schedule.discharge_w[store.key];
    const release = store.discharge;
    if (
      (chargeFloor <= 0 && dischargeFloor <= 0) || !power || !out || !release
    ) continue;
    const blocking = (score: DispatchScore) =>
      score.infeasibilities.filter((entry) =>
        entry.store_key === store.key || entry.store_key === null
      ).length;
    const tolerated = blocking(current);

    type Edit = { index: number; charging: boolean; watts: number };
    const evaluate = (edits: Edit[]): DispatchScore => {
      const before = edits.map((edit) => {
        const series = edit.charging ? power : out;
        const was = series[edit.index];
        series[edit.index] = edit.watts;
        return was;
      });
      const score = scoreDispatchWithReuse(
        slots,
        physical,
        limits,
        schedule,
        undefined,
        { previous: current, changedKey: store.key },
      );
      edits.forEach((edit, k) => {
        (edit.charging ? power : out)[edit.index] = before[k];
      });
      return score;
    };
    const stateAt = (index: number) => current.state[store.key][index];
    const inUnits = (index: number) =>
      store.units_per_kwh(stateAt(index), index);
    const outUnits = (index: number) =>
      release.state_per_kwh_out(stateAt(index), index);
    // What this quarter lets the store have without naming a size: the sun's
    // surplus to charge from, the house's residual to cover.
    const permittedW = (index: number, charging: boolean): number => {
      const otherChargeW = stores.reduce(
        (sum, other) =>
          sum +
          (other === store ? 0 : schedule.power_w[other.key]?.[index] ?? 0),
        0,
      );
      if (charging) return surplusChargeW(slots[index], otherChargeW);
      const otherReturnedW = stores.reduce(
        (sum, other) =>
          sum +
          (other === store ? 0 : schedule.discharge_w[other.key]?.[index] ?? 0),
        0,
      );
      return residualLoadW(slots[index], otherChargeW, otherReturnedW);
    };
    // Where a changed flow may land: rest, the floor, what the quarter permits
    // without a size, or as wanted when that already clears the floor.
    const landings = (
      watts: number,
      floor: number,
      ceiling: number,
      index: number,
      charging: boolean,
    ) => {
      if (watts <= GRID_NOISE_W) return [0];
      if (watts + 1e-6 >= floor) return [Math.min(watts, ceiling)];
      return sizedFlow(watts, charging, permittedW(index, charging))
        ? [0, floor]
        : [watts];
    };
    // The committed-window rule the auction and refinement already hold: a
    // binding quarter buys grid energy only against a quoted sell price.
    const gridBarred = (index: number, addedW: number): boolean => {
      if (!slots[index].binding || addedW <= GRID_NOISE_W) return false;
      const chargingW = stores.reduce(
        (sum, other) => sum + (schedule.power_w[other.key]?.[index] ?? 0),
        0,
      );
      const spareW = Math.max(
        0,
        slots[index].pv_w - slots[index].fixed_load_w - chargingW,
      );
      const roundTrip = inUnits(index) / Math.max(1e-9, outUnits(index));
      return addedW > spareW + GRID_NOISE_W &&
        !(sellPrices[index] >
          slots[index].import_price_sek_per_kwh / Math.max(1e-9, roundTrip));
    };

    const changed = new Set<number>();
    const unsettled = new Set<string>();
    for (;;) {
      let target: Edit | null = null;
      for (let index = 0; index < count; index += 1) {
        for (const charging of [true, false]) {
          const watts = (charging ? power : out)[index];
          if (
            !belowSizedMinimum(
              watts,
              charging ? chargeFloor : dischargeFloor,
              charging,
              permittedW(index, charging),
            ) || unsettled.has(`${index}:${charging}`)
          ) continue;
          if (!target || watts < target.watts - 1e-9) {
            target = { index, charging, watts };
          }
        }
      }
      if (!target) break;
      const { index: at, charging, watts: from } = target;
      const floor = charging ? chargeFloor : dischargeFloor;
      let best: { edits: Edit[]; score: DispatchScore } | null = null;
      const consider = (edits: Edit[]): DispatchScore => {
        const score = evaluate(edits);
        if (
          blocking(score) <= tolerated && Number.isFinite(score.total_sek) &&
          (!best || score.total_sek < best.score.total_sek - 1e-9)
        ) best = { edits, score };
        return score;
      };
      // Rest, the floor, or the size this quarter does not have to name: a
      // charge inside the surplus, a discharge that covers the house exactly.
      const permitted = permittedW(at, charging);
      const targets = permitted > GRID_NOISE_W && permitted + 1e-6 < floor
        ? [0, floor, permitted]
        : [0, floor];
      for (const to of targets) {
        if (to > from && charging && gridBarred(at, to - from)) continue;
        const base: Edit = { index: at, charging, watts: to };
        const alone = consider([base]);
        // State the rounding adds from `at` onward; negative when it removes.
        const delta = (to - from) / 1_000 * hoursAt(store, at) *
          (charging ? inUnits(at) : -outUnits(at));
        const offsets = new Set<number>();
        for (
          let j = Math.max(0, at - MINIMUM_OFFSET_WINDOW);
          j <= Math.min(count - 1, at + MINIMUM_OFFSET_WINDOW);
          j += 1
        ) offsets.add(j);
        // A bound the rounding alone breaks can lie hours away, where a full
        // pack meets energy that was meant to be spent tonight. Any active
        // quarter before it can absorb the difference.
        const broken = alone.infeasibilities.find((entry) =>
          entry.store_key === store.key && entry.slot > at
        );
        if (broken) {
          for (let j = at + 1; j < Math.min(count, broken.slot); j += 1) {
            if (power[j] > GRID_NOISE_W || out[j] > GRID_NOISE_W) {
              offsets.add(j);
            }
          }
        }
        offsets.delete(at);
        for (const j of offsets) {
          if (out[j] <= GRID_NOISE_W && inUnits(j) > 0) {
            const wanted = power[j] -
              delta / inUnits(j) / hoursAt(store, j) * 1_000;
            for (
              const watts of landings(
                wanted,
                chargeFloor,
                store.max_power_w,
                j,
                true,
              )
            ) {
              const added = watts - power[j];
              if (Math.abs(added) <= GRID_NOISE_W) continue;
              if (
                added > 0 &&
                (gridBarred(j, added) || (slots[j].binding && !slots[at].binding))
              ) continue;
              consider([base, { index: j, charging: true, watts }]);
            }
          }
          if (power[j] <= GRID_NOISE_W && outUnits(j) > 0) {
            const wanted = out[j] +
              delta / outUnits(j) / hoursAt(store, j) * 1_000;
            for (
              const watts of landings(
                wanted,
                dischargeFloor,
                release.max_power_w,
                j,
                false,
              )
            ) {
              if (Math.abs(watts - out[j]) <= GRID_NOISE_W) continue;
              consider([base, { index: j, charging: false, watts }]);
            }
          }
        }
      }
      const settled = best as { edits: Edit[]; score: DispatchScore } | null;
      if (!settled) {
        unsettled.add(`${at}:${charging}`);
        continue;
      }
      for (const edit of settled.edits) {
        (edit.charging ? power : out)[edit.index] = edit.watts;
        changed.add(edit.index);
      }
      current = settled.score;
    }
    if (changed.size > 0) adjusted.set(store.key, changed);
  }
  return adjusted;
}

/** Optional coupled auctions shared by every comparison in one plan generation.
 * Recreated on replay, so completed auctions consume the same allowance in order.
 */
export interface DispatchSearchBudget { remaining: number }
export function dispatchSearchBudget(): DispatchSearchBudget { return { remaining: 12 }; }

/** A solver can execute each auction in a separate CPU budget. */
export type DispatchAuctionSolver = (
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  options: { maxIterations?: number },
) => DispatchResult;

/** Only numeric state crosses the internal planning boundary; never callbacks. */
export interface DispatchCheckpoint {
  next: "transfers" | "refinement";
  powerW: Record<string, number[]>;
  dischargeW: Record<string, number[]>;
  stateByKey: Record<string, number[]>;
  occupiedW: number[];
  returnedW: number[];
  allocations: DispatchAllocationDiagnostic[][];
  iterations: number;
  stopped: DispatchResult["stopped_because"];
  /** Stores the transfer stage has already moved energy through, when it
   * checkpointed between two transfers rather than at its start. */
  transferred?: string[];
  /** Where cost refinement resumes, when it checkpointed part-way through. */
  refinement?: RefinementCursor;
}

export function planDispatch(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  options: { maxIterations?: number; solveAuction?: DispatchAuctionSolver; searchBudget?: DispatchSearchBudget; commandProposal?: Record<string, number[]> } =
    {},
): DispatchResult {
  if (stores.some(store => store.input_response)) {
    return planResponsiveDispatch(slots, stores, limits, options);
  }
  return planScalarDispatch(slots, stores, limits, { ...options, searchBudget: undefined });
}

/** A projected optional candidate spends credits here, including EV alternatives.
 * Ordinary and mandatory scalar solves are never limited by responsive search.
 */
function planScalarDispatch(
  slots: DispatchSlot[], stores: DispatchStore[], limits: DispatchLimits,
  options: { maxIterations?: number; solveAuction?: DispatchAuctionSolver; searchBudget?: DispatchSearchBudget; commandProposal?: Record<string, number[]> },
): DispatchResult {
  // Resolve source getters once; searches and scoring reuse immutable slot data.
  slots = slots.map((slot) => ({ ...slot }));
  const solveAuction = options.solveAuction ?? dispatchAuction;
  const auctionOptions = { maxIterations: options.maxIterations };
  if (options.searchBudget) options.searchBudget.remaining -= 1;
  let best = solveAuction(slots, stores, limits, auctionOptions);
  // Selection runs through the same scorer a hand-built plan is judged by, so
  // "the planner picked this" and "this scored better" are the same claim.
  const objective = (result: DispatchResult): number =>
    scoreDispatch(slots, stores, limits, {
      power_w: result.power_w,
      discharge_w: result.discharge_w,
    }).total_sek;
  let bestCost = objective(best);
  for (const store of stores) {
    if (store.fixed_charge_w_by_slot || (options.searchBudget && options.searchBudget.remaining <= 0)) continue;
    const profile = cheapestDiscreteProfile(
      slots,
      store,
      best.power_w[store.key],
      limits,
    );
    if (!profile) continue;
    // Let the battery and other stores respond to the new car schedule; keeping
    // their old allocations would reserve tomorrow's solar against moving it.
    if (options.searchBudget) options.searchBudget.remaining -= 1;
    const candidate = solveAuction(
      slots.map((slot, i) => ({
        ...slot,
        fixed_load_w: slot.fixed_load_w + profile[i],
      })),
      stores.filter((other) => other !== store),
      limits,
      auctionOptions,
    );
    const state = new Array(slots.length + 1).fill(store.initial_state);
    const discharge = new Array(slots.length).fill(0);
    project(store, profile, discharge, 0, state);
    candidate.power_w[store.key] = profile;
    candidate.discharge_w[store.key] = discharge;
    candidate.state[store.key] = state;
    const retention = retentionBySlot(store, slots.length);
    for (let i = 0; i < slots.length; i += 1) {
      const watts = profile[i];
      if (watts <= 0) continue;
      const kwh = watts / 1_000 * hoursAt(store, i);
      const value = valueOfMove(store.curve, state[i], state[i + 1]) *
        retention[i];
      const otherW = Object.entries(candidate.power_w).reduce(
        (total, [key, powers]) => total + (key === store.key ? 0 : powers[i]),
        0,
      );
      const returned = Object.values(candidate.discharge_w).reduce(
        (total, powers) => total + powers[i],
        0,
      );
      const cost = energyCostSekPerKwh(
        slots[i],
        otherW,
        watts,
        limits,
        returned,
      );
      const wear = store.wear_sek_per_kwh ?? 0;
      const solarW = Math.min(
        watts,
        Math.max(0, slots[i].pv_w - slots[i].fixed_load_w - otherW),
      );
      candidate.allocations[i].push({
        store_key: store.key,
        direction: "charge",
        trigger: "economic_winner",
        allocation_order: candidate.iterations,
        run_start_index: i,
        run_slots: 1,
        power_w: watts,
        state_before: state[i],
        state_after: state[i + 1],
        state_unit: store.curve.unit,
        retention_factor: retention[i],
        average_value_sek_per_kwh: value / kwh,
        energy_cost_sek_per_kwh: cost,
        wear_cost_sek_per_kwh: wear,
        start_cost_sek: 0,
        net_value_sek: value - (cost + wear) * kwh,
        run_net_value_sek: value - (cost + wear) * kwh,
        solar_w: solarW,
        grid_w: watts - solarW,
        discharge_destination: null,
      });
    }
    const cost = objective(candidate);
    if (
      candidate.stopped_because !== "iteration_cap" && cost < bestCost - 1e-9
    ) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best;
}

/** Adapt complete command profiles to immutable physical inputs for the scalar solver. */
export function physicalDispatchStores(
  slots: DispatchSlot[], stores: DispatchStore[], commands: Record<string, number[]>,
): DispatchStore[] {
  const hours = slots.map(slot => slot.duration_hours ?? SLOT_HOURS);
  return stores.map(store => {
    if (!store.input_response) return store;
    const profile = commands[store.key];
    const projection = store.input_response.project(profile, hours);
    return {
      ...store, input_response: undefined,
      fixed_charge_w_by_slot: projection.draw_w,
      max_power_w: Math.max(store.max_power_w, ...projection.draw_w),
      min_power_w: 0, power_step_w: 0, start_cost_sek: 0,
      units_per_kwh: (state, index) => {
        const draw = projection.draw_w[index];
        const heatInput = profile[index] * projection.gain_fraction[index];
        if (draw === 0 && heatInput !== 0) throw new Error("A scalar physical profile cannot deliver heat without electricity");
        return draw > 0 ? store.units_per_kwh(state, index) * heatInput / draw : 0;
      },
    };
  });
}

/** Whole-run response economics around the scalar auction, with exact coupled acceptance.
 * The bounded neighborhood is a heuristic, not a minimum runtime or convergence guarantee.
 */
function planResponsiveDispatch(
  slots: DispatchSlot[], stores: DispatchStore[], limits: DispatchLimits,
  options: { maxIterations?: number; solveAuction?: DispatchAuctionSolver; searchBudget?: DispatchSearchBudget; commandProposal?: Record<string, number[]> },
): DispatchResult {
  const responsive = stores.filter(store => store.input_response);
  // A steady proposal has internally consistent trajectories and costs; it is never accepted without projection.
  const proposal = (options.solveAuction ?? dispatchAuction)(slots,
    stores.map(store => ({ ...store, input_response: undefined })), limits, { maxIterations: options.maxIterations });
  const visited = new Set<string>();
  let evaluations = 0;
  // Mandatory projected comparisons always run; optional auctions have one
  // generation-wide allowance, including discrete-store alternatives.
  const budget = options.searchBudget ?? dispatchSearchBudget();
  const identity = (powers: Record<string, number[]>) => responsive.map(s => powers[s.key].join(",")).join("|");
  const solve = (commands: Record<string, number[]>, optional = false): DispatchResult => {
    visited.add(identity(commands));
    evaluations += 1;
    const result = planScalarDispatch(slots, physicalDispatchStores(slots, stores, commands), limits, { ...options, searchBudget: optional ? budget : undefined });
    for (const store of responsive) result.power_w[store.key] = [...commands[store.key]];
    const scored = scoreDispatch(slots, stores, limits, result);
    for (const store of responsive) {
      for (const run of runsOf(result.power_w[store.key])) {
        const parts = result.allocations.slice(run.start, run.start + run.slots)
          .flatMap(slot => slot.filter(part => part.store_key === store.key && part.direction === "charge"));
        const fee = run.start === 0 && store.initially_charging ? 0 : store.start_cost_sek ?? 0;
        for (const part of parts) {
          const share = fee / parts.length;
          part.net_value_sek += part.start_cost_sek - share;
          part.start_cost_sek = share; part.run_start_index = run.start; part.run_slots = run.slots;
        }
        const net = parts.reduce((sum, part) => sum + part.net_value_sek, 0);
        for (const part of parts) part.run_net_value_sek = net;
      }
    }
    return { ...result, state: scored.state, import_w: scored.import_w, export_w: scored.export_w };
  };
  const seed = solve(proposal.power_w);
  const seedScore = scoreDispatch(slots, stores, limits, seed);
  let best = seed;
  let bestScore = seedScore;
  const accept = (candidate: DispatchResult) => {
    const score = scoreDispatch(slots, stores, limits, candidate);
    if (!score.infeasibilities.length && (bestScore.infeasibilities.length || score.total_sek < bestScore.total_sek - 1e-9)) {
      best = candidate; bestScore = score; return true;
    }
    return false;
  };
  const allOff = { ...best.power_w };
  for (const store of responsive) allOff[store.key] = slots.map((_, i) => store.fixed_charge_w_by_slot?.[i] ?? 0);
  if (!visited.has(identity(allOff))) accept(solve(allOff));
  if (options.commandProposal) {
    const commands = { ...options.commandProposal };
    for (const store of responsive) commands[store.key] = slots.map((_, i) =>
      store.fixed_charge_w_by_slot?.[i] ?? options.commandProposal![store.key][i]);
    const check = scoreDispatch(slots, stores, limits, {
      power_w: commands, discharge_w: best.discharge_w,
    });
    if (!visited.has(identity(commands)) && !check.infeasibilities.some(item =>
      responsive.some(store => store.key === item.store_key))) accept(solve(commands));
  }
  while (budget.remaining > 0) {
    const trials = new Map<string, { powers: Record<string, number[]>; cost: number; bridge: boolean }>();
    // All-off can beat a fragmented seed before any bridges are tried. Keep
    // that seed as a search origin so startup charges cannot erase the very
    // run combinations that repay them.
    const origins = identity(best.power_w) === identity(seed.power_w) ? [best] : [best, seed];
    for (const origin of origins) for (const store of responsive) {
      const originScore = origin === seed ? seedScore : bestScore;
      const current = origin.power_w[store.key];
      const add = (profile: number[], bridge = false) => {
        if (store.fixed_charge_w_by_slot?.some((fixed, i) => fixed !== null && fixed !== profile[i])) return;
        const powers = { ...origin.power_w, [store.key]: profile };
        const key = identity(powers);
        if (visited.has(key) || trials.has(key)) return;
        const score = scoreDispatchWithReuse(slots, stores, limits, { ...origin, power_w: powers }, undefined,
          { previous: originScore, changedKey: store.key });
        // Other stores can repair grid and battery conflicts, but cannot repair this heater's own state cap.
        if (score.infeasibilities.some(item => item.store_key === store.key)) return;
        trials.set(key, { powers, cost: score.total_sek, bridge });
      };
      const change = (from: number, to: number, watts: number, bridge = false) => {
        const profile = [...current]; profile.fill(watts, from, to); add(profile, bridge);
      };
      const runs = runsOf(current).map(run => ({ ...run, end: run.start + run.slots }));
      for (let r = 0; r < runs.length; r++) {
        const run = runs[r];
        change(run.start, run.end, 0);
        if (r + 1 < runs.length) change(run.end, runs[r + 1].start, store.max_power_w, true);
        change(run.start, run.start + 1, 0);
        change(run.end - 1, run.end, 0);
        if (run.start > 0) change(run.start - 1, run.start, store.max_power_w);
        if (run.end < slots.length) change(run.end, run.end + 1, store.max_power_w);
        for (const shift of [-1, 1]) {
          if (run.start + shift < 0 || run.end + shift > slots.length) continue;
          const profile = [...current]; profile.fill(0, run.start, run.end);
          profile.fill(store.max_power_w, run.start + shift, run.end + shift); add(profile);
        }
      }
      // Multi-quarter insertion crosses the initial low-output interval without a hard run limit.
      for (let start = 0; start < slots.length; start++) {
        if (current[start] > 0) continue;
        for (const length of [1, 2, 4, 8, 16, 32, 64]) {
          if (start + length <= slots.length) change(start, start + length, store.max_power_w);
        }
      }
    }
    const ranked = [...trials.values()].sort((a, b) => Number(b.bridge) - Number(a.bridge) || a.cost - b.cost);
    if (!ranked.length) return { ...best, responsive_search: { evaluations, stopped_because: "neighborhood_exhausted" } };
    // Rank on the exact physics with the incumbent coupling, then re-solve the best candidates jointly.
    let improved = false;
    for (const trial of ranked.slice(0, 8)) {
      if (budget.remaining <= 0) break;
      improved = accept(solve(trial.powers, true)) || improved;
    }
    if (!improved) break;
  }
  return { ...best, responsive_search: { evaluations, stopped_because: "work_budget" } };
}

/** Minimum-cost placement of a fixed amount at executable current settings. */
function cheapestDiscreteProfile(
  slots: DispatchSlot[],
  store: DispatchStore,
  original: number[],
  limits: DispatchLimits,
): number[] | null {
  const step = store.power_step_w ?? 0;
  const minimum = store.min_power_w ?? 0;
  const units = store.units_per_kwh(store.initial_state, 0);
  if (
    store.discharge || step <= 0 || store.retention_per_slot !== 1 ||
    (store.start_cost_sek ?? 0) !== 0 ||
    Math.abs(minimum / step - Math.round(minimum / step)) > 1e-9 ||
    store.usage_weight.filter((weight) => weight > 0).length > 1 ||
    slots.some((_slot, i) =>
      hoursAt(store, i) !== hoursAt(store, 0) ||
      store.units_per_kwh(store.initial_state, i) !== units ||
      store.drift(store.initial_state, i) !== store.initial_state
    )
  ) return null;
  const target = Math.round(
    original.reduce((sum, watts) => sum + watts, 0) / step,
  );
  if (
    target === 0 ||
    original.some((watts) =>
      Math.abs(watts / step - Math.round(watts / step)) > 1e-6
    )
  ) return null;
  const retention = retentionBySlot(store, slots.length);
  const wanted = Math.max(...retention);
  if (original.some((watts, i) => watts > 0 && retention[i] !== wanted)) {
    return null;
  }
  let costs = new Float64Array(target + 1).fill(Infinity);
  costs[0] = 0;
  const previous: Int32Array[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    const maximum = retention[i] === wanted
      ? Math.min(store.max_power_w, headroomW(slots[i], limits, 0, 0))
      : 0;
    const choices = [{ steps: 0, cost: 0 }];
    for (
      let watts = Math.max(step, minimum);
      watts <= maximum + 1e-9;
      watts += step
    ) {
      choices.push({
        steps: Math.round(watts / step),
        cost: watts / 1_000 * hoursAt(store, i) *
          energyCostSekPerKwh(slots[i], 0, watts, limits),
      });
    }
    const next = new Float64Array(target + 1).fill(Infinity);
    const picked = new Int32Array(target + 1).fill(-1);
    for (let total = 0; total <= target; total += 1) {
      if (!Number.isFinite(costs[total])) continue;
      for (const choice of choices) {
        const after = total + choice.steps;
        if (after > target) continue;
        const cost = costs[total] + choice.cost;
        if (cost < next[after] - 1e-9) {
          next[after] = cost;
          picked[after] = choice.steps;
        }
      }
    }
    previous.push(picked);
    costs = next;
  }
  if (!Number.isFinite(costs[target])) return null;
  const replacement = new Array<number>(slots.length).fill(0);
  let remaining = target;
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    const chosen = previous[i][remaining];
    if (chosen < 0) throw new Error("discrete charge schedule is unreachable");
    replacement[i] = chosen * step;
    remaining -= chosen;
  }
  // Validate the full physical trajectory, not just the integer energy total.
  const before = new Array(slots.length + 1).fill(store.initial_state);
  project(store, original, new Array(slots.length).fill(0), 0, before);
  let projected = store.initial_state;
  for (let i = 0; i < slots.length; i += 1) {
    projected = nextState(store, projected, replacement[i], 0, i);
    if (
      projected < (store.min_state ?? -Infinity) - 1e-9 ||
      projected > (store.max_state ?? Infinity) + 1e-9
    ) return null;
  }
  return Math.abs(projected - before.at(-1)!) < 1e-9 ? replacement : null;
}

function dispatchAuction(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  options: { maxIterations?: number },
): DispatchResult {
  const steps = dispatchAuctionSteps(slots, stores, limits, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * The synchronous and distributed planners execute these same three stages.
 * `budgetSpent` lets a distributed caller also checkpoint the transfer and
 * refinement stages part-way through; the synchronous planner never pauses.
 */
export function* dispatchAuctionSteps(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  { maxIterations = 20_000 }: { maxIterations?: number } = {},
  checkpoint?: DispatchCheckpoint,
  budgetSpent?: () => boolean,
): Generator<DispatchCheckpoint, DispatchResult> {
  const count = slots.length;
  const sellPrices = publishedSellPrices(slots);
  const powerW: Record<string, number[]> = checkpoint?.powerW ?? {};
  const dischargeW: Record<string, number[]> = checkpoint?.dischargeW ?? {};
  const stateByKey: Record<string, number[]> = checkpoint?.stateByKey ?? {};
  const retentionByKey: Record<string, number[]> = {};
  const suffixMinByKey: Record<string, number[]> = {};
  const suffixMaxByKey: Record<string, number[]> = {};
  const occupiedW = checkpoint?.occupiedW ?? new Array(count).fill(0);
  // Energy the stores are returning to the house, which offsets the load every
  // other candidate is costed against.
  const returnedW = checkpoint?.returnedW ?? new Array(count).fill(0);

  // SEK per unit a store with `sustained_value_tail_hours` gets for a unit added
  // in each quarter, rebuilt whenever its trajectory has moved.
  const sustainedByKey: Record<string, { trajectory: number; marginal: number[] }> = {};
  const sustainedMarginal = (store: DispatchStore): number[] | null => {
    const tailHours = store.sustained_value_tail_hours;
    if (tailHours === undefined) return null;
    const state = stateByKey[store.key];
    let trajectory = 0;
    for (let index = 0; index <= count; index += 1) trajectory += state[index] * (index + 1);
    const held = sustainedByKey[store.key];
    if (held?.trajectory === trajectory) return held.marginal;
    const decay = Math.min(1, Math.max(0, store.retention_per_slot));
    const marginal = new Array(count).fill(0);
    let value = tailHours * marginalValue(store.curve, state[count]);
    let hours = tailHours;
    for (let index = count - 1; index >= 0; index -= 1) {
      // What is added in this quarter sits on every state after it.
      marginal[index] = hours > 0
        ? Math.pow(decay, hoursAt(store, index) / SLOT_HOURS) * value / hours
        : 0;
      value = hoursAt(store, index) * marginalValue(store.curve, state[index]) +
        Math.pow(decay, hoursAt(store, index) / SLOT_HOURS) * value;
      hours += hoursAt(store, index);
    }
    sustainedByKey[store.key] = { trajectory, marginal };
    return marginal;
  };

  for (const store of stores) {
    if (!checkpoint) {
      powerW[store.key] = Array.from({ length: count }, (_, index) => store.fixed_charge_w_by_slot?.[index] ?? 0);
      for (let i = 0; i < count; i++) occupiedW[i] += powerW[store.key][i];
      dischargeW[store.key] = new Array(count).fill(0);
      const state = new Array(count + 1).fill(store.initial_state);
      state[0] = store.initial_state;
      project(store, powerW[store.key], dischargeW[store.key], 0, state);
      stateByKey[store.key] = state;
    }
    retentionByKey[store.key] = retentionBySlot(store, count);
    suffixMinByKey[store.key] = new Array(count + 1);
    suffixMaxByKey[store.key] = new Array(count + 1);
  }

  let iterations = checkpoint?.iterations ?? 0;
  let releasedThisRound = 0;
  let stopped: DispatchResult["stopped_because"] = checkpoint?.stopped ??
    "no_profitable_candidate";
  const allocations: DispatchAllocationDiagnostic[][] =
    checkpoint?.allocations ?? Array.from(
      { length: count },
      () => [],
    );
  type Candidate = {
    store: DispatchStore;
    index: number;
    indices: number[];
    surplus: number;
    /** Net welfare per kWh; the marginal auction ranks this, not block size. */
    score: number;
    direction: "charge" | "discharge";
    parts: DispatchAllocationDiagnostic[];
  };

  // Scratch buffers for the two lists every priced quarter builds and throws
  // away. Both are consumed before the next quarter is priced, so one array
  // each serves the whole auction; the allocation they replace was running
  // hundreds of thousands of times per plan.
  const rawPowers: number[] = [];
  const levelScratch: number[] = [];
  const addLevel = (level: number) => {
    // A handful of levels per quarter, so a walk beats a Set — and it keeps
    // insertion order, which is what the Set was relied on for.
    for (let index = 0; index < levelScratch.length; index += 1) {
      if (levelScratch[index] === level) return;
    }
    levelScratch.push(level);
  };
  const executablePowerLevels = (
    store: DispatchStore,
    rawLevels: number[],
    maximumW: number,
  ): number[] => {
    const minimumW = Math.max(0, store.min_power_w ?? 0);
    const stepW = Math.max(0, store.power_step_w ?? 0);
    levelScratch.length = 0;
    // A discrete charger can be optimal at any supported current between a
    // curve/source breakpoint and full power. Testing only the rounded
    // breakpoint and the maximum skipped those intermediate executable bids.
    if (stepW > 0 && maximumW + 1e-9 >= minimumW) {
      for (let level = minimumW; level <= maximumW + 1e-9; level += stepW) {
        const rounded = Math.round(level * 1e6) / 1e6;
        if (rounded > 1e-9 && rounded <= maximumW + 1e-9) addLevel(rounded);
      }
    }
    for (const raw of rawLevels) {
      let level = Math.min(maximumW, raw);
      if (level <= 1e-9 || level + 1e-9 < minimumW) continue;
      if (stepW > 0) {
        level = minimumW + Math.floor((level - minimumW) / stepW + 1e-9) *
            stepW;
      }
      level = Math.round(level * 1e6) / 1e6;
      if (level > 1e-9 && level <= maximumW + 1e-9) {
        addLevel(level);
      }
    }
    return levelScratch;
  };

  const chargeCandidate = (
    store: DispatchStore,
    indices: number[],
    powerLevel: number,
    startsRun: boolean,
    bestPrefix = false,
  ): Candidate | null => {
    if (indices.some(index => store.fixed_charge_w_by_slot?.[index] != null)) return null;
    const state = stateByKey[store.key];
    const retention = retentionByKey[store.key];
    const sustained = sustainedMarginal(store);
    const wear = store.wear_sek_per_kwh ?? 0;
    const startCost = startsRun ? store.start_cost_sek ?? 0 : 0;
    const startShare = startCost / indices.length;
    const low = store.min_state ?? -Infinity;
    const high = store.max_state ?? Infinity;
    const parts: DispatchAllocationDiagnostic[] = [];
    let candidateState = state[indices[0]];
    // The highest the trajectory already reaches from here on, which is what a
    // block's gain lands on top of — not the state standing in its first slot.
    //
    // `fullW` bounds each slot of a block against this, and the walk below
    // bounds the block's own local trajectory, and until now those were the
    // only two checks. Neither sees a *multi-slot* block placed earlier than
    // work already scheduled: at slot 7 the local state was the vehicle's
    // starting 257.81 km while the suffix already reached 353.03, so two
    // quarters of charge each individually inside the room together carried it
    // past the 375 km its own charge limit allows. `project` then clamped the
    // state and left the power in the schedule, so the plan bought 22.08 kWh
    // for a car that stops accepting at 20.38.
    const ceilingFrom = Math.max(
      candidateState,
      suffixMaxByKey[store.key]?.[indices[0]] ?? candidateState,
    );
    let gainedUnits = 0;
    let previousSurplus = 0;
    let addedKwh = 0;
    let prefixSurplus = 0;
    let bestLength = 0;
    let bestScore = 0;
    let prefixStartCost = 0;

    for (const index of indices) {
      const slot = slots[index];
      const before = candidateState;
      const units = store.units_per_kwh(before, index);
      if (units <= 0) {
        if (bestPrefix) break;
        return null;
      }
      if (
        bestPrefix && (dischargeW[store.key][index] > 0 ||
          headroomW(slot, limits, occupiedW[index], returnedW[index]) + 1e-9 <
            powerLevel)
      ) break;
      const kwh = powerLevel / 1_000 * hoursAt(store, index);
      const previousW = powerW[store.key][index];
      const previousKwh = previousW / 1_000 * hoursAt(store, index);
      const otherW = occupiedW[index] - previousW;
      addedKwh += kwh - previousKwh;
      const afterInput = before + kwh * units;
      if (afterInput < low - 1e-9 || afterInput > high + 1e-9) {
        if (bestPrefix) break;
        return null;
      }
      // Drift only ever removes some of what was added — a leaky store loses
      // heat, it does not gain it — so charging the whole block raises every
      // later state by at most the total put in, and refusing on that total is
      // safe for a drifting store and exact for one that holds.
      gainedUnits += (kwh - previousKwh) * units;
      if (ceilingFrom + gainedUnits > high + 1e-9) {
        if (bestPrefix) break;
        return null;
      }
      const retained = retention[index];
      const landedSek = valueOfMove(store.curve, before, afterInput) * retained;
      const valueSek = sustained
        ? Math.min(landedSek, sustained[index] * (afterInput - before))
        : landedSek;
      const valuePerKwh = valueSek / kwh;
      const sourceCost = energyCostSekPerKwh(
        slot,
        otherW,
        powerLevel,
        limits,
        returnedW[index],
      );
      const surplusW = Math.max(
        0,
        slot.pv_w - slot.fixed_load_w - otherW,
      );
      const solarW = Math.min(powerLevel, surplusW);
      const gridW = powerLevel - solarW;
      const slotAllocations = allocations[index];
      let previousPart: DispatchAllocationDiagnostic | undefined;
      for (let at = 0; at < slotAllocations.length; at += 1) {
        if (slotAllocations[at].store_key === store.key) {
          previousPart = slotAllocations[at];
          break;
        }
      }
      const costOfStart = bestPrefix
        ? 0
        : previousPart?.start_cost_sek ?? startShare;
      const netSek = (valuePerKwh - sourceCost - wear) * kwh - costOfStart;
      if (previousKwh > 0) {
        previousSurplus += valueOfMove(
              store.curve,
              before,
              before + previousKwh * units,
            ) * retained -
          (energyCostSekPerKwh(
              slot,
              otherW,
              previousW,
              limits,
              returnedW[index],
            ) + wear) * previousKwh -
          costOfStart;
      }
      parts.push({
        store_key: store.key,
        direction: "charge",
        trigger: "economic_winner",
        allocation_order: 0,
        run_start_index: previousPart?.run_start_index ?? indices[0],
        run_slots: previousPart?.run_slots ?? indices.length,
        power_w: powerLevel,
        state_before: before,
        state_after: afterInput,
        state_unit: store.curve.unit,
        retention_factor: retained,
        average_value_sek_per_kwh: valuePerKwh,
        energy_cost_sek_per_kwh: sourceCost,
        wear_cost_sek_per_kwh: wear,
        start_cost_sek: costOfStart,
        net_value_sek: netSek,
        run_net_value_sek: 0,
        solar_w: solarW,
        grid_w: gridW,
        discharge_destination: null,
      });
      if (bestPrefix) {
        prefixSurplus += netSek;
        const cost = (indices[0] === 0 && store.initially_charging) ||
            (powerW[store.key][indices[0] - 1] ?? 0) > 0 ||
            (powerW[store.key][index + 1] ?? 0) > 0
          ? 0
          : startCost;
        const score = (prefixSurplus - cost) / addedKwh;
        if (prefixSurplus - cost > 1e-9 && score > bestScore + 1e-12) {
          bestLength = parts.length;
          bestScore = score;
          prefixStartCost = cost;
        }
      }
      candidateState = Math.min(
        high,
        Math.max(low, store.drift(afterInput, index)),
      );
    }

    if (bestPrefix) {
      if (!bestLength) return null;
      parts.length = bestLength;
      indices = indices.slice(0, bestLength);
      addedKwh = indices.reduce((sum, index) => sum + powerLevel / 1_000 * hoursAt(store, index), 0);
      for (const part of parts) {
        part.run_slots = bestLength;
        part.start_cost_sek = prefixStartCost / bestLength;
        part.net_value_sek -= part.start_cost_sek;
      }
    }
    const totalSurplus = parts.reduce(
      (total, part) => total + part.net_value_sek,
      0,
    );
    const surplus = totalSurplus - previousSurplus;
    if (surplus <= 1e-9 || addedKwh <= 1e-9) return null;
    for (const part of parts) part.run_net_value_sek = totalSurplus;
    return {
      store,
      index: indices[0],
      indices,
      surplus,
      score: surplus / addedKwh,
      direction: "charge",
      parts,
    };
  };
  const outranks = (candidate: Candidate, incumbent: Candidate | null) =>
    incumbent === null || candidate.score > incumbent.score + 1e-12 ||
    (Math.abs(candidate.score - incumbent.score) <= 1e-12 &&
      candidate.surplus > incumbent.surplus);
  // ---------------------------------------------------------------------
  // Only reprice the quarters an allocation actually moved.
  //
  // The auction takes one bid per iteration and a thousand iterations to reach
  // a fixed point, so what it costs is set by how much of the horizon each of
  // those iterations has to look at again. Pricing every quarter of every store
  // every time is what put a 72-hour plan past a worker's CPU budget.
  //
  // The winner's own quarters all move: its trajectory shifts from the
  // allocation onwards, and `suffixBounds` carries that shift back to every
  // earlier quarter as a tighter — or looser — ceiling. Nothing of the sort
  // happens to the other stores. They read the winner only through the load
  // already in the quarter, so a bid of theirs is stale exactly when its block
  // overlaps one the winner just took, and stands everywhere else.
  //
  // Held per quarter rather than per store, because a store's best bid is not a
  // thing that survives on its own: when the quarter it stood in is taken, the
  // runner-up in some other quarter is the store's new bid, and only a per-slot
  // record still holds it.
  // ---------------------------------------------------------------------
  const chargeBestBySlot: Record<string, (Candidate | null)[]> = {};
  const dischargeBestBySlot: Record<string, (Candidate | null)[]> = {};
  const staleBySlot: Record<string, Uint8Array> = {};
  for (const store of stores) {
    chargeBestBySlot[store.key] = new Array(count).fill(null);
    dischargeBestBySlot[store.key] = new Array(count).fill(null);
    staleBySlot[store.key] = new Uint8Array(count).fill(1);
  }
  const markAllStale = () => {
    for (const store of stores) staleBySlot[store.key].fill(1);
  };
  const markStaleWindow = (key: string, from: number, to: number) => {
    const stale = staleBySlot[key];
    for (
      let index = Math.max(0, from);
      index <= Math.min(count - 1, to);
      index += 1
    ) stale[index] = 1;
  };

  // ---------------------------------------------------------------------
  // Settle the books against the trajectory the plan will execute.
  //
  // The auction values every move against the state as it stood when that
  // move won, and each later allocation shifts the trajectory underneath the
  // earlier ones. With a concave curve the error has a direction: an
  // allocation is booked at the marginal value of an emptier store than the
  // plan ever runs, so the greedy keeps buying energy it has already stopped
  // valuing. One observed plan booked +19.69 SEK of battery charging that was
  // worth -4.28 SEK where it landed, 40 of its 75 charges losing money.
  //
  // Re-price each committed run where it actually sits, release what no longer
  // pays for itself, and repeat until the schedule is self-consistent. Only
  // removal happens here, which is what makes this pass terminate; putting back
  // what the removals re-open is the outer round's job, and the note on that
  // loop says why a discharging store needs one.
  // ---------------------------------------------------------------------
  const movedValue = (
    store: DispatchStore,
    index: number,
    inW: number,
    outW: number,
  ): { after: number; value: number } => {
    const state = stateByKey[store.key];
    const before = state[index];
    // Drift belongs to the slot, not to the allocation, so the move is valued
    // before it — exactly as the candidate that won was.
    const gained = inW / 1_000 * hoursAt(store, index) *
      store.units_per_kwh(before, index);
    const spent = outW > 0
      ? outW / 1_000 * hoursAt(store, index) *
        (store.discharge?.state_per_kwh_out(before, index) ?? 0)
      : 0;
    const after = before + gained - spent;
    const landed = valueOfMove(store.curve, before, after) *
      retentionByKey[store.key][index];
    const sustained = outW > 0 ? null : sustainedMarginal(store);
    return {
      after,
      value: sustained ? Math.min(landed, sustained[index] * gained) : landed,
    };
  };

  const partAt = (store: DispatchStore, index: number) =>
    allocations[index].find((part) => part.store_key === store.key);

  /** A charge the search did not bid for, priced where the schedule put it. */
  const bookedCharge = (
    store: DispatchStore,
    index: number,
    adjustment: "cost_refined" | "minimum_adjusted" | "fixed_profile",
  ): DispatchAllocationDiagnostic => {
    const watts = powerW[store.key][index];
    const kwh = watts / 1_000 * hoursAt(store, index);
    const { value } = movedValue(store, index, watts, 0);
    const cost = energyCostSekPerKwh(
      slots[index],
      occupiedW[index] - watts,
      watts,
      limits,
      returnedW[index],
    );
    const start = !(index === 0 && store.initially_charging) &&
        (powerW[store.key][index - 1] ?? 0) <= GRID_NOISE_W
      ? store.start_cost_sek ?? 0
      : 0;
    const wear = store.wear_sek_per_kwh ?? 0;
    const solar = Math.min(
      watts,
      Math.max(
        0,
        slots[index].pv_w - slots[index].fixed_load_w - occupiedW[index] +
          watts,
      ),
    );
    return {
      store_key: store.key,
      direction: "charge",
      trigger: "economic_winner",
      allocation_order: iterations,
      [adjustment]: true,
      run_start_index: index,
      run_slots: 1,
      power_w: watts,
      state_before: stateByKey[store.key][index],
      state_after: stateByKey[store.key][index + 1],
      state_unit: store.curve.unit,
      retention_factor: retentionByKey[store.key][index],
      average_value_sek_per_kwh: value / kwh,
      energy_cost_sek_per_kwh: cost,
      wear_cost_sek_per_kwh: wear,
      start_cost_sek: start,
      net_value_sek: value - (cost + wear) * kwh - start,
      run_net_value_sek: value - (cost + wear) * kwh - start,
      solar_w: solar,
      grid_w: watts - solar,
      discharge_destination: null,
    };
  };

  /** A discharge the search did not bid for, priced as a discharge bid is. */
  const bookedDischarge = (
    store: DispatchStore,
    index: number,
    adjustment: "cost_refined" | "minimum_adjusted" = "minimum_adjusted",
  ): DispatchAllocationDiagnostic => {
    const slot = slots[index];
    const watts = dischargeW[store.key][index];
    const kwh = watts / 1_000 * hoursAt(store, index);
    const { value } = movedValue(store, index, 0, watts);
    const importBeforeW = gridImportW(
      slot,
      occupiedW[index],
      returnedW[index] - watts,
    );
    const loadW = Math.min(watts, importBeforeW);
    const price = (loadW * slot.import_price_sek_per_kwh +
          (watts - loadW) * slot.export_price_sek_per_kwh) / watts +
      peakReliefSekPerKwh(limits, importBeforeW, loadW);
    const givenUp = -value / kwh;
    const wear = store.wear_sek_per_kwh ?? 0;
    const net = (price - wear - givenUp) * kwh;
    return {
      store_key: store.key,
      direction: "discharge",
      trigger: "economic_winner",
      allocation_order: iterations,
      [adjustment]: true,
      run_start_index: index,
      run_slots: 1,
      power_w: watts,
      state_before: stateByKey[store.key][index],
      state_after: stateByKey[store.key][index + 1],
      state_unit: store.curve.unit,
      retention_factor: retentionByKey[store.key][index],
      average_value_sek_per_kwh: price,
      energy_cost_sek_per_kwh: givenUp,
      wear_cost_sek_per_kwh: wear,
      start_cost_sek: 0,
      net_value_sek: net,
      run_net_value_sek: net,
      solar_w: 0,
      grid_w: 0,
      discharge_destination: loadW >= watts - 1e-9
        ? "load"
        : loadW <= 1e-9
        ? "export"
        : "mixed",
    };
  };

  type ChargeExchange = {
    store: DispatchStore;
    from: number;
    to: number;
    removed_w: number;
    added_w: number;
    saving_sek: number;
  };

  /**
   * Replace a committed charge with cheaper surplus solar.
   *
   * A full future trajectory blocks an additional charge, but it does not make
   * the existing source irrevocable. The September 5 replay reserved tomorrow's
   * full pack with grid purchases while exporting today's solar at 59% SOC.
   * Exchange equal stored energy between two quarters, checking every state
   * between them. Beyond the second quarter the trajectory is unchanged.
   *
   * This neighbourhood applies to continuous, lossless storage valued at the
   * horizon edge. Timed demand, leaking heat and discrete hardware
   * cannot exchange arbitrary fractions of a charge under that contract.
   */
  const bestSolarExchange = (): ChargeExchange | null => {
    let best: ChargeExchange | null = null;
    for (const store of stores) {
      if (!supportsEnergyTransfers(store)) continue;
      const schedule = powerW[store.key];
      const discharge = dischargeW[store.key];
      const state = stateByKey[store.key];
      const low = store.min_state ?? -Infinity;
      const high = store.max_state ?? Infinity;
      const wear = store.wear_sek_per_kwh ?? 0;
      const units = slots.map((_slot, index) =>
        store.units_per_kwh(state[index], index)
      );
      const chargeCost = (index: number, watts: number) =>
        watts / 1_000 * hoursAt(store, index) * energyCostSekPerKwh(
          slots[index],
          occupiedW[index] - schedule[index],
          watts,
          limits,
          returnedW[index],
        );
      const sourceCosts = schedule.map((watts, index) =>
        chargeCost(index, watts)
      );

      for (let to = 0; to < count; to += 1) {
        if (discharge[to] > 0 || units[to] <= 0) continue;
        const availableW = Math.min(
          store.max_power_w - schedule[to],
          slots[to].pv_w - slots[to].fixed_load_w - occupiedW[to],
        );
        if (availableW <= 1e-6) continue;

        // Moving charge earlier raises the intervening states; moving it later
        // lowers them. Only that interval changes, not the whole suffix.
        const room = transferRoom(state, to, low, high);

        for (let from = 0; from < count; from += 1) {
          if (from === to || schedule[from] <= 1e-6 || units[from] <= 0) {
            continue;
          }
          const maxUnits = Math.min(
            room[from],
            schedule[from] / 1_000 * hoursAt(store, from) * units[from],
            availableW / 1_000 * hoursAt(store, to) * units[to],
          );
          if (maxUnits <= 1e-9) continue;
          const maximumW = maxUnits / units[from] / hoursAt(store, from) * 1_000;
          const importBeforeW = gridImportW(
            slots[from],
            occupiedW[from],
            returnedW[from],
          );
          const levels = [maximumW, Math.min(maximumW, importBeforeW)];
          const rate = limits.peak_shaping_sek_per_kwh_per_kw;
          if (rate > 0) {
            // The marginal removal price meets the replacement price part way
            // down a shaped import peak; the source's solar boundary is above.
            const replacementPrice =
              (slots[to].export_price_sek_per_kwh + wear) *
                units[from] / units[to] - wear;
            levels.push(
              Math.min(
                maximumW,
                importBeforeW - limits.grid_import_shaping_w -
                  Math.max(
                      0,
                      replacementPrice - slots[from].import_price_sek_per_kwh,
                    ) /
                    rate * 1_000,
              ),
            );
          }
          for (const removedW of new Set(levels)) {
            if (removedW <= 1e-6) continue;
            const addedW = removedW * units[from] / units[to] * hoursAt(store, from) / hoursAt(store, to);
            const saving = sourceCosts[from] -
              chargeCost(from, schedule[from] - removedW) -
              addedW / 1_000 * hoursAt(store, to) * energyCostSekPerKwh(
                  slots[to],
                  occupiedW[to],
                  addedW,
                  limits,
                  returnedW[to],
                ) +
              (removedW * hoursAt(store, from) - addedW * hoursAt(store, to)) / 1_000 * wear;
            if (saving <= (best?.saving_sek ?? 0) + 1e-9) continue;

            // Verify the actual dynamics without clamping. In particular, a
            // state-dependent efficiency must not create or destroy charge.
            const first = Math.min(from, to);
            const last = Math.max(from, to);
            let projected = state[first];
            let feasible = true;
            for (let index = first; index <= last; index += 1) {
              projected = nextState(
                store,
                projected,
                schedule[index] + (index === to ? addedW : 0) -
                  (index === from ? removedW : 0),
                discharge[index],
                index,
              );
              if (
                !Number.isFinite(projected) || projected < low - 1e-9 ||
                projected > high + 1e-9
              ) {
                feasible = false;
                break;
              }
            }
            if (!feasible || Math.abs(projected - state[last + 1]) > 1e-9) {
              continue;
            }
            best = {
              store,
              from,
              to,
              removed_w: removedW,
              added_w: addedW,
              saving_sek: saving,
            };
          }
        }
      }
    }
    return best;
  };

  /**
   * Re-price one quarter's charges against the company they ended up keeping.
   *
   * The auction quotes each bid against the occupancy at the moment it is
   * evaluated, so whichever store wins a sunny quarter first books the whole
   * surplus at the export price and a store that wins the same quarter later
   * pays import for all of it. Nothing re-prices the first once the second
   * arrives, and one observed quarter charged the battery with 1106 W booked
   * at 0.846 SEK/kWh while the house imported at 1.852 — the sign of that
   * decision settled by allocation order alone.
   *
   * The quarter's spare PV is one pool of energy and no store has a claim on it
   * beyond its share of the draw. Splitting it pro-rata is the only division
   * that does not depend on bid order and still adds back up to what the
   * quarter really costs.
   */
  const recostSlot = (index: number): void => {
    const slot = slots[index];
    const charges = allocations[index].filter((part) =>
      part.direction === "charge"
    );
    if (charges.length === 0) return;
    const chargeW = charges.reduce((sum, part) => sum + part.power_w, 0);
    if (chargeW <= 0) return;
    // PV surplus only. A store discharging into this quarter is *not* spare
    // energy: it is a transfer the discharging store was already paid for
    // through its own allocation, and counting it here hands the charging store
    // a discount nobody funded. One observed quarter had the pool book its
    // whole 3.5 kW at the export price of 1.09 SEK/kWh while PV was under
    // 1.2 kW and the import price was 2.15 — the four dearest quarters of that
    // day, made to look like the cheapest.
    //
    // `energyCostSekPerKwh`, which the auction bids against, never included it.
    // Only the settled re-pricing did, so the plan was decided on one number
    // and explained with another.
    const spareW = Math.max(0, slot.pv_w - slot.fixed_load_w);
    const solarShare = Math.min(1, spareW / chargeW);
    // Peak is a property of the quarter, not of one allocation, so it is shared
    // in proportion to the grid each part actually draws — the same pro-rata
    // rule the surplus above uses, and for the same reason: no store has a
    // claim on the quarter beyond its share of it.
    const gridTotalW = charges.reduce(
      (sum, part) => sum + part.power_w * (1 - solarShare),
      0,
    );
    const peakSek = peakSekPerKwh(
      limits,
      Math.max(0, slot.fixed_load_w - spareW),
      gridTotalW,
    );
    for (const part of charges) {
      part.solar_w = part.power_w * solarShare;
      part.grid_w = part.power_w - part.solar_w;
      part.energy_cost_sek_per_kwh =
        (part.solar_w * slot.export_price_sek_per_kwh +
            part.grid_w * slot.import_price_sek_per_kwh) / part.power_w +
        peakSek * (part.grid_w / Math.max(1e-9, part.power_w));
    }
  };

  /** Net worth of one committed part where the executed trajectory puts it. */
  const settledNet = (store: DispatchStore, index: number): number => {
    const part = partAt(store, index);
    if (!part) return 0;
    const wear = store.wear_sek_per_kwh ?? 0;
    const kwh = part.power_w / 1_000 * hoursAt(store, index);
    const charging = part.direction === "charge";
    const { value } = movedValue(
      store,
      index,
      charging ? part.power_w : 0,
      charging ? 0 : part.power_w,
    );
    return charging
      ? value - (part.energy_cost_sek_per_kwh + wear) * kwh -
        part.start_cost_sek
      : value + (part.average_value_sek_per_kwh - wear) * kwh;
  };

  /** Rebuild heat-pump runs from executable power, not auction bid identities.
   * A continuation can outlive the bid it joined. Settlement must price the
   * whole physical run, including any newly exposed restart.
   * Only stores explicitly carrying compressor start costs use this accounting;
   * battery and EV allocations retain their energy-trade identities.
   */
  if (!checkpoint) {
    for (const store of stores) {
      store.fixed_charge_w_by_slot?.forEach((watts, index) => {
        if (watts !== null && watts > 0) allocations[index].push(bookedCharge(store, index, "fixed_profile"));
      });
    }
  }

  const editable = (store: DispatchStore, indices: number[]): boolean =>
    indices.every(index => store.fixed_charge_w_by_slot?.[index] == null);

  const reconcileChargeRuns = (): void => {
    for (const store of stores) {
      if ((store.start_cost_sek ?? 0) <= 0) continue;
      for (const run of runsOf(powerW[store.key])) {
        const startCost = run.start === 0 && store.initially_charging
          ? 0
          : store.start_cost_sek ?? 0;
        const parts = Array.from(
          { length: run.slots },
          (_, offset) => partAt(store, run.start + offset)!,
        );
        for (const part of parts) {
          const share = startCost / run.slots;
          part.net_value_sek += part.start_cost_sek - share;
          part.start_cost_sek = share;
          part.run_start_index = run.start;
          part.run_slots = run.slots;
        }
        const net = parts.reduce((sum, part) => sum + part.net_value_sek, 0);
        for (const part of parts) part.run_net_value_sek = net;
      }
    }
  };

  /** Settlement can remove the discharge that made room for a later charge,
   * or the load another discharge was supplying. Check both physical bounds
   * and the no-export contract against the changed schedule, without clamping.
   */
  const physicallyInvalid = (store: DispatchStore, index: number): boolean => {
    const inW = powerW[store.key][index];
    const outW = dischargeW[store.key][index];
    const after = nextState(
      store,
      stateByKey[store.key][index],
      inW,
      outW,
      index,
    );
    if (inW > 0 && after > transitionBand(store, stateByKey[store.key][index], index).ceiling + 1e-9) return true;
    if (outW > 0 && after < (store.min_state ?? -Infinity) - 1e-9) return true;
    const exporting = outW >
      gridImportW(slots[index], occupiedW[index], returnedW[index] - outW) +
        1e-6;
    return outW > 0 && exporting && (!store.discharge?.export_allowed ||
      store.discharge.export_allowed_by_slot?.[index] === false ||
      after < (store.discharge.export_min_state ?? -Infinity) - 1e-9);
  };

  const releaseRun = (store: DispatchStore, indices: number[]): void => {
    for (const index of indices) {
      const at = allocations[index].findIndex((part) =>
        part.store_key === store.key
      );
      if (at < 0) continue;
      const [part] = allocations[index].splice(at, 1);
      if (part.direction === "charge") {
        powerW[store.key][index] = 0;
        occupiedW[index] = Math.max(0, occupiedW[index] - part.power_w);
      } else {
        dischargeW[store.key][index] = 0;
        returnedW[index] = Math.max(0, returnedW[index] - part.power_w);
      }
    }
    project(
      store,
      powerW[store.key],
      dischargeW[store.key],
      0,
      stateByKey[store.key],
    );
  };

  // ---------------------------------------------------------------------
  // The auction and the settlement are one fixed point, not two passes.
  //
  // Settling only ever removes, and the note below justifies that with a
  // monotonicity that holds for a pure sink: releasing a charge lowers every
  // later state, which raises what the charge still standing is worth, so no
  // release can create work for another. A store that also *discharges* breaks
  // it in both directions. Releasing a charge starves the discharges it was
  // funding, and releasing a discharge raises every later state, which pushes
  // the charges that fed it under water. The two feed each other downwards,
  // and what the pass leaves behind is a schedule the auction would not have
  // stopped at.
  //
  // Live plan `eb2ffa5e`, 2026-08-28. The auction bought the cheap night and
  // planned to discharge continuously across the 17:15–23:30 evening. Settling
  // released the afternoon top-up as unprofitable, starved the discharges it
  // funded — from the back, so the *dearest* quarters were the ones dropped —
  // and shipped a battery that sat on 1.41 kWh through 20:15–21:15 while the
  // house imported at 2.19 SEK/kWh. Discharging into any of those quarters was
  // worth about +0.13 SEK and needed nothing that was not already bought.
  // Nothing re-ran the auction to notice.
  //
  // So alternate them until a settlement releases nothing: each round bids
  // against the trajectory the previous one actually left, and a round that
  // releases nothing is by construction a schedule where every commitment pays
  // where it lands and no absent one would.
  //
  // Some horizons never reach that. The auction re-bids exactly what the last
  // settlement released, settlement releases exactly the same runs again, and
  // the pair sits in a limit cycle: the September 5 replay released the same 30
  // battery runs every round from round 2 to the cap, twenty-one rounds of
  // provably identical work costing about 58% of the solve's iterations and
  // most of its settlement passes. A worker's CPU budget cannot pay for that,
  // and nothing at the end of it differs from the schedule round 2 had already
  // produced. So a round that releases exactly what the round before it
  // released stops the loop where it stands: repeating it cannot change the
  // answer, only the bill. The result is the same schedule the round cap used
  // to return, and `settle_cycle` says that is why it stopped.
  //
  // The loop is therefore bounded three ways — by the iteration budget the
  // auction already spends from, by the round cap, and by the cycle.
  // ---------------------------------------------------------------------
  if (!checkpoint) {
    let settling = true;
    let previousReleases: string | null = null;
    for (let round = 0; settling; round += 1) {
      if (round >= MAX_SETTLE_ROUNDS) {
        stopped = "settle_cap";
        break;
      }
      releasedThisRound = 0;
      const releasedRuns: string[] = [];
      // Every held bid was priced against a schedule the previous round has since
      // settled away.
      markAllStale();
      while (iterations < maxIterations) {
        iterations += 1;
        let best: Candidate | null = null;

        for (const store of stores) {
          let storeBest: Candidate | null = null;
          const stale = staleBySlot[store.key];
          const chargeBest = chargeBestBySlot[store.key];
          const dischargeBest = dischargeBestBySlot[store.key];
          let anyStale = false;
          for (let index = 0; index < count; index += 1) {
            if (stale[index]) {
              anyStale = true;
              break;
            }
          }
          const schedule = powerW[store.key];
          const dischargeByKey = dischargeW[store.key];
          const state = stateByKey[store.key];
          const retention = retentionByKey[store.key];
          // Both directions read the same suffix extremes: charging is bounded by
          // the highest state still to come, discharging by the lowest.
          const suffixMin = suffixMinByKey[store.key];
          const suffixMax = suffixMaxByKey[store.key];
          if (anyStale) suffixBounds(state, suffixMin, suffixMax);
          for (let index = 0; anyStale && index < count; index += 1) {
            if (!stale[index]) continue;
            // A quarter about to be repriced holds nothing from last time: every
            // path out of this loop is a quarter with no charge bid in it.
            chargeBest[index] = null;
            // A slot already committed to discharge must not also charge. Only the
            // discharge side used to check this, so whichever direction won the
            // auction first could be joined by the other in the same slot — the
            // plan then bought energy at the import price and paid the round trip
            // to push it through the battery for nothing.
            if (dischargeByKey[index] > 0) continue;
            // A partial charge can grow after another allocation frees state or
            // source capacity. Its bid is the gain over the existing setpoint,
            // and accepting it replaces that setpoint rather than charging twice.
            const previousW = schedule[index];
            if (store.fixed_charge_w_by_slot?.[index] != null || previousW >= store.max_power_w - 1e-6) continue;
            const adjacentRun = (index === 0 && store.initially_charging) ||
              (schedule[index - 1] ?? 0) > 0 ||
              (schedule[index + 1] ?? 0) > 0;
            const startsRun = previousW === 0 && !adjacentRun;
            const span = 1;
            const indices = [index];

            // Only a store that sells its charge back is doing arbitrage. A pool
            // buys warmth and a car buys range; neither is betting on a price.
            const roundTrip = store.discharge
              ? store.units_per_kwh(state[index], index) /
                Math.max(
                  1e-9,
                  store.discharge.state_per_kwh_out(state[index], index),
                )
              : 0;
            // Walked for the same reason as the block check above: mapping the
            // block and spreading it into `Math.min` allocated two arrays for
            // every quarter the auction priced, which at 288 quarters times three
            // stores times a thousand iterations is most of a worker's budget.
            let fullW = store.max_power_w;
            for (let offset = 0; offset < span; offset += 1) {
              const slotIndex = index + offset;
              const units = store.units_per_kwh(state[slotIndex], slotIndex);
              if (units <= 0) {
                fullW = 0;
                break;
              }
              const slot = slots[slotIndex];
              const otherW = occupiedW[slotIndex] - schedule[slotIndex];
              const gridBarred = store.discharge !== undefined &&
                slots[slotIndex].binding === true &&
                !(sellPrices[slotIndex] >
                  slots[slotIndex].import_price_sek_per_kwh /
                    Math.max(1e-9, roundTrip));
              const limitW = Math.min(
                headroomW(
                  slot,
                  limits,
                  otherW,
                  returnedW[slotIndex],
                ),
                schedule[slotIndex] +
                  chargeRoomW(store, suffixMax[slotIndex], units, slotIndex),
                // Barred from the grid, it may still take what the roof is
                // giving away: that energy costs no committed money.
                gridBarred
                  ? Math.max(
                    0,
                    slot.pv_w - slot.fixed_load_w - otherW,
                  )
                  : Infinity,
              );
              if (limitW < fullW) fullW = limitW;
            }
            if (fullW <= previousW + 1e-6) continue;
            if (fullW + 1e-9 < (store.min_power_w ?? 0)) continue;
            // A fixed-power relay has one executable level. Curve and price
            // breakpoints cannot introduce another, so price its run directly.
            if (
              store.min_power_w === store.max_power_w &&
              fullW === store.max_power_w
            ) {
              const level = Math.round(fullW * 1e6) / 1e6;
              if (level > previousW + 1e-6 && level <= fullW + 1e-9) {
                chargeBest[index] = chargeCandidate(
                  store,
                  indices,
                  level,
                  startsRun,
                );
              }
              continue;
            }
            // Concavity bounds every charge's average value by the marginal
            // value of its first unit. If even that cannot pay the cheapest
            // source, no executable level in this quarter can win. Restrict this
            // bound to a new single-slot bid: upgrades and drifting run blocks
            // compare different trajectories.
            if (
              span === 1 && previousW === 0 && (store.start_cost_sek ?? 0) >= 0
            ) {
              const upperValue = marginalValue(store.curve, state[index]) *
                store.units_per_kwh(state[index], index) * retention[index];
              const slot = slots[index];
              const hasSurplus =
                slot.pv_w > slot.fixed_load_w + occupiedW[index];
              const lowerCost = (hasSurplus
                ? Math.min(
                  slot.import_price_sek_per_kwh,
                  slot.export_price_sek_per_kwh,
                )
                : slot.import_price_sek_per_kwh) +
                (store.wear_sek_per_kwh ?? 0);
              if (upperValue < lowerCost - 1e-9) {
                continue;
              }
            }
            // Candidate levels stop wherever either the source cost or the curve
            // changes. This applies to every store: valuing an 11 kW EV quarter or
            // a four-quarter pool run at the first infinitesimal unit is precisely
            // the defect an integral utility curve exists to prevent.
            // One scratch array for the whole auction: nothing retains it past
            // the levels it produces, and a fresh array per priced quarter is
            // pure allocation.
            rawPowers.length = 0;
            rawPowers.push(fullW, store.min_power_w ?? 0);
            for (let offset = 0; offset < span; offset += 1) {
              const slotIndex = index + offset;
              const surplusW = Math.max(
                0,
                Math.min(
                  fullW,
                  slots[slotIndex].pv_w - slots[slotIndex].fixed_load_w -
                    (occupiedW[slotIndex] - schedule[slotIndex]),
                ),
              );
              if (surplusW > 0 && surplusW < fullW) rawPowers.push(surplusW);
              const units = store.units_per_kwh(state[slotIndex], slotIndex);
              // Where the shaped cost of the next kilowatt meets what it is worth.
              //
              // Every other level here is a breakpoint of something piecewise —
              // the surplus running out, the curve turning. A shaped peak is not
              // piecewise: its marginal cost rises continuously with the power
              // already committed, so the profit-maximising power is an interior
              // point that no breakpoint lands on. Without it the auction can only
              // take the block whole or leave it, which is why a shaped plan
              // stopped charging altogether instead of charging more gently.
              //
              // Solving `value = price + rate × (over + x)` for the increment x,
              // where the average-marginal form makes the optimum exactly
              // `(value − price)/rate − over`.
              if (limits.peak_shaping_sek_per_kwh_per_kw > 0 && units > 0) {
                const slot = slots[slotIndex];
                const valuePerKwh =
                  marginalValue(store.curve, state[slotIndex]) *
                  units;
                const beforeW = gridImportW(
                  slot,
                  occupiedW[slotIndex] - schedule[slotIndex],
                  returnedW[slotIndex],
                );
                const gainPerKwh = valuePerKwh - slot.import_price_sek_per_kwh -
                  (store.wear_sek_per_kwh ?? 0);
                // Two points, because the cost is not one curve but two joined at
                // the threshold. The join itself is a breakpoint like any other —
                // the surplus running out, the utility curve turning — and it is
                // frequently the answer: filling a quarter exactly up to the
                // threshold and stopping costs nothing at all, which beats both
                // going further and stopping short. Missing it let a house at 4 kW
                // charge at the full 8.8 rather than the 6 that reaches the
                // threshold, so the shaped and unshaped plans were identical.
                const toThresholdW = limits.grid_import_shaping_w - beforeW;
                if (toThresholdW > 1e-9 && toThresholdW < fullW - 1e-9) {
                  rawPowers.push(toThresholdW);
                }
                // And the optimum of the branch above it, where the marginal cost
                // is rising: `value = price + rate × (over_before + x)/2` in the
                // average-marginal form the cost is charged at.
                const overBeforeKw = (beforeW - limits.grid_import_shaping_w) /
                  1_000;
                const bestKw = gainPerKwh /
                    limits.peak_shaping_sek_per_kwh_per_kw -
                  overBeforeKw / 2;
                const bestW = bestKw * 1_000;
                if (
                  bestW > 1e-9 && bestW < fullW - 1e-9 &&
                  beforeW + bestW > limits.grid_import_shaping_w
                ) {
                  rawPowers.push(bestW);
                }
              }
              for (const point of store.curve.points) {
                const toPointW = (point.at - state[slotIndex]) / units /
                  hoursAt(store, slotIndex) *
                  1_000;
                if (toPointW > 1e-9 && toPointW < fullW - 1e-9) {
                  rawPowers.push(toPointW);
                }
              }
            }
            let slotBest: Candidate | null = null;
            for (
              const powerLevel of executablePowerLevels(store, rawPowers, fullW)
            ) {
              if (powerLevel <= previousW + 1e-6) continue;
              const candidate = chargeCandidate(
                store,
                indices,
                powerLevel,
                startsRun,
              );
              // Compare complete executable setpoints by the welfare gained over
              // what is already scheduled, then rank slots by that gain per kWh.
              if (
                candidate &&
                (slotBest === null ||
                  candidate.surplus > slotBest.surplus + 1e-12 ||
                  (Math.abs(candidate.surplus - slotBest.surplus) <= 1e-12 &&
                    candidate.score > slotBest.score))
              ) {
                slotBest = candidate;
              }
            }
            chargeBest[index] = slotBest;
          }

          // Discharge is the same comparison with the signs exchanged: the value is
          // the import it avoids, and the cost is the stored energy given up. Making
          // it a candidate in the same auction is the point — a battery that would
          // rather keep its charge simply loses to the sinks, and one whose charge is
          // worth less than tonight's import price wins.
          if (store.discharge) {
            for (let index = 0; anyStale && index < count; index += 1) {
              if (!stale[index]) continue;
              dischargeBest[index] = null;
              if (schedule[index] > 0) continue;
              const previousW = dischargeByKey[index];
              const otherReturnedW = returnedW[index] - previousW;
              const slot = slots[index];
              const deficitW = Math.max(
                0,
                slot.fixed_load_w + occupiedW[index] - slot.pv_w -
                  otherReturnedW,
              );
              const coverW = Math.min(store.discharge.max_power_w, deficitW);
              const statePerKwh = store.discharge.state_per_kwh_out(
                state[index],
                index,
              );
              const exportPermitted = store.discharge.export_allowed &&
                (store.discharge.export_allowed_by_slot?.[index] ?? true);
              const exportW = exportPermitted
                ? Math.min(
                  store.discharge.max_power_w - coverW,
                  Math.max(
                    0,
                    (state[index] -
                          (store.discharge.export_min_state ?? -Infinity)) /
                        statePerKwh * 1000 / hoursAt(store, index) - coverW,
                  ),
                  Math.max(
                    0,
                    limits.grid_export_limit_w -
                      Math.max(0, slot.pv_w - slot.fixed_load_w),
                  ),
                )
                : 0;
              const maximumW = coverW + exportW;
              if (maximumW <= previousW + 1e-6) continue;
              const rawLevels = [coverW, maximumW];
              // Removing energy only moves up a concave marginal-value curve.
              // Price the most optimistic first unit before enumerating levels.
              // Peak relief is bounded by the marginal relief at today's import.
              if (previousW === 0 && (store.min_state ?? -Infinity) >= 0) {
                const lowerValue = marginalValue(store.curve, state[index]) *
                  statePerKwh * retention[index];
                const rate = limits.peak_shaping_sek_per_kwh_per_kw;
                const relief = rate > 0
                  ? rate * overThresholdKw(
                    limits,
                    gridImportW(slot, occupiedW[index], otherReturnedW),
                  )
                  : 0;
                const upperPrice = (exportPermitted
                  ? Math.max(
                    slot.import_price_sek_per_kwh,
                    slot.export_price_sek_per_kwh,
                  )
                  : slot.import_price_sek_per_kwh) + relief;
                if (
                  upperPrice - (store.wear_sek_per_kwh ?? 0) < lowerValue - 1e-9
                ) {
                  continue;
                }
              }
              const previousKwh = previousW / 1_000 * hoursAt(store, index);
              const previousSpent = previousKwh * statePerKwh;
              const importBeforeW = gridImportW(
                slot,
                occupiedW[index],
                otherReturnedW,
              );
              const priceFor = (powerW: number): number => {
                if (powerW <= 0) return 0;
                const loadW = Math.min(powerW, coverW);
                return (loadW * slot.import_price_sek_per_kwh +
                      (powerW - loadW) * slot.export_price_sek_per_kwh) /
                    powerW +
                  peakReliefSekPerKwh(limits, importBeforeW, loadW);
              };
              const previousSurplus =
                (priceFor(previousW) - (store.wear_sek_per_kwh ?? 0)) *
                  previousKwh +
                valueOfMove(
                    store.curve,
                    state[index],
                    state[index] - previousSpent,
                  ) * retention[index];
              for (const point of store.curve.points) {
                const toPointW = (state[index] - point.at) / statePerKwh /
                  hoursAt(store, index) * 1_000;
                if (toPointW > 1e-9 && toPointW < maximumW - 1e-9) {
                  rawLevels.push(toPointW);
                }
              }
              const dischargeLevels = [
                ...new Set(
                  rawLevels.map((level) => Math.round(level * 1e6) / 1e6),
                ),
              ].filter((level) => level > 1e-9);
              let slotBest: Candidate | null = null;
              for (const powerLevel of dischargeLevels) {
                if (powerLevel <= previousW + 1e-6) continue;
                const loadW = Math.min(powerLevel, coverW);
                const toExportW = powerLevel - loadW;
                const price = priceFor(powerLevel);
                const destination = toExportW <= 1e-9
                  ? "load" as const
                  : loadW <= 1e-9
                  ? "export" as const
                  : "mixed" as const;
                const kwh = powerLevel / 1_000 * hoursAt(store, index);
                const spent = kwh * statePerKwh;
                // Feasible only if the lowest state still to come can absorb it.
                if (
                  store.min_state !== undefined &&
                  suffixMin[index] - (spent - previousSpent) <
                    store.min_state - 1e-9
                ) continue;
                // The sell side of the curve: what the charge being given up is
                // worth, not what the next unit would be worth to buy.
                const after = state[index] - spent;
                const givenUp = -valueOfMove(
                  store.curve,
                  state[index],
                  after,
                ) / kwh * retention[index];
                const gained = price - (store.wear_sek_per_kwh ?? 0);
                const totalSurplus = (gained - givenUp) * kwh;
                const surplus = totalSurplus - previousSurplus;
                if (surplus <= 1e-9) continue;
                const candidate: Candidate = {
                  store,
                  index,
                  indices: [index],
                  surplus,
                  score: surplus / (kwh - previousKwh),
                  direction: "discharge",
                  parts: [{
                    store_key: store.key,
                    direction: "discharge",
                    trigger: "economic_winner",
                    allocation_order: 0,
                    run_start_index: index,
                    run_slots: 1,
                    power_w: powerLevel,
                    state_before: state[index],
                    state_after: after,
                    state_unit: store.curve.unit,
                    retention_factor: retention[index],
                    average_value_sek_per_kwh: price,
                    energy_cost_sek_per_kwh: givenUp,
                    wear_cost_sek_per_kwh: store.wear_sek_per_kwh ?? 0,
                    start_cost_sek: 0,
                    net_value_sek: totalSurplus,
                    run_net_value_sek: totalSurplus,
                    solar_w: 0,
                    grid_w: 0,
                    discharge_destination: destination,
                  }],
                };
                if (
                  slotBest === null ||
                  candidate.surplus > slotBest.surplus + 1e-12 ||
                  (Math.abs(candidate.surplus - slotBest.surplus) <= 1e-12 &&
                    candidate.score > slotBest.score)
                ) {
                  slotBest = candidate;
                }
              }
              dischargeBest[index] = slotBest;
            }
          }
          if (anyStale) stale.fill(0);
          // Reduced in the order the two scans ran in, because `outranks` keeps
          // the incumbent on a tie: charge bids across the horizon, then
          // discharge bids across it.
          for (let index = 0; index < count; index += 1) {
            const candidate = chargeBest[index];
            if (candidate && outranks(candidate, storeBest)) {
              storeBest = candidate;
            }
          }
          if (store.discharge) {
            for (let index = 0; index < count; index += 1) {
              const candidate = dischargeBest[index];
              if (candidate && outranks(candidate, storeBest)) {
                storeBest = candidate;
              }
            }
          }
          if (storeBest && outranks(storeBest, best)) {
            best = storeBest;
          }
        }

        if (!best) {
          // A relay's first quarter need not repay the entire startup cost.
          // Search every executable run length only once single-quarter bids
          // are exhausted. Each prefix is priced incrementally, so this is
          // quadratic in the horizon, not a fresh simulation for every block.
          for (const store of stores) {
            if (
              store.discharge || store.min_power_w !== store.max_power_w ||
              (store.start_cost_sek ?? 0) <= 0
            ) continue;
            const schedule = powerW[store.key];
            for (let start = 0; start < count; start += 1) {
              if (schedule[start] > 0 || store.fixed_charge_w_by_slot?.[start] != null) continue;
              const indices: number[] = [];
              for (
                let end = start;
                end < count && schedule[end] === 0 && store.fixed_charge_w_by_slot?.[end] == null;
                end += 1
              ) indices.push(end);
              if (indices.length < 2) continue;
              const levels = new Set([store.max_power_w, store.min_power_w ?? store.max_power_w]);
              for (const level of levels) {
                const candidate = chargeCandidate(store, indices, level, true, true);
                if (candidate && outranks(candidate, best)) best = candidate;
              }
            }
          }
        }
        if (!best) {
          const exchange = bestSolarExchange();
          if (!exchange) break;
          const { store, from, to, removed_w, added_w } = exchange;
          const schedule = powerW[store.key];
          const source = partAt(store, from)!;
          const target = partAt(store, to);
          schedule[from] -= removed_w;
          schedule[to] += added_w;
          occupiedW[from] -= removed_w;
          occupiedW[to] += added_w;
          if (schedule[from] <= 1e-9) {
            // Drop the rounding residue with the allocation it belonged to, or
            // the schedule keeps power in a quarter that no longer records any.
            occupiedW[from] -= schedule[from];
            schedule[from] = 0;
            allocations[from].splice(allocations[from].indexOf(source), 1);
          } else {
            source.power_w = schedule[from];
          }
          if (target) {
            target.power_w = schedule[to];
            target.allocation_order = iterations;
          } else {
            // Settlement recomputes both quarters' value and source costs from
            // the new trajectory, just as it does after every ordinary bid.
            allocations[to].push({
              ...source,
              power_w: schedule[to],
              allocation_order: iterations,
              run_start_index: to,
              run_slots: 1,
              start_cost_sek: 0,
            });
          }
          project(
            store,
            schedule,
            dischargeW[store.key],
            Math.min(from, to),
            stateByKey[store.key],
          );
          markAllStale();
          continue;
        }

        // Apply exactly the executable setpoint that won.
        const schedule = powerW[best.store.key];
        const discharge = dischargeW[best.store.key];
        const changedIndices: number[] = [];
        for (const [partIndex, part] of best.parts.entries()) {
          const index = best.indices[partIndex];
          part.allocation_order = iterations;
          const previousAt = allocations[index].findIndex((allocation) =>
            allocation.store_key === best.store.key
          );
          if (previousAt < 0) allocations[index].push(part);
          else allocations[index][previousAt] = part;
          if (best.direction === "discharge") {
            returnedW[index] += part.power_w - discharge[index];
            discharge[index] = part.power_w;
          } else {
            occupiedW[index] += part.power_w - schedule[index];
            schedule[index] = part.power_w;
          }
          changedIndices.push(index);
        }
        project(
          best.store,
          schedule,
          discharge,
          best.index,
          stateByKey[best.store.key],
        );
        let firstChanged = changedIndices[0];
        let lastChanged = changedIndices[0];
        for (const index of changedIndices) {
          if (index < firstChanged) firstChanged = index;
          if (index > lastChanged) lastChanged = index;
        }
        for (const store of stores) {
          if (store.key === best.store.key) {
            // Its trajectory moved from here on, and `suffixBounds` turns that
            // into a different ceiling for the quarters before it too.
            staleBySlot[store.key].fill(1);
            continue;
          }
          // Everyone else sees this only as load that appeared in — or left —
          // those quarters, which reprices a bid whose block reaches into one of
          // them and nothing further. A sink that starts charging can create a
          // discharge opportunity the same way, so the window is the same on both
          // sides.
          markStaleWindow(
            store.key,
            firstChanged,
            lastChanged,
          );
        }
      }

      // Every store settles in the same loop, because releasing one store's charge
      // frees surplus that re-prices another's in the same quarter. Settling them
      // one after another would leave whichever went first holding a price the
      // rest of the pass had already moved.
      //
      // Release allocations that no longer pay for their energy and start cost.
      for (let pass = 0; pass <= count * stores.length; pass += 1) {
        for (const store of stores) {
          project(
            store,
            powerW[store.key],
            dischargeW[store.key],
            0,
            stateByKey[store.key],
          );
        }
        for (let index = 0; index < count; index += 1) recostSlot(index);
        reconcileChargeRuns();

        let starved: { store: DispatchStore; indices: number[] } | null = null;
        let worst:
          | { store: DispatchStore; indices: number[]; net: number }
          | null = null;
        for (const store of stores) {
          const runs = new Map<string, { indices: number[]; net: number }>();
          let starvedKey: string | null = null;
          for (let index = 0; index < count; index += 1) {
            const part = partAt(store, index);
            if (!part) continue;
            const key = `${part.direction}:${part.run_start_index}`;
            const run = runs.get(key) ?? { indices: [], net: 0 };
            run.indices.push(index);
            run.net += settledNet(store, index);
            runs.set(key, run);
            if (starvedKey === null && physicallyInvalid(store, index)) {
              starvedKey = key;
            }
          }
          // Resolve the run only once the scan has collected all of its slots.
          if (starvedKey !== null && starved === null && editable(store, runs.get(starvedKey)!.indices)) {
            starved = { store, indices: runs.get(starvedKey)!.indices };
          }
          for (const run of runs.values()) {
            const startCost = store.start_cost_sek ?? 0;
            if (startCost > 0) {
              // Trimming a run is allowed, but cutting a gap creates a restart.
              // Include that change in cost BEFORE removing any quarters. Price
              // every contiguous cut so we can also release an expensive prefix,
              // suffix, or whole run without making the run indivisible.
              const continuing = run.indices[0] === 0 &&
                store.initially_charging;
              const originalStart = continuing ? 0 : startCost;
              const margins = run.indices.map((index) =>
                settledNet(store, index) + partAt(store, index)!.start_cost_sek
              );
              for (let from = 0; from < run.indices.length; from += 1) {
                let margin = 0;
                for (let to = from; to < run.indices.length; to += 1) {
                  margin += margins[to];
                  const remainingStarts = (from > 0 ? originalStart : 0) +
                    (to + 1 < run.indices.length ? startCost : 0);
                  // Per quarter released, so a run that is under water as a
                  // whole is trimmed from where it loses most and priced again
                  // rather than dropped: the quarters that remain are worth
                  // more once the ones stacked on them are gone.
                  const net = (margin + remainingStarts - originalStart) /
                    (to - from + 1);
                  if (net < -1e-9 && (worst === null || net < worst.net) && editable(store, run.indices.slice(from, to + 1))) {
                    worst = {
                      store,
                      indices: run.indices.slice(from, to + 1),
                      net,
                    };
                  }
                }
              }
            } else if (
              run.net < -1e-9 && (worst === null || run.net < worst.net) && editable(store, run.indices)
            ) {
              worst = { store, indices: run.indices, net: run.net };
            }
          }
        }
        // An unsupplied discharge goes before anything merely unprofitable.
        const target = starved ?? worst;
        if (target === null) break;
        releasedThisRound += 1;
        releasedRuns.push(
          `${target.store.key}:${target.indices.join(",")}`,
        );
        releaseRun(target.store, target.indices);
      }

      // Order is an artefact of which run happened to price worst first, so the
      // set is what has to match, not the sequence.
      const releases = releasedRuns.sort().join("|");
      if (releasedThisRound > 0 && releases === previousReleases) {
        stopped = "settle_cycle";
        break;
      }
      previousReleases = releases;
      settling = releasedThisRound > 0;
    }

    if (iterations >= maxIterations) stopped = "iteration_cap";

    for (const store of stores) {
      // Publish the settled arithmetic. The allocation's own record and the
      // executed trajectory used to disagree, which is what hid all of this.
      const runNet = new Map<number, number>();
      for (let index = 0; index < count; index += 1) {
        const part = partAt(store, index);
        if (!part) continue;
        const wear = store.wear_sek_per_kwh ?? 0;
        const kwh = part.power_w / 1_000 * hoursAt(store, index);
        const charging = part.direction === "charge";
        const { after, value } = movedValue(
          store,
          index,
          charging ? part.power_w : 0,
          charging ? 0 : part.power_w,
        );
        part.state_before = stateByKey[store.key][index];
        part.state_after = after;
        part.retention_factor = retentionByKey[store.key][index];
        if (charging) {
          part.average_value_sek_per_kwh = kwh > 0 ? value / kwh : 0;
        } else {
          part.energy_cost_sek_per_kwh = kwh > 0 ? -value / kwh : 0;
        }
        part.net_value_sek = settledNet(store, index);
        runNet.set(
          part.run_start_index,
          (runNet.get(part.run_start_index) ?? 0) + part.net_value_sek,
        );
      }
      for (let index = 0; index < count; index += 1) {
        const part = partAt(store, index);
        if (part) {
          part.run_net_value_sek = runNet.get(part.run_start_index) ?? 0;
        }
      }
    }

    yield {
      next: "transfers",
      powerW,
      dischargeW,
      stateByKey,
      occupiedW,
      returnedW,
      allocations,
      iterations,
      stopped,
    };
  }

  if (checkpoint?.next !== "refinement") {
    // A single charge can be blocked by tomorrow's full pack while a single
    // discharge loses to retained value. Buying energy and serving another load
    // TOGETHER changes neither tomorrow's pack nor terminal utility. Price that
    // transaction directly, after settlement so neither leg is released alone.
    // Check the intervening trajectory in either direction: charge before use,
    // or use existing charge before a refill. The suffix remains intact.
    // Each accepted transfer consumes charging or load headroom.
    type EnergyTransfer = {
      store: DispatchStore;
      charge: number;
      discharge: number;
      inW: number;
      outW: number;
      cost: number;
      benefit: number;
      wear: number;
      saving: number;
      score: number;
    };
    const transferredStores = new Set<string>(checkpoint?.transferred);
    const rate = limits.peak_shaping_sek_per_kwh_per_kw;
    let transfersThisCall = 0;
    while (iterations < maxIterations) {
      // Every transfer rescans every charge/discharge pair, and a long horizon
      // can accept a hundred of them: on 2026-09-19 this stage alone outran a
      // planning worker's CPU limit (546). Between two transfers the stage is
      // exactly its checkpoint, so a caller whose budget is spent resumes it
      // in its next request. One transfer per call guarantees progress.
      if (transfersThisCall > 0 && budgetSpent?.()) {
        yield {
          next: "transfers",
          powerW,
          dischargeW,
          stateByKey,
          occupiedW,
          returnedW,
          allocations,
          iterations,
          stopped,
          transferred: [...transferredStores],
        };
        transfersThisCall = 0;
      }
      let best: EnergyTransfer | null = null;
      for (const store of stores) {
        if (!supportsEnergyTransfers(store)) continue;
        const schedule = powerW[store.key];
        const discharge = dischargeW[store.key];
        const state = stateByKey[store.key];
        const flowWear = store.wear_sek_per_kwh ?? 0;
        const cycling = store.discharge!.cycling_cost_sek_per_unit ?? 0;
        // A destination quarter's side of a pair is the same for every charge
        // quarter in this scan, so it is worked out once per quarter rather
        // than once per pair. The expressions and their order are unchanged.
        const hours = new Array<number>(count);
        const importAt = new Array<number>(count);
        const spentAt = new Array<number>(count);
        const deliverableAt = new Array<number>(count);
        for (let load = 0; load < count; load += 1) {
          hours[load] = hoursAt(store, load);
          if (schedule[load] > 0) continue;
          importAt[load] = gridImportW(
            slots[load],
            occupiedW[load],
            returnedW[load],
          );
          spentAt[load] = store.discharge!.state_per_kwh_out(state[load], load);
          deliverableAt[load] = Math.min(
            importAt[load],
            store.discharge!.max_power_w - discharge[load],
          ) /
            1_000 * hours[load] * spentAt[load];
        }
        for (let charge = 0; charge < count; charge += 1) {
          if (discharge[charge] > 0) continue;
          const availableW = Math.min(
            store.max_power_w - schedule[charge],
            headroomW(
              slots[charge],
              limits,
              occupiedW[charge],
              returnedW[charge],
            ),
          );
          const units = store.units_per_kwh(state[charge], charge);
          if (availableW <= 1e-6 || units <= 0) continue;
          const room = transferRoom(
            state,
            charge,
            store.min_state ?? -Infinity,
            store.max_state ?? Infinity,
          );
          const chargeSlot = slots[charge];
          const chargeHours = hours[charge];
          const chargeable = availableW / 1_000 * chargeHours * units;
          const solarW = Math.max(
            0,
            chargeSlot.pv_w - chargeSlot.fixed_load_w - occupiedW[charge],
          );
          const netSource = chargeSlot.fixed_load_w + occupiedW[charge] -
            chargeSlot.pv_w - returnedW[charge];
          // Buying here costs at least what selling here earns, so the
          // marginal saving below cannot rise with the power transferred.
          const buyingCostsMore = chargeSlot.import_price_sek_per_kwh >=
            chargeSlot.export_price_sek_per_kwh;
          for (let load = 0; load < count; load += 1) {
            if (load === charge || schedule[load] > 0) continue;
            const importW = importAt[load];
            const spent = spentAt[load];
            if (spent <= 0) continue;
            const loadHours = hours[load];
            const stored = Math.min(
              room[load],
              chargeable,
              deliverableAt[load],
            );
            if (stored <= 1e-9) continue;
            let maximumW = stored / spent / loadHours * 1_000;
            // Committed grid purchases need a quoted sell opportunity, never a
            // speculative tail price. Solar keeps its opportunity-cost economics.
            if (chargeSlot.binding && !slots[load].published_price) {
              maximumW = Math.min(maximumW, solarW * units / spent * chargeHours / loadHours);
            }
            if (maximumW <= GRID_NOISE_W) continue;
            const economics = (outW: number) => {
              const inW = outW * spent / units * loadHours / chargeHours;
              const inKwh = inW / 1_000 * chargeHours;
              const outKwh = outW / 1_000 * loadHours;
              const cost = inKwh *
                energyCostSekPerKwh(
                  chargeSlot,
                  occupiedW[charge],
                  inW,
                  limits,
                  returnedW[charge],
                );
              const wear = (inKwh + outKwh) * flowWear + outKwh * spent *
                  cycling;
              const benefit = outKwh * (slots[load].import_price_sek_per_kwh +
                peakReliefSekPerKwh(limits, importW, outW));
              return {
                inW,
                inKwh,
                outKwh,
                cost,
                wear,
                benefit,
                saving: benefit - cost - wear,
              };
            };
            if (
              buyingCostsMore &&
              economics(Math.min(maximumW, 0.01)).saving <= 1e-12
            ) continue;
            const levels = [
              maximumW,
              Math.min(maximumW, solarW * units / spent * chargeHours / loadHours),
            ];
            // Equal marginal source and destination costs give the convex optimum.
            if (rate > 0) {
              const ratio = spent / units;
              const flowWearCost = (ratio + 1) * flowWear;
              const cyclingCost = spent * cycling;
              const marginalSaving = (out: number) => {
                const source = netSource + out * ratio * loadHours / chargeHours;
                const buy = source > 0
                  ? chargeSlot.import_price_sek_per_kwh
                  : chargeSlot.export_price_sek_per_kwh;
                return slots[load].import_price_sek_per_kwh +
                  rate * overThresholdKw(limits, importW - out) -
                  ratio *
                    (buy +
                      rate * overThresholdKw(limits, Math.max(0, source))) -
                  flowWearCost - cyclingCost;
              };
              levels.push(
                bisectedLevel(maximumW, marginalSaving, buyingCostsMore),
              );
            }
            for (const outW of levels) {
              if (outW <= 1e-6) continue;
              const { inW, outKwh, cost, wear, benefit, saving } = economics(
                outW,
              );
              const score = saving / (outKwh * spent);
              if (saving <= 0.001 || score <= (best?.score ?? 0) + 1e-9) {
                continue;
              }
              // Verify actual dynamics without clamping, including any
              // state-dependent efficiency. The suffix must be unchanged.
              const first = Math.min(charge, load);
              const last = Math.max(charge, load);
              let projected = state[first];
              let feasible = true;
              for (let index = first; index <= last; index += 1) {
                projected = nextState(
                  store,
                  projected,
                  schedule[index] + (index === charge ? inW : 0),
                  discharge[index] + (index === load ? outW : 0),
                  index,
                );
                if (
                  !Number.isFinite(projected) ||
                  projected < (store.min_state ?? -Infinity) - 1e-9 ||
                  projected > (store.max_state ?? Infinity) + 1e-9 ||
                  // Spending now and refilling later must preserve the reserve
                  // behind any export already scheduled between the two legs.
                  (discharge[index] > gridImportW(
                    slots[index], occupiedW[index],
                    returnedW[index] - discharge[index],
                  ) + GRID_NOISE_W &&
                    projected < (store.discharge!.export_min_state ?? -Infinity) - 1e-9)
                ) {
                  feasible = false;
                  break;
                }
              }
              if (!feasible || Math.abs(projected - state[last + 1]) > 1e-9) {
                continue;
              }
              best = {
                store,
                charge,
                discharge: load,
                inW,
                outW,
                cost,
                benefit,
                wear,
                saving,
                score,
              };
            }
          }
        }
      }
      if (!best) break;
      iterations += 1;
      transfersThisCall += 1;
      const {
        store,
        charge,
        discharge,
        inW,
        outW,
        cost,
        benefit,
        wear,
        saving,
      } = best;
      transferredStores.add(store.key);
      const solarW = Math.min(
        inW,
        Math.max(
          0,
          slots[charge].pv_w -
            slots[charge].fixed_load_w - occupiedW[charge],
        ),
      );
      const transfer = {
        charge_index: charge,
        discharge_index: discharge,
        charged_kwh: inW / 1_000 * hoursAt(store, charge),
        discharged_kwh: outW / 1_000 * hoursAt(store, discharge),
        saving_sek: saving,
        grid_charged_kwh: (inW - solarW) / 1_000 * hoursAt(store, charge),
      };
      // Attribute the opportunity cost to the discharge it funds. Charging this
      // energy has zero standalone profit; the load leg records the joint saving.
      for (
        const [index, watts, charging] of [[charge, inW, true], [
          discharge,
          outW,
          false,
        ]] as const
      ) {
        const old = partAt(store, index);
        const oldKwh = (old?.power_w ?? 0) / 1_000 * hoursAt(store, index);
        const kwh = watts / 1_000 * hoursAt(store, index);
        const total = oldKwh + kwh;
        const part: DispatchAllocationDiagnostic = {
          store_key: store.key,
          direction: charging ? "charge" : "discharge",
          trigger: "economic_winner",
          allocation_order: iterations,
          run_start_index: index,
          run_slots: 1,
          power_w: (old?.power_w ?? 0) + watts,
          state_before: 0,
          state_after: 0,
          state_unit: store.curve.unit,
          retention_factor: 1,
          average_value_sek_per_kwh:
            ((old?.average_value_sek_per_kwh ?? 0) * oldKwh +
              (charging ? cost : benefit)) / total,
          energy_cost_sek_per_kwh:
            ((old?.energy_cost_sek_per_kwh ?? 0) * oldKwh + cost) / total,
          wear_cost_sek_per_kwh: ((old?.wear_cost_sek_per_kwh ?? 0) * oldKwh +
            (charging ? 0 : wear)) /
            total,
          start_cost_sek: 0,
          net_value_sek: (old?.net_value_sek ?? 0) + (charging ? 0 : saving),
          run_net_value_sek: (old?.net_value_sek ?? 0) +
            (charging ? 0 : saving),
          solar_w: (old?.solar_w ?? 0) + (charging ? solarW : 0),
          grid_w: (old?.grid_w ?? 0) + (charging ? watts - solarW : 0),
          discharge_destination: charging ? null : "load",
          energy_transfers: [...(old?.energy_transfers ?? []), transfer],
        };
        if (old) allocations[index][allocations[index].indexOf(old)] = part;
        else allocations[index].push(part);
      }
      powerW[store.key][charge] += inW;
      occupiedW[charge] += inW;
      dischargeW[store.key][discharge] += outW;
      returnedW[discharge] += outW;
      project(
        store,
        powerW[store.key],
        dischargeW[store.key],
        Math.min(charge, discharge),
        stateByKey[store.key],
      );
    }
    if (iterations >= maxIterations) stopped = "iteration_cap";
    // Transfers change intermediate states, including those of pre-existing bids.
    for (const store of stores) {
      if (!transferredStores.has(store.key)) continue;
      for (let index = 0; index < count; index += 1) {
        const part = partAt(store, index);
        if (!part) continue;
        part.state_before = stateByKey[store.key][index];
        part.state_after = stateByKey[store.key][index + 1];
      }
    }

    yield {
      next: "refinement",
      powerW,
      dischargeW,
      stateByKey,
      occupiedW,
      returnedW,
      allocations,
      iterations,
      stopped,
    };
  }

  // ---------------------------------------------------------------------
  // Nothing the plan asks for by size is smaller than the store's floor.
  //
  // Between transfers and refinement: transfers need continuous power to price
  // a pair, and refinement only exchanges charge between executable levels,
  // which include this floor. A refinement resumed part-way already started
  // from the rounded schedule, so the rounding never runs twice.
  // ---------------------------------------------------------------------
  if (!checkpoint?.refinement) {
    const adjusted = enforceMinimumSizedPower(slots, stores, limits, {
      power_w: powerW,
      discharge_w: dischargeW,
    });
    for (const [key, indices] of adjusted) {
      const store = stores.find((candidate) => candidate.key === key)!;
      for (const index of indices) {
        occupiedW[index] = stores.reduce(
          (sum, other) => sum + powerW[other.key][index],
          0,
        );
        returnedW[index] = stores.reduce(
          (sum, other) => sum + dischargeW[other.key][index],
          0,
        );
      }
      project(store, powerW[key], dischargeW[key], 0, stateByKey[key]);
      for (const index of indices) {
        const old = partAt(store, index);
        if (old) allocations[index].splice(allocations[index].indexOf(old), 1);
        if (powerW[key][index] > GRID_NOISE_W) {
          allocations[index].push(
            bookedCharge(store, index, "minimum_adjusted"),
          );
        } else if (dischargeW[key][index] > GRID_NOISE_W) {
          allocations[index].push(bookedDischarge(store, index));
        }
      }
      for (let index = 0; index < count; index += 1) {
        const part = partAt(store, index);
        if (!part) continue;
        part.state_before = stateByKey[key][index];
        part.state_after = stateByKey[key][index + 1];
        // A pair whose leg was rounded no longer describes the schedule.
        const pairs = part.energy_transfers?.filter((pair) =>
          !indices.has(pair.charge_index) && !indices.has(pair.discharge_index)
        );
        if (pairs?.length) part.energy_transfers = pairs;
        else delete part.energy_transfers;
      }
      for (const index of indices) recostSlot(index);
    }
  }

  if (
    (limits.grid_ramp_sek_per_kw ?? 0) > 0 ||
    (limits.load_start_preference_sek ?? 0) > 0
  ) {
    // Refinement rescores the whole schedule for every trial exchange, which
    // makes it the costliest stage after transfers. It too stops between two
    // source quarters when a caller's budget is spent; the schedule refined so
    // far is `powerW`, already in the checkpoint.
    const search = refineDispatchCostSteps(
      slots,
      stores,
      limits,
      { power_w: powerW, discharge_w: dischargeW },
      checkpoint?.refinement,
      budgetSpent,
    );
    let changed: Set<string>;
    for (;;) {
      const searched = search.next();
      if (searched.done === true) {
        changed = searched.value;
        break;
      }
      yield {
        next: "refinement",
        powerW,
        dischargeW,
        stateByKey,
        occupiedW,
        returnedW,
        allocations,
        iterations,
        stopped,
        refinement: searched.value,
      };
    }
    if (changed.size > 0) {
      for (let index = 0; index < count; index += 1) {
        occupiedW[index] = stores.reduce(
          (sum, store) => sum + powerW[store.key][index],
          0,
        );
        returnedW[index] = stores.reduce(
          (sum, store) => sum + dischargeW[store.key][index],
          0,
        );
      }
      for (const store of stores) {
        if (!changed.has(store.key)) continue;
        project(
          store,
          powerW[store.key],
          dischargeW[store.key],
          0,
          stateByKey[store.key],
        );
        for (let index = 0; index < count; index += 1) {
          const old = partAt(store, index);
          if (old) {
            allocations[index].splice(allocations[index].indexOf(old), 1);
          }
          if (dischargeW[store.key][index] > GRID_NOISE_W) {
            allocations[index].push(
              bookedDischarge(store, index, "cost_refined"),
            );
          } else if (powerW[store.key][index] > GRID_NOISE_W) {
            allocations[index].push(bookedCharge(store, index, "cost_refined"));
          }
        }
      }
      for (let index = 0; index < count; index += 1) recostSlot(index);
    }
  }

  reconcileChargeRuns();

  const importW = new Array(count).fill(0);
  const exportW = new Array(count).fill(0);
  for (let index = 0; index < count; index += 1) {
    const net = slots[index].pv_w + returnedW[index] -
      slots[index].fixed_load_w - occupiedW[index];
    if (net >= 0) {
      exportW[index] = Math.min(net, limits.grid_export_limit_w);
    } else {
      importW[index] = -net;
    }
  }

  const batteryStore = stores.find((store) => store.discharge !== undefined);
  const battery: (DispatchBatteryDiagnostic | null)[] = new Array(count).fill(
    null,
  );
  if (batteryStore?.discharge) {
    const state = stateByKey[batteryStore.key];
    const retention = retentionByKey[batteryStore.key];
    const suffixMin = suffixMinByKey[batteryStore.key];
    const suffixMax = suffixMaxByKey[batteryStore.key];
    suffixBounds(state, suffixMin, suffixMax);
    const wear = batteryStore.wear_sek_per_kwh ?? 0;
    for (let index = 0; index < count; index += 1) {
      const accepted = allocations[index].find((allocation) =>
        allocation.store_key === batteryStore.key
      );
      if (accepted) {
        battery[index] = {
          action: accepted.direction,
          reason: accepted.direction === "charge"
            ? "profitable_charge"
            : "profitable_discharge",
          state_before: state[index],
          state_after: state[index + 1],
          state_unit: batteryStore.curve.unit,
          comparison_power_w: accepted.power_w,
          power_w: accepted.power_w,
          comparison_price_sek_per_kwh: accepted.direction === "charge"
            ? accepted.energy_cost_sek_per_kwh
            : accepted.average_value_sek_per_kwh,
          stored_value_sek_per_kwh: accepted.direction === "charge"
            ? accepted.average_value_sek_per_kwh
            : accepted.energy_cost_sek_per_kwh,
          wear_cost_sek_per_kwh: accepted.wear_cost_sek_per_kwh,
          net_value_sek: accepted.net_value_sek,
        };
        continue;
      }

      if (importW[index] > 1e-9) {
        const possibleW = Math.min(
          batteryStore.discharge.max_power_w,
          importW[index],
        );
        const kwh = possibleW / 1_000 * hoursAt(batteryStore, index);
        const statePerKwh = batteryStore.discharge.state_per_kwh_out(
          state[index],
          index,
        );
        const spent = kwh * statePerKwh;
        const floor = batteryStore.min_state ?? -Infinity;
        if (suffixMin[index] - spent < floor - 1e-9) {
          battery[index] = {
            action: "hold",
            reason: state[index] <= floor + 1e-9
              ? "state_floor"
              : "future_state_constraint",
            state_before: state[index],
            state_after: state[index + 1],
            state_unit: batteryStore.curve.unit,
            comparison_power_w: possibleW,
            power_w: 0,
            comparison_price_sek_per_kwh: slots[index].import_price_sek_per_kwh,
            stored_value_sek_per_kwh: null,
            wear_cost_sek_per_kwh: wear,
            net_value_sek: null,
          };
          continue;
        }
        const heldValue = -valueOfMove(
          batteryStore.curve,
          state[index],
          state[index] - spent,
        ) / kwh * retention[index];
        battery[index] = {
          action: "hold",
          reason: "retained_value_exceeds_import",
          state_before: state[index],
          state_after: state[index + 1],
          state_unit: batteryStore.curve.unit,
          comparison_power_w: possibleW,
          power_w: 0,
          comparison_price_sek_per_kwh: slots[index].import_price_sek_per_kwh,
          stored_value_sek_per_kwh: heldValue,
          wear_cost_sek_per_kwh: wear,
          net_value_sek:
            (slots[index].import_price_sek_per_kwh - wear - heldValue) * kwh,
        };
        continue;
      }

      if (exportW[index] > 1e-9) {
        const units = batteryStore.units_per_kwh(state[index], index);
        const possibleW = Math.min(
          batteryStore.max_power_w,
          exportW[index],
          chargeRoomW(batteryStore, suffixMax[index], units, index),
        );
        if (possibleW <= 1e-9) {
          const ceiling = batteryStore.max_state ?? Infinity;
          battery[index] = {
            action: "hold",
            reason: state[index] >= ceiling - 1e-9
              ? "state_ceiling"
              : "future_state_constraint",
            state_before: state[index],
            state_after: state[index + 1],
            state_unit: batteryStore.curve.unit,
            comparison_power_w: 0,
            power_w: 0,
            comparison_price_sek_per_kwh: slots[index].export_price_sek_per_kwh,
            stored_value_sek_per_kwh: null,
            wear_cost_sek_per_kwh: wear,
            net_value_sek: null,
          };
          continue;
        }
        const kwh = possibleW / 1_000 * hoursAt(batteryStore, index);
        const after = state[index] + kwh * units;
        const storedValue = valueOfMove(
          batteryStore.curve,
          state[index],
          after,
        ) / kwh * retention[index];
        battery[index] = {
          action: "hold",
          reason: "charge_value_below_export",
          state_before: state[index],
          state_after: state[index + 1],
          state_unit: batteryStore.curve.unit,
          comparison_power_w: possibleW,
          power_w: 0,
          comparison_price_sek_per_kwh: slots[index].export_price_sek_per_kwh,
          stored_value_sek_per_kwh: storedValue,
          wear_cost_sek_per_kwh: wear,
          net_value_sek:
            (storedValue - slots[index].export_price_sek_per_kwh - wear) * kwh,
        };
        continue;
      }

      battery[index] = {
        action: "hold",
        reason: "balanced",
        state_before: state[index],
        state_after: state[index + 1],
        state_unit: batteryStore.curve.unit,
        comparison_power_w: 0,
        power_w: 0,
        comparison_price_sek_per_kwh: null,
        stored_value_sek_per_kwh: null,
        wear_cost_sek_per_kwh: wear,
        net_value_sek: null,
      };
    }
  }

  return {
    power_w: powerW,
    discharge_w: dischargeW,
    state: stateByKey,
    import_w: importW,
    export_w: exportW,
    allocations,
    battery,
    stopped_because: stopped,
    iterations,
  };
}
