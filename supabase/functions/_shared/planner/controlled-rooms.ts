/**
 * The rooms a plan drives: those whose heaters Home Assistant runs in control
 * verification or controlling. A room in monitoring or planning follows its
 * own thermostat, so its planned temperature is not a forecast of the room.
 */
export interface PlannedRoom {
  key: string;
  name: string;
  device_keys?: string[];
  /** °C at the end of each projected quarter. */
  planned_temperature_c: number[];
  comfort_min_c: number[];
}

export interface RoomPlan {
  operating_scope?: { modes: Record<string, string>; device_owners: Record<string, string> } | null;
  thermal_projection?: { starts: string[]; zones: PlannedRoom[] } | null;
}

const DRIVEN = new Set(["control_verification", "controlling"]);

export function controlledRooms(plan: RoomPlan): PlannedRoom[] {
  const scope = plan.operating_scope;
  if (!scope?.modes || !scope.device_owners) return [];
  return (plan.thermal_projection?.zones ?? []).filter(room =>
    room.device_keys?.some(key => DRIVEN.has(scope.modes[scope.device_owners[key] ?? key])));
}
