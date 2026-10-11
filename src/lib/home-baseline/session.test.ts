import { assert, assertEquals } from '@std/assert';
import { createBaselineSession } from './session';
import { createCaptureSource } from './source';
import type { BaselineCapture } from './browser';
import { baselineFixture } from './fixture';
import { prepareHomeBaseline, projectBaseline } from './model';
import type { BaselinePeriod } from './period';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core';

const engine = createWasmPlanner(new Uint8Array(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));
const fixture = baselineFixture();
const initialInput = prepareHomeBaseline(fixture);
const initial: BaselineCapture = { input: initialInput, result: projectBaseline(initialInput, engine), engineHash: 'test' };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const ref = { homeId: 'home', customerId: 'customer' };
const capture = (p: BaselinePeriod) => ({ ...initial, input: { ...initial.input, start: p.start, end: p.end } });

function harness() {
  let anchorReads = 0;
  const calls: { period: BaselinePeriod; signal: AbortSignal; resolve: (value: BaselineCapture) => void; reject: (error: Error) => void }[] = [];
  const source = createCaptureSource(ref, {
    resolveAnchor: () => { anchorReads++; return Promise.resolve({ snapshot: fixture.snapshot, latestEnd: fixture.end }); },
    generate: (_, __, period, signal) => new Promise<BaselineCapture>((resolve, reject) => { calls.push({ period, signal, resolve, reject }); }),
  });
  const session = createBaselineSession(source);
  return { session, calls, anchorReads: () => anchorReads };
}

Deno.test('session stays lazy until Generate, then uncached navigation auto-loads and cached targets display synchronously', async () => {
  const { session, calls, anchorReads } = harness();
  await session.setView('month');
  assertEquals(anchorReads(), 0);
  await session.setView('frame');
  const first = session.generate(); await settle();
  assertEquals(calls.length, 1);
  calls[0].resolve(capture(calls[0].period)); await first;
  const previous = session.step(-1); await settle();
  assertEquals(calls.length, 2);
  assert(session.snapshot().busy);
  calls[1].resolve(capture(calls[1].period)); await previous;
  const next = session.step(1);
  assertEquals(session.snapshot().capture!.input.end, fixture.end);
  assertEquals(session.snapshot().busy, false);
  await next;
  assertEquals(calls.length, 2);
  assertEquals(anchorReads(), 1);
  session.dispose();
});

Deno.test('rapid navigation cancels superseded work and never caches a late stale result', async () => {
  const { session, calls } = harness();
  const first = session.generate(); await settle();
  calls[0].resolve(capture(calls[0].period)); await first;
  const old = session.step(-1); await settle();
  const latest = session.step(-1); await settle();
  assert(calls[1].signal.aborted);
  calls[2].resolve(capture(calls[2].period)); await latest;
  const chosen = session.snapshot();
  calls[1].resolve(capture(calls[1].period)); await old;
  assertEquals(session.snapshot(), chosen);
  const back = session.step(1); await settle();
  assertEquals(calls.length, 4); // Late result was not admitted to the cache.
  calls[3].resolve(capture(calls[3].period)); await back;
  session.dispose();
});

Deno.test('month switching and previous/next month automatically generate exact periods', async () => {
  const { session, calls } = harness();
  const first = session.generate(); await settle();
  calls[0].resolve(capture(calls[0].period)); await first;
  const month = session.setView('month'); await settle();
  assertEquals(calls[1].period.start, '2026-09-30T22:00:00.000Z');
  assertEquals(calls[1].period.end, fixture.end);
  calls[1].resolve(capture(calls[1].period)); await month;
  assertEquals(session.snapshot().canNext, false);
  const previous = session.step(-1); await settle();
  assertEquals(calls[2].period.start, '2026-08-31T22:00:00.000Z');
  assertEquals(calls[2].period.end, '2026-09-30T22:00:00.000Z');
  calls[2].resolve(capture(calls[2].period)); await previous;
  await session.step(1);
  assertEquals(calls.length, 3);
  assertEquals(session.snapshot().capture!.input.start, calls[1].period.start);
  session.dispose();
});

Deno.test('a failed period leaves auto-navigation armed; disposal cancels and ignores pending completion', async () => {
  const { session, calls, anchorReads } = harness();
  const first = session.generate(); await settle();
  calls[0].reject(new Error('Missing history')); await first;
  assertEquals(session.snapshot().error, 'Missing history');
  assert(session.snapshot().canPrevious);
  const previous = session.step(-1); await settle();
  assertEquals(calls.length, 2);
  session.dispose();
  assert(calls[1].signal.aborted);
  const state = session.snapshot();
  calls[1].resolve(capture(calls[1].period)); await previous;
  assertEquals(session.snapshot(), state);
  assertEquals(anchorReads(), 1);
});

Deno.test('cache is bounded and Generate refreshes the selected target using pinned models', async () => {
  const { session, calls, anchorReads } = harness();
  const first = session.generate(); await settle();
  calls[0].resolve(capture(calls[0].period)); await first;
  for (let i = 1; i <= 8; i++) {
    const previous = session.step(-1); await settle();
    calls[i].resolve(capture(calls[i].period)); await previous;
  }
  for (let i = 0; i < 7; i++) await session.step(1);
  const evicted = session.step(1); await settle();
  assertEquals(calls.length, 10);
  calls[9].resolve(capture(calls[9].period)); await evicted;
  const refresh = session.generate(); await settle();
  assertEquals(calls.length, 11);
  calls[10].resolve(capture(calls[10].period)); await refresh;
  assertEquals(anchorReads(), 1);
  session.dispose();
});
