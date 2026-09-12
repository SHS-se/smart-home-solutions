/** Last reported local state; lack of contact does not stop a cached HA plan. */
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
export interface HaRuntimeRow {
  plan_id: string | null;
  ha_runtime: HaRuntime | null;
  ha_runtime_received_at: string | null;
}
export function haRuntimeStatus(row: HaRuntimeRow, now: number) {
  const runtime = row.ha_runtime;
  const observed = Date.parse(runtime?.observed_at ?? '');
  const received = Date.parse(row.ha_runtime_received_at ?? '');
  if (!runtime || !Number.isFinite(observed) || observed > now + 30_000 || !Number.isFinite(received) || received > now + 30_000) {
    return { state: 'unconfirmed', ready: false, runtime: null };
  }
  if (runtime.state !== 'ready') return { state: runtime.state, ready: false, runtime };
  if (!row.plan_id || runtime.plan_id !== row.plan_id) {
    return { state: 'different_plan', ready: false, runtime };
  }
  if (!(Date.parse(runtime.valid_until ?? '') > now)) return { state: 'expired', ready: false, runtime };
  return { state: 'ready', ready: true, runtime };
}
