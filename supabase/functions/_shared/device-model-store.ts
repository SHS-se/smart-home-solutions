import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
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
  for (const model of [...rooms, ...(pool ? [pool] : [])]) {
    if (!Number.isSafeInteger(model.model_revision) || model.model_revision < 1) throw new Error("Missing device model revision");
  }
  return { rooms, pool, revisions: {
    rooms: Object.fromEntries(rooms.map(model => [String(model.room_key), model.model_revision])),
    pool: pool?.model_revision ?? null,
  } };
}
export interface LearningOwner {
  kind: "room" | "pool";
  key: string;
  input: Record<string, unknown>;
}
export async function requestDeviceLearning(db: ModelDatabase, homeId: string, customerId: string, owners: LearningOwner[]): Promise<void> {
  const { error } = await db.rpc("request_energy_device_learning", {
    p_home_id: homeId, p_customer_id: customerId, p_owners: owners,
  });
  if (error) throw new Error(error.message);
}
