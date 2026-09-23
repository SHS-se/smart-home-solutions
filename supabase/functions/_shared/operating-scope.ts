/** Physical execution scope, independent of hypothetical scheduling preferences. */
import type { OptimisationSnapshot } from "./energy-optimisation.ts";

export type OperatingMode = "monitoring" | "planning" | "control_verification" | "controlling";
export interface OperatingScope {
  modes: Record<string, OperatingMode>;
  device_owners: Record<string, string>;
  external_demands: Record<string, {
    forecast_w_by_slot: number[];
    recent_observation: null | {
      start: string;
      end: string;
      average_w: number;
      source: "completed_meter_quarter";
    };
  }>;
}
const modes = new Set(["monitoring", "planning", "control_verification", "controlling"]);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const power = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000;
const sameKeys = (a: object, keys: string[]) => Object.keys(a).sort().join("\n") === [...keys].sort().join("\n");

export function validateOperatingScope(snapshot: OptimisationSnapshot): void {
  const s = snapshot.operating_scope;
  if (!record(s) || !record(s.modes) || !record(s.device_owners) || !record(s.external_demands)
      || Object.entries(s.modes).some(([key, mode]) => !key || !modes.has(mode))
      || !["$battery", "$pool", "$ev"].every(key => key in s.modes)) {
    throw new Error("operating_scope requires explicit operating modes and external demand");
  }
  const models = snapshot.device_models;
  if (!sameKeys(s.device_owners, models.map(m => m.key)) || models.some(m =>
    typeof s.device_owners[m.key] !== "string" || !(s.device_owners[m.key] in s.modes))) {
    throw new Error("operating_scope must name exactly one known owner per device model");
  }
  const external = models.filter(m => s.modes[s.device_owners[m.key]] !== "controlling");
  if (!sameKeys(s.external_demands, external.map(m => m.key))) {
    throw new Error("operating_scope external demand must cover every non-controlling model exactly once");
  }
  for (const demand of Object.values(s.external_demands)) {
    if (!record(demand) || !Array.isArray(demand.forecast_w_by_slot)
        || demand.forecast_w_by_slot.length !== snapshot.slots.length || !demand.forecast_w_by_slot.every(power)) {
      throw new Error("external demand requires finite nonnegative watts for every slot");
    }
    const r = demand.recent_observation;
    if (r !== null && (!record(r) || r.source !== "completed_meter_quarter" || !power(r.average_w)
        || Date.parse(r.end) !== Date.parse(snapshot.slots[0].start)
        || Date.parse(r.end) - Date.parse(r.start) !== 900_000)) {
      throw new Error("external demand observation must be the last completed meter quarter");
    }
  }
}
