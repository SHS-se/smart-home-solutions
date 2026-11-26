import type { DeviceModelBundle } from "../../device-model-store.ts";

/** Source policy is part of the learner contract, independently of transport. */
export const ROOM_FIT_WINDOW_DAYS = 30;

/** Source extents own rows by start; a full capture also owns their ends. */
export function roomSourceIntervalOwned(start: number, durationSeconds: number | undefined,
  from: number, to: number, scopeTo?: number): boolean {
  return start >= from && start < to && (scopeTo === undefined || start + (durationSeconds ?? 900) * 1000 <= scopeTo);
}

export function roomFitContext(models: Pick<DeviceModelBundle, "roomHeating" | "roomObserved">, key: string) {
  return models.roomHeating?.[key] ?? models.roomObserved?.[key];
}

export function usesConnectedRoomFit(context: { observedOnly: boolean; peerKeys: readonly string[] }): boolean {
  return context.observedOnly || context.peerKeys.length > 0;
}

export function roomFitFromAt(historyTo: number, binding: string,
  current: { binding: string; since: string } | null | undefined, observedSince?: string | null): { since: string; fromAt: string } {
  const floorMs = historyTo - ROOM_FIT_WINDOW_DAYS * 86_400_000;
  const since = current?.binding === binding
    ? new Date(Math.min(Date.parse(current.since), Date.parse(observedSince ?? current.since))).toISOString()
    : observedSince ?? new Date(floorMs).toISOString();
  return { since, fromAt: new Date(Math.max(floorMs, Date.parse(since))).toISOString() };
}
