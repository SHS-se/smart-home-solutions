import { marketDate, marketDaySpan } from './demand-forecast-quality.ts';
import type { SmhiDocument } from './smhi-observations.ts';
import type { EntsoeInterval } from './entsoe-market-data.ts';
import { NEIGHBOUR_EIC } from './entsoe-market-data.ts';
import { intervalCoverage } from './market-intervals.ts';

export const MARKET_ASSESSOR = 'market-quality-v1';
export interface AssessedObservation {
  id: string; dataset: string; zone: string; requested_from: string; requested_to: string;
  result: { status: string; http_status?: number | null; error_code?: string | null; body_sha256?: string | null; document?: unknown; request?: unknown };
}
export interface MarketAssessment {
  assessor_version: typeof MARKET_ASSESSOR; status: string; http_status: number | null;
  error_code: string | null; body_sha256: string | null; facts: Record<string, unknown>;
}
export function assessMarketObservation(row: AssessedObservation): MarketAssessment {
  const result = row.result;
  const assessment: MarketAssessment = { assessor_version: MARKET_ASSESSOR, status: result.status,
    http_status: result.http_status ?? null, error_code: result.error_code ?? null,
    body_sha256: result.body_sha256 ?? null, facts: { kind: 'no_document' } };
  if (row.dataset.startsWith('smhi_') && result.request && typeof result.request === 'object' && 'station_id' in result.request) assessment.facts.station_id = result.request.station_id;
  if (row.dataset.startsWith('nucs_') && result.request && typeof result.request === 'object' && 'neighbour' in result.request && 'direction' in result.request) {
    assessment.facts.scope_key = `${result.request.neighbour}/${result.request.direction}`;
  }
  if (result.status !== 'data' || !result.document || typeof result.document !== 'object') return assessment;
  const doc = result.document as Record<string, unknown>;
  if (row.dataset === 'nucs_week_ahead_ntc' || row.dataset === 'nucs_transmission_outages') {
    const native = result.document as import('./nucs-market-data.ts').NucsDocument;
    assessment.facts = { ...assessment.facts, kind: 'regional_border_context', semantics: native.semantics,
      in_domain: native.in_domain, out_domain: native.out_domain, documents: native.notices.length,
      cancelled_documents: native.notices.filter(n => n.status === 'A09').length,
      unspecified_status_documents: native.notices.filter(n => n.status === null).length,
      capacity_points: native.capacity_intervals.length };
  } else if (row.dataset === 'smhi_wind_10m_observed' || row.dataset === 'smhi_temperature_2m_observed') {
    const native = result.document as SmhiDocument;
    const priorDay = new Date(Date.parse(marketDate(Date.parse(row.requested_to))) - 86_400_000).toISOString().slice(0, 10), [start, end] = marketDaySpan(priorDay);
    const previous = native.hours.filter(p => p.at >= start && p.at < end);
    assessment.facts = { kind: 'station_hourly_truth', station_id: native.station_id, variable: native.variable,
      unit: native.unit, height_m: native.height_m, semantics: native.semantics,
      first: native.hours[0]?.at ?? null, last: native.hours.at(-1)?.at ?? null,
      points: native.hours.length, conflicts: native.hours.filter(p => p.conflict).length,
      quality: Object.fromEntries([...new Set(native.hours.map(p => p.quality ?? 'unknown'))].map(q => [q, native.hours.filter(p => (p.quality ?? 'unknown') === q).length])),
      previous_day: { day: priorDay, expected: (end - start) / 3_600_000, present: previous.filter(p => p.value !== null && !p.conflict).length,
        approved: previous.filter(p => p.value !== null && !p.conflict && p.quality === 'G').length } };
  } else if (Array.isArray(doc.intervals)) {
    const rows = doc.intervals as EntsoeInterval[];
    const groups = new Map<string, EntsoeInterval[]>();
    for (const interval of rows) {
      const key = [interval.psrType, interval.businessType, interval.flow, interval.unit, interval.resolution].join('/');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(interval);
    }
    const series = [...groups].map(([key, values]) => ({ key, points: values.length,
      first: new Date(Math.min(...values.map(r => r.startMs))).toISOString(),
      last: new Date(Math.max(...values.map(r => r.endMs))).toISOString(),
      ...intervalCoverage(values, Date.parse(row.requested_from), Date.parse(row.requested_to)) }));
    const issues: string[] = [];
    if (rows.some(r => r.unit !== 'MAW')) issues.push('unexpected_native_unit');
    const expectedProcess = row.dataset.includes('actual') ? 'A16' : row.dataset === 'load_week_ahead' ? 'A31' : 'A01';
    if (doc.processType !== expectedProcess) issues.push('unexpected_process_type');
    if (row.dataset.includes('load') && row.dataset !== 'load_week_ahead' && rows.some(r => r.flow !== 'consumption' || r.psrType !== null)) issues.push('unexpected_load_series_semantics');
    if (row.dataset === 'load_week_ahead' && rows.some(r => !['A60', 'A61'].includes(r.businessType ?? '') || r.resolution !== 'P1D')) issues.push('unexpected_week_ahead_semantics');
    const area = row.zone === 'SE3' ? '10Y1001A1001A46L' : NEIGHBOUR_EIC[row.zone as keyof typeof NEIGHBOUR_EIC];
    if (!Array.isArray(doc.biddingZones) || !doc.biddingZones.length) issues.push('provider_area_metadata_unavailable');
    else if (doc.biddingZones.some(v => v !== area)) issues.push('unexpected_provider_area');
    assessment.facts = { issues, provider_areas: doc.biddingZones ?? null, kind: row.dataset === 'load_week_ahead' ? 'daily_extrema' : 'native_intervals',
      unit: rows[0]?.unit ?? null, series, provider_created_at: doc.createdAt ?? null,
      provider_revision: doc.revisionNumber ?? null, provider_document_id: doc.documentId ?? null };
  } else if (Array.isArray(doc.sites)) {
    const sites = doc.sites as { station_id: string; times: string[]; series: Record<string, (number | null)[]> }[];
    assessment.facts = { kind: 'weather_sites', model: doc.model, provider_issue_at: doc.issue_time,
      interpolation: 'hourly API values from ECMWF IFS 0.25 degree native 3-hour steps, 6-hour after 144h',
      sites: sites.map(s => ({ station_id: s.station_id, labels: s.times.length,
        first: s.times[0] ?? null, last: s.times.at(-1) ?? null,
        series_coverage: Object.fromEntries(Object.entries(s.series).map(([name, values]) => [name,
          intervalCoverage(s.times.flatMap((time, i) => values[i] === null ? [] : [{ startMs: Date.parse(time) - (name === 'shortwave_radiation' ? 3_600_000 : 0),
            endMs: Date.parse(time) + (name === 'shortwave_radiation' ? 0 : 3_600_000), value: values[i]! }]), Date.parse(row.requested_from), Date.parse(row.requested_to))])),
        nulls: Object.fromEntries(Object.entries(s.series).map(([name, values]) => [name, values.filter(v => v === null).length])) })),
      lead_coverage: doc.coverage };
  } else if (Array.isArray(doc.records)) {
    const records = doc.records as { start: string; end: string; values: Record<string, number | null> }[];
    const labels = [...new Set(records.flatMap(r => Object.keys(r.values)))].sort();
    assessment.facts = { kind: 'network_bounds', semantics: doc.semantics, unit: doc.unit,
      rejected: doc.rejected, messages: doc.messages,
      series: labels.map(label => ({ label, nulls: records.filter(r => r.values[label] === null || r.values[label] === undefined).length,
        ...intervalCoverage(records.flatMap(r => typeof r.values[label] === 'number'
          ? [{ startMs: Date.parse(r.start), endMs: Date.parse(r.end), value: r.values[label]! }] : []),
        Date.parse(row.requested_from), Date.parse(row.requested_to)) })),
      missing_se3_labels: (row.dataset === 'jao_max_net_positions' ? ['min_SE3', 'max_SE3'] :
        ['border_SE2_SE3', 'border_SE3_SE2', 'border_SE4_SE3', 'border_SE3_SE4', 'border_NO1_SE3', 'border_SE3_NO1',
          'border_FI_SE3', 'border_SE3_FI', 'border_DK1_SE3', 'border_SE3_DK1']).filter(label => !labels.includes(label)) };
  } else {
    assessment.facts = { kind: 'source_documents', records: Array.isArray(doc.weeks) ? doc.weeks.length :
      Array.isArray(doc.units) ? doc.units.length : Array.isArray(doc.documents) ? doc.documents.length : 0 };
  }
  return assessment;
}
