/**
 * The rooms shown on the selected-plan chart. Verification is a counterfactual
 * of Controlling and never asserts that physical commands were executed.
 */
export interface PlannedRoom {
  key: string;
  name: string;
  device_keys?: string[];
  /** Published capture state; older stored plans omit it. */
  initial_temperature_c?: number;
  observed_through?: string | null;
  /** °C at the end of each projected quarter. */
  planned_temperature_c: number[];
  /** Integrated mean over the corresponding planning interval. */
  planned_mean_temperature_c?: number[];
  comfort_min_c: number[];
}

export interface RoomPlan {
  operating_scope?: { modes: Record<string, string>; device_owners: Record<string, string> } | null;
  thermal_projection?: { initial_at?: string; starts: string[]; zones: PlannedRoom[] } | null;
}

const DRIVEN = new Set(["control_verification", "controlling"]);

export function controlledRooms(plan: RoomPlan): PlannedRoom[] {
  const scope = plan.operating_scope;
  if (!scope?.modes || !scope.device_owners) return [];
  return (plan.thermal_projection?.zones ?? []).filter(room =>
    room.device_keys?.some(key => DRIVEN.has(scope.modes[scope.device_owners[key] ?? key])));
}

export function roomForecastComparison(plan: RoomPlan, room: PlannedRoom): 'executed_interval_mean' | 'counterfactual' | 'mode_unrecorded' {
  const scope = plan.operating_scope;
  if (!room.device_keys?.length || !scope) return 'mode_unrecorded';
  const modes = room.device_keys.map(key => scope.modes[scope.device_owners[key]]);
  if (modes.some(mode => !mode)) return 'mode_unrecorded';
  return modes.every(mode => mode === 'controlling') ? 'executed_interval_mean' : 'counterfactual';
}
