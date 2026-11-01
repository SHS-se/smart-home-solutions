/** Forecast-vintage demand scoring. No retrospective forecast substitution or cross-revision filling. */
import type { EntsoeInterval } from './entsoe-market-data.ts';
import { intervalMean } from './market-intervals.ts';
const DAY = 86_400_000, QUARTER = 900_000;
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });
export function marketDate(at: number): string {
  const parts = Object.fromEntries(dateFormat.formatToParts(at).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function marketDaySpan(day: string): [number, number] {
  const midnight = (date: number) => {
    const label = new Date(date).toISOString().slice(0, 10);
    for (const offset of [1, 2]) {
      const at = date - offset * 3_600_000;
      if (marketDate(at) === label && marketDate(at - 1) !== label) return at;
    }
    throw new Error('Unsupported Stockholm date');
  };
  const nominal = Date.parse(`${day}T00:00:00Z`);
  return [midnight(nominal), midnight(nominal + DAY)];
}
export interface DemandEvidence {
  id: string; sequence: number; dataset: string; zone: string;
  requested_from: string; requested_to: string; recorded_at: string;
  result: { status: string; document?: { processType: string | null; intervals: EntsoeInterval[] } };
}
function demandRows(row: DemandEvidence) {
  return (row.result.document?.intervals ?? []).filter(r => r.unit === 'MAW' && r.psrType === null &&
    r.flow === 'consumption' && ['PT15M', 'PT60M'].includes(r.resolution));
}
export function scoreDemandForecasts(evidence: readonly DemandEvidence[]) {
  const actuals = new Map<number, { value: number | null; id: string }>();
  for (const row of [...evidence].filter(r => r.dataset === 'load_actual' && r.zone === 'SE3' &&
    r.result.status === 'data' && r.result.document?.processType === 'A16').sort((a, b) => a.sequence - b.sequence)) {
    const rows = demandRows(row), start = Math.ceil(Date.parse(row.requested_from) / QUARTER) * QUARTER,
      end = Math.floor(Date.parse(row.requested_to) / QUARTER) * QUARTER;
    for (let at = start; at < end; at += QUARTER) {
      actuals.set(at, { value: intervalMean(rows.filter(r => r.startMs < at + QUARTER && r.endMs > at), at, at + QUARTER), id: row.id });
    }
  }
  const samples: { observation_id: string; truth_ids: string[]; dataset: string; origin_day: string; target_day: string;
    lead_day: number; quarters: number; mae_mw: number; bias_mw: number; wape: number | null; min_error_mw?: number; max_error_mw?: number }[] = [];
  const exclusions: Record<string, number> = {};
  const skip = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  for (const row of evidence.filter(r => ['load_day_ahead', 'load_week_ahead'].includes(r.dataset) && r.zone === 'SE3' && r.result.status === 'data')) {
    const doc = row.result.document;
    if (!doc || doc.processType !== (row.dataset === 'load_week_ahead' ? 'A31' : 'A01')) { skip('unexpected_forecast_process'); continue; }
    const known = Date.parse(row.recorded_at), origin = marketDate(known);
    const days = [...new Set(doc.intervals.map(r => marketDate(r.startMs)))].sort();
    for (const day of days) {
      const [start, end] = marketDaySpan(day);
      if (start < known) { skip('target_started_before_local_acquisition'); continue; }
      const truth = Array.from({ length: (end - start) / QUARTER }, (_, i) => actuals.get(start + i * QUARTER));
      if (truth.some(v => v?.value === null || v?.value === undefined)) { skip('incomplete_actual_day'); continue; }
      const values = truth.map(v => v!.value!), truthIds = [...new Set(truth.map(v => v!.id))];
      let errors: number[], minError: number | undefined, maxError: number | undefined;
      if (row.dataset === 'load_week_ahead') {
        const extrema = (business: string) => doc.intervals.filter(r => r.unit === 'MAW' && r.resolution === 'P1D' &&
          r.businessType === business && r.startMs === start && r.endMs === end);
        // A60 = minimum, A61 = maximum. Never turn an extremum into hourly mean load.
        const minimum = intervalMean(extrema('A60'), start, end), maximum = intervalMean(extrema('A61'), start, end);
        if (minimum === null || maximum === null) { skip('incomplete_or_conflicting_forecast_extrema'); continue; }
        minError = minimum - Math.min(...values); maxError = maximum - Math.max(...values);
        errors = [minError, maxError];
      } else {
        const rows = demandRows(row);
        const predicted = values.map((_, i) => intervalMean(rows.filter(r => r.startMs < start + (i + 1) * QUARTER && r.endMs > start + i * QUARTER), start + i * QUARTER, start + (i + 1) * QUARTER));
        if (predicted.some(v => v === null)) { skip('incomplete_or_conflicting_forecast_day'); continue; }
        errors = predicted.map((v, i) => v! - values[i]);
      }
      const absolute = errors.reduce((s, e) => s + Math.abs(e), 0);
      const denominator = row.dataset === 'load_week_ahead' ? Math.abs(Math.min(...values)) + Math.abs(Math.max(...values)) : values.reduce((s, v) => s + Math.abs(v), 0);
      samples.push({ observation_id: row.id, truth_ids: truthIds, dataset: row.dataset, origin_day: origin, target_day: day,
        lead_day: (Date.parse(day) - Date.parse(origin)) / DAY, quarters: values.length,
        mae_mw: absolute / errors.length, bias_mw: errors.reduce((s, e) => s + e, 0) / errors.length,
        wape: denominator ? absolute / denominator : null,
        ...(minError === undefined ? {} : { min_error_mw: minError, max_error_mw: maxError }) });
    }
  }
  // One latest locally observed forecast per origin date and target date. Repeated hourly downloads add no independent date.
  const order = new Map(evidence.map(r => [r.id, r.sequence]));
  const selected = new Map<string, typeof samples[number]>();
  for (const sample of samples.sort((a, b) => order.get(a.observation_id)! - order.get(b.observation_id)!)) selected.set(`${sample.dataset}/${sample.origin_day}/${sample.target_day}`, sample);
  const normalized = [...selected.values()];
  const groups = new Map<string, typeof samples>();
  for (const sample of normalized) {
    const key = `${sample.dataset}/D+${sample.lead_day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(sample);
  }
  return { policy: 'Locally committed forecasts before whole target-day start. Latest forecast per origin date and target date; complete native demand quarters only. Newest actual request replaces its entire aligned scope, including omissions. Week-ahead daily extrema scored separately.',
    correlation: 'Different leads can share target dates and overlapping origins are correlated; date counts are not independent sample counts.',
    forecast_origin_count: new Set(samples.map(r => r.observation_id)).size, distinct_target_dates: new Set(normalized.map(r => r.target_day)).size,
    exclusions, scores: [...groups].map(([group, rows]) => ({ group, origin_dates: new Set(rows.map(r => r.origin_day)).size,
      target_dates: new Set(rows.map(r => r.target_day)).size, forecast_days: rows.length,
      mae_mw: rows.reduce((s, r) => s + r.mae_mw, 0) / rows.length,
      bias_mw: rows.reduce((s, r) => s + r.bias_mw, 0) / rows.length,
      mean_daily_wape: rows.every(r => r.wape !== null) ? rows.reduce((s, r) => s + r.wape!, 0) / rows.length : null,
      ...(rows[0].min_error_mw === undefined ? {} : {
        minimum_mae_mw: rows.reduce((s, r) => s + Math.abs(r.min_error_mw!), 0) / rows.length,
        maximum_mae_mw: rows.reduce((s, r) => s + Math.abs(r.max_error_mw!), 0) / rows.length }) })),
    samples: normalized, truth_observation_ids: [...new Set([...actuals.values()].map(r => r.id))] };
}
