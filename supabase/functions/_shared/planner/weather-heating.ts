/** Electrical draw while heating, with the observed outdoor range kept as evidence. */
import { heatingBand, type HeatingBandRevision } from "./heating-bands.ts";

export const WEATHER_HEATING_METHOD = "weather_heating_draw_v1";
export const MAX_POINTS = 10;

export const isWeatherHeatingBinding = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 768;

export interface HeatingPoint {
  outdoor_c: number;
  min_c: number;
  max_c: number;
  watts: number;
  spread_w: number;
  hours: number;
  days: number;
}
export type HeatingDrawBand = HeatingPoint & HeatingBandRevision;
export interface WeatherHeatingProfile {
  method: typeof WEATHER_HEATING_METHOD;
  binding: string;
  points: HeatingPoint[];
  banded?: true;
  reference?: { revision: string; points: HeatingPoint[] };
  versioned?: { candidates: HeatingDrawBand[]; attempted: Record<string, string>;
    implementation?: string; evidence_updated_at?: Record<string, string>; pending_bands?: number };
}

export function readWeatherHeating(value: unknown, binding: string, allowEmpty = false): WeatherHeatingProfile | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as WeatherHeatingProfile;
  if (profile.method !== WEATHER_HEATING_METHOD || profile.binding !== binding ||
    !Array.isArray(profile.points) || profile.points.length < (profile.versioned || profile.banded
      ? (allowEmpty || profile.reference ? 0 : 1) : 2) ||
    (!(profile.versioned || profile.banded) && profile.points.length > MAX_POINTS)) return null;
  const valid = (point: HeatingPoint, i: number, points: HeatingPoint[]) => point &&
    [point.outdoor_c, point.min_c, point.max_c, point.watts, point.spread_w, point.hours, point.days].every(Number.isFinite) &&
    point.min_c <= point.outdoor_c && point.outdoor_c <= point.max_c && point.watts > 0 &&
    point.spread_w >= 0 && point.hours > 0 && point.days > 0 &&
    (i === 0 || points[i - 1].outdoor_c < point.outdoor_c);
  const readBand = (point: HeatingDrawBand) => valid(point, 0, []) &&
    Number.isFinite(point.band_c) && point.band_c === heatingBand(point.min_c) &&
    point.band_c === heatingBand(point.max_c) && typeof point.revision === "string" && !!point.revision &&
    Date.parse(point.training_from) < Date.parse(point.training_to);
  if (profile.versioned && (!Array.isArray(profile.versioned.candidates) ||
    !profile.versioned.attempted || typeof profile.versioned.attempted !== "object")) return null;
  const reference = profile.reference && typeof profile.reference.revision === "string" &&
    Array.isArray(profile.reference.points) && profile.reference.points.length >= 2 &&
    profile.reference.points.every(valid) ? profile.reference : undefined;
  if (profile.versioned || profile.banded) {
    const points = (profile.points as HeatingDrawBand[]).filter(readBand);
    if (!points.length && !reference && !allowEmpty) return null;
    const versioned = profile.versioned && { ...profile.versioned, candidates: profile.versioned.candidates.filter(readBand) };
    return { ...profile, points, reference, ...(versioned ? { versioned } : {}) };
  }
  return profile.points.every(valid) ? profile : null;
}

/** Resolve once per forecast quarter, never extrapolate from the end of the curve. */
export function heatingWatts(profile: WeatherHeatingProfile, outdoor: number | null): number | null {
  return heatingDraw(profile, outdoor)?.watts ?? null;
}

export function heatingDraw(profile: WeatherHeatingProfile, outdoor: number | null):
  { watts: number; band?: HeatingDrawBand; reference?: string; anchors_c?: number[] } | null {
  if (profile.versioned || profile.banded) {
    const band = heatingDrawBandAt(profile, outdoor);
    if (band) return { watts: band.watts, band };
    const fitted = profile.reference && heatingCurveAt(profile.reference.points, outdoor);
    return fitted && profile.reference ? { ...fitted, reference: profile.reference.revision } : null;
  }
  return heatingCurveAt(profile.points, outdoor);
}

export function heatingCurveAt(points: readonly HeatingPoint[], outdoor: number | null) {
  if (outdoor === null || !Number.isFinite(outdoor) || points.length < 2 ||
    outdoor < points[0].min_c || outdoor > points[points.length - 1].max_c) return null;
  const next = points.findIndex(point => point.outdoor_c > outdoor);
  if (next <= 0) {
    const point = points[next === 0 ? 0 : points.length - 1];
    return { watts: point.watts, anchors_c: [point.outdoor_c] };
  }
  const a = points[next - 1], b = points[next];
  const weight = (outdoor - a.outdoor_c) / (b.outdoor_c - a.outdoor_c);
  return { watts: a.watts + (b.watts - a.watts) * weight,
    anchors_c: [a.outdoor_c, b.outdoor_c] };
}

export function heatingDrawBandAt(profile: WeatherHeatingProfile, outdoor: number | null): HeatingDrawBand | undefined {
  if (!(profile.versioned || profile.banded) || outdoor === null || !Number.isFinite(outdoor)) return;
  return (profile.points as HeatingDrawBand[]).find(band =>
    band.band_c === heatingBand(outdoor) && outdoor >= band.min_c && outdoor <= band.max_c);
}
