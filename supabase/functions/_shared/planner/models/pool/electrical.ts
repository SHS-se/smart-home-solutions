/** Pool ON electricity, independent of fitted thermal response and recovered heat. */
import type { OptimisationSnapshot } from "../../planning-contracts.ts";
import { operatingPoint } from "../../device-models.ts";
import { deviceMembers, allocateDevicePower } from "../../device-power-allocation.ts";
import { poolHeaters } from "../../pool-devices.ts";
// Thermal dynamics, water state and comfort intent are deliberately absent.
type PoolElectricalInput = Pick<OptimisationSnapshot, "device_models" | "device_physics">;
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

/** Supported ON electricity is a device fact, never a historical duty average. */
export function poolElectricalDemand(snapshot: PoolElectricalInput): { compressor_w: number; auxiliary_w: number; member_w: Record<string, number> } {
  const members = snapshot.device_models.filter(m => m.planning_service === "pool");
  const keys = new Set(poolHeaters(members).map(m => m.key));
  const supplied = snapshot.device_physics?.pool?.heater;
  const compressor = supplied ? operatingPoint(supplied, supplied.selected_setting).electric_w
    : sum(members.filter(m => keys.has(m.key)).map(m => m.active_power_w ?? 0));
  const auxiliary = supplied?.auxiliary_w ?? sum(members.filter(m => !keys.has(m.key)).map(m => m.active_power_w ?? 0));
  const member_w: Record<string, number> = {};
  allocateDevicePower(deviceMembers(members.filter(m => keys.has(m.key)), compressor), compressor, member_w);
  allocateDevicePower(deviceMembers(members.filter(m => !keys.has(m.key)), auxiliary), auxiliary, member_w);
  return { compressor_w: compressor, auxiliary_w: auxiliary, member_w };
}
