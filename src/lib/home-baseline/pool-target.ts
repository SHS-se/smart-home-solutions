import type { HomeModelCapture } from './home-physics.ts';
import type { BaselineAnchor } from './period.ts';

/** The range the comfort settings accept for a pool. */
export const POOL_TARGET_RANGE_C = [10, 40] as const;

/** The one pool temperature the estimate holds, in both models and in every month. */
export function poolTarget(snapshot: HomeModelCapture): number | null {
  return snapshot.capabilities.pool ? snapshot.comfort?.pool?.target_c ?? null : null;
}

/** Pin the estimate to a stated pool temperature instead of the home's current comfort target.
 * It replaces the comfort target in the model about to be pinned, so the thermostat, the
 * scheduler and the saved report all read the same number. */
export function withPoolTarget(anchor: BaselineAnchor, targetC: number | null): BaselineAnchor {
  if (targetC === null || !anchor.snapshot.capabilities.pool) return anchor;
  const [min, max] = POOL_TARGET_RANGE_C;
  if (!Number.isFinite(targetC) || targetC < min || targetC > max) throw new Error(`Pool temperature must be between ${min} and ${max} °C`);
  return { ...anchor, snapshot: { ...anchor.snapshot, comfort: { ...anchor.snapshot.comfort, pool: { target_c: targetC } } } };
}
