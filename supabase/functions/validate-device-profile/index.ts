import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface CurvePoint {
  temp_c: number;
  cop: number;
  capacity_w: number;
}

interface SurfacePoint {
  indoor_temp_c: number;
  temp_c: number;
  capacity_w: number;
  input_power_w: number;
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}

function validateCopCapacityCurve(data: unknown): ValidationResult {
  if (typeof data !== "object" || data === null) {
    return { valid: false, error: "Data must be an object" };
  }

  const d = data as Record<string, unknown>;
  const keys = Object.keys(d);
  for (const k of keys) {
    if (k !== "points") {
      return { valid: false, error: `Unexpected property: "${k}"` };
    }
  }

  if (!Array.isArray(d.points)) {
    return { valid: false, error: '"points" must be an array' };
  }

  if (d.points.length < 2) {
    return { valid: false, error: `At least 2 points required, got ${d.points.length}` };
  }

  for (let i = 0; i < d.points.length; i++) {
    const p = d.points[i];
    if (typeof p !== "object" || p === null) {
      return { valid: false, error: `points[${i}]: must be an object` };
    }

    const pKeys = Object.keys(p);
    for (const k of pKeys) {
      if (!["temp_c", "cop", "capacity_w"].includes(k)) {
        return { valid: false, error: `points[${i}]: unexpected property "${k}"` };
      }
    }

    if (typeof p.temp_c !== "number" || p.temp_c < -40 || p.temp_c > 40) {
      return { valid: false, error: `points[${i}].temp_c must be a number between -40 and 40` };
    }
    if (typeof p.cop !== "number" || p.cop <= 0 || p.cop > 15) {
      return { valid: false, error: `points[${i}].cop must be a number > 0 and <= 15` };
    }
    if (typeof p.capacity_w !== "number" || !Number.isInteger(p.capacity_w) || p.capacity_w <= 0 || p.capacity_w > 30000) {
      return { valid: false, error: `points[${i}].capacity_w must be an integer > 0 and <= 30000` };
    }

    if (i > 0 && p.temp_c <= d.points[i - 1].temp_c) {
      return {
        valid: false,
        error: `points[${i}].temp_c (${p.temp_c}) must be strictly greater than previous (${d.points[i - 1].temp_c})`,
      };
    }
  }

  return { valid: true };
}

function validateHeatingPerformanceSurface(data: unknown): ValidationResult {
  if (typeof data !== "object" || data === null) {
    return { valid: false, error: "Data must be an object" };
  }

  const d = data as Record<string, unknown>;
  const keys = Object.keys(d);
  for (const k of keys) {
    if (k !== "points") {
      return { valid: false, error: `Unexpected property: "${k}"` };
    }
  }

  if (!Array.isArray(d.points)) {
    return { valid: false, error: '"points" must be an array' };
  }

  if (d.points.length < 2) {
    return { valid: false, error: `At least 2 points required, got ${d.points.length}` };
  }

  const warnings: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < d.points.length; i++) {
    const p = d.points[i];
    if (typeof p !== "object" || p === null) {
      return { valid: false, error: `points[${i}]: must be an object` };
    }

    const pKeys = Object.keys(p);
    for (const k of pKeys) {
      if (!["indoor_temp_c", "temp_c", "capacity_w", "input_power_w"].includes(k)) {
        return { valid: false, error: `points[${i}]: unexpected property "${k}"` };
      }
    }

    if (typeof p.indoor_temp_c !== "number" || p.indoor_temp_c < 10 || p.indoor_temp_c > 35) {
      return { valid: false, error: `points[${i}].indoor_temp_c must be a number between 10 and 35` };
    }
    if (typeof p.temp_c !== "number" || p.temp_c < -40 || p.temp_c > 40) {
      return { valid: false, error: `points[${i}].temp_c must be a number between -40 and 40` };
    }
    if (typeof p.capacity_w !== "number" || !Number.isInteger(p.capacity_w) || p.capacity_w <= 0 || p.capacity_w > 50000) {
      return { valid: false, error: `points[${i}].capacity_w must be an integer > 0 and <= 50000` };
    }
    if (typeof p.input_power_w !== "number" || !Number.isInteger(p.input_power_w) || p.input_power_w <= 0 || p.input_power_w > 20000) {
      return { valid: false, error: `points[${i}].input_power_w must be an integer > 0 and <= 20000` };
    }

    // Uniqueness check
    const key = `${p.indoor_temp_c}_${p.temp_c}`;
    if (seen.has(key)) {
      return { valid: false, error: `points[${i}]: duplicate (indoor_temp_c=${p.indoor_temp_c}, temp_c=${p.temp_c})` };
    }
    seen.add(key);

    // Derived COP sanity
    const derivedCop = p.capacity_w / p.input_power_w;
    if (derivedCop < 0.2 || derivedCop > 25) {
      return { valid: false, error: `points[${i}]: derived COP (${derivedCop.toFixed(2)}) is wildly out of range (0.2-25)` };
    }
    if (derivedCop < 0.5 || derivedCop > 15) {
      warnings.push(`points[${i}]: derived COP ${derivedCop.toFixed(2)} is unusual (expected 0.5-15)`);
    }
  }

  return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { profile_kind, data } = await req.json();

    let result: ValidationResult;

    if (profile_kind === "cop_capacity_curve") {
      result = validateCopCapacityCurve(data);
    } else if (profile_kind === "heating_performance_surface") {
      result = validateHeatingPerformanceSurface(data);
    } else {
      result = { valid: false, error: `Unsupported profile_kind: "${profile_kind}"` };
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, error: "Invalid request body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
