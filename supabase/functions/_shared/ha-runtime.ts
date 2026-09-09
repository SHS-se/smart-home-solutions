import { HA_UUID } from './ha-api-contract.ts';

export const RUNTIME_STATES = ['unavailable', 'disabled', 'not_configured', 'expired',
  'invalid', 'advisory_only', 'ready', 'incomplete', 'infeasible'] as const;

export function validRuntime(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const timestamp = (v: unknown) => typeof v === 'string' &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
  const nullableTime = (v: unknown) => v === null || timestamp(v);
  return Object.keys(r).length === 9 &&
    timestamp(r.observed_at) &&
    Date.parse(r.observed_at as string) > now - 150_000 &&
    Date.parse(r.observed_at as string) <= now + 30_000 &&
    (r.plan_id === null || (typeof r.plan_id === 'string' && HA_UUID.test(r.plan_id))) &&
    RUNTIME_STATES.includes(r.state as typeof RUNTIME_STATES[number]) &&
    typeof r.reason === 'string' && r.reason.length <= 1000 &&
    nullableTime(r.binding_until) && nullableTime(r.valid_until) && nullableTime(r.retry_at) &&
    typeof r.recovering === 'boolean' &&
    (r.last_error === null || (typeof r.last_error === 'string' && r.last_error.length <= 1000)) &&
    (r.state !== 'ready' || (r.plan_id !== null && timestamp(r.binding_until) && timestamp(r.valid_until)));
}
