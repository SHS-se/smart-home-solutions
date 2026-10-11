import type { generateHomeBaseline, ComparisonCapture } from './browser';
import type { resolveBaselineAnchor, HomeRef } from './history';
import { periodKey, type BaselineAnchor, type BaselinePeriod } from './period';
import { comparisonMonthLedger, type MonthLedger } from './savings';
import { CALCULATION_VERSION, type MonthStore, type SavedReport } from './saved-months.ts';

interface Job { controller: AbortController; promise: Promise<ComparisonCapture>; waiters: Set<symbol> }

/** One home owns its pinned models, eight full captures and shared in-flight generation. */
export function createCaptureSource(ref: HomeRef | null, dependencies: { resolveAnchor: typeof resolveBaselineAnchor; generate: typeof generateHomeBaseline; store?: MonthStore; now?: () => number }) {
  const lifetime = new AbortController(), cache = new Map<string, ComparisonCapture>(), jobs = new Map<string, Job>();
  const summaries = new Map<string, MonthLedger>();
  const summaryListeners = new Set<(ledger: MonthLedger) => void>();
  let anchorPromise: Promise<BaselineAnchor> | null = null;
  let report: SavedReport | null = null, hydration: Promise<SavedReport | null> | null = null;
  const hydrate = (): Promise<SavedReport | null> => {
    if (!hydration) hydration = (!ref || !dependencies.store ? Promise.resolve<SavedReport | null>(null) : dependencies.store.read(ref, lifetime.signal)).then(saved => {
      report = saved;
      for (const value of Object.values(saved?.months ?? {})) summaries.set(periodKey({ view: 'month', start: value.ledger.start, end: value.ledger.end }), value.ledger);
      return saved;
    }).catch(error => { hydration = null; throw error; });
    return hydration;
  };
  const anchor = (refresh = false) => {
    if (!ref) return Promise.reject(new Error('Select a home'));
    lifetime.signal.throwIfAborted();
    if (refresh) anchorPromise = null;
    if (!anchorPromise) anchorPromise = hydrate().then(async () => {
      const current = await dependencies.resolveAnchor(ref, lifetime.signal);
      if (!report && dependencies.store) report = await dependencies.store.pin(ref, current.snapshot, null, lifetime.signal);
      return { ...current, snapshot: report?.model ?? current.snapshot };
    }).catch(error => { anchorPromise = null; throw error; });
    return anchorPromise;
  };
  const cached = (period: BaselinePeriod) => {
    const key = periodKey(period), capture = cache.get(key);
    if (capture) { cache.delete(key); cache.set(key, capture); }
    return capture;
  };
  return {
    subscribeSummary: (listener: (ledger: MonthLedger) => void) => { summaryListeners.add(listener); return () => { summaryListeners.delete(listener); }; },
    anchor, hydrate, cached, summary: (period: BaselinePeriod) => summaries.get(periodKey(period)),
    saved: (month: string) => report?.months[month],
    modelCapturedAt: () => report?.model.captured_at,
    now: dependencies.now ?? Date.now,
    repin: async (signal: AbortSignal) => {
      if (!ref) throw new Error('Select a home');
      await hydrate(); signal.throwIfAborted();
      const current = await dependencies.resolveAnchor(ref, signal);
      if (dependencies.store) report = await dependencies.store.pin(ref, current.snapshot, report?.generation ?? null, signal);
      jobs.forEach(job => job.controller.abort()); jobs.clear(); cache.clear(); summaries.clear();
      anchorPromise = Promise.resolve({ ...current, snapshot: report?.model ?? current.snapshot });
    },
    capture: async (period: BaselinePeriod, signal: AbortSignal, fresh = false): Promise<ComparisonCapture> => {
      if (!ref) throw new Error('Select a home');
      signal.throwIfAborted(); lifetime.signal.throwIfAborted();
      if (!fresh) { const found = cached(period); if (found) return found; }
      const key = periodKey(period);
      if (fresh) cache.delete(key);
      let job = jobs.get(key);
      if (!job) {
        const controller = new AbortController();
        const own: Job = { controller, waiters: new Set(),
          promise: anchor().then(pinned => { controller.signal.throwIfAborted(); return dependencies.generate(ref, pinned, period, controller.signal); })
          .then(async capture => {
            controller.signal.throwIfAborted(); lifetime.signal.throwIfAborted();
            if (jobs.get(key) === own && !controller.signal.aborted && !lifetime.signal.aborted && own.waiters.size) {
              if (period.view === 'month') {
                let ledger = comparisonMonthLedger(capture);
                if (dependencies.store) {
                  const bytes = new TextEncoder().encode(JSON.stringify({ version: CALCULATION_VERSION, problem: capture.input.problem,
                    ev: capture.input.evDemandKwh, evidence: capture.input.evidence, recorded: capture.input.recorded, ledger }));
                  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
                  controller.signal.throwIfAborted();
                  const saved = await dependencies.store.save(ref, report!.generation, ledger, hash, report!.months[ledger.month]?.inputHash ?? null, controller.signal);
                  controller.signal.throwIfAborted(); lifetime.signal.throwIfAborted();
                  report!.months[ledger.month] = saved; ledger = saved.ledger;
                }
                summaries.set(key, ledger);
                summaryListeners.forEach(listener => listener(ledger));
              }
              cache.set(key, capture);
              if (cache.size > 8) cache.delete(cache.keys().next().value!);
            }
            return capture;
          }).finally(() => { if (jobs.get(key) === own) jobs.delete(key); }) };
        jobs.set(key, own); job = own;
      }
      const own = job, token = Symbol(); own.waiters.add(token);
      return new Promise((resolve, reject) => {
        const release = () => {
          signal.removeEventListener('abort', cancel); own.waiters.delete(token);
          if (!own.waiters.size && jobs.get(key) === own) { own.controller.abort(); jobs.delete(key); }
        };
        const cancel = () => { release(); reject(new DOMException('Cancelled', 'AbortError')); };
        signal.addEventListener('abort', cancel, { once: true });
        own.promise.then(value => { release(); if (!signal.aborted) resolve(value); }, error => { release(); reject(error); });
      });
    },
    dispose: () => { lifetime.abort(); jobs.forEach(job => job.controller.abort()); jobs.clear(); cache.clear(); summaries.clear(); summaryListeners.clear(); },
  };
}
export type CaptureSource = ReturnType<typeof createCaptureSource>;
