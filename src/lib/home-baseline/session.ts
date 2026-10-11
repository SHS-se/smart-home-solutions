import type { BaselineCapture } from './browser';
import type { CaptureSource } from './source';
import { latestPeriod, monthPeriod, stepPeriod, switchPeriodView, type BaselineAnchor, type BaselinePeriod, type BaselineView } from './period';

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

/** Viewer owns lazy activation, selection and its interest in shared model generation. */
export function createBaselineSession(source: CaptureSource) {
  let anchor: BaselineAnchor | null = null, request: AbortController | null = null, disposed = false;
  let state: BaselineSessionState = { view: 'frame', period: null, capture: null, busy: false, error: null,
    timeZone: null, canPrevious: false, canNext: false };
  const listeners = new Set<() => void>();
  const publish = (change: Partial<BaselineSessionState>) => {
    state = { ...state, ...change };
    state.canPrevious = state.period !== null;
    state.canNext = !!anchor && !!state.period && Date.parse(state.period.end) < Date.parse(anchor.latestEnd);
    listeners.forEach(listener => listener());
  };
  const show = async (period: BaselinePeriod | null, force = false, monthKey?: string) => {
    if (disposed) return;
    request?.abort(); request = null;
    const cached = period && !force ? source.cached(period) : null;
    if (cached && period) {
      publish({ period, capture: cached, error: null, busy: false });
      return;
    }
    const controller = new AbortController(); request = controller;
    publish({ period, capture: null, error: null, busy: true });
    try {
      if (!anchor) {
        const resolved = await source.anchor();
        if (request !== controller || disposed) return;
        anchor = resolved;
      }
      const target = period ?? (monthKey ? monthPeriod(anchor, monthKey) : latestPeriod(anchor, state.view));
      if (!target) throw new Error('No recorded quarters for this month');
      publish({ period: target, timeZone: anchor.snapshot.timezone });
      const capture = await source.capture(target, controller.signal, force);
      if (request !== controller || disposed || controller.signal.aborted) return;
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
    showMonth: (key: string) => {
      if (disposed) return Promise.resolve();
      publish({ view: 'month' });
      return show(anchor ? monthPeriod(anchor, key) : null, false, key);
    },
    dispose: () => { disposed = true; request?.abort(); request = null; listeners.clear(); },
  };
}

export type BaselineSession = ReturnType<typeof createBaselineSession>;
