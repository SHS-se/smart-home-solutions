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

interface CurveData {
  points: CurvePoint[];
}

function validateCopCapacityCurve(data: unknown): { valid: true } | { valid: false; error: string } {
  if (typeof data !== "object" || data === null) {
    return { valid: false, error: "Data must be an object" };
  }

  const d = data as Record<string, unknown>;

  // Check no extra keys
  const keys = Object.keys(d);
  for (const k of keys) {
    if (k !== "points") {
      return { valid: false, error: `Unexpected property: "${k}"` };
    }
  }

  if (!Array.isArray(d.points)) {
    return { valid: false, error: '"points" must be an array' };
  }

  if (d.points.length < 4) {
    return { valid: false, error: `At least 4 points required, got ${d.points.length}` };
  }

  for (let i = 0; i < d.points.length; i++) {
    const p = d.points[i];
    if (typeof p !== "object" || p === null) {
      return { valid: false, error: `Point ${i}: must be an object` };
    }

    const pKeys = Object.keys(p);
    for (const k of pKeys) {
      if (!["temp_c", "cop", "capacity_w"].includes(k)) {
        return { valid: false, error: `Point ${i}: unexpected property "${k}"` };
      }
    }

    if (typeof p.temp_c !== "number" || p.temp_c < -40 || p.temp_c > 40) {
      return { valid: false, error: `Point ${i}: temp_c must be a number between -40 and 40` };
    }
    if (typeof p.cop !== "number" || p.cop <= 0 || p.cop > 15) {
      return { valid: false, error: `Point ${i}: cop must be a number > 0 and <= 15` };
    }
    if (typeof p.capacity_w !== "number" || !Number.isInteger(p.capacity_w) || p.capacity_w < 0 || p.capacity_w > 50000) {
      return { valid: false, error: `Point ${i}: capacity_w must be an integer between 0 and 50000` };
    }

    // Check strictly increasing temp_c
    if (i > 0 && p.temp_c <= d.points[i - 1].temp_c) {
      return {
        valid: false,
        error: `Point ${i}: temp_c (${p.temp_c}) must be strictly greater than previous (${d.points[i - 1].temp_c})`,
      };
    }
  }

  return { valid: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { profile_kind, data } = await req.json();

    if (profile_kind !== "cop_capacity_curve") {
      return new Response(JSON.stringify({ valid: false, error: `Unsupported profile_kind: "${profile_kind}"` }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = validateCopCapacityCurve(data);

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
