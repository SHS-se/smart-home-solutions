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

import { type UtilityCurve, valueOfMove } from "./store-value.ts";

export const SLOT_HOURS = 0.25;

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
  /** Slots a run must last once started. Compressor protection, not taste. */
  min_run_slots?: number;
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
  };
}

export interface DispatchLimits {
  grid_import_limit_w: number;
  grid_export_limit_w: number;
}

export interface DispatchAllocationDiagnostic {
  store_key: string;
  direction: "charge" | "discharge";
  trigger: "economic_winner" | "minimum_run_continuation";
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
  stopped_because: "no_profitable_candidate" | "iteration_cap";
  iterations: number;
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
    const current = state[index];
    const inKwh = powerW[index] / 1_000 * SLOT_HOURS;
    const outKwh = dischargeW[index] / 1_000 * SLOT_HOURS;
    const gained = inKwh * store.units_per_kwh(current, index);
    const spent = outKwh > 0
      ? outKwh * (store.discharge?.state_per_kwh_out(current, index) ?? 0)
      : 0;
    const next = store.drift(current + gained - spent, index);
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
): number {
  if (addedW <= 0) return 0;
  const surplusW = Math.max(0, slot.pv_w - slot.fixed_load_w - occupiedW);
  const solarW = Math.min(addedW, surplusW);
  const gridW = addedW - solarW;
  return (
    solarW * slot.export_price_sek_per_kwh +
    gridW * slot.import_price_sek_per_kwh
  ) / addedW;
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
function sellLegIsPublished(
  slots: DispatchSlot[],
  index: number,
  roundTrip: number,
): boolean {
  if (slots[index].binding !== true) return true;
  const needed = slots[index].import_price_sek_per_kwh / Math.max(1e-9, roundTrip);
  for (let ahead = index + 1; ahead < slots.length; ahead += 1) {
    if (slots[ahead].published_price !== true) continue;
    if (slots[ahead].import_price_sek_per_kwh > needed) return true;
  }
  return false;
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
 */
export function planDispatch(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  { maxIterations = 20_000 }: { maxIterations?: number } = {},
): DispatchResult {
  const count = slots.length;
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

  const executablePowerLevels = (
    store: DispatchStore,
    rawLevels: number[],
    maximumW: number,
  ): number[] => {
    const minimumW = Math.max(0, store.min_power_w ?? 0);
    const stepW = Math.max(0, store.power_step_w ?? 0);
    const levels = new Set<number>();
    // A discrete charger can be optimal at any supported current between a
    // curve/source breakpoint and full power. Testing only the rounded
    // breakpoint and the maximum skipped those intermediate executable bids.
    if (stepW > 0 && maximumW + 1e-9 >= minimumW) {
      for (let level = minimumW; level <= maximumW + 1e-9; level += stepW) {
        const rounded = Math.round(level * 1e6) / 1e6;
        if (rounded > 1e-9 && rounded <= maximumW + 1e-9) levels.add(rounded);
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
        levels.add(level);
      }
    }
    return [...levels];
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

    for (const [offset, index] of indices.entries()) {
      const slot = slots[index];
      const before = candidateState;
      const units = store.units_per_kwh(before, index);
      if (units <= 0) return null;
      const kwh = powerLevel / 1_000 * SLOT_HOURS;
      const afterInput = before + kwh * units;
      if (afterInput < low - 1e-9 || afterInput > high + 1e-9) return null;
      const retained = retention[index];
      const valueSek = valueOfMove(store.curve, before, afterInput) * retained;
      const valuePerKwh = valueSek / kwh;
      const sourceCost = energyCostSekPerKwh(
        slot,
        occupiedW[index],
        powerLevel,
      );
      const surplusW = Math.max(
        0,
        slot.pv_w - slot.fixed_load_w - occupiedW[index],
      );
      const solarW = Math.min(powerLevel, surplusW);
      const gridW = powerLevel - solarW;
      const netSek = (valuePerKwh - sourceCost - wear) * kwh - startShare;
      parts.push({
        store_key: store.key,
        direction: "charge",
        trigger: offset === 0 ? "economic_winner" : "minimum_run_continuation",
        allocation_order: 0,
        run_start_index: indices[0],
        run_slots: indices.length,
        power_w: powerLevel,
        state_before: before,
        state_after: afterInput,
        state_unit: store.curve.unit,
        retention_factor: retained,
        average_value_sek_per_kwh: valuePerKwh,
        energy_cost_sek_per_kwh: sourceCost,
        wear_cost_sek_per_kwh: wear,
        start_cost_sek: startShare,
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

    const surplus = parts.reduce(
      (total, part) => total + part.net_value_sek,
      0,
    );
    if (surplus <= 1e-9) return null;
    for (const part of parts) part.run_net_value_sek = surplus;
    return {
      store,
      index: indices[0],
      indices,
      surplus,
      score: surplus / parts.reduce(
        (total, part) => total + part.power_w / 1_000 * SLOT_HOURS,
        0,
      ),
      direction: "charge",
      parts,
    };
  };
  const outranks = (candidate: Candidate, incumbent: Candidate | null) =>
    incumbent === null || candidate.score > incumbent.score + 1e-12 ||
    (Math.abs(candidate.score - incumbent.score) <= 1e-12 &&
      candidate.surplus > incumbent.surplus);
  // A winning allocation changes its own future state, but it does not change
  // another pure sink's candidates outside the occupied slot. Retain those
  // unaffected per-store winners instead of rescanning every store across all
  // 288 quarters after each allocation.
  const cachedBestByStore = new Map<string, Candidate | null>();

  while (iterations < maxIterations) {
    iterations += 1;
    let best: Candidate | null = null;

    for (const store of stores) {
      if (cachedBestByStore.has(store.key)) {
        const cached = cachedBestByStore.get(store.key);
        if (cached && outranks(cached, best)) best = cached;
        continue;
      }
      let storeBest: Candidate | null = null;
      const schedule = powerW[store.key];
      const dischargeByKey = dischargeW[store.key];
      const state = stateByKey[store.key];
      const retention = retentionByKey[store.key];
      const minRun = Math.max(1, store.min_run_slots ?? 1);
      // Both directions read the same suffix extremes: charging is bounded by
      // the highest state still to come, discharging by the lowest.
      const suffixMin = suffixMinByKey[store.key];
      const suffixMax = suffixMaxByKey[store.key];
      suffixBounds(state, suffixMin, suffixMax);
      for (let index = 0; index < count; index += 1) {
        // A slot already committed to discharge must not also charge. Only the
        // discharge side used to check this, so whichever direction won the
        // auction first could be joined by the other in the same slot — the
        // plan then bought energy at the import price and paid the round trip
        // to push it through the battery for nothing.
        if (schedule[index] > 0 || dischargeByKey[index] > 0) continue;
        const adjacentRun = (schedule[index - 1] ?? 0) > 0 ||
          (schedule[index + 1] ?? 0) > 0;
        const startsRun = minRun > 1 && !adjacentRun;
        const indices = startsRun
          ? Array.from({ length: minRun }, (_, offset) => index + offset)
          : [index];
        if (
          indices.at(-1)! >= count ||
          indices.some((slotIndex) =>
            schedule[slotIndex] > 0 || dischargeByKey[slotIndex] > 0
          )
        ) continue;

        // Only a store that sells its charge back is doing arbitrage. A pool
        // buys warmth and a car buys range; neither is betting on a price.
        const roundTrip = store.discharge
          ? store.units_per_kwh(state[index], index) /
            Math.max(1e-9, store.discharge.state_per_kwh_out(state[index], index))
          : 0;
        const fullW = Math.min(
          store.max_power_w,
          ...indices.map((slotIndex) => {
            const units = store.units_per_kwh(state[slotIndex], slotIndex);
            if (units <= 0) return 0;
            const slot = slots[slotIndex];
            const gridBarred = store.discharge !== undefined &&
              !sellLegIsPublished(slots, slotIndex, roundTrip);
            return Math.min(
              headroomW(
                slot,
                limits,
                occupiedW[slotIndex],
                returnedW[slotIndex],
              ),
              chargeRoomW(store, suffixMax[slotIndex], units),
              // Barred from the grid, it may still take what the roof is
              // giving away: that energy costs no committed money.
              gridBarred
                ? Math.max(
                  0,
                  slot.pv_w - slot.fixed_load_w - occupiedW[slotIndex],
                )
                : Infinity,
            );
          }),
        );
        if (fullW <= 0) continue;
        // Candidate levels stop wherever either the source cost or the curve
        // changes. This applies to every store: valuing an 11 kW EV quarter or
        // a four-quarter pool run at the first infinitesimal unit is precisely
        // the defect an integral utility curve exists to prevent.
        const rawPowers = [fullW, store.min_power_w ?? 0];
        for (const slotIndex of indices) {
          const surplusW = Math.max(
            0,
            Math.min(
              fullW,
              slots[slotIndex].pv_w - slots[slotIndex].fixed_load_w -
                occupiedW[slotIndex],
            ),
          );
          if (surplusW > 0 && surplusW < fullW) rawPowers.push(surplusW);
          const units = store.units_per_kwh(state[slotIndex], slotIndex);
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
          const candidate = chargeCandidate(
            store,
            indices,
            powerLevel,
            startsRun,
          );
          // Power levels in one slot are alternatives, not separate bids: the
          // charger cannot first win 5 A and then add 1 A after the slot has
          // been locked. Choose the executable level with the greatest total
          // welfare here, then compare that action with other slots/stores by
          // welfare per kWh.
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
        if (slotBest && outranks(slotBest, storeBest)) storeBest = slotBest;
      }

      // Discharge is the same comparison with the signs exchanged: the value is
      // the import it avoids, and the cost is the stored energy given up. Making
      // it a candidate in the same auction is the point — a battery that would
      // rather keep its charge simply loses to the sinks, and one whose charge is
      // worth less than tonight's import price wins.
      if (store.discharge) {
        for (let index = 0; index < count; index += 1) {
          if (schedule[index] > 0 || dischargeByKey[index] > 0) continue;
          const slot = slots[index];
          const deficitW = Math.max(
            0,
            slot.fixed_load_w + occupiedW[index] - slot.pv_w - returnedW[index],
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
          const rawLevels = [coverW, maximumW];
          const statePerKwh = store.discharge.state_per_kwh_out(
            state[index],
            index,
          );
          for (const point of store.curve.points) {
            const toPointW = (state[index] - point.at) / statePerKwh /
              SLOT_HOURS * 1_000;
            if (toPointW > 1e-9 && toPointW < maximumW - 1e-9) {
              rawLevels.push(toPointW);
            }
          }
          const dischargeLevels = [
            ...new Set(rawLevels.map((level) => Math.round(level * 1e6) / 1e6)),
          ].filter((level) => level > 1e-9);
          let slotBest: Candidate | null = null;
          for (const powerLevel of dischargeLevels) {
            if (powerLevel <= 0) continue;
            const loadW = Math.min(powerLevel, coverW);
            const toExportW = powerLevel - loadW;
            const price = (
              loadW * slot.import_price_sek_per_kwh +
              toExportW * slot.export_price_sek_per_kwh
            ) / powerLevel;
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
              suffixMin[index] - spent < store.min_state - 1e-9
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
            const surplus = (gained - givenUp) * kwh;
            if (surplus <= 1e-9) continue;
            const candidate: Candidate = {
              store,
              index,
              indices: [index],
              surplus,
              score: surplus / kwh,
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
                net_value_sek: surplus,
                run_net_value_sek: surplus,
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
          if (slotBest && outranks(slotBest, storeBest)) storeBest = slotBest;
        }
      }
      cachedBestByStore.set(store.key, storeBest);
      if (storeBest && outranks(storeBest, best)) {
        best = storeBest;
      }
    }

    if (!best) break;

    // Apply exactly the candidate that won. A new compressor run reached this
    // point only after the complete block cleared its complete cost; no
    // unevaluated continuation is appended here.
    const schedule = powerW[best.store.key];
    const discharge = dischargeW[best.store.key];
    const changedIndices: number[] = [];
    for (const [partIndex, part] of best.parts.entries()) {
      const index = best.indices[partIndex];
      part.allocation_order = iterations;
      allocations[index].push(part);
      if (best.direction === "discharge") {
        discharge[index] = part.power_w;
        returnedW[index] += part.power_w;
      } else {
        schedule[index] = part.power_w;
        occupiedW[index] += part.power_w;
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
    const changed = new Set(changedIndices);
    for (const store of stores) {
      const cached = cachedBestByStore.get(store.key);
      if (
        store.key === best.store.key || best.direction === "discharge" ||
        // A sink that starts charging can create a new discharge opportunity
        // in that slot even when the battery's previous winner was elsewhere.
        store.discharge !== undefined ||
        (cached !== null && cached !== undefined &&
          cached.indices.some((index) => changed.has(index)))
      ) {
        cachedBestByStore.delete(store.key);
      }
    }
  }
  if (iterations >= maxIterations) stopped = "iteration_cap";

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
  // removal happens here: releasing a charge lowers the states after it, which
  // raises what the remaining energy is worth, so nothing is made worse by
  // settling and the pass terminates.
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
    const spareW = Math.max(
      0,
      slot.pv_w + returnedW[index] - slot.fixed_load_w,
    );
    const solarShare = Math.min(1, spareW / chargeW);
    for (const part of charges) {
      part.solar_w = part.power_w * solarShare;
      part.grid_w = part.power_w - part.solar_w;
      part.energy_cost_sek_per_kwh =
        (part.solar_w * slot.export_price_sek_per_kwh +
          part.grid_w * slot.import_price_sek_per_kwh) / part.power_w;
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
      ? value - (part.energy_cost_sek_per_kwh + wear) * kwh - part.start_cost_sek
      : value + (part.average_value_sek_per_kwh - wear) * kwh;
  };

  /**
   * A charge block too short for the compressor that has to run it.
   *
   * The auction only ever starts a run at its full minimum length and then
   * grows it a slot at a time, so each extension records itself as its own
   * one-slot run. Releasing by that record can cut a contiguous block in half
   * and strand the remainder: a deployed plan scheduled the pool heat pump for
   * a single quarter at 04:30 against a four-quarter minimum. Contiguity is
   * what the contract is about, so contiguity is what has to be repaired.
   */
  const shortBlock = (store: DispatchStore): number[] | null => {
    const minRun = Math.max(1, store.min_run_slots ?? 1);
    if (minRun <= 1) return null;
    let block: number[] = [];
    for (let index = 0; index <= count; index += 1) {
      if (index < count && powerW[store.key][index] > 0) {
        block.push(index);
        continue;
      }
      if (block.length > 0 && block.length < minRun) return block;
      block = [];
    }
    return null;
  };

  /** A discharge the released charge can no longer supply is not a price call. */
  const overdrawn = (store: DispatchStore, index: number): boolean => {
    const low = store.min_state;
    if (low === undefined) return false;
    const outW = dischargeW[store.key][index];
    if (outW <= 0) return false;
    return movedValue(store, index, powerW[store.key][index], outW).after <
      low - 1e-9;
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
    project(store, powerW[store.key], dischargeW[store.key], 0, stateByKey[store.key]);
  };

  // Every store settles in the same loop, because releasing one store's charge
  // frees surplus that re-prices another's in the same quarter. Settling them
  // one after another would leave whichever went first holding a price the
  // rest of the pass had already moved.
  //
  // A minimum-run block cleared its cost as a block and is released as one, or
  // the schedule would keep a compressor start it no longer pays for.
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
    let stranded: { store: DispatchStore; indices: number[] } | null = null;
    let worst: { store: DispatchStore; indices: number[]; net: number } | null =
      null;
    for (const store of stores) {
      if (stranded === null) {
        const block = shortBlock(store);
        if (block !== null) stranded = { store, indices: block };
      }
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
        if (starvedKey === null && overdrawn(store, index)) starvedKey = key;
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
    // Neither an unsupplied discharge nor a run the hardware cannot execute is
    // a price call, so both go before anything that is merely unprofitable.
    const target = starved ?? stranded ?? worst;
    if (target === null) break;
    releaseRun(target.store, target.indices);
  }

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
          wear_cost_sek_per_kwh: wear,
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
