import { monthPeriod } from './period';
import { monthLedger, monthsBetween, type MonthLedger } from './savings';
import type { CaptureSource } from './source';

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
  const calculate = async () => {
    if (disposed || !state.rows.length) return;
    cancel();
    const controller = new AbortController(); active = controller;
    publish({ running: true, error: null });
    const current = () => !disposed && active === controller && !controller.signal.aborted;
    const update = (month: string, row: MonthRow) => publish({ rows: state.rows.map(r => r.month === month ? row : r) });
    try {
      const anchor = await source.anchor();
      if (!current()) return;
      publish({ rows: state.rows.map(row => ({ month: row.month, status: 'queued' })) });
      for (const { month } of state.rows) {
        if (!current()) return;
        const period = monthPeriod(anchor, month);
        if (!period) { update(month, { month, status: 'unavailable' }); continue; }
        const saved = source.summary(period);
        if (saved) { update(month, { month, status: 'done', ledger: saved }); continue; }
        update(month, { month, status: 'running' });
        try {
          const capture = await source.capture(period, controller.signal);
          if (!current()) return;
          const ledger = monthLedger(capture);
          update(month, { month, status: 'done', ledger });
        } catch (error) {
          if (!current()) return;
          update(month, { month, status: 'failed', error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) { if (current()) publish({ error: error instanceof Error ? error.message : String(error) }); }
    finally { if (current()) { active = null; publish({ running: false }); } }
  };
  return { snapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setRange, calculate, cancel,
    dispose: () => { disposed = true; active?.abort(); active = null; listeners.clear(); } };
}
export type SavingsRun = ReturnType<typeof createSavingsRun>;
