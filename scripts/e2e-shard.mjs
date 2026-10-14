// Prints the Playwright --test-list for one CI browser-test shard.
// Usage: node scripts/e2e-shard.mjs INDEX/COUNT > shard.txt
//        npm run test:e2e:local -- --test-list shard.txt
//
// Playwright's own --shard cuts the ordered test list into equal counts, which
// puts the adjacent multi-minute ROI tests in one shard. This balances by
// measured duration instead, the way scripts/run-unit-tests.ts balances files.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Seconds per test from the 2026-10-14 CI log (two workers per shard). These
// are scheduling weights, never a filter on which tests run; unlisted tests
// count as DEFAULT_COST.
const COSTS = {
  'ROI May–August sensor gaps generate, and month graphs use the same ledgers as ROI': 174,
  'ROI reloads durable monthly totals without fetching history or generating charts': 102,
  'the estimate holds one pool temperature in both columns, and changing it recalculates': 60,
  'ROI only mounts shared charts on request, auto-navigates 72-hour frames and caches them': 42,
  'the track record counts only full months SHS controlled, against the estimate for those months': 40,
  'ROI retains saved months when new prices are unavailable and keeps graph navigation usable': 39,
  'customer ROI uses optimizer replay and original bills, with subscription only in ROI': 39,
  'the model check prices metered use like an itemised invoice, both without the demand charge': 27,
  'delayed meter energy is disclosed as an estimated interval average in the actual chart': 21,
  'ROI recovers an empty month from hourly history and uses the same costs in its graph': 16,
  'shows a rescore queued, then running on the plan it is at, then done': 10,
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
