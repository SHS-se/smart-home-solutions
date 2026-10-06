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

interface PlanAcknowledgement {
  plan_id: string | null;
  ha_ack_status: 'pending' | 'accepted' | 'rejected';
  ha_ack_error: { message?: string; details?: unknown } | null;
  ha_integration_version: string | null;
  ha_acknowledged_at: string | null;
}

/** Delivery of the displayed plan and HA's retained schedule are separate facts. */
export function planDeliveryStatus({ displayedPlanId, acknowledgement, reported, now }: {
  displayedPlanId: string;
  acknowledgement: PlanAcknowledgement;
  reported: HaRuntimeRow;
  now: number;
}) {
  // A newer cloud row may be unreadable while the previous chart stays visible.
  const runtimeStatus = haRuntimeStatus({ ...reported, plan_id: displayedPlanId }, now);
  const rejection = acknowledgement.plan_id === displayedPlanId && acknowledgement.ha_ack_status === 'rejected'
    ? {
      messages: [...new Set([
        acknowledgement.ha_ack_error?.message,
        ...(Array.isArray(acknowledgement.ha_ack_error?.details) ? acknowledgement.ha_ack_error.details : []),
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0))],
      integrationVersion: acknowledgement.ha_integration_version,
      acknowledgedAt: acknowledgement.ha_acknowledged_at,
    }
    : null;
  const runtime = runtimeStatus.runtime;
  const retained = runtime?.plan_id && runtime.plan_id !== displayedPlanId
    ? { runtime, ready: runtime.state === 'ready' && Date.parse(runtime.valid_until ?? '') > now }
    : null;
  return { runtimeStatus, rejection, retained };
}
