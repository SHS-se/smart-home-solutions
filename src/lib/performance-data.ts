import { supabase } from '@/integrations/supabase/client';

// ── Types ──

export interface CurvePoint {
  temp_c: number;
  cop: number;
  capacity_w: number;
}

export interface SurfacePoint {
  indoor_temp_c: number;
  temp_c: number;
  capacity_w: number;
  input_power_w: number;
}

export type ProfileKind = 'cop_capacity_curve' | 'heating_performance_surface' | 'load_curve';

export interface ProfileResolution {
  profile: {
    id: string;
    data: { points: CurvePoint[] | SurfacePoint[] };
    source: string | null;
    notes: string | null;
    mode: string;
    profile_kind: string;
    updated_at: string;
  } | null;
  resolvedSource: 'own' | 'borrowed' | null;
  borrowedFromName?: string;
}

// ── Validation ──

export interface ValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}

export function validateCurvePoints(points: unknown[]): ValidationResult {
  if (points.length < 2) return { valid: false, error: `At least 2 points required, got ${points.length}` };
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Record<string, number>;
    if (typeof p.temp_c !== 'number' || p.temp_c < -40 || p.temp_c > 40)
      return { valid: false, error: `points[${i}].temp_c must be between -40 and 40` };
    if (typeof p.cop !== 'number' || p.cop <= 0 || p.cop > 15)
      return { valid: false, error: `points[${i}].cop must be > 0 and <= 15` };
    if (typeof p.capacity_w !== 'number' || !Number.isInteger(p.capacity_w) || p.capacity_w <= 0 || p.capacity_w > 30000)
      return { valid: false, error: `points[${i}].capacity_w must be an integer > 0 and <= 30000` };
    if (i > 0 && p.temp_c <= (points[i - 1] as Record<string, number>).temp_c)
      return { valid: false, error: `points[${i}].temp_c not strictly increasing` };
  }
  return { valid: true };
}

export function validateSurfacePoints(points: unknown[]): ValidationResult {
  if (points.length < 2) return { valid: false, error: `At least 2 points required, got ${points.length}` };
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Record<string, number>;
    if (typeof p.indoor_temp_c !== 'number' || p.indoor_temp_c < 10 || p.indoor_temp_c > 35)
      return { valid: false, error: `points[${i}].indoor_temp_c must be between 10 and 35` };
    if (typeof p.temp_c !== 'number' || p.temp_c < -40 || p.temp_c > 40)
      return { valid: false, error: `points[${i}].temp_c must be between -40 and 40` };
    if (typeof p.capacity_w !== 'number' || !Number.isInteger(p.capacity_w) || p.capacity_w <= 0 || p.capacity_w > 50000)
      return { valid: false, error: `points[${i}].capacity_w must be integer > 0 and <= 50000` };
    if (typeof p.input_power_w !== 'number' || !Number.isInteger(p.input_power_w) || p.input_power_w <= 0 || p.input_power_w > 20000)
      return { valid: false, error: `points[${i}].input_power_w must be integer > 0 and <= 20000` };
    const key = `${p.indoor_temp_c}_${p.temp_c}`;
    if (seen.has(key)) return { valid: false, error: `points[${i}]: duplicate (indoor_temp_c=${p.indoor_temp_c}, temp_c=${p.temp_c})` };
    seen.add(key);
    const cop = p.capacity_w / p.input_power_w;
    if (cop < 0.2 || cop > 25) return { valid: false, error: `points[${i}]: derived COP ${cop.toFixed(2)} out of range` };
    if (cop < 0.5 || cop > 15) warnings.push(`points[${i}]: derived COP ${cop.toFixed(2)} is unusual`);
  }
  return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
}

export function validateProfileData(kind: ProfileKind, data: unknown): ValidationResult {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { points?: unknown[] }).points))
    return { valid: false, error: 'Data must contain a "points" array' };
  const pts = (data as { points?: unknown[] }).points;
  return kind === 'cop_capacity_curve' ? validateCurvePoints(pts) : validateSurfacePoints(pts);
}

// ── Profile Resolution ──

export async function resolveProfile(
  deviceId: string,
  mode: string,
  profileKind: ProfileKind,
): Promise<ProfileResolution> {
  // 1. Check own profile
  const { data: own } = await supabase
    .from('device_profiles')
    .select('*')
    .eq('device_id', deviceId)
    .eq('mode', mode)
    .eq('profile_kind', profileKind)
    .maybeSingle();

  if (own) {
    return { profile: own as unknown as ProfileResolution['profile'], resolvedSource: 'own' };
  }

  // 2. Check borrowed
  const { data: device } = await supabase
    .from('device_instances')
    .select('performance_data_device_id')
    .eq('id', deviceId)
    .single();

  if (device?.performance_data_device_id) {
    const { data: borrowed } = await supabase
      .from('device_profiles')
      .select('*')
      .eq('device_id', device.performance_data_device_id)
      .eq('mode', mode)
      .eq('profile_kind', profileKind)
      .maybeSingle();

    if (borrowed) {
      const { data: srcDevice } = await supabase
        .from('device_instances')
        .select('name')
        .eq('id', device.performance_data_device_id)
        .single();

      return {
        profile: borrowed as unknown as ProfileResolution['profile'],
        resolvedSource: 'borrowed',
        borrowedFromName: srcDevice?.name || 'Unknown',
      };
    }
  }

  return { profile: null, resolvedSource: null };
}

// ── Interpolation helpers ──

export function interpolateCurve(points: CurvePoint[], tempC: number): { cop: number; capacityW: number } | null {
  if (!points || points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.temp_c - b.temp_c);
  if (tempC <= sorted[0].temp_c) return { cop: sorted[0].cop, capacityW: sorted[0].capacity_w };
  if (tempC >= sorted[sorted.length - 1].temp_c) return { cop: sorted[sorted.length - 1].cop, capacityW: sorted[sorted.length - 1].capacity_w };
  for (let i = 0; i < sorted.length - 1; i++) {
    if (tempC >= sorted[i].temp_c && tempC <= sorted[i + 1].temp_c) {
      const t = (tempC - sorted[i].temp_c) / (sorted[i + 1].temp_c - sorted[i].temp_c);
      return {
        cop: sorted[i].cop + t * (sorted[i + 1].cop - sorted[i].cop),
        capacityW: Math.round(sorted[i].capacity_w + t * (sorted[i + 1].capacity_w - sorted[i].capacity_w)),
      };
    }
  }
  return null;
}

export function interpolateSurface(
  points: SurfacePoint[],
  indoorTempC: number,
  outdoorTempC: number,
): { capacityW: number; inputPowerW: number; cop: number } | null {
  if (!points || points.length === 0) return null;
  
  // Get unique indoor temps
  const indoorTemps = [...new Set(points.map(p => p.indoor_temp_c))].sort((a, b) => a - b);
  
  // For each indoor temp, interpolate along outdoor temp
  const interpolatedAtIndoor = indoorTemps.map(it => {
    const slice = points.filter(p => p.indoor_temp_c === it).sort((a, b) => a.temp_c - b.temp_c);
    let capW: number, inpW: number;
    
    if (outdoorTempC <= slice[0].temp_c) {
      capW = slice[0].capacity_w;
      inpW = slice[0].input_power_w;
    } else if (outdoorTempC >= slice[slice.length - 1].temp_c) {
      capW = slice[slice.length - 1].capacity_w;
      inpW = slice[slice.length - 1].input_power_w;
    } else {
      let idx = 0;
      for (let i = 0; i < slice.length - 1; i++) {
        if (outdoorTempC >= slice[i].temp_c && outdoorTempC <= slice[i + 1].temp_c) { idx = i; break; }
      }
      const t = (outdoorTempC - slice[idx].temp_c) / (slice[idx + 1].temp_c - slice[idx].temp_c);
      capW = Math.round(slice[idx].capacity_w + t * (slice[idx + 1].capacity_w - slice[idx].capacity_w));
      inpW = Math.round(slice[idx].input_power_w + t * (slice[idx + 1].input_power_w - slice[idx].input_power_w));
    }
    return { indoorTemp: it, capW, inpW };
  });

  // Now interpolate along indoor temp
  if (indoorTempC <= interpolatedAtIndoor[0].indoorTemp) {
    const r = interpolatedAtIndoor[0];
    return { capacityW: r.capW, inputPowerW: r.inpW, cop: r.capW / r.inpW };
  }
  if (indoorTempC >= interpolatedAtIndoor[interpolatedAtIndoor.length - 1].indoorTemp) {
    const r = interpolatedAtIndoor[interpolatedAtIndoor.length - 1];
    return { capacityW: r.capW, inputPowerW: r.inpW, cop: r.capW / r.inpW };
  }
  for (let i = 0; i < interpolatedAtIndoor.length - 1; i++) {
    if (indoorTempC >= interpolatedAtIndoor[i].indoorTemp && indoorTempC <= interpolatedAtIndoor[i + 1].indoorTemp) {
      const t = (indoorTempC - interpolatedAtIndoor[i].indoorTemp) / (interpolatedAtIndoor[i + 1].indoorTemp - interpolatedAtIndoor[i].indoorTemp);
      const capW = Math.round(interpolatedAtIndoor[i].capW + t * (interpolatedAtIndoor[i + 1].capW - interpolatedAtIndoor[i].capW));
      const inpW = Math.round(interpolatedAtIndoor[i].inpW + t * (interpolatedAtIndoor[i + 1].inpW - interpolatedAtIndoor[i].inpW));
      return { capacityW: capW, inputPowerW: inpW, cop: capW / inpW };
    }
  }
  return null;
}

// ── Example data ──

export const EXAMPLE_CURVE: { points: CurvePoint[] } = {
  points: [
    { temp_c: -20, cop: 1.8, capacity_w: 3500 },
    { temp_c: -15, cop: 2.1, capacity_w: 4200 },
    { temp_c: -10, cop: 2.5, capacity_w: 5000 },
    { temp_c: -7, cop: 2.8, capacity_w: 5800 },
    { temp_c: -2, cop: 3.2, capacity_w: 6500 },
    { temp_c: 2, cop: 3.8, capacity_w: 7200 },
    { temp_c: 7, cop: 4.5, capacity_w: 8000 },
    { temp_c: 12, cop: 5.2, capacity_w: 8500 },
  ],
};

export const EXAMPLE_SURFACE: { points: SurfacePoint[] } = {
  points: [
    { indoor_temp_c: 20, temp_c: -15, capacity_w: 5000, input_power_w: 2500 },
    { indoor_temp_c: 20, temp_c: -7, capacity_w: 6500, input_power_w: 2200 },
    { indoor_temp_c: 20, temp_c: 2, capacity_w: 8000, input_power_w: 1800 },
    { indoor_temp_c: 20, temp_c: 7, capacity_w: 9000, input_power_w: 1600 },
    { indoor_temp_c: 25, temp_c: -15, capacity_w: 4500, input_power_w: 2700 },
    { indoor_temp_c: 25, temp_c: -7, capacity_w: 5800, input_power_w: 2400 },
    { indoor_temp_c: 25, temp_c: 2, capacity_w: 7200, input_power_w: 2000 },
    { indoor_temp_c: 25, temp_c: 7, capacity_w: 8200, input_power_w: 1800 },
  ],
};
