import { createHash } from 'node:crypto';

/** Mock the portal's incremental response, including unchanged-content reads. */
export function portalDelta(
  known: Record<string, unknown>,
  { current = null, plan = null, devices = [] }: {
    current?: Record<string, unknown> | null;
    plan?: unknown;
    devices?: unknown[];
  } = {},
) {
  const changed = (key: string, value: unknown) => {
    const hash = createHash('md5').update(JSON.stringify(value)).digest('hex');
    return { hash, value: known[key] === hash ? null : value };
  };
  return {
    current,
    plan: current?.plan_id && known.plan_id !== current.plan_id ? plan : null,
    actuals: { upserts: [], removed: [] },
    prices: { upserts: [], removed: [] },
    device_actuals: { upserts: [], removed: [] },
    devices: changed('devices', devices),
    zone_models: changed('zone_models', []),
    thermal: changed('thermal', {
      slotCount: 0, outdoorSlotCount: 0, observedRoomKeys: [],
      firstObservedAt: null, lastObservedAt: null,
    }),
  };
}
