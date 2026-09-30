// Shared shapes for the planner bench (docs/planner-bench/README.md).
//
// The runner (bench/run.ts, Deno) writes these into the bench_* tables and the
// staff page reads them back, so both sides import this one definition. Pure
// data only: no React, no Deno APIs.

/** What the planner needs from a replay file, and nothing else. */
export interface BenchInput {
  /** `entrypoint.arguments` of an `shs-energy-optimisation-quarter-replay`. */
  snapshot: Record<string, unknown> & { captured_at: string; timezone?: string };
  now: string;
  price_archive: unknown[];
  resolved_price_outlook?: unknown;
}

/**
 * One planner's 72-hour plan for one test case, as parallel arrays over its
 * quarters. Watts are quarter averages; prices are SEK/kWh.
 */
export interface BenchSeries {
  start: string[];
  hours: number[];
  /** 1 where the market published the price, 0 where the planner estimated it. */
  published: number[];
  importPrice: number[];
  exportPrice: number[];
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
  carConnected: number[];
  /** Pool temperature at the end of each quarter, °C; null without a pool model. */
  poolC: (number | null)[];
  /** Net grid cost of the quarter, SEK (import cost minus export revenue). */
  costSek: number[];
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
}

export interface BenchResultSummary {
  sha: string;
  scenario_id: string;
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
