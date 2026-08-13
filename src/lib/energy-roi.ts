// Return on investment for energy optimisation.
//
// REPLACES the dumb/smart `model_runs` comparison (ENERGY_OPTIMISATION_
// ARCHITECTURE.md §1.3.6). That comparison was structurally void: `scenario`
// was written to `model_runs` and never read by `simulateDeviceDay()`, so both
// sides ran the identical simulation and any difference was drift between two
// runs' inputs. §11.1 item 12 already listed the savings method as undecided.
//
// What replaces it, in order of evidence strength:
//
//  1. **Observed** — the planner's own priority-versus-baseline comparison,
//     taken from `energy_optimisation_plan_runs` for this home. Real, specific
//     to the customer, and it accumulates.
//  2. **Seasonal fixtures** (§10.1) — deliberately NOT used as the customer's
//     annual figure. They describe one synthetic reference home, and running
//     them exposed a live defect: in the autumn fixture the priority plan costs
//     ~12.8 SEK more than its own baseline over 72 hours, with both ending at
//     identical SOC, so it is not a terminal-valuation artefact. Averaging that
//     into a headline would have buried it. They are surfaced as a planner
//     diagnostic instead.
//
// TWO HONEST LIMITS, both surfaced rather than papered over:
//
//  - **Plan runs are retained 30 days** (`prune_energy_optimisation_data`), so
//    a *measured* annual saving can never be accumulated from them. The annual
//    figure here is therefore an explicit "if this rate held all year"
//    extrapolation, labelled as such, never presented as measured. A durable
//    monthly rollup is the fix and is recorded as follow-up work.
//  - **Runs are hourly over a 72-hour horizon**, so consecutive runs overlap by
//    71/72. Averaging *rates* is unbiased, but the independent sample size is
//    the number of distinct days covered, not the number of runs. We report
//    days, not runs, as the coverage measure.
//
// And the framing that matters commercially: this is a **counterfactual**, not
// a measured before-and-after. It is what the planner believes it saved against
// its own baseline, not a comparison of the house with and without the product.

import { comparePlans } from './energy-shift/plan-comparison';
import { createWebsiteDemoPlan } from './energy-shift/demo';
import type { PortalOptimisationPlan } from './energy-shift/contracts';

/** The planner's canonical look-ahead. One run covers this many days. */
export const PLAN_HORIZON_DAYS = 3;

/** Distinct days of plan runs before an observed daily rate is worth stating. */
export const MIN_DAYS_FOR_OBSERVED_RATE = 7;

export type Season = 'winter' | 'spring' | 'summer' | 'autumn';

/** Days per meteorological season, summing to 365. */
export const SEASON_DAYS: Readonly<Record<Season, number>> = {
  winter: 90,
  spring: 92,
  summer: 92,
  autumn: 91,
};

export function seasonOf(isoDate: string): Season {
  const month = Number(isoDate.slice(5, 7));
  if (month === 12 || month <= 2) return 'winter';
  if (month <= 5) return 'spring';
  if (month <= 8) return 'summer';
  return 'autumn';
}

interface PlanScenarioSummary {
  net_cost_sek?: number;
  terminal_adjusted_cost_sek?: number;
}

/** The compact per-run record stored by the ingest function. */
export interface PlanRunRow {
  issued_at: string;
  status: string;
  summary: unknown;
}

export interface ObservedSaving {
  issuedAt: string;
  day: string;
  /** (baseline − priority) terminal-adjusted cost, per day of horizon. */
  savingSekPerDay: number;
}


export interface ObservedEvidence {
  savings: ObservedSaving[];
  runs: number;
  /** Distinct local days with at least one run — the real sample size. */
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  seasons: Season[];
  medianSavingSekPerDay: number | null;
  p10SavingSekPerDay: number | null;
  p90SavingSekPerDay: number | null;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function scenarioCost(summary: unknown, key: 'priority' | 'baseline'): number | null {
  if (typeof summary !== 'object' || summary === null) return null;
  const plans = (summary as { plans?: Record<string, { summary?: PlanScenarioSummary }> }).plans;
  const scenario = plans?.[key]?.summary;
  const value = scenario?.terminal_adjusted_cost_sek ?? scenario?.net_cost_sek;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reduce stored plan runs to a per-day saving rate.
 *
 * Only `ready` runs count: an infeasible or incomplete run has no meaningful
 * cost to compare, and letting one through would quietly drag the median.
 */
export function summariseObservedSavings(rows: readonly PlanRunRow[]): ObservedEvidence {
  const savings: ObservedSaving[] = [];
  for (const row of rows) {
    if (row.status !== 'ready') continue;
    const priority = scenarioCost(row.summary, 'priority');
    const baseline = scenarioCost(row.summary, 'baseline');
    if (priority === null || baseline === null) continue;
    const day = row.issued_at.slice(0, 10);
    savings.push({
      issuedAt: row.issued_at,
      day,
      savingSekPerDay: (baseline - priority) / PLAN_HORIZON_DAYS,
    });
  }

  const days = [...new Set(savings.map(s => s.day))].sort();
  const rates = savings.map(s => s.savingSekPerDay).sort((a, b) => a - b);

  return {
    savings,
    runs: savings.length,
    days: days.length,
    firstDay: days.at(0) ?? null,
    lastDay: days.at(-1) ?? null,
    seasons: [...new Set(days.map(seasonOf))],
    medianSavingSekPerDay: rates.length > 0 ? quantile(rates, 0.5) : null,
    p10SavingSekPerDay: rates.length > 0 ? quantile(rates, 0.1) : null,
    p90SavingSekPerDay: rates.length > 0 ? quantile(rates, 0.9) : null,
  };
}

export interface SeasonalModelPoint {
  season: Season;
  savingSekPerDay: number;
  days: number;
}

export interface SeasonalPlannerCheck {
  perSeason: SeasonalModelPoint[];
  /** Seasons where the priority plan costs more than its own baseline. */
  regressions: Season[];
  /** What a year would look like if the reference home were the customer. */
  referenceAnnualSavingSek: number;
}

/**
 * Run the four canonical seasonal fixtures through the planner.
 *
 * This is a **diagnostic**, not a customer figure. The fixtures describe one
 * synthetic reference home, so the money is not the customer's. Its value is
 * `regressions`: a season where the priority plan costs more than its own
 * baseline is a planner defect, and the ROI page should show that rather than
 * average it into a reassuring annual total.
 */
export function seasonalPlannerCheck(
  referenceTime: number = Date.now(),
  makePlan: (at: number, season: Season) => PortalOptimisationPlan = createWebsiteDemoPlan,
): SeasonalPlannerCheck {
  const perSeason = (Object.keys(SEASON_DAYS) as Season[]).map((season) => {
    const plan = makePlan(referenceTime, season);
    const comparison = comparePlans(plan.plans.priority, plan.plans.baseline);
    return {
      season,
      // comparePlans is priority − baseline, so a saving is negative. Flip it
      // so the whole module speaks in "positive means money kept".
      savingSekPerDay: -comparison.terminalAdjustedCostSekDelta / PLAN_HORIZON_DAYS,
      days: SEASON_DAYS[season],
    };
  });

  return {
    perSeason,
    regressions: perSeason.filter(point => point.savingSekPerDay < 0).map(point => point.season),
    referenceAnnualSavingSek: perSeason.reduce(
      (sum, point) => sum + point.savingSekPerDay * point.days,
      0,
    ),
  };
}

export interface RoiInputs {
  observed: ObservedEvidence;
  investmentSek: number;
  monthlySubscriptionSek: number;
}

export type RoiBlocker = 'no_plan_history' | 'too_few_days' | null;

export interface RoiResult {
  /** Median observed saving per day, or null when there is not enough of it. */
  savingSekPerDay: number | null;
  observedDays: number;
  observedPeriodSavingSek: number | null;
  /**
   * The observed daily rate carried across a year.
   *
   * This is an extrapolation, not a measurement, and the UI must say so. Plan
   * history is pruned at 30 days and savings are strongly seasonal, so a rate
   * observed in one season is not a year. It is offered because a
   * clearly-labelled conditional is more useful than refusing to answer — but
   * it is never called "annual savings" without the condition attached.
   */
  annualIfSustainedSek: number | null;
  annualSubscriptionSek: number;
  netAnnualIfSustainedSek: number | null;
  /** Years to recover the investment at the observed rate, if it held. */
  paybackYearsIfSustained: number | null;
  /** Why no figure is offered, when none is. */
  blocker: RoiBlocker;
}

export function computeRoi(inputs: RoiInputs): RoiResult {
  const { observed, investmentSek, monthlySubscriptionSek } = inputs;
  const annualSubscriptionSek = monthlySubscriptionSek * 12;

  const hasRate = observed.days >= MIN_DAYS_FOR_OBSERVED_RATE
    && observed.medianSavingSekPerDay !== null;
  const savingSekPerDay = hasRate ? observed.medianSavingSekPerDay : null;

  const annualIfSustainedSek = savingSekPerDay === null ? null : savingSekPerDay * 365;
  const netAnnualIfSustainedSek = annualIfSustainedSek === null
    ? null
    : annualIfSustainedSek - annualSubscriptionSek;
  const paybackYearsIfSustained =
    netAnnualIfSustainedSek !== null && netAnnualIfSustainedSek > 0
      ? investmentSek / netAnnualIfSustainedSek
      : null;

  return {
    savingSekPerDay,
    observedDays: observed.days,
    observedPeriodSavingSek: observed.medianSavingSekPerDay !== null
      ? observed.medianSavingSekPerDay * observed.days
      : null,
    annualIfSustainedSek,
    annualSubscriptionSek,
    netAnnualIfSustainedSek,
    paybackYearsIfSustained,
    blocker: observed.days === 0 ? 'no_plan_history' : hasRate ? null : 'too_few_days',
  };
}
