import type { OptimisationSnapshot } from "./planning-contracts.ts";
import { DeviceModelError, parseHeaterResponse, publishHeater, WATER_KWH_PER_M3_K, type PublishedHeater, type ThermalStoreModel } from "./device-models.ts";
import { poolHeaters } from "./pool-devices.ts";
import { poolHeatGain } from "./pool-response.ts";

type PoolFacts = Pick<OptimisationSnapshot, "pool" | "pool_model" | "device_models" | "device_physics">;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
function fail(message: string): never { throw new DeviceModelError(message); }

/** One publication boundary for live, replay and browser models. No I/O or fit. */
export function poolPhysics(snapshot: PoolFacts): { store: ThermalStoreModel; heater: PublishedHeater } {
  const supplied = snapshot.device_physics?.pool;
  if (supplied) return { store: supplied.store, heater: publishHeater(supplied.heater) };
  const measured = snapshot.pool_model;
  if (!snapshot.pool || !measured?.heater_response) fail("Pool physical response model is unavailable");
  const members = snapshot.device_models.filter(m => m.planning_service === "pool");
  const keys = new Set(poolHeaters(members).map(m => m.key));
  const response = parseHeaterResponse(measured.heater_response);
  const observed = response.kind === "bergvarme" ? response.evidence?.steady_compressor_w : undefined;
  const compressor = finite(observed) ? observed : sum(members.filter(m => keys.has(m.key)).map(m => m.active_power_w ?? 0));
  const auxiliary = sum(members.filter(m => !keys.has(m.key)).map(m => m.active_power_w ?? 0));
  const capacity = snapshot.pool.volume_m3 * WATER_KWH_PER_M3_K;
  if (!(compressor > 0) || !(capacity > 0)) fail("Pool compressor input and water capacity must be positive");
  const dynamics = measured.thermal_dynamics;
  if (dynamics) {
    const fade = dynamics.heat_fade_c_per_kwh_per_h ?? 0, until = dynamics.heat_fade_until_h ?? 0;
    if (dynamics.version !== 1 || ![dynamics.response_time_constant_h, dynamics.heat_c_per_kwh, dynamics.idle_c_per_h, dynamics.reference_c, fade, until].every(finite)
      || dynamics.response_time_constant_h < 0 || !(dynamics.heat_c_per_kwh > 0) || dynamics.idle_c_per_h > 0
      || fade < 0 || until < 0 || !(poolHeatGain(dynamics, until) > 0)) fail("Invalid learned pool thermal response");
    // This fit's forcing is compressor ELECTRICITY. The old supply/return
    // delta proxy must not attenuate the same startup a second time. The
    // learned fade rides on the same run-age curve: steady heat is the gain
    // where the observed runs end, and younger runs deliver proportionally more.
    const startup = response.kind === "steady" ? [{ elapsed_seconds: 0, electric_fraction: 1, heat_fraction: 1 }] : response.startup;
    const steadyAt = Math.max(fade > 0 ? until * 3600 : 0, startup.at(-1)!.elapsed_seconds), steadyGain = poolHeatGain(dynamics, steadyAt / 3600);
    const aged = startup.map(p => ({ ...p, heat_fraction: p.electric_fraction * poolHeatGain(dynamics, p.elapsed_seconds / 3600) / steadyGain }));
    if (steadyAt > startup.at(-1)!.elapsed_seconds) aged.push({ elapsed_seconds: steadyAt, electric_fraction: 1, heat_fraction: 1 });
    else aged[aged.length - 1].heat_fraction = 1;
    const thermalResponse = response.kind === "steady" && aged.length === 1 ? response
      : { ...(response.kind === "steady" ? { kind: "bergvarme" as const } : response), startup: aged };
    return { store: { capacity_kwh_per_c: capacity, response_time_constant_h: dynamics.response_time_constant_h,
      loss: { kind: "measured", points: [{ at_c: dynamics.reference_c, c_per_h: dynamics.idle_c_per_h }] } },
      heater: { compressor_w: compressor, auxiliary_w: auxiliary, heat_w: steadyGain * capacity * compressor, response: thermalResponse } };
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
