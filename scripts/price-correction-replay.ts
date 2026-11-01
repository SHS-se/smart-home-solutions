/** Offline comparison on original issue-time inputs. Keep measured output outside the public repo. */
import { isDeepStrictEqual } from 'node:util';
import { buildPriceCorrection, PRICE_CORRECTION_ALGORITHM, type PriceCorrectionForecast,
  type PriceCorrectionInput } from '../supabase/functions/_shared/price-correction.ts';
import { buildPriceCorrectionV2 } from '../supabase/functions/_shared/price-correction-v2.ts';

interface FrozenRun { id: string; context: PriceCorrectionInput; forecast: PriceCorrectionForecast | null }
interface Outcome { pair_id: string; start_ts: string; target_day: string; lead_day: number;
  reduced: number; full: number; actual: number }
interface Sample { run: string; day: string; lead: number; actual: number; wind: number; v1: number; v2: number }
const MODELS = ['wind', 'v1', 'v2'] as const;
type Model = typeof MODELS[number];

function metrics(rows: readonly Sample[], model: Model) {
  const groups = new Map<string, Sample[]>();
  const dates = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.run}/${row.day}`;
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    const errors = dates.get(row.day) ?? []; errors.push(Math.abs(row[model] - row.actual)); dates.set(row.day, errors);
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const levels: number[] = [], shapes: number[] = [];
  const regrets = new Map([8, 16, 32].map(count => [count, [] as number[]]));
  for (const group of groups.values()) {
    const predicted = mean(group.map(row => row[model])), actual = mean(group.map(row => row.actual));
    levels.push(Math.abs(predicted - actual));
    shapes.push(...group.map(row => Math.abs(row[model] - predicted - (row.actual - actual))));
    for (const [count, values] of regrets) {
      if (group.length < count) continue;
      const chosen = [...group].sort((a, b) => a[model] - b[model]).slice(0, count);
      const best = [...group].sort((a, b) => a.actual - b.actual).slice(0, count);
      values.push(mean(chosen.map(row => row.actual)) - mean(best.map(row => row.actual)));
    }
  }
  return { quarters: rows.length, origins: new Set(rows.map(row => row.run)).size, targetDays: dates.size,
    mae: mean(rows.map(row => Math.abs(row[model] - row.actual))),
    bias: mean(rows.map(row => row[model] - row.actual)),
    targetDateBalancedMae: mean([...dates.values()].map(mean)),
    dayMeanMae: mean(levels), centeredShapeMae: mean(shapes),
    cheapQuarterRegret: Object.fromEntries([...regrets].map(([count, values]) => [count, values.length ? mean(values) : null])),
  };
}

export function compareFrozenPriceCorrections(runs: readonly FrozenRun[], outcomes: readonly Outcome[]) {
  const byRun = new Map<string, { v1: Map<number, number>; v2: Map<number, number> }>();
  let replayed = 0;
  for (const run of runs) {
    if (!run.forecast || run.forecast.algorithm !== PRICE_CORRECTION_ALGORITHM) continue;
    if (!isDeepStrictEqual(buildPriceCorrection(run.context), run.forecast)) throw new Error(`Saved v1 replay differs: ${run.id}`);
    const v2 = buildPriceCorrectionV2(run.context);
    const predictions = (targets: PriceCorrectionForecast['targets']) => new Map(targets.flatMap(row => row.corrected === null ? [] : [[Date.parse(row.start), row.corrected] as const]));
    byRun.set(run.id, { v1: predictions(run.forecast.targets), v2: predictions(v2.targets) }); replayed++;
  }
  const samples: Sample[] = [];
  for (const row of outcomes) {
    const pair = byRun.get(row.pair_id);
    if (!pair) continue;
    const at = Date.parse(row.start_ts), v1 = pair.v1.get(at), v2 = pair.v2.get(at);
    if (v1 === undefined || v2 === undefined || ![row.reduced, row.full, row.actual].every(Number.isFinite)) throw new Error('Missing common scored prediction');
    if (v1 !== row.full) throw new Error('Outcome differs from the frozen v1 forecast');
    samples.push({ run: row.pair_id, day: row.target_day, lead: row.lead_day, actual: row.actual, wind: row.reduced, v1, v2 });
  }
  if (!samples.length) throw new Error('No common scored quarters');
  const summary = (rows: Sample[]) => Object.fromEntries(MODELS.map(model => [model, metrics(rows, model)]));
  const beyondTomorrow = samples.filter(row => row.lead === 2 || row.lead === 3);
  return { evidence: 'retrospective-frozen-origin-replay', prospective: false,
    selectionWarning: 'V2 was selected using these dates. Every refit uses only its original frozen training evidence; the next prospective week is independent validation.',
    replayed, all: summary(samples), d2d3: beyondTomorrow.length ? summary(beyondTomorrow) : null,
    byLead: Object.fromEntries([...new Set(samples.map(row => row.lead))].sort().map(lead => [lead, summary(samples.filter(row => row.lead === lead))])),
    byTargetDate: Object.fromEntries([...new Set(samples.map(row => row.day))].sort().map(day => [day, summary(samples.filter(row => row.day === day))])),
    costWarning: 'Cheap-quarter regret is a ranking proxy over scored masks, not a household-planner saving. Partial days remain partial.',
  };
}

if (import.meta.main) {
  if (Deno.args.length !== 4 || Deno.args[0] !== '--input' || Deno.args[2] !== '--out') throw new Error('Usage: price-correction-replay.ts --input PRIVATE_DIRECTORY --out NEW_PRIVATE_DIRECTORY');
  const input = Deno.args[1], out = Deno.args[3];
  const report = compareFrozenPriceCorrections(JSON.parse(await Deno.readTextFile(`${input}/runs.json`)),
    JSON.parse(await Deno.readTextFile(`${input}/outcomes.json`)));
  await Deno.mkdir(out);
  await Deno.writeTextFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ replayed: report.replayed, all: report.all, d2d3: report.d2d3, prospective: false }, null, 2));
}
