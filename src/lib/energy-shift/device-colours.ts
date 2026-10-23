import type { DeviceControlType, DeviceLoadType, DevicePlanningRole } from './contracts';

export interface EmpiricalEnergyDevice {
  id: string;
  device_key: string;
  statistic_id: string;
  name: string;
  colour: string;
  retired_at: string | null;
  category: string;
  load_type_override: DeviceLoadType;
  planning_role_override: DevicePlanningRole;
  planning_choice_at: string | null;
  control_type_override: DeviceControlType | null;
  mapping_status: 'not_configured' | 'ready' | 'invalid';
  mapped_control_type: DeviceControlType | null;
  mapping_error: string | null;
  mapping_summary: Record<string, unknown>;
  mapping_reported_at: string | null;
  active_power_w: number | null;
  profile_sample_count: number;
  last_seen_at: string;
}

export interface DeviceColour { device_key: string; colour: string }

/** Validate the catalogue boundary once; a missing assignment is a data error. */
export function parseDeviceColours<T extends DeviceColour>(rows: readonly T[]): T[] {
  const keys = new Set<string>(), colours = new Set<string>();
  for (const row of rows) {
    if (!/^#[0-9a-f]{6}$/.test(row.colour)) throw new Error(`Invalid saved colour for device ${row.device_key}`);
    if (keys.has(row.device_key) || colours.has(row.colour)) throw new Error('Duplicate device identity or saved colour');
    keys.add(row.device_key); colours.add(row.colour);
  }
  return [...rows];
}

export function deviceColour(devices: readonly DeviceColour[], key: string): string {
  const device = devices.find(device => device.device_key === key);
  if (!device) throw new Error(`Device colour is missing from the catalogue: ${key}`);
  return device.colour;
}

/** A true aggregate has its own semantic colour; one device retains its identity. */
export function ownerColour(devices: readonly DeviceColour[], keys: readonly string[], aggregateColour: string): string {
  const owners = [...new Set(keys)];
  return owners.length === 1 ? deviceColour(devices, owners[0]) : aggregateColour;
}
