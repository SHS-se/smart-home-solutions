// Room temperatures for the plan chart: measured before now, planned after,
// measured rooms remain visible even when the plan cannot forecast them.
import {
  controlledRooms, type RoomPlan,
} from '../../../supabase/functions/_shared/planner/controlled-rooms';

/** A native quarter mean, keyed by the beginning of its measurement interval. */
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

/** Forecast states are instants; recorded room temperatures are interval means. */
export interface RoomTemperatureSample {
  atMs: number;
  temperatureC: number;
  kind: 'interval_mean' | 'forecast';
}

export type RoomTemperatureSamples = Record<string, readonly RoomTemperatureSample[]>;

export interface RoomTemperaturePlan {
  rooms: ChartRoom[];
  /** Timestamped forecast segments owned by the quarter they describe. */
  samplesByStart: ReadonlyMap<number, RoomTemperatureSamples>;
  /** Each planned quarter's comfort minimum, by quarter start. */
  comfortMinByStart: ReadonlyMap<number, Record<string, number>>;
}

const QUARTER_MS = 15 * 60_000;

/**
 * Preserve the plan's capture state and quarter-end states on their own clock.
 * Each quarter owns its segment, including the final horizon endpoint. A window
 * starting later can therefore show its published start without a live reading.
 * Older stored plans have endpoints but no initial state; do not invent one.
 */
export function plannedRoomTemperatures(plan: RoomPlan): RoomTemperaturePlan {
  const rooms = controlledRooms(plan);
  const starts = (plan.thermal_projection?.starts ?? []).map(start => Date.parse(start));
  const initialAt = Date.parse(plan.thermal_projection?.initial_at ?? '');
  const samplesByStart = new Map<number, RoomTemperatureSamples>();
  const comfortMinByStart = new Map<number, Record<string, number>>();
  for (const room of rooms) starts.forEach((start, i) => {
    if (!Number.isFinite(start)) return;
    const samples: RoomTemperatureSample[] = [];
    const add = (atMs: number, temperatureC: number | undefined) => {
      if (Number.isFinite(atMs) && temperatureC !== undefined && Number.isFinite(temperatureC)) {
        samples.push({ atMs, temperatureC, kind: 'forecast' });
      }
    };
    if (i === 0) add(initialAt, room.initial_temperature_c);
    else if (starts[i - 1] + QUARTER_MS === start) add(start, room.planned_temperature_c[i - 1]);
    add(start + QUARTER_MS, room.planned_temperature_c[i]);
    if (samples.length) samplesByStart.set(start, { ...samplesByStart.get(start), [room.key]: samples });
    const comfort = room.comfort_min_c[i];
    if (Number.isFinite(comfort)) comfortMinByStart.set(start, { ...comfortMinByStart.get(start), [room.key]: comfort });
  });
  return {
    rooms: rooms.map(room => ({ key: room.key, name: room.name, deviceKeys: room.device_keys ?? [] })),
    samplesByStart, comfortMinByStart,
  };
}

export const EMPTY_ROOM_PLAN: RoomTemperaturePlan = {
  rooms: [], samplesByStart: new Map(), comfortMinByStart: new Map(),
};

/** Keep missing quarters and source boundaries visible; never bridge a hole. */
export function roomTemperatureSeries(
  rows: readonly { roomTemperatures?: RoomTemperatureSamples }[],
  key: string,
  kind: RoomTemperatureSample['kind'],
): (RoomTemperatureSample | null)[] {
  const points: (RoomTemperatureSample | null)[] = [];
  for (const row of rows) {
    const samples = row.roomTemperatures?.[key]?.filter(sample => sample.kind === kind) ?? [];
    if (!samples.length) { points.push(null); continue; }
    const previous = points.at(-1);
    if (kind === 'forecast' && previous && previous.atMs !== samples[0].atMs) points.push(null);
    for (const sample of samples) {
      const previous = points.at(-1);
      if (previous?.atMs === sample.atMs && previous.temperatureC === sample.temperatureC) continue;
      points.push(sample);
    }
  }
  return points;
}
