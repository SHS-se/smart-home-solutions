import { HA_UUID } from './ha-api-contract.ts';

export const RUNTIME_STATES = ['unavailable', 'disabled', 'not_configured', 'expired',
  'invalid', 'advisory_only', 'ready', 'incomplete', 'infeasible'] as const;

function validBatteryPlan(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  if (Object.keys(b).length !== 2 || !('accepted' in b) || !('rejection' in b)) return false;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1000;
  const generation = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  return (b.accepted === null || (record(b.accepted) && Object.keys(b.accepted).length === 4 &&
    typeof b.accepted.plan_id === 'string' && HA_UUID.test(b.accepted.plan_id) &&
    text(b.accepted.contract_id) && text(b.accepted.scope_revision) && generation(b.accepted.generation))) &&
    (b.rejection === null || (record(b.rejection) && Object.keys(b.rejection).length === 3 &&
      text(b.rejection.contract_id) && generation(b.rejection.generation) && text(b.rejection.reason)));
}

export function validRuntime(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const timestamp = (v: unknown) => typeof v === 'string' &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
  const nullableTime = (v: unknown) => v === null || timestamp(v);
  return Object.keys(r).length === 10 && validBatteryPlan(r.battery_plan) &&
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

/** The HA software that sent a request, as its own headers name it. */
export interface ReportedClient {
  integration_version: string | null;
  app_version: string | null;
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/** Versions travel as headers on every HA request; anything else is not a version. */
export function reportedClient(headers: Headers): ReportedClient {
  const version = (name: string) => {
    const value = headers.get(name)?.trim();
    return value && VERSION.test(value) ? value : null;
  };
  return {
    integration_version: version('x-shs-integration-version'),
    app_version: version('x-shs-app-version'),
  };
}
