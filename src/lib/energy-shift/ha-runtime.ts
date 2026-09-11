/** Acknowledgement records receipt; only a fresh runtime report proves readiness. */
export interface HaRuntime {
  observed_at: string;
  plan_id: string | null;
  state: string;
  reason: string;
  binding_until: string | null;
  valid_until: string | null;
  recovering: boolean;
  retry_at: string | null;
  last_error: string | null;
}
export const HA_RUNTIME_LEASE_MS = 150_000;
export interface HaRuntimeRow {
  plan_id: string | null;
  ha_runtime: HaRuntime | null;
  ha_runtime_received_at: string | null;
}
export function haRuntimeStatus(row: HaRuntimeRow, now: number) {
  const runtime = row.ha_runtime;
  const observed = Date.parse(runtime?.observed_at ?? '');
  const received = Date.parse(row.ha_runtime_received_at ?? '');
  if (!runtime || !Number.isFinite(observed) || now - observed >= HA_RUNTIME_LEASE_MS || observed > now + 30_000 || !Number.isFinite(received) || now - received >= HA_RUNTIME_LEASE_MS || received > now + 30_000) {
    return { state: 'unconfirmed', ready: false, runtime: null };
  }
  if (runtime.state !== 'ready') return { state: runtime.state, ready: false, runtime };
  if (!row.plan_id || runtime.plan_id !== row.plan_id) {
    return { state: 'different_plan', ready: false, runtime };
  }
  if (!(Date.parse(runtime.valid_until ?? '') > now)) return { state: 'expired', ready: false, runtime };
  if (!(Date.parse(runtime.binding_until ?? '') > now)) return { state: 'advisory_only', ready: false, runtime };
  return { state: 'ready', ready: true, runtime };
}
