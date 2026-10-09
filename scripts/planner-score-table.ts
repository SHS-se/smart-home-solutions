// The 11-case table of the kronor score, for plans that already exist: each
// report's stored decisions are scored again by today's referee and scorer.
// No planner is run.
//
//   deno task bench:score-table <export.json> <label>=<report.json> [<label>=<report.json> ...]
//
// <export.json> holds { cases: [{ name, dataset, recorded }], rules }. A report
// holds { results: [{ name, record }] }, as `deno task bench:planner-wasm`
// writes it; any file of that shape will do.
import { loadCase } from '../src/lib/planner-bench/case.ts';
import { evaluate } from '../src/lib/planner-bench/evaluate.ts';
import { BASE_LANE } from '../src/lib/planner-bench/lanes.ts';
import type { CriteriaOverrides, PlanRecord } from '../src/lib/planner-bench/types.ts';

const [input, ...reports] = Deno.args;
if (!input || !reports.length || reports.some(r => !r.includes('='))) {
  throw new Error('Usage: deno task bench:score-table <export.json> <label>=<report.json> [<label>=<report.json> ...]');
}
const data: { cases: { name: string; dataset: unknown; recorded: unknown }[]; rules: CriteriaOverrides } = JSON.parse(await Deno.readTextFile(input));
const cases = [...data.cases].sort((a, b) => a.name.localeCompare(b.name));
const kr = (v: number, digits = 2) => v.toFixed(digits).padStart(9);

for (const report of reports) {
  const [label, path] = [report.slice(0, report.indexOf('=')), report.slice(report.indexOf('=') + 1)];
  const stored: { results: { name: string; record: PlanRecord }[] } = JSON.parse(await Deno.readTextFile(path));
  console.log(`\n${label}`);
  console.log(`${'case'.padEnd(9)}${'points'.padStart(9)}${'grid'.padStart(9)}${'wear'.padStart(9)}${'stores'.padStart(9)}  (${'battery'.padStart(8)}${'pool'.padStart(8)}${'car'.padStart(8)})${'deduct'.padStart(8)}  rules charged`);
  const total = { points: 0, grid: 0, wear: 0, credit: 0, battery: 0, pool: 0, ev: 0, deductions: 0 };
  let missing = 0;
  for (const scenario of cases) {
    const record = stored.results.find(r => r.name === scenario.name)?.record;
    if (!record) { console.log(`${scenario.name.padEnd(9)} no stored plan`); missing++; continue; }
    const c = loadCase(scenario.dataset, scenario.recorded);
    const { score, series } = evaluate(c, record, data.rules, BASE_LANE);
    const credit = series.bill!.credit;
    const stores = [credit.battery?.credit_sek ?? 0, credit.pool?.credit_sek ?? 0, credit.ev?.credit_sek ?? 0];
    total.points += score.points; total.grid += score.grid_sek; total.wear += score.wear_sek; total.credit += score.credit_sek;
    total.battery += stores[0]; total.pool += stores[1]; total.ev += stores[2]; total.deductions += score.sum;
    const charged = Object.entries(score.counts).map(([key, count]) => `${key}×${count}`).join(' ');
    console.log(`${scenario.name.padEnd(9)}${kr(score.points)}${kr(score.grid_sek)}${kr(score.wear_sek)}${kr(score.credit_sek)}  (${stores.map(v => v.toFixed(1).padStart(8)).join('')})${String(score.sum).padStart(8)}  ${charged}${score.required_fired.length ? ` REQUIRED ${score.required_fired.join(',')}` : ''}${score.physical_failed ? ' PHYSICAL FAILURE' : ''}`);
  }
  console.log(`${'total'.padEnd(9)}${kr(total.points)}${kr(total.grid)}${kr(total.wear)}${kr(total.credit)}  (${[total.battery, total.pool, total.ev].map(v => v.toFixed(1).padStart(8)).join('')})${String(total.deductions).padStart(8)}${missing ? `  ${missing} case(s) without a plan: not a full comparison` : ''}`);
}
