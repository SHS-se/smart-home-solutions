/** Read-only TEST snapshot and reproducible scoring; no provider or planner writes. */
import { PROBE_PROJECT, testProbeServiceKey } from './planner-probe-auth.ts';
import { isDeepStrictEqual } from 'node:util';
import { resolveGenerationTruth } from '../supabase/functions/_shared/generation-truth.ts';
import { forecastGenerationMix, scoreGenerationRuns, type GenerationMixForecast } from '../supabase/functions/_shared/generation-mix.ts';
import { forecastGenerationMixV2 } from '../supabase/functions/_shared/generation-mix-v2.ts';
import type { HydroDocument } from '../supabase/functions/_shared/reservoir-hydrology.ts';
import type { NuclearRoster, NuclearOutageDocument } from '../supabase/functions/_shared/nuclear-availability.ts';
import type { EntsoeInterval } from '../supabase/functions/_shared/entsoe-market-data.ts';

if (Deno.args.length !== 2 || Deno.args[0] !== '--out') throw new Error('Usage: deno task research:generation:report --out NEW_DIRECTORY');
const out = Deno.args[1];
await Deno.mkdir(out); // Refuse to overwrite a previous evidence bundle.
const key = await testProbeServiceKey();
const headers = { authorization: `Bearer ${key}`, apikey: key };
async function rows<T>(table: string, parameters: Record<string, string>, maximum?: number): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const query = new URLSearchParams({ ...parameters, offset: String(offset), limit: String(maximum ? Math.min(100, maximum - offset) : 100) });
    const response = await fetch(`https://${PROBE_PROJECT}.supabase.co/rest/v1/${table}?${query}`, { headers });
    if (!response.ok) throw new Error(`TEST ${table} HTTP ${response.status}`);
    const page: T[] = await response.json();
    result.push(...page);
    if (page.length < 100 || maximum && result.length >= maximum) return result;
  }
}
interface Run { id: string; origin: string; source_refs: Record<string, string>; forecast: GenerationMixForecast }
interface Evidence { id: string; sequence: number; dataset: string; requested_from: string; requested_to: string; result: { status: string; document?: unknown } }
const runs = await rows<Run>('energy_generation_forecast_runs', { select: 'id,origin,source_refs,forecast', order: 'origin,id' });
const ids = [...new Set(runs.flatMap(run => Object.values(run.source_refs)))];
const observations: Evidence[] = [];
for (let index = 0; index < ids.length; index += 50) {
  observations.push(...await rows<Evidence>('energy_market_forecast_observations', {
    select: 'id,sequence,dataset,requested_from,requested_to,result', id: `in.(${ids.slice(index, index + 50).join(',')})`, order: 'sequence',
  }));
}
// Keep older targets scoreable after they leave the provider's rolling window.
const latest = await rows<Evidence>('energy_market_forecast_observations', {
  select: 'id,sequence,dataset,requested_from,requested_to,result', dataset: 'eq.generation_actual', 'result->>status': 'eq.data',
  order: 'sequence.desc',
}, 1);
const truth = latest[0];
const actualDocuments = new Map(observations.filter(row => row.dataset === 'generation_actual' && row.result.status === 'data').map(row => [row.id, row]));
if (truth) actualDocuments.set(truth.id, truth);
const resolvedTruth = resolveGenerationTruth([...actualDocuments.values()].map(row => ({
  id: row.id, sequence: row.sequence, requestedFrom: row.requested_from, requestedTo: row.requested_to,
  intervals: (row.result.document as { intervals: EntsoeInterval[] }).intervals,
})));
const actuals = resolvedTruth.intervals;
const byId = new Map(observations.map(row => [row.id, row]));
const replay = runs.map(run => {
  const document = <T>(dataset: string): T | null => {
    const row = byId.get(run.source_refs[dataset]);
    return row?.result.status === 'data' ? row.result.document as T : null;
  };
  const inputs = { origin: run.origin,
    actuals: document<{ intervals: EntsoeInterval[] }>('generation_actual')?.intervals ?? [],
    published: document<{ intervals: EntsoeInterval[] }>('wind_day_ahead')?.intervals ?? [],
    weather: document<Parameters<typeof forecastGenerationMix>[0]['weather']>('weather_medium_range'),
  };
  const calculated = run.forecast.algorithm === 'se3-generation-analog-v1' ? forecastGenerationMix(inputs)
    : run.forecast.algorithm === 'se3-generation-analog-v2' ? forecastGenerationMixV2({ ...inputs,
      hydro: document<HydroDocument>('sweden_hydrology'),
      nuclear: { roster: document<NuclearRoster>('installed_generation_units'),
        productionOutages: document<NuclearOutageDocument>('production_outages'),
        generationOutages: document<NuclearOutageDocument>('generation_outages') },
    }) : (() => { throw new Error('Unknown frozen generation forecast algorithm'); })();
  return { id: run.id, matches: isDeepStrictEqual(calculated, run.forecast) };
});
const scores = scoreGenerationRuns(runs.map(run => run.forecast), actuals);
const report = { project: PROBE_PROJECT, generated_at: new Date().toISOString(), runs: runs.length,
  truth_observation_ids: [...new Set(Object.values(resolvedTruth.hourSources))],
  truth_policy: 'Newest acquisition sequence for each whole UTC hour; no cross-vintage filling of gaps or missing types.', replay, scores,
  interpretation: 'Prospective hourly MW errors. Historical weather acquired at each run trains future predictions; it does not establish old forecast skill. Generation accuracy alone does not demonstrate better prices.' };
await Deno.writeTextFile(`${out}/evidence.json`, JSON.stringify({ runs, observations, truth,
  truth_hours: resolvedTruth.hourSources }) + '\n');
await Deno.writeTextFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (replay.some(run => !run.matches)) throw new Error('Frozen generation forecast replay differs');
