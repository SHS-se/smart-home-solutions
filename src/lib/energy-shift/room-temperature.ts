// Room temperatures for the plan chart: measured before now, planned after,
// for the rooms the plan drives (controlled-rooms.ts).
import {
  controlledRooms, type RoomPlan,
} from '../../../supabase/functions/_shared/planner/controlled-rooms';

/** One measured room reading: the temperature at the start of the quarter. */
export interface RoomSlotRow {
  start_ts: string;
  room_key: string;
  room_temperature_c: number;
}

export interface ChartRoom { key: string; name: string; deviceKeys: string[] }

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
