import type { generateHomeBaseline, BaselineCapture } from './browser';
import type { resolveBaselineAnchor, HomeRef } from './history';
import { periodKey, type BaselineAnchor, type BaselinePeriod } from './period';
import { monthLedger, type MonthLedger } from './savings';

interface Job { controller: AbortController; promise: Promise<BaselineCapture>; waiters: Set<symbol> }

/** One home owns its pinned models, eight full captures and shared in-flight generation. */
export function createCaptureSource(ref: HomeRef | null, dependencies: { resolveAnchor: typeof resolveBaselineAnchor; generate: typeof generateHomeBaseline }) {
  const lifetime = new AbortController(), cache = new Map<string, BaselineCapture>(), jobs = new Map<string, Job>();
  const summaries = new Map<string, MonthLedger>();
  let anchorPromise: Promise<BaselineAnchor> | null = null;
  const anchor = () => {
    if (!ref) return Promise.reject(new Error('Select a home'));
    lifetime.signal.throwIfAborted();
    if (!anchorPromise) anchorPromise = dependencies.resolveAnchor(ref, lifetime.signal).catch(error => { anchorPromise = null; throw error; });
    return anchorPromise;
  };
  const cached = (period: BaselinePeriod) => {
    const key = periodKey(period), capture = cache.get(key);
    if (capture) { cache.delete(key); cache.set(key, capture); }
    return capture;
  };
  return {
    anchor, cached, summary: (period: BaselinePeriod) => summaries.get(periodKey(period)),
    capture: async (period: BaselinePeriod, signal: AbortSignal, fresh = false): Promise<BaselineCapture> => {
      if (!ref) throw new Error('Select a home');
      signal.throwIfAborted(); lifetime.signal.throwIfAborted();
      if (!fresh) { const found = cached(period); if (found) return found; }
      const key = periodKey(period);
      if (fresh) { cache.delete(key); summaries.delete(key); }
      let job = jobs.get(key);
      if (!job) {
        const controller = new AbortController();
        const own: Job = { controller, waiters: new Set(),
          promise: anchor().then(pinned => { controller.signal.throwIfAborted(); return dependencies.generate(ref, pinned, period, controller.signal); })
          .then(capture => {
            controller.signal.throwIfAborted(); lifetime.signal.throwIfAborted();
            if (jobs.get(key) === own && !controller.signal.aborted && !lifetime.signal.aborted && own.waiters.size) {
              cache.set(key, capture);
              if (period.view === 'month') summaries.set(key, monthLedger(capture));
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
    dispose: () => { lifetime.abort(); jobs.forEach(job => job.controller.abort()); jobs.clear(); cache.clear(); summaries.clear(); },
  };
}
export type CaptureSource = ReturnType<typeof createCaptureSource>;
