// How the planner values and protects the car's charge.
//
// Everything is relative to the car's own charge limit L, which the integration
// reads from the car. P is the home's floor setting, F = min(P, L) the floor the
// car can actually reach, and M = (F + L) / 2 the middle of what is left. Energy
// up to M is valued at the plan's 75th-percentile import price and M to L at its
// 25th (end-credit.ts), so the car fills cheaply and never at the peak.
//
// Below F the car is short of a safe charge. Each plugged-in quarter still below
// F once its grace has passed costs CAR_FLOOR_POINTS. The grace runs from the
// moment the car was plugged in, so no replan renews it, and shrinks with the
// charge: GRACE_AT_FLOOR_H at P, half an hour less per point below it, none from
// 20 points below.
//
// This is the only definition of those levels and of the grace. The planner gets
// them as one whole-number line per quarter and only compares against it; the
// bench referee and the savings replay call the same functions.

import type { CarBatteryModel } from "../planner/device-models.ts";
import type { ReadyProblem, ReadySlot } from "./ready-problem.ts";

export const CAR_FLOOR_SOC_DEFAULT = 0.3;
export const CAR_FLOOR_POINTS = -2;
export const GRACE_AT_FLOOR_H = 10;
export const GRACE_H_PER_POINT = 0.5;
/** Elapsed time per permille of charge the line rises: half an hour per point. */
const MS_PER_PERMILLE = (GRACE_H_PER_POINT * 3_600_000) / 10;
/** How far below P the line starts, in permille: where the grace reaches zero. */
const LINE_START_BELOW_FLOOR = (GRACE_AT_FLOOR_H / GRACE_H_PER_POINT) * 10;

export interface CarLevels { readonly floor: number; readonly middle: number; readonly limit: number }

/** Fractions of the battery. F <= M <= L whatever limit the car reports. */
export function carLevels(limitSoc: number, floorSetting: number): CarLevels {
  const limit = Math.min(1, Math.max(0, limitSoc));
  const floor = Math.min(Math.max(0, floorSetting), limit);
  return { floor, middle: (floor + limit) / 2, limit };
}

export type CarConnection =
  /** The integration recorded when the cable went in. */
  | { kind: "plugged"; sinceMs: number }
  /** Connected, but the sender predates plug-in times: no new grace is granted. */
  | { kind: "plugged_unknown_since" }
  /** Planned as if it were plugged in at the start of the plan. */
  | { kind: "unplugged" };

export interface CarPlan { battery: CarBatteryModel; limitSoc: number; floorSetting: number; connection: CarConnection }

/** A snapshot's cable state. A missing or unreadable plug-in time never grants a new grace. */
export function connectionFromSnapshot(ev: { connected: boolean; plugged_in_at?: string | null }): CarConnection {
  if (!ev.connected) return { kind: "unplugged" };
  const sinceMs = Date.parse(ev.plugged_in_at ?? "");
  return Number.isFinite(sinceMs) ? { kind: "plugged", sinceMs } : { kind: "plugged_unknown_since" };
}

/** The owner's formula, in hours. The line below is this, in whole numbers. */
export function graceHours(socPercent: number, floorSettingPercent: number): number {
  return Math.max(0, GRACE_AT_FLOOR_H - GRACE_H_PER_POINT * (floorSettingPercent - socPercent));
}

export const socPermille = (kwh: number, capacityKwh: number) => Math.floor((kwh / capacityKwh) * 1000 + 0.5);

/**
 * One breach line per quarter: the charge in permille at or below which that
 * quarter counts as below the floor, or null when it cannot. A later spell of
 * availability in the same plan is a plug-in of its own.
 */
export function carPolicy(plan: CarPlan, slots: readonly Pick<ReadySlot, "start_seconds" | "hours" | "ev_available">[], originMs: number): NonNullable<ReadyProblem["car_policy"]> {
  const levels = carLevels(plan.limitSoc, plan.floorSetting);
  const capacity = plan.battery.capacity_kwh;
  const floor = Math.round(levels.floor * 1000), setting = Math.round(Math.max(0, plan.floorSetting) * 1000);
  const firstAnchor = plan.connection.kind === "plugged" ? plan.connection.sinceMs
    : plan.connection.kind === "plugged_unknown_since" ? originMs - GRACE_AT_FLOOR_H * 3_600_000
    : originMs;
  let anchor: number | null = null, previous = false;
  const breach_permille = slots.map((slot, i) => {
    const startMs = originMs + slot.start_seconds * 1000;
    if (!slot.ev_available) { previous = false; return null; }
    if (!previous) anchor = i === 0 ? Math.min(firstAnchor, originMs) : startMs;
    previous = true;
    const elapsed = Math.max(0, startMs + slot.hours * 3_600_000 - anchor!);
    const line = Math.min(floor - 1, setting - LINE_START_BELOW_FLOOR + Math.floor(elapsed / MS_PER_PERMILLE));
    return line < 0 ? null : line;
  });
  return { floor_kwh: levels.floor * capacity, limit_kwh: levels.limit * capacity, breach_permille };
}

/** Which quarters count as below the floor, given the charge at the end of each. */
export function floorBreaches(policy: NonNullable<ReadyProblem["car_policy"]>, capacityKwh: number, evKwh: ArrayLike<number>): boolean[] {
  return policy.breach_permille.map((line, i) => line !== null && socPermille(evKwh[i], capacityKwh) <= line);
}
