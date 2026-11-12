/** Electrical draw while heating, with the observed outdoor range kept as evidence. */
export const WEATHER_HEATING_METHOD = "weather_heating_draw_v1";
export const MAX_POINTS = 10;

export const isWeatherHeatingBinding = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 768;

interface HeatingPoint {
  outdoor_c: number;
  min_c: number;
  max_c: number;
  watts: number;
  spread_w: number;
  hours: number;
  days: number;
}
export interface WeatherHeatingProfile {
  method: typeof WEATHER_HEATING_METHOD;
  binding: string;
  points: HeatingPoint[];
}

export function readWeatherHeating(value: unknown, binding: string): WeatherHeatingProfile | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as WeatherHeatingProfile;
  if (profile.method !== WEATHER_HEATING_METHOD || profile.binding !== binding ||
    !Array.isArray(profile.points) || profile.points.length < 2 || profile.points.length > MAX_POINTS) return null;
  return profile.points.every((point, i, points) => point &&
    [point.outdoor_c, point.min_c, point.max_c, point.watts, point.spread_w, point.hours, point.days].every(Number.isFinite) &&
    point.min_c <= point.outdoor_c && point.outdoor_c <= point.max_c && point.watts > 0 &&
    point.spread_w >= 0 && point.hours > 0 && point.days > 0 &&
    (i === 0 || points[i - 1].outdoor_c < point.outdoor_c)) ? profile : null;
}

/** Resolve once per forecast quarter, never extrapolate from the end of the curve. */
export function heatingWatts(profile: WeatherHeatingProfile, outdoor: number | null): number | null {
  const points = profile.points;
  if (outdoor === null || !Number.isFinite(outdoor) || points.length < 2 ||
    outdoor < points[0].min_c || outdoor > points[points.length - 1].max_c) return null;
  const next = points.findIndex(point => point.outdoor_c > outdoor);
  if (next < 0) return points[points.length - 1].watts;
  if (next === 0) return points[0].watts;
  const a = points[next - 1], b = points[next];
  return a.watts + (b.watts - a.watts) * (outdoor - a.outdoor_c) / (b.outdoor_c - a.outdoor_c);
}
