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

export interface DispatchStore {
  key: string;
  curve: UtilityCurve;
  /** Measured state now, in the curve's own units. */
  initial_state: number;
  max_power_w: number;
  /** Smallest executable non-zero input power. */
  min_power_w?: number;
  /** Executable power increment above `min_power_w`. */
  power_step_w?: number;
  /** Cost of starting a run: cycling wear, and lost efficiency on restart. */
  start_cost_sek?: number;
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
   * Zero restores the pure energy objective exactly.
   */
  peak_shaping_sek_per_kwh_per_kw: number;
}

export interface DispatchAllocationDiagnostic {
  store_key: string;
  direction: "charge" | "discharge";
  trigger: "economic_winner";
  allocation_order: number;
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
  /** Joint solar-to-load decisions, priced together rather than against reserve value. */
  solar_transfers?: {
    charge_index: number;
    discharge_index: number;
    charged_kwh: number;
    discharged_kwh: number;
    saving_sek: number;
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
  return store.discharge !== undefined && store.retention_per_slot === 1 &&
    store.usage_weight.every((weight) => weight === 0) &&
    (store.min_power_w ?? 0) === 0 && (store.power_step_w ?? 0) === 0 &&
    (store.start_cost_sek ?? 0) === 0;
}

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
    tail = nextWeight + decay * tail;
    retention[index] = tail;
  }
  return retention;
}

/** The physical transition before applying the store's state bounds. */
function nextState(
  store: DispatchStore,
  current: number,
  chargeW: number,
  dischargeW: number,
  index: number,
): number {
  const gained = chargeW / 1_000 * SLOT_HOURS *
    store.units_per_kwh(current, index);
  const spent = dischargeW > 0
    ? dischargeW / 1_000 * SLOT_HOURS *
      (store.discharge?.state_per_kwh_out(current, index) ?? 0)
    : 0;
  return store.drift(current + gained - spent, index);
}

/** Project a store's state through the horizon under a power schedule. */
function project(
  store: DispatchStore,
  powerW: number[],
  dischargeW: number[],
  from: number,
  state: number[],
): void {
  const low = store.min_state ?? -Infinity;
  const high = store.max_state ?? Infinity;
  for (let index = from; index < powerW.length; index += 1) {
    const next = nextState(
      store,
      state[index],
      powerW[index],
      dischargeW[index],
      index,
    );
    state[index + 1] = Math.min(high, Math.max(low, next));
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
): number {
  if (store.max_state === undefined) return Infinity;
  const roomUnits = store.max_state - highestState;
  if (roomUnits <= 0) return 0;
  return roomUnits / unitsPerKwh / SLOT_HOURS * 1_000;
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
  /**
   * The objective. **Lower is better** — it is a cost net of service delivered,
   * and it is routinely negative on a plan that delivers more than it spends.
   */
  total_sek: number;
  import_sek: number;
  /** Revenue, stated positive and subtracted from the total. */
  export_sek: number;
  peak_sek: number;
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
  const count = slots.length;
  const from = Math.max(0, range?.from ?? 0);
  const to = Math.min(count, range?.to ?? count);
  const zeros = () => new Array<number>(count).fill(0);
  const infeasibilities: DispatchInfeasibility[] = [];
  const powerByKey: Record<string, number[]> = {};
  const dischargeByKey: Record<string, number[]> = {};
  const stateByKey: Record<string, number[]> = {};

  for (const store of stores) {
    const power = (schedule.power_w[store.key] ?? zeros()).slice(0, count);
    const discharge = (schedule.discharge_w[store.key] ?? zeros()).slice(
      0,
      count,
    );
    while (power.length < count) power.push(0);
    while (discharge.length < count) discharge.push(0);
    powerByKey[store.key] = power;
    dischargeByKey[store.key] = discharge;

    // Project the trajectory unclamped so a schedule that overfills or drains a
    // store is reported rather than quietly bounded into feasibility.
    const low = store.min_state ?? -Infinity;
    const high = store.max_state ?? Infinity;
    const state = new Array<number>(count + 1).fill(store.initial_state);
    for (let index = 0; index < count; index += 1) {
      const next = nextState(
        store,
        state[index],
        power[index],
        discharge[index],
        index,
      );
      if (next < low - 1e-6 || next > high + 1e-6) {
        infeasibilities.push({
          slot: index + 1,
          store_key: store.key,
          message: `${store.key} reaches ${next.toFixed(2)} ${store.curve.unit}, outside ${low}–${high}`,
        });
      }
      state[index + 1] = Math.min(high, Math.max(low, next));
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
        Math.abs((watts - minimum) / step - Math.round((watts - minimum) / step)) >
          1e-6
      ) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message: `${store.key} draws ${
            Math.round(watts)
          } W, off its ${Math.round(step)} W increment`,
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
      occupiedW[index] += powerByKey[store.key][index];
      returnedW[index] += dischargeByKey[store.key][index];
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
    if (!store.discharge || store.discharge.export_allowed) continue;
    for (let index = 0; index < count; index += 1) {
      if (schedule.allow_export?.[index]) continue;
      if (
        dischargeByKey[store.key][index] > 1e-9 && exportW[index] > GRID_NOISE_W
      ) {
        infeasibilities.push({
          slot: index,
          store_key: store.key,
          message: `${store.key} discharges into export, which it is not permitted to do`,
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
    const importKwh = importW[index] / 1_000 * SLOT_HOURS;
    const exportKwh = exportW[index] / 1_000 * SLOT_HOURS;
    gridImportKwh += importKwh;
    gridExportKwh += exportKwh;
    const bought = importKwh * slots[index].import_price_sek_per_kwh;
    const sold = exportKwh * slots[index].export_price_sek_per_kwh;
    importSek += bought;
    peakSek += importKwh * peakSekPerKwh(limits, 0, importW[index]);
    exportSek += sold;
    if (slots[index].published_price) quotedSek += bought - sold;
  }

  const scored: DispatchScoreStore[] = [];
  let serviceValueSek = 0;
  let wearSek = 0;
  let startSek = 0;
  for (const store of stores) {
    const power = powerByKey[store.key];
    const discharge = dischargeByKey[store.key];
    const state = stateByKey[store.key];
    let storeValue = to === count
      ? (store.terminal_weight ?? 0) *
        valueOfMove(store.curve, store.initial_state, state[count])
      : 0;
    let storeWear = 0;
    let chargedKwh = 0;
    let dischargedKwh = 0;
    for (let index = from; index < to; index += 1) {
      storeValue += (store.usage_weight[index] ?? 0) *
        valueOfMove(store.curve, store.initial_state, state[index]);
      storeWear += SLOT_HOURS / 1_000 *
        ((power[index] + discharge[index]) * (store.wear_sek_per_kwh ?? 0) +
          discharge[index] *
            (store.discharge?.state_per_kwh_out(state[index], index) ?? 0) *
            (store.discharge?.cycling_cost_sek_per_unit ?? 0));
      chargedKwh += power[index] / 1_000 * SLOT_HOURS;
      dischargedKwh += discharge[index] / 1_000 * SLOT_HOURS;
    }
    const runs = runsOf(power).filter(
      (run) => run.start >= from && run.start < to,
    );
    const storeStart = runs.length * (store.start_cost_sek ?? 0);
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
    total_sek: importSek + peakSek - exportSek + startSek + wearSek -
      serviceValueSek,
    import_sek: importSek,
    export_sek: exportSek,
    peak_sek: peakSek,
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

export function planDispatch(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  options: { maxIterations?: number } = {},
): DispatchResult {
  let best = dispatchAuction(slots, stores, limits, options);
  // Selection runs through the same scorer a hand-built plan is judged by, so
  // "the planner picked this" and "this scored better" are the same claim.
  const objective = (result: DispatchResult): number =>
    scoreDispatch(slots, stores, limits, {
      power_w: result.power_w,
      discharge_w: result.discharge_w,
    }).total_sek;
  let bestCost = objective(best);
  for (const store of stores) {
    const profile = cheapestDiscreteProfile(
      slots,
      store,
      best.power_w[store.key],
      limits,
    );
    if (!profile) continue;
    // Let the battery and other stores respond to the new car schedule; keeping
    // their old allocations would reserve tomorrow's solar against moving it.
    const candidate = dispatchAuction(
      slots.map((slot, i) => ({
        ...slot,
        fixed_load_w: slot.fixed_load_w + profile[i],
      })),
      stores.filter((other) => other !== store),
      limits,
      options,
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
      const kwh = watts / 1_000 * SLOT_HOURS;
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
        cost: watts / 1_000 * SLOT_HOURS *
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
  { maxIterations = 20_000 }: { maxIterations?: number } = {},
): DispatchResult {
  const count = slots.length;
  const sellPrices = publishedSellPrices(slots);
  const powerW: Record<string, number[]> = {};
  const dischargeW: Record<string, number[]> = {};
  const stateByKey: Record<string, number[]> = {};
  const retentionByKey: Record<string, number[]> = {};
  const suffixMinByKey: Record<string, number[]> = {};
  const suffixMaxByKey: Record<string, number[]> = {};
  const occupiedW = new Array(count).fill(0);
  // Energy the stores are returning to the house, which offsets the load every
  // other candidate is costed against.
  const returnedW = new Array(count).fill(0);

  for (const store of stores) {
    powerW[store.key] = new Array(count).fill(0);
    dischargeW[store.key] = new Array(count).fill(0);
    const state = new Array(count + 1).fill(store.initial_state);
    state[0] = store.initial_state;
    project(store, powerW[store.key], dischargeW[store.key], 0, state);
    stateByKey[store.key] = state;
    retentionByKey[store.key] = retentionBySlot(store, count);
    suffixMinByKey[store.key] = new Array(count + 1);
    suffixMaxByKey[store.key] = new Array(count + 1);
  }

  let iterations = 0;
  let releasedThisRound = 0;
  let stopped: DispatchResult["stopped_because"] = "no_profitable_candidate";
  const allocations: DispatchAllocationDiagnostic[][] = Array.from(
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
  ): Candidate | null => {
    const state = stateByKey[store.key];
    const retention = retentionByKey[store.key];
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

    for (const index of indices) {
      const slot = slots[index];
      const before = candidateState;
      const units = store.units_per_kwh(before, index);
      if (units <= 0) return null;
      const kwh = powerLevel / 1_000 * SLOT_HOURS;
      const previousW = powerW[store.key][index];
      const previousKwh = previousW / 1_000 * SLOT_HOURS;
      const otherW = occupiedW[index] - previousW;
      addedKwh += kwh - previousKwh;
      const afterInput = before + kwh * units;
      if (afterInput < low - 1e-9 || afterInput > high + 1e-9) return null;
      // Drift only ever removes some of what was added — a leaky store loses
      // heat, it does not gain it — so charging the whole block raises every
      // later state by at most the total put in, and refusing on that total is
      // safe for a drifting store and exact for one that holds.
      gainedUnits += (kwh - previousKwh) * units;
      if (ceilingFrom + gainedUnits > high + 1e-9) return null;
      const retained = retention[index];
      const valueSek = valueOfMove(store.curve, before, afterInput) * retained;
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
      const costOfStart = previousPart?.start_cost_sek ?? startShare;
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
      candidateState = Math.min(
        high,
        Math.max(low, store.drift(afterInput, index)),
      );
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
    const gained = inW / 1_000 * SLOT_HOURS *
      store.units_per_kwh(before, index);
    const spent = outW > 0
      ? outW / 1_000 * SLOT_HOURS *
        (store.discharge?.state_per_kwh_out(before, index) ?? 0)
      : 0;
    const after = before + gained - spent;
    return {
      after,
      value: valueOfMove(store.curve, before, after) *
        retentionByKey[store.key][index],
    };
  };

  const partAt = (store: DispatchStore, index: number) =>
    allocations[index].find((part) => part.store_key === store.key);

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
        watts / 1_000 * SLOT_HOURS * energyCostSekPerKwh(
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
            schedule[from] / 1_000 * SLOT_HOURS * units[from],
            availableW / 1_000 * SLOT_HOURS * units[to],
          );
          if (maxUnits <= 1e-9) continue;
          const maximumW = maxUnits / units[from] / SLOT_HOURS * 1_000;
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
            const addedW = removedW * units[from] / units[to];
            const saving = sourceCosts[from] -
              chargeCost(from, schedule[from] - removedW) -
              addedW / 1_000 * SLOT_HOURS * energyCostSekPerKwh(
                  slots[to],
                  occupiedW[to],
                  addedW,
                  limits,
                  returnedW[to],
                ) +
              (removedW - addedW) / 1_000 * SLOT_HOURS * wear;
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
    const kwh = part.power_w / 1_000 * SLOT_HOURS;
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

  /** Settlement can remove the discharge that made room for a later charge,
   * or the load another discharge was supplying. Check both physical bounds
   * and the no-export contract against the changed schedule, without clamping.
   */
  const physicallyInvalid = (store: DispatchStore, index: number): boolean => {
    const inW = powerW[store.key][index];
    const outW = dischargeW[store.key][index];
    const after = nextState(store, stateByKey[store.key][index], inW, outW, index);
    if (inW > 0 && after > (store.max_state ?? Infinity) + 1e-9) return true;
    if (outW > 0 && after < (store.min_state ?? -Infinity) - 1e-9) return true;
    return outW > 0 && store.discharge?.export_allowed === false &&
      outW > gridImportW(slots[index], occupiedW[index], returnedW[index] - outW) + 1e-6;
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
          if (previousW >= store.max_power_w - 1e-6) continue;
          const adjacentRun = (schedule[index - 1] ?? 0) > 0 ||
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
                chargeRoomW(store, suffixMax[slotIndex], units),
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
                store, indices, level, startsRun,
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
            const hasSurplus = slot.pv_w > slot.fixed_load_w + occupiedW[index];
            const lowerCost = (hasSurplus
              ? Math.min(
                slot.import_price_sek_per_kwh,
                slot.export_price_sek_per_kwh,
              )
              : slot.import_price_sek_per_kwh) + (store.wear_sek_per_kwh ?? 0);
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
              const valuePerKwh = marginalValue(store.curve, state[slotIndex]) *
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
                SLOT_HOURS *
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
            const exportW = store.discharge.export_allowed
              ? Math.min(
                store.discharge.max_power_w - coverW,
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
            const statePerKwh = store.discharge.state_per_kwh_out(
              state[index],
              index,
            );
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
              const upperPrice = (store.discharge.export_allowed
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
            const previousKwh = previousW / 1_000 * SLOT_HOURS;
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
                    (powerW - loadW) * slot.export_price_sek_per_kwh) / powerW +
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
                SLOT_HOURS * 1_000;
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
              const kwh = powerLevel / 1_000 * SLOT_HOURS;
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
          if (candidate && outranks(candidate, storeBest)) storeBest = candidate;
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
          if (starvedKey === null && physicallyInvalid(store, index)) starvedKey = key;
        }
        // Resolve the run only once the scan has collected all of its slots.
        if (starvedKey !== null && starved === null) {
          starved = { store, indices: runs.get(starvedKey)!.indices };
        }
        for (const run of runs.values()) {
          if (run.net < -1e-9 && (worst === null || run.net < worst.net)) {
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
      const kwh = part.power_w / 1_000 * SLOT_HOURS;
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

  // A single charge can be blocked by tomorrow's full pack while a single
  // discharge loses to retained value. Buying surplus and serving a later load
  // TOGETHER changes neither tomorrow's pack nor terminal utility. Price that
  // transaction directly, after settlement so neither leg is released alone.
  // Check the intervening trajectory in either direction: charge before use,
  // or use existing charge before a solar refill. The suffix remains intact.
  // Each accepted transfer consumes solar or load headroom.
  type SolarTransfer = {
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
  const transferredStores = new Set<string>();
  while (iterations < maxIterations) {
    let best: SolarTransfer | null = null;
    for (const store of stores) {
      if (!supportsEnergyTransfers(store)) continue;
      const schedule = powerW[store.key];
      const discharge = dischargeW[store.key];
      const state = stateByKey[store.key];
      const flowWear = store.wear_sek_per_kwh ?? 0;
      for (let charge = 0; charge < count; charge += 1) {
        if (discharge[charge] > 0) continue;
        const availableW = Math.min(
          store.max_power_w - schedule[charge],
          slots[charge].pv_w - slots[charge].fixed_load_w - occupiedW[charge],
        );
        const units = store.units_per_kwh(state[charge], charge);
        if (availableW <= 1e-6 || units <= 0) continue;
        const room = transferRoom(
          state,
          charge,
          store.min_state ?? -Infinity,
          store.max_state ?? Infinity,
        );
        for (let load = 0; load < count; load += 1) {
          if (load === charge || schedule[load] > 0) continue;
          const importW = gridImportW(
            slots[load],
            occupiedW[load],
            returnedW[load],
          );
          const spent = store.discharge!.state_per_kwh_out(state[load], load);
          if (spent <= 0) continue;
          const stored = Math.min(
            room[load],
            availableW / 1_000 * SLOT_HOURS * units,
            Math.min(importW, store.discharge!.max_power_w - discharge[load]) /
              1_000 * SLOT_HOURS * spent,
          );
          if (stored <= 1e-9) continue;
          const maximumW = stored / spent / SLOT_HOURS * 1_000;
          const unitCost = (slots[charge].export_price_sek_per_kwh + flowWear) *
              spent / units +
            flowWear +
            (store.discharge!.cycling_cost_sek_per_unit ?? 0) * spent;
          const levels = [maximumW];
          const rate = limits.peak_shaping_sek_per_kwh_per_kw;
          if (rate > 0) {
            levels.push(
              Math.min(
                maximumW,
                importW - limits.grid_import_shaping_w -
                  Math.max(0, unitCost - slots[load].import_price_sek_per_kwh) /
                    rate * 1_000,
              ),
            );
          }
          for (const outW of levels) {
            if (outW <= 1e-6) continue;
            const inW = outW * spent / units;
            const inKwh = inW / 1_000 * SLOT_HOURS;
            const outKwh = outW / 1_000 * SLOT_HOURS;
            const cost = inKwh * slots[charge].export_price_sek_per_kwh;
            const wear = (inKwh + outKwh) * flowWear + outKwh * spent *
                (store.discharge!.cycling_cost_sek_per_unit ?? 0);
            const benefit = outKwh * (slots[load].import_price_sek_per_kwh +
              peakReliefSekPerKwh(limits, importW, outW));
            const saving = benefit - cost - wear;
            const score = saving / (outKwh * spent);
            if (saving <= 1e-9 || score <= (best?.score ?? 0) + 1e-9) continue;
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
                projected > (store.max_state ?? Infinity) + 1e-9
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
    const { store, charge, discharge, inW, outW, cost, benefit, wear, saving } =
      best;
    transferredStores.add(store.key);
    const transfer = {
      charge_index: charge,
      discharge_index: discharge,
      charged_kwh: inW / 1_000 * SLOT_HOURS,
      discharged_kwh: outW / 1_000 * SLOT_HOURS,
      saving_sek: saving,
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
      const oldKwh = (old?.power_w ?? 0) / 1_000 * SLOT_HOURS;
      const kwh = watts / 1_000 * SLOT_HOURS;
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
        wear_cost_sek_per_kwh:
          ((old?.wear_cost_sek_per_kwh ?? 0) * oldKwh + (charging ? 0 : wear)) /
          total,
        start_cost_sek: 0,
        net_value_sek: (old?.net_value_sek ?? 0) + (charging ? 0 : saving),
        run_net_value_sek: (old?.net_value_sek ?? 0) + (charging ? 0 : saving),
        solar_w: (old?.solar_w ?? 0) + (charging ? watts : 0),
        grid_w: old?.grid_w ?? 0,
        discharge_destination: charging ? null : "load",
        solar_transfers: [...(old?.solar_transfers ?? []), transfer],
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
        const kwh = possibleW / 1_000 * SLOT_HOURS;
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
          chargeRoomW(batteryStore, suffixMax[index], units),
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
        const kwh = possibleW / 1_000 * SLOT_HOURS;
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
