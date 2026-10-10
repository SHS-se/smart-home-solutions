// What the bench chart is showing, as data: the period on screen, quarter by
// quarter, for the planner shown and the one it is compared with. For debugging
// and analysis outside the page. It is not a test case and cannot be added as one.
//
// Nothing here is worked out afresh: every number is the stored series the
// chart draws, and every point is the score the page shows.

import type { OpportunityFinding } from './opportunities.ts';
import type { CaseScore } from './score.ts';
import type { BenchSeries } from './types.ts';

export interface ExportedPlanSource {
  /** What the page calls the planner: its branch, or its short hash. */
  name: string;
  sha: string;
  committed_at: string;
  subject: string;
  series: BenchSeries;
  score: CaseScore | null;
}

export interface BenchChartExportInput {
  scenario: { id: string; name: string; captured_at: string; revision: string; start_state?: unknown };
  timeZone: string;
  /** The period shown: its label, and its quarters as [from, to). */
  period: { label: string; from: number; to: number };
  /** Which of the two the chart draws in full. */
  shown: 'current' | 'test';
  plans: Record<'current' | 'test', ExportedPlanSource | null>;
  /** The rules in force, as the page scores with them. */
  rules: readonly { key: string; label: string; points: number; threshold: number; enabled: boolean }[];
}

const overlaps = (f: OpportunityFinding, from: number, to: number) =>
  (f.from < to && f.fromEnd >= from) || (f.to < to && f.toEnd >= from);

function exportedPlan(source: ExportedPlanSource, role: 'current' | 'test', shown: boolean, from: number, to: number, points: ReadonlyMap<string, number>) {
  const { series: s, score } = source;
  const audit = score?.audit && !score.auditPending ? score.audit : null;
  let running = 0, quarterPoints = 0;
  const quarters = s.start.slice(from, to).map((start, offset) => {
    const i = from + offset;
    const scored = score?.quarters[i];
    running += s.costSek[i];
    quarterPoints += scored?.score ?? 0;
    return {
      index: i, start, hours: s.hours[i],
      import_price_sek_per_kwh: s.importPrice[i], export_price_sek_per_kwh: s.exportPrice[i],
      believed_import_price_sek_per_kwh: s.believedImportPrice?.[i] ?? null, price_published: s.published[i] === 1,
      solar_w: s.solarW[i], load_w: s.loadW[i], grid_import_w: s.gridImportW[i], grid_export_w: s.gridExportW[i],
      battery_charge_w: s.batteryChargeW[i], battery_discharge_w: s.batteryDischargeW[i],
      pool_w: s.poolW[i], hot_water_w: s.hotWaterW[i], car_w: s.carW[i],
      devices_w: Object.fromEntries(s.devices.map(d => [d.key, s.deviceW[d.key][i]])),
      home_soc_percent: s.homeSoc[i], car_soc_percent: s.carSoc[i], car_km: s.carKm?.[i] ?? null, car_connected: s.carConnected[i] === 1,
      pool_c: s.poolC[i],
      cost_sek: s.costSek[i],
      wear_sek: s.wearSek?.[i] ?? null,
      // Counted from the start of the period, as the chart's cost panel does.
      cumulative_cost_sek: running,
      // Service deductions in this quarter, a point a krona.
      score: scored?.score ?? null,
      rules_fired: Object.fromEntries((scored?.fired ?? []).map(key => [key, points.get(key) ?? null])),
    };
  });
  return {
    role: role === 'current' ? 'production' : 'compared', name: source.name, shown,
    sha: source.sha, committed_at: source.committed_at, subject: source.subject,
    devices: s.devices,
    targets: s.comfort ? { pool_c: s.comfort.pool_target_c, car_km: s.comfort.ev_target_km } : null,
    period: { deduction_points: score ? quarterPoints : null, cost_sek: running },
    // The case's points are its deductions less its net bill over all 72 hours, a point a krona; a day has no share of the store credit.
    case: score ? {
      points: score.complete ? score.points : null, deduction_points: score.sum,
      grid_sek: score.bill?.grid_sek ?? null, wear_sek: score.bill?.wear_sek ?? null,
      store_credit_sek: score.bill?.credit.credit_sek ?? null, net_bill_sek: score.bill?.net_sek ?? null,
      store_credit: score.bill?.credit ?? null,
    } : null,
    energy_timing_findings: audit ? audit.findings.filter(f => overlaps(f, from, to)).map(f => ({
      id: f.id, rule: f.rule, tags: f.tags, device: f.device, basis: f.basis,
      from_quarter: f.from, from_quarter_end: f.fromEnd, to_quarter: f.to, to_quarter_end: f.toEnd,
      kwh: f.kwh, saving_sek: f.savingSek,
    })) : null,
    quarters,
  };
}

export function benchChartExport(input: BenchChartExportInput) {
  const { scenario, period, plans } = input;
  const length = (plans[input.shown] ?? plans.current ?? plans.test)?.series.start.length ?? 0;
  const from = Math.max(0, period.from), to = Math.min(length, period.to);
  const starts = (plans[input.shown] ?? plans.current ?? plans.test)?.series.start ?? [];
  const points = new Map(input.rules.map(rule => [rule.key, rule.points]));
  return {
    format: 'shs-planner-bench-chart',
    schema_version: 2,
    case: { id: scenario.id, name: scenario.name, captured_at: scenario.captured_at, revision: scenario.revision, start_state: scenario.start_state ?? null },
    period: {
      label: period.label, time_zone: input.timeZone, from_quarter: from, to_quarter: to, quarters: to - from,
      start: starts[from] ?? null,
      end: to > from ? new Date(Date.parse(starts[to - 1]) + 900_000).toISOString() : null,
    },
    // Every planner on the bench is given the real prices, and is costed at them.
    price_basis: 'real',
    rules: input.rules.filter(rule => rule.enabled).map(({ key, label, points: p, threshold }) => ({ key, label, points: p, threshold })),
    plans: (['current', 'test'] as const).flatMap(role => {
      const source = plans[role];
      // The same commit on both sides is one plan, not two.
      if (!source || (role === 'test' && plans.current?.sha === source.sha)) return [];
      return [exportedPlan(source, role, role === input.shown || plans.current?.sha === plans.test?.sha, from, to, points)];
    }),
  };
}

/** A file name that says which case, planner and period it holds. */
export const benchChartFilename = (caseName: string, planner: string, period: string) =>
  `bench-${[caseName, planner, period].map(part => part.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')).join('-')}.json`;
