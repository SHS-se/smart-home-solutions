// Room temperatures for the plan chart: measured before now, planned after,
// measured rooms remain visible even when the plan cannot forecast them.
import {
  controlledRooms, type RoomPlan,
} from '../../../supabase/functions/_shared/planner/controlled-rooms';

/** One measured room reading: the temperature at the start of the quarter. */
export interface RoomSlotRow {
  start_ts: string;
  room_key: string;
  room_name: string;
  room_temperature_c: number;
}

export interface ChartRoom { key: string; name: string; deviceKeys: string[] }

/** Measurements identify their own rooms; forecasting is not a prerequisite. */
export function chartedTemperatureRooms(
  planned: readonly ChartRoom[],
  actuals: readonly RoomSlotRow[],
  devices: readonly { device_key: string; mapping_summary: Record<string, unknown> }[],
): ChartRoom[] {
  const rooms = new Map(planned.map(room => [room.key, room]));
  const measuredNames = new Map(actuals.map(row => [row.room_key, row.room_name]));
  for (const [key, name] of measuredNames) {
    rooms.set(key, {
      key, name,
      deviceKeys: [...new Set([
        ...(rooms.get(key)?.deviceKeys ?? []),
        ...devices.filter(device => device.mapping_summary.room_key === key).map(device => device.device_key),
      ])],
    });
  }
  return [...rooms.values()];
}

export interface RoomTemperaturePlan {
  rooms: ChartRoom[];
  /** °C at the start of each quarter, by quarter start. */
  temperatureByStart: ReadonlyMap<number, Record<string, number>>;
  /** Each planned quarter's comfort minimum, by quarter start. */
  comfortMinByStart: ReadonlyMap<number, Record<string, number>>;
}

const QUARTER_MS = 15 * 60_000;

const put = (map: Map<number, Record<string, number>>, at: number, key: string, value: number) => {
  if (!Number.isFinite(at) || !Number.isFinite(value)) return;
  map.set(at, { ...map.get(at), [key]: value });
};

/**
 * The plan gives each quarter's temperature at its end, which is the next
 * quarter's start: the instant a measured reading is taken at. Shifting it a
 * quarter keeps the planned line on the same clock as the measured one.
 */
export function plannedRoomTemperatures(plan: RoomPlan): RoomTemperaturePlan {
  const rooms = controlledRooms(plan);
  const starts = (plan.thermal_projection?.starts ?? []).map(start => Date.parse(start));
  const temperatureByStart = new Map<number, Record<string, number>>();
  const comfortMinByStart = new Map<number, Record<string, number>>();
  for (const room of rooms) starts.forEach((start, i) => {
    put(temperatureByStart, start + QUARTER_MS, room.key, room.planned_temperature_c[i]);
    put(comfortMinByStart, start, room.key, room.comfort_min_c[i]);
  });
  return {
    rooms: rooms.map(room => ({ key: room.key, name: room.name, deviceKeys: room.device_keys ?? [] })),
    temperatureByStart, comfortMinByStart,
  };
}

export const EMPTY_ROOM_PLAN: RoomTemperaturePlan = {
  rooms: [], temperatureByStart: new Map(), comfortMinByStart: new Map(),
};
