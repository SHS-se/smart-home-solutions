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
  marginalValueHeld,
  type UtilityCurve,
  valueOfMove,
} from "./store-value.ts";

export const SLOT_HOURS = 0.25;

export interface DispatchSlot {
  pv_w: number;
  /** Base load plus anything not being scheduled here. */
  fixed_load_w: number;
  import_price_sek_per_kwh: number;
  export_price_sek_per_kwh: number;
}

export interface DispatchStore {
  key: string;
  curve: UtilityCurve;
  /** Measured state now, in the curve's own units. */
  initial_state: number;
  max_power_w: number;
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

export interface DispatchResult {
  power_w: Record<string, number[]>;
  /** Energy returned to the house, per store. Zero for a pure sink. */
  discharge_w: Record<string, number[]>;
  state: Record<string, number[]>;
  import_w: number[];
  export_w: number[];
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
 * Allocate energy to the stores that value it above its cost.
 *
 * Greedy on the best (value − cost) surplus across every store and every slot
 * at once. Greedy is not a shortcut here: with concave utility, the highest
 * marginal bid is always the right next allocation, and taking them in that
 * order is what lets a cheap sunny slot two days out lose to an expensive slot
 * today when the store needs the energy sooner — or win when it does not.
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
  type Candidate = {
    store: DispatchStore;
    index: number;
    powerW: number;
    surplus: number;
    direction: "charge" | "discharge";
  };
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
        if (cached && (!best || cached.surplus > best.surplus)) best = cached;
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
        const slot = slots[index];

        const units = store.units_per_kwh(state[index], index);
        if (units <= 0) continue;
        const fullW = Math.min(
          store.max_power_w,
          headroomW(slot, limits, occupiedW[index], returnedW[index]),
          chargeRoomW(store, suffixMax[index], units),
        );
        if (fullW <= 0) continue;
        // Candidate levels stop at both kinds of economic boundary: where free
        // surplus turns into grid import, and—on a terminal store—where the
        // marginal value changes. Without the curve boundaries a 0.25 kWh
        // price spike could only bid for a full 1.25 kWh battery interval;
        // valuing that whole interval at its first kWh caused a charge/discharge
        // cycle through the cheap band and filled the pack from the grid.
        const surplusW = Math.max(
          0,
          Math.min(fullW, slot.pv_w - slot.fixed_load_w - occupiedW[index]),
        );
        const candidatePowers = [fullW];
        if (surplusW > 0 && surplusW < fullW) candidatePowers.push(surplusW);
        if ((store.terminal_weight ?? 0) > 0) {
          for (const point of store.curve.points) {
            const toPointW = (point.at - state[index]) / units / SLOT_HOURS *
              1_000;
            if (
              toPointW > 1e-9 && toPointW < fullW - 1e-9 &&
              Math.abs(toPointW - surplusW) > 1e-9
            ) {
              candidatePowers.push(toPointW);
            }
          }
        }

        for (const powerLevel of candidatePowers) {
          const kwh = powerLevel / 1_000 * SLOT_HOURS;
          const value = (store.terminal_weight ?? 0) > 0
            ? valueOfMove(
              store.curve,
              state[index],
              state[index] + kwh * units,
            ) / kwh * retention[index]
            : marginalValue(store.curve, state[index]) * units *
              retention[index];
          if (value <= 0) continue;
          let cost = energyCostSekPerKwh(slot, occupiedW[index], powerLevel) +
            (store.wear_sek_per_kwh ?? 0);
          // Starting a run costs something real, so an isolated slot has to
          // clear a higher bar than extending one. Without this the planner
          // would chatter a compressor on and off all afternoon.
          const startsRun = (schedule[index - 1] ?? 0) <= 0 &&
            (schedule[index + 1] ?? 0) <= 0;
          if (startsRun && store.start_cost_sek) {
            cost += store.start_cost_sek / Math.max(kwh * minRun, 1e-9);
          }
          const surplus = (value - cost) * kwh;
          if (surplus <= 1e-9) continue;
          if (!storeBest || surplus > storeBest.surplus) {
            storeBest = {
              store,
              index,
              powerW: powerLevel,
              surplus,
              direction: "charge",
            };
          }
        }
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
          for (
            const [powerLevel, price] of [
              [coverW, slot.import_price_sek_per_kwh] as const,
              [coverW + exportW, slot.export_price_sek_per_kwh] as const,
            ]
          ) {
            if (powerLevel <= 0) continue;
            const kwh = powerLevel / 1_000 * SLOT_HOURS;
            const spent = kwh *
              store.discharge.state_per_kwh_out(state[index], index);
            // Feasible only if the lowest state still to come can absorb it.
            if (
              store.min_state !== undefined &&
              suffixMin[index] - spent < store.min_state - 1e-9
            ) continue;
            // The sell side of the curve: what the charge being given up is
            // worth, not what the next unit would be worth to buy.
            const givenUp = (store.terminal_weight ?? 0) > 0
              ? -valueOfMove(
                store.curve,
                state[index],
                state[index] - spent,
              ) / kwh * retention[index]
              : marginalValueHeld(store.curve, state[index]) *
                (spent / Math.max(kwh, 1e-9)) * retention[index];
            const gained = price - (store.wear_sek_per_kwh ?? 0);
            const surplus = (gained - givenUp) * kwh;
            if (surplus <= 1e-9) continue;
            if (!storeBest || surplus > storeBest.surplus) {
              storeBest = {
                store,
                index,
                powerW: powerLevel,
                surplus,
                direction: "discharge",
              };
            }
          }
        }
      }
      cachedBestByStore.set(store.key, storeBest);
      if (storeBest && (!best || storeBest.surplus > best.surplus)) {
        best = storeBest;
      }
    }

    if (!best) break;

    // Apply the winning allocation, and honour a minimum run by extending
    // forward from it. Extension is deliberately not re-tested for profit: a
    // compressor that may not stop for four slots costs four slots, and
    // pretending otherwise is how a plan becomes unexecutable.
    const schedule = powerW[best.store.key];
    const discharge = dischargeW[best.store.key];
    const changedIndices: number[] = [];
    if (best.direction === "discharge") {
      // Discharge is applied one slot at a time: there is no compressor to
      // protect, and holding a battery open for a minimum run would forfeit
      // charge the next slot might value more.
      discharge[best.index] = best.powerW;
      returnedW[best.index] += best.powerW;
      changedIndices.push(best.index);
    } else {
      const minRun = Math.max(1, best.store.min_run_slots ?? 1);
      for (let offset = 0; offset < minRun; offset += 1) {
        const index = best.index + offset;
        if (index >= count || schedule[index] > 0) continue;
        if (discharge[index] > 0) continue;
        const available = Math.min(
          best.powerW,
          headroomW(slots[index], limits, occupiedW[index], returnedW[index]),
        );
        if (available <= 0) continue;
        schedule[index] = available;
        occupiedW[index] += available;
        changedIndices.push(index);
      }
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
        (cached !== null && cached !== undefined && changed.has(cached.index))
      ) {
        cachedBestByStore.delete(store.key);
      }
    }
  }
  if (iterations >= maxIterations) stopped = "iteration_cap";

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

  return {
    power_w: powerW,
    discharge_w: dischargeW,
    state: stateByKey,
    import_w: importW,
    export_w: exportW,
    stopped_because: stopped,
    iterations,
  };
}
