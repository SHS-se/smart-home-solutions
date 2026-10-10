/**
 * The pool heat pump's own start and stop temperatures.
 *
 * The home reads them from the equipment and sends them with every snapshot,
 * so a plan is made on what the heat pump is set to now. They were once typed
 * into the pool model by hand: production had none and refused every plan, and
 * the test copy went stale the day the heat pump was adjusted.
 */
import type { OptimisationSnapshot } from "./planner/energy-optimisation.ts";

export type PoolHardware = NonNullable<NonNullable<OptimisationSnapshot["pool_model"]>["hardware"]>;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The settings this snapshot reports, or null when it reports none: an
 * integration from before it read them, for which the stored copy stands.
 * Settings that are sent but unreadable are refused rather than replaced by
 * that stored copy, which may describe the heat pump as it was.
 */
export function reportedPoolHardware(pool: unknown): PoolHardware | null {
  const reported = (pool as { hardware?: unknown } | null | undefined)?.hardware;
  if (reported === undefined || reported === null) return null;
  const { start_c, stop_c, control, source_entity_ids } = reported as Record<string, unknown>;
  const sources = source_entity_ids as Record<string, unknown> | null | undefined;
  if (!finite(start_c) || !finite(stop_c) || control !== "external_enable" ||
      typeof sources?.start !== "string" || !sources.start || typeof sources?.stop !== "string" || !sources.stop) {
    throw new Error("Pool heater start and stop settings are unreadable");
  }
  return { start_c, stop_c, control, source_entity_ids: { start: sources.start, stop: sources.stop } };
}

/** Whether the stored copy already says what the home just reported. */
export function samePoolHardware(stored: unknown, reported: PoolHardware): boolean {
  const s = stored as Partial<PoolHardware> | null | undefined;
  return !!s && s.start_c === reported.start_c && s.stop_c === reported.stop_c && s.control === reported.control &&
    s.source_entity_ids?.start === reported.source_entity_ids.start &&
    s.source_entity_ids?.stop === reported.source_entity_ids.stop;
}
