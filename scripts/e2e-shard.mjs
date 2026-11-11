// Prints the Playwright --test-list for one CI browser-test shard.
// Usage: node scripts/e2e-shard.mjs INDEX/COUNT > shard.txt
//        npm run test:e2e:local -- --test-list shard.txt
//
// Playwright's own --shard cuts the ordered test list into equal counts, which
// puts the adjacent multi-minute ROI tests in one shard. This balances by
// measured duration instead, the way scripts/run-unit-tests.ts balances files.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Seconds per test from CI run 43061174266. These are scheduling weights,
// never a filter on which tests run; unlisted tests count as DEFAULT_COST.
const COSTS = {
  'ROI May–August sensor gaps generate, and month graphs use the same ledgers as ROI': 72,
  'ROI reloads durable monthly totals without fetching history or generating charts': 66,
  'equipment comparison keeps the in-progress month when newer readings arrive after the reference was saved': 66,
  'the estimate holds one pool temperature in both columns, and changing it recalculates': 41,
  'reloaded equipment trials never save reference months and retain sizes through calculation failure and reload': 40,
  'a full ROI month completes with bounded native projection memory': 26,
  'equipment sizing reads published nameplates and supports zero solar and battery': 24,
  'ROI retains saved months when new prices are unavailable and keeps graph navigation usable': 24,
  'ROI only mounts shared charts on request, auto-navigates 72-hour frames and caches them': 23,
  'customer ROI uses optimizer replay and original bills, with subscription only in ROI': 23,
  'equipment trials rerun solar, inverter and battery physics without replacing the saved home report': 21,
  'the track record counts only full months SHS controlled, against the estimate for those months': 17,
  'the model check prices metered use like an itemised invoice, both without the demand charge': 17,
  'ROI recovers an empty month from hourly history and uses the same costs in its graph': 11,
  'shows a rescore queued, then running on the plan it is at, then done': 10,
  'planning toggles preserve methods across Monitoring and reload without rewriting existing choices': 10,
  'delayed meter energy is disclosed as an estimated interval average in the actual chart': 9,
};
const DEFAULT_COST = 3;

/** Every test in the local suite as `[project] › file › describe… › title`. */
export function listTests() {
  const report = JSON.parse(execFileSync('npx', [
    'playwright', 'test', '--config', 'playwright.local.config.ts', '--list', '--reporter=json',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const tests = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) tests.push({ project: test.projectName, file: spec.file, titles: [...titles, spec.title] });
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites) walk(file, []);
  return tests;
}

/** Longest-first greedy assignment; returns one sorted test-list line array per shard. */
export function shardTests(tests, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Shard count must be a positive integer');
  const lines = [...new Set(tests.map(({ project, file, titles }) => {
    for (const part of [file, ...titles]) {
      if (part.includes('›')) throw new Error(`Test titles cannot contain ›: ${part}`);
    }
    return [`[${project}]`, file, ...titles].join(' › ');
  }))];
  const cost = line => COSTS[line.slice(line.lastIndexOf(' › ') + 3)] ?? DEFAULT_COST;
  /** @type {{ cost: number, lines: string[] }[]} */
  const shards = Array.from({ length: count }, () => ({ cost: 0, lines: [] }));
  lines.sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const line of lines) {
    const next = shards.reduce((best, shard) => shard.cost < best.cost ? shard : best);
    next.lines.push(line);
    next.cost += cost(line);
  }
  return shards.map(shard => shard.lines.sort());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const match = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? '');
  if (!match) throw new Error('Usage: node scripts/e2e-shard.mjs INDEX/COUNT');
  const index = Number(match[1]), count = Number(match[2]);
  if (index < 1 || index > count) throw new Error('Shard index must be between 1 and COUNT');
  const tests = listTests();
  const selected = shardTests(tests, count)[index - 1];
  if (!selected.length) throw new Error('Browser test shard is empty');
  console.error(`Browser test shard ${index}/${count}: ${selected.length} of ${tests.length} tests`);
  console.log(selected.join('\n'));
}
