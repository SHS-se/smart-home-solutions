import type { OptimisationSnapshot } from "./planning-contracts.ts";
import { DeviceModelError, validateHeaterSource, operatingPoint, parseHeaterResponse, publishHeater, WATER_KWH_PER_M3_K, type PublishedHeater, type ThermalStoreModel } from "./device-models.ts";
import { deviceMembers, allocateDevicePower } from "./device-power-allocation.ts";
import { poolHeaters } from "./pool-devices.ts";
import { validatePoolDynamics } from "./pool-response.ts";

type PoolFacts = Pick<OptimisationSnapshot, "pool" | "pool_model" | "device_models" | "device_physics">;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
function fail(message: string): never { throw new DeviceModelError(message); }

/** Supported ON electricity is a device fact, never a historical duty average. */
export function poolElectricalDemand(snapshot: PoolFacts): { compressor_w: number; auxiliary_w: number; member_w: Record<string, number> } {
  const members = snapshot.device_models.filter(m => m.planning_service === "pool");
  const keys = new Set(poolHeaters(members).map(m => m.key));
  const response = snapshot.pool_model?.heater_response;
  const observed = response?.kind === "bergvarme" ? response.evidence?.steady_compressor_w : undefined;
  const supplied = snapshot.device_physics?.pool?.heater;
  const compressor = supplied ? operatingPoint(supplied, supplied.selected_setting).electric_w : (finite(observed) && observed > 0 ? observed
    : sum(members.filter(m => keys.has(m.key)).map(m => m.active_power_w ?? 0)));
  const auxiliary = supplied?.auxiliary_w ?? sum(members.filter(m => !keys.has(m.key)).map(m => m.active_power_w ?? 0));
  const member_w: Record<string, number> = {};
  allocateDevicePower(deviceMembers(members.filter(m => keys.has(m.key)), compressor), compressor, member_w);
  allocateDevicePower(deviceMembers(members.filter(m => !keys.has(m.key)), auxiliary), auxiliary, member_w);
  return { compressor_w: compressor, auxiliary_w: auxiliary, member_w };
}

/** One publication boundary for live, replay and browser models. No I/O or fit. */
export function poolPhysics(snapshot: PoolFacts): { store: ThermalStoreModel; heater: PublishedHeater } {
  const supplied = snapshot.device_physics?.pool;
  if (supplied) return { store: supplied.store, heater: publishHeater(supplied.heater) };
  const measured = snapshot.pool_model;
  if (!snapshot.pool || !measured?.heater_response) fail("Pool physical response model is unavailable");
  const response = parseHeaterResponse(measured.heater_response);
  const { compressor_w: compressor, auxiliary_w: auxiliary } = poolElectricalDemand(snapshot);
  const capacity = snapshot.pool.volume_m3 * WATER_KWH_PER_M3_K;
  if (!(compressor > 0) || !(capacity > 0)) fail("Pool compressor input and water capacity must be positive");
  const dynamics = measured.thermal_dynamics;
  if (dynamics) {
    validatePoolDynamics(dynamics);
    const startup = response.kind === 'steady' ? response : { ...response,
      startup: response.startup.map(p => ({ ...p, heat_fraction: p.electric_fraction })) };
    const heater = { compressor_w: compressor, auxiliary_w: auxiliary, heat_w: dynamics.heat_c_per_kwh * capacity * compressor,
      response: startup, ...(dynamics.source ? { source: { recovery_rate_per_h: dynamics.source.recovery_rate_per_h,
        heat_loss_per_kwh: dynamics.source.heat_loss_c_per_kwh_per_kwh / dynamics.heat_c_per_kwh } } : {}) };
    validateHeaterSource(heater);
    return { store: { capacity_kwh_per_c: capacity, response_time_constant_h: dynamics.response_time_constant_h,
      loss: { kind: 'measured', points: [{ at_c: dynamics.reference_c, c_per_h: dynamics.idle_c_per_h }] } }, heater };

  }
  const points = (measured.response ?? []).flatMap(b => finite(b.idle_c_per_h) ? [{ at_c: b.at_c, c_per_h: b.idle_c_per_h }] : []).sort((a, b) => a.at_c - b.at_c);
  const gains = (measured.response ?? []).filter(b => finite(b.heat_c_per_kwh) && b.heat_c_per_kwh > 0 && finite(b.heated_kwh) && b.heated_kwh > 0);
  const weight = sum(gains.map(b => b.heated_kwh!));
  const heat = weight > 0 ? sum(gains.map(b => b.heat_c_per_kwh! * b.heated_kwh!)) / weight * capacity * compressor
    : finite(measured.rated_cop) ? measured.rated_cop * compressor : null;
  const loss: ThermalStoreModel["loss"] | null = points.length ? { kind: "measured", points }
    : finite(measured.loss_kw_per_k) ? { kind: "linear", kw_per_c: measured.loss_kw_per_k, surroundings_c: null } : null;
  if (!heat || !(heat > 0) || !loss) fail("Pool model requires measured heat delivery and standing loss");
  return { store: { capacity_kwh_per_c: capacity, response_time_constant_h: 0, loss },
    heater: { compressor_w: compressor, auxiliary_w: auxiliary, heat_w: heat, response } };
}
