/** Numeric starting estimates for a NEW solve, separate from retry checkpoints. */
export type StoreKey = "battery" | "ev" | "pool";
export const STORE_KEYS: readonly StoreKey[] = ["battery", "ev", "pool"];
export interface Quarter {
  /** Canonical ISO quarter address from resolved planning inputs. */
  readonly start: string;
  readonly hours: number;
  /** Current market/forecast baseline. Never imported from an earlier plan. */
  readonly basePrice: number;
  readonly importPrice: number;
  readonly exportPrice: number;
}
export interface ValueSeed {
  readonly layout: string;
  readonly model: string;
  readonly economics: string;
  /** One value row per quarter, excluding terminal boundary. */
  readonly rows: readonly (readonly number[])[];
}
export interface ReplanProblem {
  readonly home: string;
  readonly algorithm: string;
  readonly resources: string;
  readonly quarters: readonly Quarter[];
  readonly stores: Readonly<Record<StoreKey, ValueSeed>>;
}
export interface SelectedEstimates extends ReplanProblem {
  readonly selectedRound: number;
  /** Prices and tables from the SELECTED solve, not the last attempted round. */
  readonly prices: readonly number[];
}
export interface ReplanStart {
  prices: number[];
  values: Record<StoreKey, number[][]>;
  alignedQuarters: number;
  priceRowsReused: number;
  priceReason:
    | "fresh"
    | "aligned"
    | "resources_changed"
    | "economics_changed"
    | "model_changed";
  stores: Record<StoreKey, {
    reusedRows: number;
    reason:
      | "fresh"
      | "aligned"
      | "model_changed"
      | "economics_changed"
      | "layout_changed";
  }>;
}

/**
 * Rebase the prior market-price position and separate scarcity premium; copy compatible
 * value rows as guesses. No preferences, measurements, constraints or schedule
 * are copied. New terminal boundaries must be supplied by the current solver.
 */
export function prepareReplanStart(
  problem: ReplanProblem,
  previous: SelectedEstimates | null,
): ReplanStart {
  if (previous && previous.home !== problem.home) {
    throw new Error("Cannot seed a different home");
  }
  if (previous && previous.algorithm !== problem.algorithm) {
    throw new Error("Unsupported warm-start algorithm");
  }
  if (previous && previous.prices.length !== previous.quarters.length) {
    throw new Error("Price estimate shape mismatch");
  }
  const oldIndex = new Map(
    previous?.quarters.map((quarter, index) => [quarter.start, index]) ?? [],
  );
  const matches = problem.quarters.map((quarter) => {
    const index = oldIndex.get(quarter.start);
    return index !== undefined &&
        previous!.quarters[index].hours === quarter.hours
      ? index
      : undefined;
  });
  // Resource premiums encode competition under all service preferences. A
  // changed objective/model needs current price initialization for the household.
  const priceReason: ReplanStart["priceReason"] = !previous
    ? "fresh"
    : previous.resources !== problem.resources
    ? "resources_changed"
    : STORE_KEYS.some((key) =>
        previous.stores[key].economics !== problem.stores[key].economics
      )
    ? "economics_changed"
    : STORE_KEYS.some((key) =>
        previous.stores[key].model !== problem.stores[key].model
      )
    ? "model_changed"
    : "aligned";
  const prices = problem.quarters.map((quarter, index) => {
    const before = matches[index];
    if (
      ![quarter.basePrice, quarter.importPrice, quarter.exportPrice].every(
        Number.isFinite,
      )
    ) throw new Error("Non-finite price estimate");
    if (before === undefined || priceReason !== "aligned") {
      return quarter.basePrice;
    }
    const old = previous!.quarters[before], price = previous!.prices[before];
    if (![price, old.importPrice, old.exportPrice].every(Number.isFinite)) {
      throw new Error("Non-finite price estimate");
    }
    const market = Math.max(
      Math.min(old.importPrice, old.exportPrice),
      Math.min(Math.max(old.importPrice, old.exportPrice), price),
    );
    // The old import/export spread is not a resource premium. Carry its relative
    // market position into today's spread, then add only the separate premium.
    // A former equal-price market has no inferred position: use a neutral guess.
    const fraction = old.importPrice === old.exportPrice
      ? .5
      : (market - old.exportPrice) / (old.importPrice - old.exportPrice);
    // Delta form preserves the estimate exactly when the tariffs are unchanged.
    return price + (1 - fraction) * (quarter.exportPrice - old.exportPrice) +
      fraction * (quarter.importPrice - old.importPrice);
  });
  const seedStore = (key: StoreKey) => {
    const current = problem.stores[key], before = previous?.stores[key];
    if (current.rows.length !== problem.quarters.length) {
      throw new Error(`${key}: value estimate shape mismatch`);
    }
    let reason: ReplanStart["stores"][StoreKey]["reason"] = "fresh";
    if (before) {
      if (before.rows.length !== previous!.quarters.length) {
        throw new Error(`${key}: previous value estimate shape mismatch`);
      }
      reason = before.economics !== current.economics
        ? "economics_changed"
        : before.model !== current.model
        ? "model_changed"
        : before.layout !== current.layout
        ? "layout_changed"
        : "aligned";
    }
    let reusedRows = 0;
    const rows = current.rows.map((row, index) => {
      const old = matches[index];
      const reuse = reason === "aligned" && old !== undefined;
      const source = reuse ? before!.rows[old] : row;
      if (
        source.length !== row.length ||
        source.some((value) => !Number.isFinite(value))
      ) throw new Error(`${key}: invalid value row`);
      if (reuse) reusedRows++;
      return [...source];
    });
    return { rows, diagnostics: { reusedRows, reason } };
  };
  const battery = seedStore("battery"),
    ev = seedStore("ev"),
    pool = seedStore("pool");
  return {
    prices,
    values: { battery: battery.rows, ev: ev.rows, pool: pool.rows },
    alignedQuarters: matches.filter((index) => index !== undefined).length,
    priceRowsReused: priceReason === "aligned"
      ? matches.filter((index) => index !== undefined).length
      : 0,
    priceReason,
    stores: {
      battery: battery.diagnostics,
      ev: ev.diagnostics,
      pool: pool.diagnostics,
    },
  };
}
