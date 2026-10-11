import { assert, assertEquals, assertRejects } from '@std/assert';
import { createCaptureSource } from './source';
import { createSavingsRun } from './savings-run';
import { createBaselineSession } from './session';
import { baselineFixture } from './fixture';
import { prepareHomeBaseline, projectBaseline } from './model';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core';
import { monthPeriod, type BaselinePeriod } from './period';
import type { BaselineCapture } from './browser';

const engine = createWasmPlanner(new Uint8Array(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));
const fixture = baselineFixture(), input = prepareHomeBaseline(fixture);
const initial = { input, result: projectBaseline(input, engine), engineHash: 'test' };
const anchor = { snapshot: fixture.snapshot, earliestStart: '2026-01-01T00:00:00.000Z', latestEnd: fixture.end };
const at = (period: BaselinePeriod, cost = 100): BaselineCapture => ({ ...initial, input: { ...input, start: period.start, end: period.end }, result: { ...initial.result, ledger: { ...initial.result.ledger, costSek: cost } } });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function harness() {
  let anchors = 0;
  const calls: { period: BaselinePeriod; signal: AbortSignal; resolve: (c: BaselineCapture) => void; reject: (e: Error) => void }[] = [];
  const source = createCaptureSource({ homeId: 'home', customerId: 'customer' }, {
    resolveAnchor: () => { anchors++; return Promise.resolve(anchor); },
    generate: (_, __, period, signal) => new Promise((resolve, reject) => { calls.push({ period, signal, resolve, reject }); }),
  });
  return { source, calls, anchors: () => anchors };
}

Deno.test('shared month generation survives one consumer cancelling and pins one home anchor', async () => {
  const { source, calls, anchors } = harness(), period = monthPeriod(anchor, '2026-09')!;
  const firstController = new AbortController(), secondController = new AbortController();
  const first = source.capture(period, firstController.signal), second = source.capture(period, secondController.signal);
  await settle(); assertEquals(calls.length, 1);
  const cancelled = assertRejects(() => first, DOMException); firstController.abort(); await cancelled;
  assert(!calls[0].signal.aborted);
  calls[0].resolve(at(period)); await second;
  assertEquals(anchors(), 1); assertEquals(source.cached(period)?.input.start, period.start);
  source.dispose();
});

Deno.test('last consumer cancellation and disposal prevent late results entering shared caches', async () => {
  const { source, calls } = harness(), period = monthPeriod(anchor, '2026-09')!, controller = new AbortController();
  const first = source.capture(period, controller.signal); await settle();
  const cancelled = assertRejects(() => first, DOMException); controller.abort(); await cancelled;
  assert(calls[0].signal.aborted); calls[0].resolve(at(period)); await settle();
  assertEquals(source.cached(period), undefined); assertEquals(source.summary(period), undefined);
  const second = source.capture(period, new AbortController().signal); await settle();
  const disposed = assertRejects(() => second, DOMException); source.dispose(); calls[1].resolve(at(period)); await disposed;
  assertEquals(source.cached(period), undefined);
});

Deno.test('compact summaries survive eight chart eviction and fresh generation replaces the canonical summary', async () => {
  const { source, calls } = harness();
  for (let m = 1; m <= 9; m++) {
    const period = monthPeriod(anchor, `2026-${String(m).padStart(2, '0')}`)!;
    const work = source.capture(period, new AbortController().signal); await settle();
    calls[m - 1].resolve(at(period)); await work;
  }
  const first = monthPeriod(anchor, '2026-01')!;
  assertEquals(source.cached(first), undefined); assertEquals(source.summary(first)?.baseline.costSek, 100);
  const fresh = source.capture(first, new AbortController().signal, true); await settle();
  assertEquals(source.summary(first)?.baseline.costSek, 100);
  calls[9].resolve(at(first, 200)); await fresh;
  assertEquals(source.summary(first)?.baseline.costSek, 200); source.dispose();
});

Deno.test('monthly errors are isolated, charts join batch work, and subscription-independent results reuse summaries', async () => {
  const { source, calls } = harness(), run = createSavingsRun(source), viewer = createBaselineSession(source);
  run.setRange('2026-08', '2026-10'); assertEquals(calls.length, 0);
  const report = run.calculate(); await settle(); calls[0].reject(new Error('Missing import price')); await settle();
  assertEquals(run.snapshot().rows[0].status, 'failed'); assertEquals(calls.length, 2);
  const view = viewer.showMonth('2026-09'); await settle(); assertEquals(calls.length, 2);
  viewer.dispose(); assert(!calls[1].signal.aborted);
  calls[1].resolve(at(calls[1].period)); await settle();
  calls[2].resolve(at(calls[2].period)); await report; await view;
  assertEquals(run.snapshot().rows.map(row => row.status), ['failed', 'done', 'done']);
  const again = run.calculate(); await settle(); assertEquals(calls.length, 4);
  calls[3].resolve(at(calls[3].period)); await again;
  assertEquals(calls.length, 4); assertEquals(run.snapshot().rows.every(row => row.status === 'done'), true);
  run.dispose(); source.dispose();
});

Deno.test('range change cancels old batch interest and suppresses stale rows; future months require no reads', async () => {
  const { source, calls } = harness(), run = createSavingsRun(source);
  run.setRange('2026-08', '2026-09'); const old = run.calculate(); await settle();
  run.setRange('2026-10', '2026-11'); assert(calls[0].signal.aborted);
  const work = run.calculate(); await settle();
  calls[0].resolve(at(calls[0].period)); await old;
  assertEquals(run.snapshot().rangeKey, '2026-10|2026-11');
  calls[1].resolve(at(calls[1].period)); await work;
  assertEquals(run.snapshot().rows.map(row => row.status), ['done', 'unavailable']);
  const unchanged = run.snapshot(); run.dispose(); source.dispose(); await run.calculate(); assertEquals(run.snapshot(), unchanged);
});

Deno.test('refreshing a graph replaces the monthly report with the same canonical summary', async () => {
  const { source, calls } = harness(), run = createSavingsRun(source);
  run.setRange('2026-09', '2026-09');
  const work = run.calculate(); await settle(); calls[0].resolve(at(calls[0].period, 100)); await work;
  const fresh = source.capture(calls[0].period, new AbortController().signal, true); await settle();
  calls[1].resolve(at(calls[1].period, 200)); await fresh;
  const row = run.snapshot().rows[0];
  assert(row.status === 'done'); assertEquals(row.ledger, source.summary(calls[0].period));
  assertEquals(row.ledger.baseline.costSek, 200); run.dispose(); source.dispose();
});
