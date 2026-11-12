import { MAX_POINTS, WEATHER_HEATING_METHOD, type WeatherHeatingProfile } from "../planner/weather-heating.ts";

const BAND_C = 3;

export interface HeatingDay {
  day: string;
  outdoor_c: number;
  watts: number;
  hours: number;
}
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** Typical draw across days, so one long heating run cannot dominate a band. */
export function fitWeatherHeating(binding: string, observations: readonly HeatingDay[]): WeatherHeatingProfile {
  const valid = observations.filter(row => Number.isFinite(row.outdoor_c) &&
    Number.isFinite(row.watts) && row.watts > 0 && Number.isFinite(row.hours) && row.hours > 0);
  const coldest = valid.reduce((min, row) => Math.min(min, row.outdoor_c), Infinity);
  const warmest = valid.reduce((max, row) => Math.max(max, row.outdoor_c), -Infinity);
  const first = Math.floor(coldest / BAND_C) * BAND_C;
  const width = Math.max(BAND_C, (warmest - first) / MAX_POINTS);
  const bands = new Map<number, HeatingDay[]>();
  for (const row of valid) {
    const index = Math.min(MAX_POINTS - 1, Math.floor((row.outdoor_c - first) / width));
    const band = bands.get(index) ?? [];
    band.push(row);
    bands.set(index, band);
  }
  const points = [...bands].sort(([a], [b]) => a - b).map(([, band]) => {
    const days = new Map<string, { wh: number; hours: number }>();
    let hours = 0, outdoorHours = 0, min = Infinity, max = -Infinity;
    for (const row of band) {
      const day = days.get(row.day) ?? { wh: 0, hours: 0 };
      day.wh += row.watts * row.hours;
      day.hours += row.hours;
      days.set(row.day, day);
      hours += row.hours;
      outdoorHours += row.outdoor_c * row.hours;
      min = Math.min(min, row.outdoor_c);
      max = Math.max(max, row.outdoor_c);
    }
    const dailyWatts = [...days.values()].map(day => day.wh / day.hours);
    const watts = median(dailyWatts);
    return { outdoor_c: outdoorHours / hours, min_c: min, max_c: max, watts,
      spread_w: median(dailyWatts.map(value => Math.abs(value - watts))), hours, days: days.size };
  });
  return { method: WEATHER_HEATING_METHOD, binding, points };
}
