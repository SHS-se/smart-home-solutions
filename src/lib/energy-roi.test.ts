/// <reference lib="deno.ns" />

import {
  computeRoi,
  MIN_DAYS_FOR_OBSERVED_RATE,
  seasonalPlannerCheck,
  PLAN_HORIZON_DAYS,
  SEASON_DAYS,
  seasonOf,
  summariseObservedSavings,
  type PlanRunRow,
} from './energy-roi.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ~${expected}, got ${actual}`);
  }
}

function run(issuedAt: string, priority: number, baseline: number, status = 'ready'): PlanRunRow {
  return {
    issued_at: issuedAt,
    status,
    summary: {
      plans: {
        priority: { summary: { terminal_adjusted_cost_sek: priority } },
        baseline: { summary: { terminal_adjusted_cost_sek: baseline } },
      },
    },
  };
}

/** N hourly runs across `days` days, each saving the same amount per horizon. */
function hourlyRuns(days: number, savingPerHorizon: number): PlanRunRow[] {
  const rows: PlanRunRow[] = [];
  for (let day = 0; day < days; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + day, hour));
      rows.push(run(date.toISOString(), 10, 10 + savingPerHorizon));
    }
  }
  return rows;
}

Deno.test('a saving is baseline minus priority, spread over the horizon', () => {
  const evidence = summariseObservedSavings([run('2026-01-15T10:00:00Z', 40, 55)]);
  assertEqual(evidence.runs, 1, 'runs');
  near(evidence.savings[0].savingSekPerDay, 15 / PLAN_HORIZON_DAYS, 1e-9, 'daily rate');
});

Deno.test('a plan that costs more than baseline is a negative saving, not zero', () => {
  const evidence = summariseObservedSavings([run('2026-01-15T10:00:00Z', 60, 55)]);
  assert((evidence.medianSavingSekPerDay ?? 0) < 0, 'negative saving is reported honestly');
});

Deno.test('coverage is counted in days, not overlapping runs', () => {
  // 240 hourly runs over 10 days. Each covers 72 h, so they overlap heavily;
  // treating 240 as the sample size would badly overstate the evidence.
  const evidence = summariseObservedSavings(hourlyRuns(10, 30));
  assertEqual(evidence.runs, 240, 'runs');
  assertEqual(evidence.days, 10, 'distinct days');
  near(evidence.medianSavingSekPerDay ?? 0, 10, 1e-9, 'median daily saving');
});

Deno.test('runs that are not ready are excluded', () => {
  const evidence = summariseObservedSavings([
    run('2026-01-15T10:00:00Z', 40, 55),
    run('2026-01-15T11:00:00Z', 0, 9999, 'infeasible'),
    run('2026-01-15T12:00:00Z', 0, 9999, 'incomplete'),
  ]);
  assertEqual(evidence.runs, 1, 'only the ready run counts');
});

Deno.test('a malformed summary is skipped rather than counted as zero', () => {
  const evidence = summariseObservedSavings([
    { issued_at: '2026-01-15T10:00:00Z', status: 'ready', summary: null },
    { issued_at: '2026-01-15T11:00:00Z', status: 'ready', summary: { plans: {} } },
    run('2026-01-15T12:00:00Z', 40, 55),
  ]);
  assertEqual(evidence.runs, 1, 'runs');
});

Deno.test('seasons are derived from the run dates', () => {
  assertEqual(seasonOf('2026-01-15'), 'winter', 'january');
  assertEqual(seasonOf('2026-04-15'), 'spring', 'april');
  assertEqual(seasonOf('2026-07-15'), 'summer', 'july');
  assertEqual(seasonOf('2026-10-15'), 'autumn', 'october');
  assertEqual(seasonOf('2026-12-15'), 'winter', 'december');
});

Deno.test('the season day weights sum to a year', () => {
  const total = Object.values(SEASON_DAYS).reduce((sum, days) => sum + days, 0);
  assertEqual(total, 365, 'total days');
});

Deno.test('the seasonal check weights every season', () => {
  const check = seasonalPlannerCheck(
    Date.UTC(2026, 0, 1),
    (_at, season) => ({
      plans: {
        priority: { summary: { terminal_adjusted_cost_sek: 0 } },
        baseline: { summary: { terminal_adjusted_cost_sek: SEASON_DAYS[season] } },
      },
    }) as never,
  );
  assertEqual(check.perSeason.length, 4, 'four seasons');
  const expected = Object.values(SEASON_DAYS)
    .reduce((sum, days) => sum + (days / PLAN_HORIZON_DAYS) * days, 0);
  near(check.referenceAnnualSavingSek, expected, 1e-6, 'reference annual');
  assertEqual(check.regressions.length, 0, 'no regressions when every season saves');
});

Deno.test('a season where the plan beats nothing is reported as a regression', () => {
  // The autumn fixture really does this today: the priority plan costs about
  // 12.8 SEK more than its own baseline over 72 hours. It must surface, not be
  // averaged into a reassuring annual total.
  const check = seasonalPlannerCheck(
    Date.UTC(2026, 0, 1),
    (_at, season) => ({
      plans: {
        priority: { summary: { terminal_adjusted_cost_sek: season === 'autumn' ? 50 : 10 } },
        baseline: { summary: { terminal_adjusted_cost_sek: 40 } },
      },
    }) as never,
  );
  assertEqual(check.regressions.join(','), 'autumn', 'autumn flagged');
});

Deno.test('a saving is positive when the plan costs less than baseline', () => {
  // comparePlans is priority minus baseline, so the sign must be flipped once.
  const check = seasonalPlannerCheck(
    Date.UTC(2026, 0, 1),
    () => ({
      plans: {
        priority: { summary: { terminal_adjusted_cost_sek: 10 } },
        baseline: { summary: { terminal_adjusted_cost_sek: 40 } },
      },
    }) as never,
  );
  assert(check.referenceAnnualSavingSek > 0, 'a cheaper plan saves money');
  near(check.referenceAnnualSavingSek, (30 / PLAN_HORIZON_DAYS) * 365, 1e-6, 'reference annual');
});

Deno.test('too little plan history states no figure at all', () => {
  const observed = summariseObservedSavings(hourlyRuns(MIN_DAYS_FOR_OBSERVED_RATE - 1, 30));
  const roi = computeRoi({ observed, investmentSek: 65_000, monthlySubscriptionSek: 299 });
  assertEqual(roi.blocker, 'too_few_days', 'blocker');
  assertEqual(roi.savingSekPerDay, null, 'no daily rate');
  assertEqual(roi.annualIfSustainedSek, null, 'no annual figure');
  assertEqual(roi.paybackYearsIfSustained, null, 'no payback');
});

Deno.test('no plan history at all is distinguished from too little', () => {
  const roi = computeRoi({
    observed: summariseObservedSavings([]),
    investmentSek: 65_000,
    monthlySubscriptionSek: 299,
  });
  assertEqual(roi.blocker, 'no_plan_history', 'blocker');
});

Deno.test('enough observation produces a labelled conditional annual figure', () => {
  const observed = summariseObservedSavings(hourlyRuns(MIN_DAYS_FOR_OBSERVED_RATE, 60));
  const roi = computeRoi({ observed, investmentSek: 65_000, monthlySubscriptionSek: 299 });
  assertEqual(roi.blocker, null, 'no blocker');
  near(roi.savingSekPerDay ?? 0, 20, 1e-9, 'observed daily rate');
  near(roi.annualIfSustainedSek ?? 0, 20 * 365, 1e-9, 'annual if sustained');
  near(roi.annualSubscriptionSek, 3_588, 1e-9, 'annual subscription');
  near(roi.netAnnualIfSustainedSek ?? 0, 20 * 365 - 3_588, 1e-9, 'net');
});

Deno.test('payback is impossible when the subscription outweighs the saving', () => {
  const observed = summariseObservedSavings(hourlyRuns(10, 3));
  const roi = computeRoi({ observed, investmentSek: 65_000, monthlySubscriptionSek: 299 });
  assert((roi.netAnnualIfSustainedSek ?? 0) < 0, 'net is negative');
  assertEqual(roi.paybackYearsIfSustained, null, 'no payback');
});
