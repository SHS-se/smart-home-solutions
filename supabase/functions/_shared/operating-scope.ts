/** Physical execution scope, independent of hypothetical scheduling preferences. */
import type { OptimisationSnapshot, ServiceInput } from "./energy-optimisation.ts";

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

/** Fold independently operated devices into fixed demand before invoking the same solver. */
export function projectExecutionSnapshot(snapshot: OptimisationSnapshot): OptimisationSnapshot {
  validateOperatingScope(snapshot);
  const scope = snapshot.operating_scope!;
  const live = snapshot.device_models.filter(m => scope.modes[scope.device_owners[m.key]] === "controlling");
  const keys = new Set(live.map(m => m.key));
  const isPool = (m: typeof live[number]) => m.planning_service === "pool";
  const pool = snapshot.capabilities.pool ? live.filter(isPool) : [];
  const ev = snapshot.capabilities.ev ? live.filter(m => m.category === "ev_charging") : [];
  const boiler = snapshot.capabilities.boiler ? live.filter(m => m.category === "hot_water" && m.control_type === "permit_inhibit") : [];
  if (pool.length && scope.modes.$pool !== "controlling") throw new Error("pool execution requires its physical controller in Controlling mode");
  if (ev.length && (scope.modes.$ev !== "controlling" || ev.length !== snapshot.device_models.filter(m => m.category === "ev_charging").length)) {
    throw new Error("partial EV control cannot define an executable charger envelope");
  }
  const zones = (snapshot.thermal_zones ?? []).filter(zone => {
    const selected = zone.device_keys.filter(key => keys.has(key));
    if (selected.length && selected.length !== zone.device_keys.length) throw new Error(`Partial control of thermal zone ${zone.key} is unsupported`);
    return selected.length > 0;
  });
  const battery = scope.modes.$battery === "controlling" ? snapshot.battery : null;
  const services = snapshot.services.flatMap<ServiceInput>(service => {
    if (service.device === "pool") {
      if (!pool.length) return [];
      if (service.control.type !== "fixed_power") throw new Error("pool execution needs a fixed-power service");
      const watts = pool.reduce((sum, m) => sum + (m.active_power_w ?? 0), 0);
      if (!power(watts) || watts <= 0) throw new Error("controlled pool devices need measured or reviewed running power");
      return [{ ...service, control: { ...service.control, power_w: watts } }];
    }
    if (service.device === "ev") return ev.length ? [service] : [];
    if (!boiler.length) return [];
    if (boiler.length === snapshot.device_models.filter(m => m.category === "hot_water").length) return [service];
    if (service.control.type !== "duty_cycle") throw new Error("boiler execution needs a duty-cycle service");
    const expected = snapshot.slots.map((_, i) => boiler.reduce((sum, m) => sum + m.forecast_w_by_slot[i], 0));
    const rated = boiler.reduce((sum, m) => sum + (m.active_power_w ?? 0), 0);
    return [{ ...service, device: "boiler", required_kwh: expected.reduce((sum, w, i) => {
      const t = Date.parse(snapshot.slots[i].start);
      return sum + (t >= Date.parse(service.earliest_start) && t + 900_000 <= Date.parse(service.deadline) ? w / 4000 : 0);
    }, 0), control: { ...service.control, rated_power_w: rated, expected_power_w_by_slot: expected } }];
  });
  const result: OptimisationSnapshot = {
    ...snapshot,
    schema_version: 8,
    replan_reference: null,
    slots: snapshot.slots.map((slot, i) => {
      const fixed = Object.values(scope.external_demands).reduce((sum, d) =>
        sum + (i === 0 && d.recent_observation !== null ? d.recent_observation.average_w : d.forecast_w_by_slot[i]), 0);
      return { ...slot, base_load_forecast_w: slot.base_load_forecast_w + fixed };
    }),
    capabilities: { ...snapshot.capabilities, battery: battery !== null,
      pool: pool.length > 0, ev: ev.length > 0, boiler: boiler.length > 0 },
    battery,
    sources: { ...snapshot.sources, battery: battery ? snapshot.sources.battery : null },
    pool: pool.length ? snapshot.pool : null,
    ev_battery: ev.length ? snapshot.ev_battery : null,
    device_models: live,
    thermal_zones: zones,
    services,
    policy: battery ? snapshot.policy : { battery_end_of_solar_target_soc: 0, battery_target_is_hard: false,
      terminal_soc_min: 0, terminal_energy_value_sek_per_kwh: 0, battery_export_enabled: false,
      battery_export_reserve_soc: 0, battery_export_min_price_sek_per_kwh: 0 },
  };
  delete result.operating_scope;
  return result;
}
