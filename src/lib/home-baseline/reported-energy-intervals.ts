import type { ActualRow } from './model.ts';

const QUARTER = 900_000;
export const ENERGY_FIELDS = ['total_load_kwh', 'solar_production_kwh', 'grid_import_kwh', 'grid_export_kwh',
  'battery_charge_kwh', 'battery_discharge_kwh'] as const;
export type EnergyField = typeof ENERGY_FIELDS[number];

/** Verified delayed counter report. Its total is measured; its within-interval timing is unknown. */
export interface ReportedEnergyInterval {
  field: EnergyField;
  start: string;
  end: string;
  kwh: number;
  source: string;
}

export function reportedEnergyIntervals(values: readonly ReportedEnergyInterval[]): ReportedEnergyInterval[] {
  const unique = new Map<string, ReportedEnergyInterval>();
  for (const value of values) {
    const start = Date.parse(value.start), end = Date.parse(value.end);
    if (!ENERGY_FIELDS.includes(value.field) || !Number.isFinite(start) || !Number.isFinite(end)
      || start % QUARTER || end % QUARTER || end <= start || !Number.isFinite(value.kwh) || value.kwh < 0
      || typeof value.source !== 'string' || !value.source.trim()) throw new Error('Invalid reported energy interval');
    const interval = { ...value, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    const key = `${value.field}|${start}|${end}`, existing = unique.get(key);
    if (existing && (existing.kwh !== interval.kwh || existing.source !== interval.source)) throw new Error('Conflicting reported energy intervals');
    unique.set(key, interval);
  }
  const ordered = [...unique.values()].sort((a, b) => a.field.localeCompare(b.field) || Date.parse(a.start) - Date.parse(b.start));
  for (let i = 1; i < ordered.length; i++) if (ordered[i].field === ordered[i - 1].field && Date.parse(ordered[i].start) < Date.parse(ordered[i - 1].end)) {
    throw new Error('Overlapping reported energy intervals');
  }
  return ordered;
}

/** Replace only explicitly corrected channels; evenly allocate the known total, never cap or discard it. */
export function allocateReportedEnergy(rows: Map<string, ActualRow>, intervals: readonly ReportedEnergyInterval[], start: number, end: number) {
  const adjusted = new Map<string, Set<EnergyField>>();
  for (const interval of reportedEnergyIntervals(intervals)) {
    const from = Date.parse(interval.start), to = Date.parse(interval.end), perQuarter = interval.kwh / ((to - from) / QUARTER);
    for (let at = Math.max(from, start); at < Math.min(to, end); at += QUARTER) {
      const stamp = new Date(at).toISOString(), row = rows.get(stamp);
      if (!row) throw new Error(`Reported energy interval has no historical row at ${stamp}`);
      row[interval.field] = perQuarter;
      if (!adjusted.has(stamp)) adjusted.set(stamp, new Set());
      adjusted.get(stamp)!.add(interval.field);
    }
  }
  return adjusted;
}

/** Operator-specified, source-verified intervals only. Missing sensor values contribute zero. */
export function measureReportedEnergy(rows: readonly ActualRow[], definitions: readonly Omit<ReportedEnergyInterval, 'kwh'>[]) {
  const byTime = new Map(rows.map(row => [Date.parse(row.start_ts), row]));
  if (byTime.size !== rows.length) throw new Error('Duplicate counter observations');
  return reportedEnergyIntervals(definitions.map(definition => {
    // Validate bounds before traversing the source observations.
    reportedEnergyIntervals([{ ...definition, kwh: 0 }]);
    let kwh = 0;
    for (let at = Date.parse(definition.start); at < Date.parse(definition.end); at += QUARTER) {
      const row = byTime.get(at);
      if (!row) throw new Error(`Missing counter observation at ${new Date(at).toISOString()}`);
      const value = row[definition.field];
      if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid counter energy');
      kwh += value ?? 0;
    }
    return { ...definition, kwh };
  }));
}
