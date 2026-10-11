import type { generateHomeBaseline, BaselineCapture } from './browser';
import type { resolveBaselineAnchor, HomeRef } from './history';
import { latestPeriod, periodKey, stepPeriod, switchPeriodView, type BaselineAnchor, type BaselinePeriod, type BaselineView } from './period';

export interface BaselineSessionState {
  view: BaselineView;
  period: BaselinePeriod | null;
  capture: BaselineCapture | null;
  busy: boolean;
  error: string | null;
  timeZone: string | null;
  canPrevious: boolean;
  canNext: boolean;
}

/** One owner for lazy activation, pinned models, bounded caching and request cancellation. */
export function createBaselineSession(ref: HomeRef | null, dependencies: { resolveAnchor: typeof resolveBaselineAnchor; generate: typeof generateHomeBaseline }) {
  let anchor: BaselineAnchor | null = null, request: AbortController | null = null, disposed = false;
  let state: BaselineSessionState = { view: 'frame', period: null, capture: null, busy: false, error: null,
    timeZone: null, canPrevious: false, canNext: false };
  const cache = new Map<string, BaselineCapture>();
  const listeners = new Set<() => void>();
  const publish = (change: Partial<BaselineSessionState>) => {
    state = { ...state, ...change };
    state.canPrevious = state.period !== null;
    state.canNext = !!anchor && !!state.period && Date.parse(state.period.end) < Date.parse(anchor.latestEnd);
    listeners.forEach(listener => listener());
  };
  const show = async (period: BaselinePeriod | null, force = false) => {
    if (!ref || disposed) return;
    request?.abort(); request = null;
    const cached = period && !force ? cache.get(periodKey(period)) : null;
    if (cached && period) {
      cache.delete(periodKey(period)); cache.set(periodKey(period), cached);
      publish({ period, capture: cached, error: null, busy: false });
      return;
    }
    const controller = new AbortController(); request = controller;
    if (period && force) cache.delete(periodKey(period));
    publish({ period, capture: null, error: null, busy: true });
    try {
      if (!anchor) {
        const resolved = await dependencies.resolveAnchor(ref, controller.signal);
        if (request !== controller || disposed) return;
        anchor = resolved;
      }
      const target = period ?? latestPeriod(anchor, state.view);
      publish({ period: target, timeZone: anchor.snapshot.timezone });
      const capture = await dependencies.generate(ref, anchor, target, controller.signal);
      if (request !== controller || disposed || controller.signal.aborted) return;
      cache.set(periodKey(target), capture);
      if (cache.size > 8) cache.delete(cache.keys().next().value!);
      publish({ capture, busy: false });
    } catch (error) {
      if (request === controller && !disposed && !controller.signal.aborted) {
        publish({ error: error instanceof Error ? error.message : String(error), busy: false });
        controller.abort();
      }
    } finally {
      if (request === controller) request = null;
    }
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    generate: () => show(state.period, true),
    step: (direction: -1 | 1) => {
      if (!anchor || !state.period) return Promise.resolve();
      const target = stepPeriod(anchor, state.period, direction);
      return target ? show(target) : Promise.resolve();
    },
    setView: (view: BaselineView) => {
      if (view === state.view) return Promise.resolve();
      const target = anchor && state.period ? switchPeriodView(anchor, state.period, view) : null;
      publish({ view });
      return anchor || state.busy ? show(target) : Promise.resolve();
    },
    dispose: () => { disposed = true; request?.abort(); request = null; cache.clear(); listeners.clear(); },
  };
}
