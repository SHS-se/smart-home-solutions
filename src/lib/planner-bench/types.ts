// Shared shapes for the planner bench (docs/planner-bench/README.md).
//
// The runner (bench/run.ts, Deno) writes these into the bench_* tables and the
// staff page reads them back, so both sides import this one definition. Pure
// data only: no React, no Deno APIs.

/**
 * One planner's 72-hour plan for one test case, as parallel arrays over its
 * quarters. Watts are quarter averages; prices are SEK/kWh.
 */
export interface BenchSeries {
  start: string[];
  hours: number[];
  /** 1 where the market published the price, 0 where the planner estimated it. */
  published: number[];
  /** What electricity really cost (referee.ts); results from before the referee hold the planner's own estimate. */
  importPrice: number[];
  exportPrice: number[];
  /** What the planner believed the import price would be; null where it gave none. */
  believedImportPrice?: (number | null)[];
  solarW: number[];
  loadW: number[];
  poolW: number[];
  hotWaterW: number[];
  carW: number[];
  gridImportW: number[];
  gridExportW: number[];
  batteryChargeW: number[];
  batteryDischargeW: number[];
  /** Percentages. */
  homeSoc: (number | null)[];
  carSoc: (number | null)[];
  /** Range in the car, km. */
  carKm?: number[];
  carConnected: number[];
  /** Pool temperature at the end of each quarter, °C; null without a pool model. */
  poolC: (number | null)[];
  /** Net grid cost of the quarter, SEK (import cost minus export revenue). */
  costSek: number[];
  /**
   * What the owner wanted and what was reachable, for scoring comfort: the
   * targets, and where each store would be at the end of every quarter if it
   * had drawn full power from the start. A comfort rule cannot fire before its
   * level was reachable.
   */
  comfort?: {
    pool_target_c: number; ev_target_km: number;
    pool_start_c: number; ev_start_km: number;
    poolReachableC: number[]; carReachableKm: number[];
  };
}

/** Per-case totals over the whole 72-hour plan. */
export interface BenchStats {
  kwh_used: number;
  grid_import_kwh: number;
  grid_export_kwh: number;
  grid_cost_sek: number;
  export_revenue_sek: number;
  pool_kwh: number;
  pool_published_kwh: number;
  pool_estimated_kwh: number;
  /** Pool energy bought in published quarters priced at or below the published 25th percentile. */
  pool_cheap_kwh: number;
  pool_heating_hours: number;
  pool_min_c: number | null;
  pool_max_c: number | null;
  pool_end_c: number | null;
  battery_charge_kwh: number;
  ev_kwh: number;
  /** Car energy planned in quarters where the car is not plugged in. */
  ev_unplugged_kwh: number;
  ev_unplugged_quarters: number;
  solar_kwh: number;
  solar_used_kwh: number;
  solar_exported_kwh: number;
  /** Average price of the energy actually imported, SEK/kWh. */
  import_price_paid: number | null;
  /** Time-average import price over the horizon, SEK/kWh. */
  import_price_mean: number;
}

export type Verdict = 'pass' | 'fail';

export interface BenchRun {
  sha: string;
  short_sha: string;
  committed_at: string;
  subject: string;
  branch: string | null;
  is_current: boolean;
  status: 'running' | 'done' | 'failed';
  error: string | null;
  finished_at: string | null;
}

export interface BenchScenario {
  id: string;
  name: string;
  captured_at: string;
  source_filename: string | null;
  criteria: CriteriaOverrides;
  notes: string | null;
  archived: boolean;
  created_at: string;
  /** The test case; null for a scenario the runner has not yet converted from its replay. */
  dataset: import('./case').BenchScenarioData | null;
  /** When the window's real prices and weather were stored; null while the case waits for them. */
  recorded_at: string | null;
  pending_reason: string | null;
}

/** What the case view loads for one result. Results from before the referee have only the series. */
export interface BenchResultDetail {
  series: BenchSeries | null;
  record: PlanRecord | null;
  outcome: Omit<import('./referee').Outcome, 'series'> | null;
}

export interface BenchResultSummary {
  sha: string;
  scenario_id: string;
  /** Which prices the planner was told and which valuation it ran under (lanes.ts). */
  lane: import('./lanes').LaneId;
  outcome: Omit<import('./referee').Outcome, 'series'> | null;
  status: 'ok' | 'error';
  error: string | null;
  stats: BenchStats | null;
  score: import('./score').StoredScore | null;
  cpu_ms: number | null;
}

export interface BenchVerdict {
  sha: string;
  scenario_id: string;
  verdict: Verdict;
  note: string | null;
}

/** Per-case changes to a default quarter rule; omitted fields keep the default. */
export interface CriterionOverride {
  enabled?: boolean;
  threshold?: number;
  /** Signed points the rule adds to a quarter, -2..+2. */
  points?: number;
}
export type CriteriaOverrides = Record<string, CriterionOverride>;

export type ValuationSupport = 'scale' | 'urgency_only' | 'none';

/** A value curve a planner actually planned with, as it reported it. */
export interface UsedCurve {
  store: string;
  unit: string | null;
  points: { at: number; sek_per_unit: number }[];
  initial_state: number | null;
  max_state: number | null;
  /** Units of the store one kWh of electricity buys at the start. */
  units_per_kwh: number | null;
  reference_sek_per_kwh: number | null;
  /** How the planner made it: its own word for the method, e.g. "balanced". */
  mode: string | null;
  /** The planner's own account of the derivation, when it gave one. */
  derivation?: Record<string, number | string>;
}

/** What one planner version did with one test case: the bench's stored truth for a result. */
export interface PlanRecord {
  /** The planner's own verdict on its plan, e.g. "ready". */
  status: string;
  /** Which input generation the adapter built for this planner (bench/adapter.ts). */
  generation: string;
  /**
   * The valuation scale the lane asked for, and how this planner generation
   * could honour it per store: `scale` multiplies the derived curve exactly;
   * `urgency_only` raises or lowers only the part of the curve below target;
   * `none` means the planner has no handle and ran as nominal.
   */
  valuation: { scale: number; pool: ValuationSupport; ev: ValuationSupport; battery: ValuationSupport };
  decisions: import('./referee').Decisions;
  /** The planner's own estimates, kept beside the referee's account. */
  beliefs: { import_sek_per_kwh: (number | null)[]; grid_cost_sek: number | null };
  /** Empty when the planner version did not report its curves. */
  curves: UsedCurve[];
}
