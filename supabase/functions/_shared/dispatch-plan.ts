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
  /** Physical units gained per kWh delivered, at this state and slot. */
  units_per_kwh: (state: number, index: number) => number;
  /** State one slot later with no energy delivered: losses, ambient drift. */
  drift: (state: number, index: number) => number;
}

export interface DispatchLimits {
  grid_import_limit_w: number;
  grid_export_limit_w: number;
}

export interface DispatchResult {
  power_w: Record<string, number[]>;
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
  let tail = 0;
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
  from: number,
  state: number[],
): void {
  for (let index = from; index < powerW.length; index += 1) {
    const current = state[index];
    const kwh = powerW[index] / 1_000 * SLOT_HOURS;
    const gained = kwh * store.units_per_kwh(current, index);
    state[index + 1] = store.drift(current + gained, index);
  }
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
    solarW * slot.export_price_sek_per_kwh + gridW * slot.import_price_sek_per_kwh
  ) / addedW;
}

/** Power still available in a slot before the import limit binds. */
function headroomW(
  slot: DispatchSlot,
  limits: DispatchLimits,
  occupiedW: number,
): number {
  const availableW = limits.grid_import_limit_w + Math.max(0, slot.pv_w) -
    slot.fixed_load_w - occupiedW;
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
  const stateByKey: Record<string, number[]> = {};
  const retentionByKey: Record<string, number[]> = {};
  const occupiedW = new Array(count).fill(0);

  for (const store of stores) {
    powerW[store.key] = new Array(count).fill(0);
    const state = new Array(count + 1).fill(store.initial_state);
    state[0] = store.initial_state;
    project(store, powerW[store.key], 0, state);
    stateByKey[store.key] = state;
    retentionByKey[store.key] = retentionBySlot(store, count);
  }

  let iterations = 0;
  let stopped: DispatchResult["stopped_because"] = "no_profitable_candidate";

  while (iterations < maxIterations) {
    iterations += 1;
    let best: {
      store: DispatchStore;
      index: number;
      powerW: number;
      surplus: number;
    } | null = null;

    for (const store of stores) {
      const schedule = powerW[store.key];
      const state = stateByKey[store.key];
      const retention = retentionByKey[store.key];
      const minRun = Math.max(1, store.min_run_slots ?? 1);
      for (let index = 0; index < count; index += 1) {
        if (schedule[index] > 0) continue;
        const slot = slots[index];
        const fullW = Math.min(
          store.max_power_w,
          headroomW(slot, limits, occupiedW[index]),
        );
        if (fullW <= 0) continue;

        const units = store.units_per_kwh(state[index], index);
        if (units <= 0) continue;
        const value = marginalValue(store.curve, state[index]) * units *
          retention[index];
        if (value <= 0) continue;

        // Two power levels are worth evaluating, because the cost of energy is
        // a step: the free surplus is charged at the export price and anything
        // beyond it at the much dearer import price. Offering only full power
        // conflates the two and makes the planner refuse a slot whose surplus
        // alone was clearly worth taking — the case where a store is worth
        // topping up from the sun but not worth buying from the grid.
        const surplusW = Math.max(
          0,
          Math.min(fullW, slot.pv_w - slot.fixed_load_w - occupiedW[index]),
        );
        const candidatePowers = surplusW > 0 && surplusW < fullW
          ? [surplusW, fullW]
          : [fullW];

        for (const powerLevel of candidatePowers) {
          const kwh = powerLevel / 1_000 * SLOT_HOURS;
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
          if (!best || surplus > best.surplus) {
            best = { store, index, powerW: powerLevel, surplus };
          }
        }
      }
    }

    if (!best) break;

    // Apply the winning allocation, and honour a minimum run by extending
    // forward from it. Extension is deliberately not re-tested for profit: a
    // compressor that may not stop for four slots costs four slots, and
    // pretending otherwise is how a plan becomes unexecutable.
    const minRun = Math.max(1, best.store.min_run_slots ?? 1);
    const schedule = powerW[best.store.key];
    for (let offset = 0; offset < minRun; offset += 1) {
      const index = best.index + offset;
      if (index >= count || schedule[index] > 0) continue;
      const available = Math.min(
        best.powerW,
        headroomW(slots[index], limits, occupiedW[index]),
      );
      if (available <= 0) continue;
      schedule[index] = available;
      occupiedW[index] += available;
    }
    project(
      best.store,
      schedule,
      best.index,
      stateByKey[best.store.key],
    );
  }
  if (iterations >= maxIterations) stopped = "iteration_cap";

  const importW = new Array(count).fill(0);
  const exportW = new Array(count).fill(0);
  for (let index = 0; index < count; index += 1) {
    const net = slots[index].pv_w - slots[index].fixed_load_w -
      occupiedW[index];
    if (net >= 0) {
      exportW[index] = Math.min(net, limits.grid_export_limit_w);
    } else {
      importW[index] = -net;
    }
  }

  return {
    power_w: powerW,
    state: stateByKey,
    import_w: importW,
    export_w: exportW,
    stopped_because: stopped,
    iterations,
  };
}
