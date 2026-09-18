import type {
  DeviceControlType,
  DeviceLoadType,
  DevicePlanningRole,
} from "../_shared/energy-optimisation.ts";

export type DeviceMappingStatus = "not_configured" | "ready" | "invalid";

export interface IncomingDevice {
  key: string;
  statistic_id: string;
  name: string;
  category: string;
  suggested_load_type: DeviceLoadType;
  suggested_planning_role: DevicePlanningRole;
  suggested_control_type: DeviceControlType | null;
  active_power_w: number | null;
  profile_sample_count: number;
  inference: Record<string, unknown>;
  mapping_status: DeviceMappingStatus;
  mapped_control_type: DeviceControlType | null;
  mapping_error: string | null;
  mapping_summary: Record<string, unknown>;
}

export interface RoomMapping {
  key: string;
  name: string;
  controlled_devices: string[];
}

const hasRoomMappingMetadata = (
  device: Pick<IncomingDevice, "mapping_summary">,
) => {
  const summary = device.mapping_summary;
  return !!summary && typeof summary === "object" && !Array.isArray(summary) &&
    ["room_key", "room_name", "controlled_devices"].some((key) =>
      Object.prototype.hasOwnProperty.call(summary, key)
    );
};

export const roomMapping = (
  device: Pick<
    IncomingDevice,
    "mapping_status" | "mapped_control_type" | "mapping_summary"
  >,
): RoomMapping | null => {
  if (
    device.mapping_status !== "ready" ||
    !["setpoint", "switch_schedule"].includes(device.mapped_control_type ?? "")
  ) return null;
  const key = device.mapping_summary.room_key;
  const name = device.mapping_summary.room_name;
  const controlled = device.mapping_summary.controlled_devices;
  if (
    typeof key !== "string" || key.length < 1 || key.length > 255 ||
    typeof name !== "string" || name.length < 1 || name.length > 255 ||
    !Array.isArray(controlled) || controlled.length === 0 ||
    controlled.some((value) =>
      typeof value !== "string" || value.length < 1 || value.length > 255
    )
  ) return null;
  return { key, name, controlled_devices: [...new Set(controlled)] };
};

const DEVICE_LOAD_TYPES = new Set<DeviceLoadType>([
  "fixed_full_load",
  "variable_full_load",
  "duty_cycle",
  "inverter",
]);
const DEVICE_PLANNING_ROLES = new Set<DevicePlanningRole>([
  "base_load",
  "controllable",
]);
const DEVICE_CONTROL_TYPES = new Set<DeviceControlType>([
  "switch_schedule",
  "variable_power",
  "permit_inhibit",
  "setpoint",
]);
const DEVICE_MAPPING_STATUSES = new Set<DeviceMappingStatus>([
  "not_configured",
  "ready",
  "invalid",
]);
const DEVICE_CATEGORIES = new Set([
  "heating",
  "hot_water",
  "cooling",
  "property_energy",
  "pool_heating",
  "ev_charging",
  "household",
]);

const boundedText = (value: unknown, max: number) =>
  typeof value === "string" && value.length >= 1 && value.length <= max;

/**
 * Which field breaks one device's contract, or null when none does.
 *
 * The predicates are the ones this endpoint has always applied, in the order it
 * always applied them. What changed is that they no longer collapse into a
 * single boolean whose rejection said `devices[3]` and nothing more — one of
 * fourteen fields is wrong, go and work out which. That mattered because this
 * is the push carrying the plan *and* the price slots, and it is refused before
 * either is stored: a home stops being planned and its prices stop arriving for
 * as long as the guessing takes, while the portal goes on drawing the last plan
 * it got. Naming the field costs a string and makes that a one-line diagnosis.
 *
 * One ordering change is deliberate. `mapping_summary` is type-checked before
 * the per-status blocks rather than after them, because `roomMapping` reads
 * through it: a `setpoint` device arriving with a null summary used to throw
 * inside the validator and answer 500, which reports a broken server for what
 * is a malformed request.
 */
export const deviceContractBreach = (
  device: IncomingDevice,
  claimedKeys: ReadonlySet<string>,
): string | null => {
  if (!boundedText(device?.key, 255)) return "key";
  if (claimedKeys.has(device.key)) return "key (duplicate)";
  if (!boundedText(device.statistic_id, 255)) return "statistic_id";
  if (!boundedText(device.name, 255)) return "name";
  if (!DEVICE_CATEGORIES.has(device.category)) return "category";
  if (!DEVICE_LOAD_TYPES.has(device.suggested_load_type)) {
    return "suggested_load_type";
  }
  if (!DEVICE_PLANNING_ROLES.has(device.suggested_planning_role)) {
    return "suggested_planning_role";
  }
  // Only a controllable meter carries a control type; base load must not.
  if (
    device.suggested_planning_role === "base_load"
      ? device.suggested_control_type !== null
      : !DEVICE_CONTROL_TYPES.has(
        device.suggested_control_type as DeviceControlType,
      )
  ) return "suggested_control_type";
  if (
    device.active_power_w !== null &&
    (typeof device.active_power_w !== "number" ||
      !Number.isFinite(device.active_power_w) ||
      device.active_power_w < 0 || device.active_power_w > 100_000)
  ) return "active_power_w";
  if (
    !Number.isInteger(device.profile_sample_count) ||
    device.profile_sample_count < 0
  ) return "profile_sample_count";
  if (
    !device.inference || typeof device.inference !== "object" ||
    Array.isArray(device.inference)
  ) return "inference";
  if (!DEVICE_MAPPING_STATUSES.has(device.mapping_status)) {
    return "mapping_status";
  }
  if (
    !device.mapping_summary || typeof device.mapping_summary !== "object" ||
    Array.isArray(device.mapping_summary)
  ) return "mapping_summary";
  if (device.mapping_status === "not_configured") {
    if (device.mapped_control_type !== null) return "mapped_control_type";
    if (device.mapping_error !== null) return "mapping_error";
  }
  if (device.mapping_status === "ready") {
    if (
      !DEVICE_CONTROL_TYPES.has(device.mapped_control_type as DeviceControlType)
    ) return "mapped_control_type";
    if (device.mapping_error !== null) return "mapping_error";
    // Pool water heating uses the pool model, even when the website calls
    // it a setpoint. Room metadata, when supplied, must still be complete.
    if (
      ((device.mapped_control_type === "setpoint" &&
        device.mapping_summary.planning_service !== "pool") ||
        hasRoomMappingMetadata(device)) && roomMapping(device) === null
    ) return "mapping_summary.room_key/room_name/controlled_devices";
  }
  if (device.mapping_status === "invalid") {
    if (
      !DEVICE_CONTROL_TYPES.has(device.mapped_control_type as DeviceControlType)
    ) return "mapped_control_type";
    if (!boundedText(device.mapping_error, 1000)) return "mapping_error";
  }
  return null;
};
