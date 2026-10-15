import type { OptimisationSnapshot, PlannedSlot } from "./planner/planning-contracts.ts";
import { parseHeaterResponse, publishHeater, WATER_KWH_PER_M3_K, type PublishedHeater, type ThermalStoreModel } from "./planner/device-models.ts";
import { poolHeaters } from "./planner/pool-devices.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";

export interface PoolService {
  physics: { store: ThermalStoreModel; heater: PublishedHeater } | null;
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
  const empty = (): PoolService => ({ physics: null, empirical: false, permitted: [], command_w: [], power: {}, total_w: [], stop_c: null, warnings: [] });
  if (!snapshot.capabilities.pool) return empty();
  const target = snapshot.comfort?.pool?.target_c;
  const stop = finite(target) ? target : snapshot.pool_model?.hardware?.stop_c;
  let reason = "Pool thermal evidence is incomplete";
  try {
    if (!snapshot.pool) throw new Error("Pool water state is unavailable");
    if (!finite(target)) throw new Error("Pool comfort target is unavailable");
    if (!finite(stop)) throw new Error("Pool stop setting is unavailable");
    if (finite(snapshot.pool_model?.cutout_air_c)) throw new Error("Pool air cutout is represented in the empirical permit schedule");
    let physics: NonNullable<PoolService["physics"]>;
    const supplied = snapshot.device_physics?.pool;
    if (supplied) physics = { store: supplied.store, heater: publishHeater(supplied.heater) };
    else {
      const measured = snapshot.pool_model;
      if (!measured?.heater_response) throw new Error("Pool heater response has not been identified");
      const heaters = new Set(poolHeaters(members).map(m => m.key));
      const observed = measured.heater_response.kind === "bergvarme" ? measured.heater_response.evidence?.steady_compressor_w : undefined;
      const compressor = finite(observed) ? observed : sum(members.filter(m => heaters.has(m.key)).map(m => m.active_power_w ?? 0));
      if (!(compressor > 0)) throw new Error("Pool steady compressor demand has not been identified");
      const capacity = snapshot.pool.volume_m3 * WATER_KWH_PER_M3_K;
      const points = (measured.response ?? []).flatMap(bin => finite(bin.idle_c_per_h)
        ? [{ at_c: bin.at_c, c_per_h: bin.idle_c_per_h }] : []).sort((a, b) => a.at_c - b.at_c);
      const gains = (measured.response ?? []).filter(bin => finite(bin.heat_c_per_kwh) && bin.heat_c_per_kwh > 0 && finite(bin.heated_kwh) && bin.heated_kwh > 0);
      const weight = sum(gains.map(bin => bin.heated_kwh!));
      const heat = weight > 0 ? sum(gains.map(bin => bin.heat_c_per_kwh! * bin.heated_kwh!)) / weight * capacity * compressor
        : finite(measured.rated_cop) ? measured.rated_cop * compressor : null;
      if (heat === null || !(heat > 0)) throw new Error("Pool heat delivery has not been identified");
      const loss: ThermalStoreModel["loss"] | null = points.length ? { kind: "measured", points }
        : finite(measured.loss_kw_per_k) ? { kind: "linear", kw_per_c: measured.loss_kw_per_k, surroundings_c: null } : null;
      if (!loss) throw new Error("Pool standing loss has not been identified");
      physics = { store: { capacity_kwh_per_c: capacity, loss }, heater: {
        compressor_w: compressor, auxiliary_w: sum(members.filter(m => !heaters.has(m.key)).map(m => m.active_power_w ?? 0)),
        heat_w: heat, response: parseHeaterResponse(measured.heater_response),
      } };
    }
    if (physics.store.loss.kind === "linear" && physics.store.loss.surroundings_c === null &&
      snapshot.slots.some((_slot, i) => !finite(snapshot.outdoor_temperature_c?.[i]))) {
      throw new Error("Pool weather coverage is incomplete");
    }
    const hardware = snapshot.pool_model?.hardware ?? snapshot.pool.hardware;
    if (!hardware || hardware.control !== "external_enable" || !finite(hardware.start_c) || !finite(hardware.stop_c)) {
      throw new Error("Pool native start/stop evidence is incomplete");
    }
    return { ...empty(), physics, stop_c: stop };
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const power = Object.fromEntries(members.map(m => [m.key, m.forecast_w_by_slot.slice()]));
  const running = sum(members.map(m => m.active_power_w && m.active_power_w > 0 ? m.active_power_w : Math.max(0, ...m.forecast_w_by_slot)));
  const permitted = snapshot.slots.map((_slot, i) => {
    const old = retained[i];
    if (typeof old?.pool_permitted === "boolean") return old.pool_permitted;
    if (old && finite(old.pool_command_w)) return old.pool_command_w > 0;
    const air = snapshot.outdoor_temperature_c?.[i], cutout = snapshot.pool_model?.cutout_air_c;
    return finite(stop) && !(finite(air) && finite(cutout) && air < cutout);
  });
  for (const m of members) for (let i = 0; i < n; i++) {
    const old = retained[i]?.device_loads_w?.[m.key];
    power[m.key][i] = finite(old) ? old : permitted[i] ? power[m.key][i] : 0;
  }
  return { physics: null, empirical: true, permitted, power,
    command_w: permitted.map(on => on ? running : 0),
    total_w: snapshot.slots.map((_s, i) => sum(Object.values(power).map(values => values[i]))),
    stop_c: finite(stop) ? stop : null,
    warnings: [planningWarning("pool_empirical_service", "pool", reason + ".",
      "Pool thermostat permission remains active. Demand uses measured history; temperature projection is unavailable.")],
  };
}
