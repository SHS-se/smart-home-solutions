import { isWeatherHeatingBinding } from "./planner/weather-heating.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { poolHeaters, type PoolDevice } from "./planner/pool-devices.ts";
/** Database capture owns calibration identity; forecasts and solvers cannot select it. */
// deno-lint-ignore no-explicit-any
export type ModelDatabase = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }> };
export interface StoredDeviceModel extends Record<string, unknown> {
  model_revision: number;
  room_key?: string;
  trained?: boolean;
  last_fit_attempt?: { issues?: string[]; learning?: { method?: string } };
}
export interface StoredPoolModel extends StoredDeviceModel {
  thermal_dynamics?: NonNullable<OptimisationSnapshot["pool_model"]>["thermal_dynamics"];
  hardware?: NonNullable<OptimisationSnapshot["pool_model"]>["hardware"];
}
export interface DeviceModelBundle {
  rooms: StoredDeviceModel[];
  pool: StoredPoolModel | null;
  /** Learned operating points and weather-dependent heating profiles. */
  devices: StoredDeviceModel[];
  revisions: { rooms: Record<string, number>; pool: number | null };
}
export async function captureDeviceModels(db: ModelDatabase, homeId: string): Promise<DeviceModelBundle> {
  const { data, error } = await db.rpc("capture_energy_device_models", { p_home_id: homeId });
  if (error) throw new Error(`Model capture failed: ${error.message}`);
  if (!data || !Array.isArray(data.rooms) || !(data.pool === null || typeof data.pool === "object")) {
    throw new Error("Malformed device model bundle");
  }
  const rooms: StoredDeviceModel[] = data.rooms;
  const pool: StoredPoolModel | null = data.pool;
  const devices: StoredDeviceModel[] = Array.isArray(data.devices) ? data.devices : [];
  for (const model of [...rooms, ...(pool ? [pool] : []), ...devices]) {
    if (!Number.isSafeInteger(model.model_revision) || model.model_revision < 1) throw new Error("Missing device model revision");
  }
  return { rooms, pool, devices, revisions: {
    rooms: Object.fromEntries(rooms.map(model => [String(model.room_key), model.model_revision])),
    pool: pool?.model_revision ?? null,
  } };
}
export interface LearningOwner {
  kind: "room" | "pool" | "device";
  key: string;
  input: Record<string, unknown>;
}
/** A pool fit needs mapped heater electricity; pool telemetry alone has no series to fit. */
export function poolLearningOwner(pool: { volume_m3: number } | null | undefined,
  devices: readonly (PoolDevice & { key: string })[]): LearningOwner | null {
  if (!pool) return null;
  const keys = poolHeaters(devices).map(device => device.key);
  // The other pool members (a circulation pump) are learned alongside: their
  // draw and settings belong to the pool's operating points, not its heat.
  const auxiliary = devices.filter(device => device.planning_service === "pool" && !keys.includes(device.key)).map(device => device.key).sort();
  return keys.length ? { kind: "pool", key: "pool", input: { volume_m3: pool.volume_m3, device_keys: keys,
    ...(auxiliary.length ? { auxiliary_keys: auxiliary } : {}) } } : null;
}
export async function requestDeviceLearning(db: ModelDatabase, homeId: string, customerId: string, owners: LearningOwner[]): Promise<void> {
  const { error } = await db.rpc("request_energy_device_learning", {
    p_home_id: homeId, p_customer_id: customerId, p_owners: owners,
  });
  if (error) throw new Error(error.message);
}

/** Every variable-power device outside the pool learns its own operating
 * points. A pool member's are learned with the pool, keyed by every member's
 * setting, because the members change one another's efficiency. */
export function variablePowerLearningOwners(
  devices: readonly { key: string; control_type: string | null }[],
  poolMemberKeys: ReadonlySet<string>,
): LearningOwner[] {
  return devices.filter(device => device.control_type === "variable_power" && !poolMemberKeys.has(device.key))
    .map(device => device.key).sort().map(key => ({ kind: "device" as const, key, input: {} }));
}

export function weatherHeatingOwners(snapshot: OptimisationSnapshot): LearningOwner[] {
  return snapshot.device_models.flatMap(model =>
    model.control_type === "setpoint" && model.planning_service !== "pool" &&
    isWeatherHeatingBinding(model.weather_heating_binding)
      ? [{ kind: "device", key: model.key, input: { weather_heating_binding: model.weather_heating_binding } }]
      : []);
}
