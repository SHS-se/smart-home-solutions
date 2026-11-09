import type { ModelDatabase } from "./device-model-store.ts";
import type { PassiveRoomHeat } from "./planner/models/room/thermal.ts";

interface PassiveHeatSource {
  device_key: string;
  watts: ReadonlyMap<number, number>;
}

export function readPassiveHeatModel(value: unknown): PassiveRoomHeat | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const model = value as Partial<PassiveRoomHeat>;
  const { device_key, direct_c_per_wh, delayed_c_per_wh, lag_h } = model;
  if (typeof device_key === "string" && typeof direct_c_per_wh === "number" && Number.isFinite(direct_c_per_wh) &&
    direct_c_per_wh >= 0 && typeof delayed_c_per_wh === "number" && Number.isFinite(delayed_c_per_wh) &&
    delayed_c_per_wh > 0 && typeof lag_h === "number" && Number.isFinite(lag_h) && lag_h > 0) {
    return { device_key, direct_c_per_wh, delayed_c_per_wh, lag_h };
  }
}

/** Current, explicitly assigned Monitoring meters only. Missing quarter keys remain unknown. */
export async function readRoomPassiveHeat(
  db: ModelDatabase, customerId: string, homeId: string,
  roomKeys: string[], from: string, to: string,
): Promise<Map<string, PassiveHeatSource>> {
  const { data, error } = await db.rpc("get_energy_room_passive_heat", {
    p_customer_id: customerId, p_home_id: homeId, p_room_keys: roomKeys, p_from: from, p_to: to,
  });
  if (error) throw new Error(error.message);
  const sources = new Map<string, PassiveHeatSource>();
  for (const { room_key, device_key, quarters } of data ?? []) {
    const watts = new Map<number, number>();
    for (const [start, power] of quarters) {
      if (Number.isSafeInteger(start) && typeof power === "number" && Number.isFinite(power) && power >= 0) watts.set(start, power);
    }
    sources.set(room_key, { device_key, watts });
  }
  return sources;
}
