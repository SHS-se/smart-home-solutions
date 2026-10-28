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
const report = (): SavedReport => ({ generation: 1, version: CALCULATION_VERSION, model, months: { '2026-09': saved() }, checkpoints: {} });

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
    save: (_, generation, value) => { assertEquals(generation, 1); writes++; return Promise.resolve({ ...stored, months: { ...stored.months, [value.month]: { ...saved(), ledger: value } } }); } };
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
    save: (_, __, value) => fail ? Promise.reject(new Error('Save unavailable')) : Promise.resolve({ ...stored, months: { ...stored.months, [value.month]: { ledger: value, inputHash: hash, computedAt: new Date(clock).toISOString() } } }) };
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
    stored = { generation: (stored?.generation ?? 0) + 1, version: CALCULATION_VERSION, model: compactModel(snapshot), months: {}, checkpoints: {} }; return Promise.resolve(stored);
  }, save: (_, generation, value) => {
    assertEquals(generation, stored!.generation);
    if (fail) return Promise.reject(new Error('Save unavailable'));
    const entry = { ...saved(), ledger: value }; stored!.months[value.month] = entry; return Promise.resolve(stored!);
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
    stored = { generation: stored.generation + 1, version: CALCULATION_VERSION, model: compactModel(model), months: {}, checkpoints: {} };
    return Promise.resolve(stored);
  }, save: () => { writes++; return Promise.resolve(stored); } };
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

Deno.test('server month eviction removes stale local save hashes before an uncached month is calculated again', async () => {
  // Synthetic receipts reproduce the SQL's twelve-month retention contract.
  let stored: SavedReport = { ...report(), months: {} }, sequence = 0;
  const store: MonthStore = {
    read: () => Promise.resolve(structuredClone(stored)),
    pin: () => Promise.resolve(structuredClone(stored)),
    save: (_, generation, value, inputHash, expectedHash) => {
      assertEquals(generation, stored.generation);
      assertEquals(expectedHash, stored.months[value.month]?.inputHash ?? null, 'A pruned server month must not retain a local compare-and-swap hash');
      stored.months[value.month] = { ledger: value, inputHash, computedAt: new Date(now + sequence++ * 1000).toISOString() };
      const newest = Object.entries(stored.months).sort((a, b) => b[1].computedAt.localeCompare(a[1].computedAt)).slice(0, 12);
      stored = { ...stored, months: Object.fromEntries(newest) };
      return Promise.resolve(structuredClone(stored));
    },
  };
  const source = createCaptureSource(ref, { store, resolveAnchor: () => Promise.resolve({ ...anchor, earliestStart: '2025-09-01T00:00:00.000Z' }),
    generate: (_, __, period) => Promise.resolve({ ...capture, input: { ...capture.input, timeZone: 'UTC', start: period.start, end: period.end },
      result: { ...capture.result, ledger: { ...capture.result.ledger, costSek: sequence } } }) });
  try {
    const months = Array.from({ length: 13 }, (_, index) => {
      const start = new Date(Date.UTC(2025, 8 + index, 1)).toISOString();
      const end = new Date(Date.UTC(2025, 9 + index, 1)).toISOString();
      // This test's timestamps are UTC calendar months, with a matching synthetic timezone.
      return { view: 'month' as const, start, end };
    });
    for (const period of months) await source.capture(period, new AbortController().signal);
    assertEquals(Object.keys(stored.months).length, 12);
    assertEquals(source.saved('2025-09'), undefined);
    assertEquals(source.cached(months[0]), undefined);
    await source.capture(months[0], new AbortController().signal);
    assertEquals(source.saved('2025-09')?.inputHash, stored.months['2025-09'].inputHash);
  } finally { source.dispose(); }
});

for (const firstMonth of ['2026-09', '2026-10']) Deno.test(`concurrent graph and month captures consume canonical report receipts with ${firstMonth} saving first`, async () => {
  const stored: SavedReport = { ...report(), months: {} };
  const months = ['2026-09', '2026-10'];
  const generated = months.map(() => Promise.withResolvers<void>());
  const entered = months.map(() => Promise.withResolvers<void>());
  const releases = months.map(() => Promise.withResolvers<void>());
  const started: string[] = [];
  const store: MonthStore = {
    read: () => Promise.resolve(structuredClone(stored)), pin: () => Promise.resolve(structuredClone(stored)),
    save: async (_, __, value, inputHash, expectedHash) => {
      const index = started.length;
      started.push(value.month);
      entered[index].resolve();
      await releases[index].promise;
      assertEquals(expectedHash, stored.months[value.month]?.inputHash ?? null);
      stored.months[value.month] = { ledger: value, inputHash, computedAt: new Date(now).toISOString() };
      return structuredClone(stored);
    },
  };
  const source = createCaptureSource(ref, { store, resolveAnchor: () => Promise.resolve(anchor),
    generate: async (_, __, period) => {
      await generated[months.indexOf(period.start.slice(0, 7))].promise;
      return { ...capture, input: { ...capture.input, timeZone: 'UTC', start: period.start, end: period.end } };
    } });
  const pending = months.map((month, index) => source.capture({ view: 'month', start: `${month}-01T00:00:00.000Z`,
    end: index === 0 ? '2026-10-01T00:00:00.000Z' : '2026-11-01T00:00:00.000Z' }, new AbortController().signal));
  const completed = Promise.all(pending);
  // Observe failures immediately, including when an assertion exits before a save is released.
  const settled = Promise.allSettled(pending);
  const first = months.indexOf(firstMonth), second = 1 - first;
  try {
    generated[first].resolve();
    await Promise.race([entered[0].promise, completed]);
    assertEquals(started, [firstMonth]);
    generated[second].resolve();
    releases[0].resolve(); await pending[first];
    await Promise.race([entered[1].promise, completed]);
    assertEquals(started, [firstMonth, months[second]]);
    releases[1].resolve(); await completed;
    assertEquals(source.saved('2026-09'), stored.months['2026-09']);
    assertEquals(source.saved('2026-10'), stored.months['2026-10']);
  } finally {
    generated.forEach(gate => gate.resolve());
    releases.forEach(gate => gate.resolve());
    await settled;
    source.dispose();
  }
});
