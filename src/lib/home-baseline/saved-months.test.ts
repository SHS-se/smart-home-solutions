import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { baselineFixture, captureStub } from './fixture';
import { prepareHomeBaseline, projectBaseline } from './model';
import { comparisonMonthLedger } from './savings';
import { CALCULATION_VERSION, PARTIAL_REFRESH_MS, compactModel, parseSavedReport, type SavedReport, type MonthStore } from './saved-months';
import { createCaptureSource } from './source';
import { createSavingsRun } from './savings-run';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core';

const engine = createWasmPlanner(new Uint8Array(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));
const fixture = baselineFixture({ start: '2026-08-31T22:00:00.000Z', end: '2026-09-30T22:00:00.000Z' });
const input = prepareHomeBaseline(fixture), capture = captureStub({ input, result: projectBaseline(input, engine), engineHash: 'test' });
const ledger = comparisonMonthLedger(capture), model = compactModel(fixture.snapshot), hash = 'a'.repeat(64);
const anchor = { snapshot: fixture.snapshot, earliestStart: fixture.start, latestEnd: fixture.end };
const ref = { homeId: 'home', customerId: 'customer' };
const now = Date.parse('2026-10-11T18:00:00.000Z');
const saved = () => ({ ledger, inputHash: hash, computedAt: new Date(now).toISOString() });
const report = (): SavedReport => ({ generation: 1, version: CALCULATION_VERSION, model, months: { '2026-09': saved() } });

Deno.test('saved report validates compact financial/evidence data and rejects plans and forecast-bearing models', () => {
  assertEquals(parseSavedReport(report()), report());
  const plan = report(); Object.assign(plan.months['2026-09'].ledger, { commands: [] });
  assertThrows(() => parseSavedReport(plan)); delete (plan.months['2026-09'].ledger as unknown as Record<string, unknown>).commands;
  const forecast = report(); forecast.model = structuredClone(model); forecast.model.device_models[0].forecast_w_by_slot = [100];
  assertThrows(() => parseSavedReport(forecast), Error, 'non-physical data');
  const mismatch = report(); mismatch.months['2026-08'] = mismatch.months['2026-09'];
  assertThrows(() => parseSavedReport(mismatch), Error, 'Invalid saved ROI month');
  assert(!JSON.stringify(model).includes('slots'));
});

Deno.test('saved complete months hydrate without anchor/history/native work, while graphs use the saved equipment pin', async () => {
  let anchors = 0, generates = 0, writes = 0;
  const stored = report();
  const store: MonthStore = { read: () => Promise.resolve(stored), pin: () => { throw new Error('Unexpected repin'); },
    save: (_, generation, value) => { assertEquals(generation, 1); writes++; return Promise.resolve({ ...saved(), ledger: value }); } };
  const source = createCaptureSource(ref, { store, now: () => now, resolveAnchor: () => { anchors++; return Promise.resolve(anchor); },
    generate: (_, pinned) => { generates++; assertEquals(pinned.snapshot, model); return Promise.resolve(capture); } });
  const run = createSavingsRun(source); run.setRange('2026-09', '2026-09'); await run.calculate();
  assertEquals([anchors, generates, writes], [0, 0, 0]);
  assertEquals(run.snapshot().rows[0], { month: '2026-09', status: 'done', ledger });
  await source.capture({ view: 'month', start: ledger.start, end: ledger.end }, new AbortController().signal);
  assertEquals([anchors, generates, writes], [1, 1, 1]);
  run.dispose(); source.dispose();
});

Deno.test('partial freshness prevents needless modelling, then forces a new capture; failed refresh retains saved totals', async () => {
  let clock = now, generates = 0, fail = false;
  const stored = report(); stored.months['2026-09'].ledger = { ...ledger, coverage: .5 };
  const store: MonthStore = { read: () => Promise.resolve(stored), pin: () => Promise.resolve(stored),
    save: (_, __, value) => fail ? Promise.reject(new Error('Save unavailable')) : Promise.resolve({ ledger: value, inputHash: hash, computedAt: new Date(clock).toISOString() }) };
  const source = createCaptureSource(ref, { store, now: () => clock, resolveAnchor: () => Promise.resolve(anchor),
    generate: () => { generates++; return Promise.resolve(capture); } });
  const run = createSavingsRun(source); run.setRange('2026-09', '2026-09'); await run.calculate(); assertEquals(generates, 0);
  clock += PARTIAL_REFRESH_MS; fail = true; await run.calculate();
  assertEquals(generates, 1); assertEquals(run.snapshot().rows[0].status, 'done'); assertEquals(run.snapshot().error, '2026-09: Save unavailable');
  fail = false; await run.calculate(); assertEquals(generates, 2); assertEquals(source.saved('2026-09')!.ledger, ledger);
  run.dispose(); source.dispose();
});

Deno.test('durability failures do not publish a new graph or ledger and explicit recalculation replaces the model pin', async () => {
  let stored: SavedReport | null = null, fail = true;
  const store: MonthStore = { read: () => Promise.resolve(stored), pin: (_, snapshot, expected) => {
    assertEquals(expected, stored?.generation ?? null);
    stored = { generation: (stored?.generation ?? 0) + 1, version: CALCULATION_VERSION, model: compactModel(snapshot), months: {} }; return Promise.resolve(stored);
  }, save: (_, generation, value) => {
    assertEquals(generation, stored!.generation);
    if (fail) return Promise.reject(new Error('Save unavailable'));
    const entry = { ...saved(), ledger: value }; stored!.months[value.month] = entry; return Promise.resolve(entry);
  } };
  const source = createCaptureSource(ref, { store, resolveAnchor: () => Promise.resolve(anchor), generate: () => Promise.resolve(capture) });
  const period = { view: 'month' as const, start: ledger.start, end: ledger.end };
  await assertRejects(() => source.capture(period, new AbortController().signal), Error, 'Save unavailable');
  assertEquals(source.summary(period), undefined); assertEquals(source.cached(period), undefined);
  fail = false; await source.capture(period, new AbortController().signal); assertEquals(stored!.generation, 1);
  await source.repin(new AbortController().signal); assertEquals(stored!.generation, 2); assertEquals(stored!.months, {});
  assertEquals(source.cached(period), undefined); assertEquals(source.summary(period), undefined); source.dispose();
});

Deno.test('a calculation finishing after repin cannot save against the newer model generation', async () => {
  let stored = report(), finish: ((value: typeof capture) => void) | undefined, writes = 0;
  const store: MonthStore = { read: () => Promise.resolve(stored), pin: (_, model) => {
    stored = { generation: stored.generation + 1, version: CALCULATION_VERSION, model: compactModel(model), months: {} };
    return Promise.resolve(stored);
  }, save: () => { writes++; return Promise.resolve(saved()); } };
  const source = createCaptureSource(ref, { store, resolveAnchor: () => Promise.resolve(anchor),
    generate: () => new Promise(resolve => { finish = resolve; }) });
  const work = source.capture({ view: 'month', start: ledger.start, end: ledger.end }, new AbortController().signal);
  while (!finish) await new Promise(resolve => setTimeout(resolve,0));
  const rejected = assertRejects(() => work, Error, 'model changed');
  await source.repin(new AbortController().signal);
  finish(capture);
  await rejected;
  assertEquals(writes,0);assertEquals(source.summary({ view:'month',start:ledger.start,end:ledger.end }),undefined);
  source.dispose();
});
