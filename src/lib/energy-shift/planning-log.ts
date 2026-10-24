import type { Json, Tables } from '@/integrations/supabase/types';
import { replanAuditReason, replanAuditState } from './replan-audit';

export type PlanningLogEntry = Tables<'energy_planning_log'>;
type Translate = (sv: string, en: string) => string;
export const LOG_WINDOW_MS = 72 * 60 * 60 * 1000;
export const LOG_PAGE_SIZE = 50;
export const logObject = (value: Json): Record<string, Json | undefined> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const short = (value: string) => value.length > 160 ? `${value.slice(0, 157).trimEnd()}…` : value;

/** Short default text; full reasons and error details stay available on demand. */
export function planningLogText(row: PlanningLogEntry, t: Translate): {title: string; text: string; detail: string} {
  const reason = logObject(row.reason);
  const details = logObject(row.details);
  if (row.kind === 'exchange') {
    const count = Object.values(logObject(details.counts ?? {})).reduce<number>((sum, n) => sum + Number(n), 0);
    return {title: t('Data från HA', 'Data from HA'),
      text: t(`${row.occurrences} överföringar · ${count.toLocaleString()} datarader`, `${row.occurrences} batches · ${count.toLocaleString()} data rows`),
      detail: t('Rutindata sammanfattas per timme.', 'Routine data is grouped by hour.')};
  }
  if (row.kind === 'warning') {
    const message = String(reason.message ?? '');
    return {title: row.severity === 'error' ? t('Fel', 'Error') : t('Varning', 'Warning'),
      text: short(message + (row.occurrences > 1 ? t(` · ${row.occurrences} gånger`, ` · ${row.occurrences} times`) : '')),
      detail: [message, reason.consequence, row.occurrences > 1 ? t(`Observerad ${row.occurrences} gånger.`, `Observed ${row.occurrences} times.`) : ''].filter(Boolean).join(' ')};
  }
  const basis = typeof details.completion_basis === 'string' ? details.completion_basis : undefined;
  const description = replanAuditReason(row.reason, t);
  const seconds = typeof details.calculation_ms === 'number' && details.calculation_ms >= 30000
    ? t(` Beräkning: ${Math.round(details.calculation_ms / 1000)} s.`, ` Calculation: ${Math.round(details.calculation_ms / 1000)} s.`) : '';
  const failure = typeof details.detail === 'string' ? details.detail : '';
  const rejection = logObject(details.error ?? {}).message;
  return { title: replanAuditState(row.state, t, basis), text: short(description + seconds),
    detail: [description + seconds, failure, rejection].filter(Boolean).join(' ') };
}
