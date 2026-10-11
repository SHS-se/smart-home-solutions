import { monthPeriod } from './period';
import { monthsBetween, type MonthLedger } from './savings';
import type { CaptureSource } from './source';
import { PARTIAL_REFRESH_MS } from './saved-months';

export type MonthRow = { month: string } & (
  | { status: 'idle' | 'queued' | 'running' | 'unavailable' }
  | { status: 'done'; ledger: MonthLedger }
  | { status: 'failed'; error: string });
export interface SavingsState { rangeKey: string; rows: MonthRow[]; running: boolean; error: string | null }

/** Sequential monthly report retains only compact ledgers, independent of chart selection. */
export function createSavingsRun(source: CaptureSource) {
  let state: SavingsState = { rangeKey: '', rows: [], running: false, error: null };
  let active: AbortController | null = null, disposed = false;
  const listeners = new Set<() => void>();
  const publish = (change: Partial<SavingsState>) => { state = { ...state, ...change }; listeners.forEach(listener => listener()); };
  const cancel = () => {
    active?.abort(); active = null;
    publish({ running: false, rows: state.rows.map(row => ['queued', 'running'].includes(row.status) ? { month: row.month, status: 'idle' } : row) });
  };
  const setRange = (from: string, to: string) => {
    const rangeKey = `${from}|${to}`;
    if (disposed || rangeKey === state.rangeKey) return;
    cancel();
    try { publish({ rangeKey, rows: monthsBetween(from, to).map(month => ({ month, status: 'idle' })), error: null }); }
    catch (error) { publish({ rangeKey, rows: [], error: error instanceof Error ? error.message : String(error) }); }
  };
  const calculate = async (refresh = false) => {
    if (disposed || !state.rows.length) return;
    cancel();
    const controller = new AbortController(); active = controller;
    publish({ running: true, error: null });
    const current = () => !disposed && active === controller && !controller.signal.aborted;
    const update = (month: string, row: MonthRow) => publish({ rows: state.rows.map(r => r.month === month ? row : r) });
    try {
      await source.hydrate();
      if (!current()) return;
      if (refresh) await source.repin(controller.signal);
      if (!current()) return;
      const pending: string[] = [];
      publish({ rows: state.rows.map(row => {
        const saved = refresh ? undefined : source.saved(row.month);
        if (!saved || (saved.ledger.coverage < 1 && source.now() - Date.parse(saved.computedAt) >= PARTIAL_REFRESH_MS)) pending.push(row.month);
        return saved ? { month: row.month, status: 'done', ledger: saved.ledger } : { month: row.month, status: 'queued' };
      }) });
      if (!pending.length) return;
      const anchor = await source.anchor(pending.some(month => !!source.saved(month)));
      if (!current()) return;
      for (const month of pending) {
        if (!current()) return;
        const period = monthPeriod(anchor, month);
        if (!period) { update(month, { month, status: 'unavailable' }); continue; }
        const previous = source.saved(month);
        const stale = !refresh && previous && previous.ledger.coverage < 1;
        const saved = refresh || stale ? undefined : source.summary(period);
        if (saved) { update(month, { month, status: 'done', ledger: saved }); continue; }
        if (!previous) update(month, { month, status: 'running' });
        try {
          await source.capture(period, controller.signal, !!stale);
          if (!current()) return;
          const ledger = source.summary(period)!;
          update(month, { month, status: 'done', ledger });
        } catch (error) {
          if (!current()) return;
          const message = error instanceof Error ? error.message : String(error);
          if (previous) { update(month, { month, status: 'done', ledger: previous.ledger }); publish({ error: `${month}: ${message}` }); }
          else update(month, { month, status: 'failed', error: message });
        }
      }
    } catch (error) { if (current()) publish({ error: error instanceof Error ? error.message : String(error) }); }
    finally { if (current()) { active = null; publish({ running: false }); } }
  };
  const unsubscribe = source.subscribeSummary(ledger => {
    if (!disposed && state.rows.some(row => row.month === ledger.month)) publish({ rows: state.rows.map(row => row.month === ledger.month ? { month: row.month, status: 'done', ledger } : row) });
  });
  return { snapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setRange, calculate, cancel,
    dispose: () => { disposed = true; unsubscribe(); active?.abort(); active = null; listeners.clear(); } };
}
export type SavingsRun = ReturnType<typeof createSavingsRun>;
