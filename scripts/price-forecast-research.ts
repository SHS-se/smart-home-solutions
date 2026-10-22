/** TEST-only acquisition and offline price research. No production credentials or writes. */
import { PROBE_PROJECT, testProbeServiceKey } from './planner-probe-auth.ts';
import { parseEntsoeResponse, type EntsoeDataset, type EntsoeInterval } from '../supabase/functions/_shared/entsoe-market-data.ts';
import { comparePriceForecasts, type ResearchBundle, type MarketSeries, type ComparisonReport } from '../supabase/functions/_shared/price-forecast-research.ts';

const TEST_URL = `https://${PROBE_PROJECT}.supabase.co`;
const DATASETS: EntsoeDataset[] = ['price', 'load_actual', 'load_day_ahead', 'load_week_ahead',
  'wind_actual', 'wind_day_ahead', 'solar_actual', 'nuclear_actual', 'generation_outages'];
interface Acquisition {
  dataset: EntsoeDataset; from: string; to: string; retrievedAt: string;
  status: number; contentType: string; file: string; outcome: string; intervals?: number;
}
function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z]+$/.test(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected --name value options');
    const name = args[i].slice(2);
    if (name in result) throw new Error(`Duplicate option ${name}`);
    result[name] = args[i + 1];
  }
  return result;
}
function requireOptions(args: Record<string, string>, names: string[]) {
  if (Object.keys(args).sort().join(',') !== [...names].sort().join(',')) throw new Error(`Expected ${names.map(name => `--${name}`).join(', ')}`);
}
function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Expected a valid YYYY-MM-DD date');
  return `${value}T00:00:00.000Z`;
}
async function save(path: string, value: unknown) { await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + '\n'); }
async function read<T>(path: string): Promise<T> { return JSON.parse(await Deno.readTextFile(path)); }

/** Non-overlapping union boundaries preserve native source resolution and missing wind coverage. */
function totalWind(intervals: EntsoeInterval[]): MarketSeries['intervals'] {
  const types = [...new Set(intervals.map(value => value.psrType))];
  const edges = [...new Set(intervals.flatMap(value => [value.startMs, value.endMs]))].sort((a, b) => a - b);
  const result: MarketSeries['intervals'] = [];
  for (let i = 1; i < edges.length; i++) {
    const startMs = edges[i - 1], endMs = edges[i];
    const values = types.map(type => intervals.filter(value => value.psrType === type && value.startMs <= startMs && value.endMs >= endMs));
    if (values.every(value => value.length === 1)) result.push({ startMs, endMs, value: values.reduce((sum, value) => sum + value[0].value, 0) });
  }
  return result;
}
function marketSeries(dataset: EntsoeDataset, intervals: EntsoeInterval[]): MarketSeries[] {
  if (!dataset.endsWith('_outages') && intervals.some(row => row.unit !== (dataset === 'price' ? 'MWH' : 'MAW'))) {
    throw new Error(`Unexpected ${dataset} unit; source retained without using values`);
  }
  // Prices remain EUR/MWh: no implicit conversion to the household all-in import price.
  const select = (signal: string, rows: EntsoeInterval[]): MarketSeries => ({ signal, evidence: 'retrospective',
    intervals: rows.map(({ startMs, endMs, value }) => ({ startMs, endMs, value })) });
  if (dataset === 'wind_actual' || dataset === 'wind_day_ahead') {
    const wind = intervals.filter(row => row.psrType === 'B18' || row.psrType === 'B19');
    const result: MarketSeries[] = wind.length ? [{ signal: dataset, evidence: 'retrospective', intervals: totalWind(wind) }] : [];
    if (dataset === 'wind_day_ahead') {
      const solar = intervals.filter(row => row.psrType === 'B16');
      if (solar.length) result.push(select('solar_day_ahead', solar));
    }
    return result;
  }
  if (dataset.endsWith('_outages')) return []; // Retain source documents; event MW is not an aggregate supply factor.
  return [select(dataset === 'price' ? 'wholesale_price_eur_mwh' : dataset, intervals)];
}

async function collect(args: Record<string, string>) {
  requireOptions(args, ['from', 'to', 'out']);
  const from = day(args.from), to = day(args.to);
  if (from >= to) throw new Error('--to must follow --from (exclusive end date)');
  await Deno.mkdir(`${args.out}/raw`, { recursive: true });
  // Refuse to overwrite evidence from an earlier collection.
  try { await Deno.stat(`${args.out}/bundle.json`); throw new Error('Output already contains a research bundle; choose a new directory'); }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
  const key = await testProbeServiceKey();
  const headers = { authorization: `Bearer ${key}`, apikey: key };
  async function rows<T>(table: string, query: Record<string, string>): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ; offset += 1000) {
      const parameters = new URLSearchParams({ ...query, offset: String(offset), limit: '1000' });
      const response = await fetch(`${TEST_URL}/rest/v1/${table}?${parameters}`, { headers });
      if (!response.ok) throw new Error(`TEST ${table} HTTP ${response.status}`);
      const page: T[] = await response.json();
      result.push(...page);
      if (page.length < 1000) return result;
    }
  }
  const homes = await rows<{ home_id: string }>('energy_optimisation_current', { select: 'home_id' });
  if (homes.length !== 1) throw new Error(`Expected one TEST household, found ${homes.length}; explicitly scope collection before proceeding`);
  const [prices, observedWind, windForecasts] = await Promise.all([
    rows<ResearchBundle['prices'][number]>('energy_optimisation_price_slots', { select: 'start_ts,import_price_sek_per_kwh', home_id: `eq.${homes[0].home_id}`, and: `(start_ts.gte.${from},start_ts.lt.${to})`, order: 'start_ts' }),
    rows<ResearchBundle['observedWind'][number]>('energy_market_wind_observed', { select: 'day,mean_speed_m_s', zone: 'eq.SE3', day: `lt.${args.to}`, order: 'day' }),
    rows<ResearchBundle['windForecasts'][number]>('energy_market_wind_forecast', { select: 'day,mean_speed_m_s,issued_on,issued_at', zone: 'eq.SE3', issued_at: `lt.${to}`, order: 'issued_at,day' }),
  ]);
  const bundle: ResearchBundle = { prices, observedWind, windForecasts, market: [] };
  const manifest = { project: PROBE_PROJECT, zone: 'SE3', from, to, collectedAt: new Date().toISOString(),
    priceRows: prices.length, observedWindRows: observedWind.length, windForecastRows: windForecasts.length,
    evidence: 'Current historical ENTSO-E downloads are revised/retrospective; no original forecast vintage is asserted.', requests: [] as Acquisition[] };
  await save(`${args.out}/bundle.json`, bundle);
  // Sequential requests, in <=28-day chunks. No implicit provider retries or missing-value substitution.
  for (const dataset of DATASETS) {
    for (let begin = Date.parse(from); begin < Date.parse(to); begin += 28 * 86_400_000) {
      const query = { dataset, from: new Date(begin).toISOString(), to: new Date(Math.min(begin + 28 * 86_400_000, Date.parse(to))).toISOString() };
      const file = `raw/${dataset}-${query.from.slice(0, 10)}.bin`;
      const entry: Acquisition = { ...query, retrievedAt: new Date().toISOString(), status: 0, contentType: '', file, outcome: 'not_requested' };
      try {
        const response = await fetch(`${TEST_URL}/functions/v1/energy-market-research`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(query), signal: AbortSignal.timeout(100_000) });
        entry.status = response.status;
        entry.contentType = response.headers.get('content-type') ?? '';
        const bytes = new Uint8Array(await response.arrayBuffer());
        await Deno.writeFile(`${args.out}/${file}`, bytes);
        if (!response.ok) entry.outcome = `upstream_http_${response.status}`;
        else if (bytes[0] === 0x50 && bytes[1] === 0x4b) entry.outcome = 'zip_document_retained_not_used_as_factor';
        else {
          const parsed = parseEntsoeResponse(new TextDecoder().decode(bytes));
          entry.outcome = parsed.status;
          if (parsed.status === 'data') {
            entry.intervals = parsed.intervals.length;
            for (const series of marketSeries(dataset, parsed.intervals)) {
              const existing = bundle.market.find(value => value.signal === series.signal);
              if (existing) existing.intervals.push(...series.intervals); else bundle.market.push(series);
            }
          }
        }
      } catch (error) {
        // Transport/parser errors contain no credential-bearing request URL.
        entry.outcome = error instanceof Error ? error.message : 'collection_failed';
      }
      manifest.requests.push(entry);
      await save(`${args.out}/manifest.json`, manifest);
      await save(`${args.out}/bundle.json`, bundle);
      console.log(`${dataset} ${query.from.slice(0, 10)}: ${entry.outcome}${entry.intervals === undefined ? '' : ` (${entry.intervals} intervals)`}`);
      if (entry.status >= 500 || entry.status === 0) break; // Record one provider failure per dataset; explicitly rerun later.
    }
  }
  console.log(`Saved TEST bundle and request evidence to ${args.out}`);
}

async function compare(args: Record<string, string>) {
  requireOptions(args, ['input', 'out']);
  const bundle = await read<ResearchBundle>(`${args.input}/bundle.json`);
  const report = comparePriceForecasts(bundle);
  await Deno.mkdir(args.out, { recursive: true });
  await save(`${args.out}/comparison.json`, report);
  await Deno.writeTextFile(`${args.out}/comparison.md`, renderReport(report));
  console.log(JSON.stringify({ paired: report.paired, retrospective: report.retrospective }, null, 2));
}

function renderReport(report: ComparisonReport): string {
  const number = (value: number) => value.toFixed(3);
  const lines = ['# TEST price forecast comparison', '',
    `Shared wind/no-wind comparison: ${report.paired.origins} origins, ${report.paired.quarters} quarter predictions.`, '',
    '| Model | Quarter MAE | Bias | Daily mean MAE |', '| --- | ---: | ---: | ---: |'];
  for (const model of report.paired.models) {
    if (model.metrics) lines.push(`| ${model.label} | ${number(model.metrics.mae)} | ${number(model.metrics.bias)} | ${number(model.metrics.dailyMeanMae)} |`);
  }
  lines.push('', 'Errors are SEK/kWh of household import price. Negative bias means an underestimate.', '',
    `Wind improved ${report.paired.windWins} origins, worsened ${report.paired.noWindWins}, tied ${report.paired.ties}.`, '',
    '| Lead | Without wind MAE | With wind MAE | Paired quarters |', '| --- | ---: | ---: | ---: |');
  for (const lead of ['D+2', 'D+3']) {
    const plain = report.paired.models.find(model => model.id === 'no_wind')?.byHorizon[lead];
    const wind = report.paired.models.find(model => model.id === 'wind')?.byHorizon[lead];
    if (plain && wind) lines.push(`| ${lead} | ${number(plain.mae)} | ${number(wind.mae)} | ${wind.quarters} |`);
  }
  lines.push('', '## Other market factors', '', report.retrospective.reason ?? 'Retrospective/oracle results only; target-day actual factors were not known at forecast time.', '',
    '| Experiment | Status | Daily MAE | Baseline daily MAE | Evidence |', '| --- | --- | ---: | ---: | --- |');
  for (const model of report.retrospective.models) lines.push(`| ${model.id} | ${model.status} | ${model.mae === null ? '—' : number(model.mae)} | ${model.baselineMae === null ? '—' : number(model.baselineMae)} | ${model.reason ?? `${model.days} held-out days`} |`);
  lines.push('', '## Assumptions and limits', '', ...report.assumptions.map(value => `- ${value}`), '',
    'Full model, lead and per-origin results are in comparison.json.', '');
  return lines.join('\n');
}
if (import.meta.main) {
  try {
    const [command, ...args] = Deno.args;
    if (command === 'collect') await collect(options(args));
    else if (command === 'compare') await compare(options(args));
    else throw new Error('Usage: price-forecast-research.ts collect --from YYYY-MM-DD --to YYYY-MM-DD --out DIR | compare --input DIR --out DIR');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Research command failed'); Deno.exit(1); }
}
