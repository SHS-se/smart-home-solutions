import type { OptimisationSnapshot, PlannedSlot } from "./planner/planning-contracts.ts";
import { type PublishedHeater, type ThermalStoreModel } from "./planner/device-models.ts";
import { poolPhysics } from "./planner/pool-physics.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { unavailableOwner } from "./rules-commitments.ts";

export interface PoolService {
  physics: { store: ThermalStoreModel; heater: PublishedHeater } | null;
  pending_heat_kwh: number | null;
  empirical: boolean;
  permitted: boolean[];
  command_w: number[];
  power: Record<string, number[]>;
  total_w: number[];
  stop_c: number | null;
  warnings: PlanningWarning[];
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Statistical evidence selects a forecast method, never whether the home plans. */
export function preparePoolService(snapshot: OptimisationSnapshot, retained: Partial<PlannedSlot>[] = []): PoolService {
  const members = snapshot.device_models.filter(m => m.planning_service === "pool");
  const n = snapshot.slots.length;
  const empty = (): PoolService => ({ physics: null, pending_heat_kwh: null, empirical: false, permitted: [], command_w: [], power: {}, total_w: [], stop_c: null, warnings: [] });
  if (!snapshot.capabilities.pool) return empty();
  const target = snapshot.comfort?.pool?.target_c;
  const stop = finite(target) ? target : snapshot.pool_model?.hardware?.stop_c;
  let reason = "Pool thermal evidence is incomplete";
  try {
    if (!snapshot.pool) throw new Error("Pool water state is unavailable");
    if (!finite(target)) throw new Error("Pool comfort target is unavailable");
    if (!finite(stop)) throw new Error("Pool stop setting is unavailable");
    if (finite(snapshot.pool_model?.cutout_air_c)) throw new Error("Pool air cutout is represented in the empirical permit schedule");
    const physics = poolPhysics(snapshot);
    const pending = physics.store.response_time_constant_h === 0 ? 0 : snapshot.pool_model?.pending_heat_kwh;
    if (!finite(pending) || pending < 0) throw new Error("Pool response memory has not been reconstructed");
    if (physics.store.loss.kind === "linear" && physics.store.loss.surroundings_c === null &&
      snapshot.slots.some((_slot, i) => !finite(snapshot.outdoor_temperature_c?.[i]))) {
      throw new Error("Pool weather coverage is incomplete");
    }
    const hardware = snapshot.pool_model?.hardware ?? snapshot.pool.hardware;
    if (!hardware || hardware.control !== "external_enable" || !finite(hardware.start_c) || !finite(hardware.stop_c)) {
      throw new Error("Pool native start/stop evidence is incomplete");
    }
    return { ...empty(), physics, pending_heat_kwh: pending, stop_c: stop };
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const power = Object.fromEntries(members.map(m => [m.key, m.forecast_w_by_slot.slice()]));
  const running = sum(members.map(m => m.active_power_w && m.active_power_w > 0 ? m.active_power_w : Math.max(0, ...m.forecast_w_by_slot)));
  const permitted = snapshot.slots.map((_slot, i) => {
    if (unavailableOwner(snapshot, "$pool", snapshot.slots[i].start)) return false;
    const old = retained[i];
    if (typeof old?.pool_permitted === "boolean") return old.pool_permitted;
    if (old && finite(old.pool_command_w)) return old.pool_command_w > 0;
    const air = snapshot.outdoor_temperature_c?.[i], cutout = snapshot.pool_model?.cutout_air_c;
    return finite(stop) && !(finite(air) && finite(cutout) && air < cutout);
  });
  for (const m of members) for (let i = 0; i < n; i++) {
    const old = retained[i]?.device_loads_w?.[m.key];
    power[m.key][i] = unavailableOwner(snapshot, "$pool", snapshot.slots[i].start) ? power[m.key][i]
      : finite(old) ? old : permitted[i] ? power[m.key][i] : 0;
  }
  return { physics: null, pending_heat_kwh: null, empirical: true, permitted, power,
    command_w: permitted.map(on => on ? running : 0),
    total_w: snapshot.slots.map((_s, i) => sum(Object.values(power).map(values => values[i]))),
    stop_c: finite(stop) ? stop : null,
    warnings: [planningWarning("pool_empirical_service", "pool", reason + ".",
      "Pool thermostat permission remains active. Demand uses measured history; temperature projection is unavailable.")],
  };
}
