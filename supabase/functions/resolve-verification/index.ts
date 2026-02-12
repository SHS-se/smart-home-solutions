import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Rate limit: max 5 attempts per IP per 15-minute window
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

  // Extract client IP for rate limiting
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown";

  try {
    // Rate limit check (DB-backed)
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    // Upsert rate limit record
    const { data: rateData } = await supabaseAdmin
      .from("rate_limits")
      .select("id, request_count, window_start")
      .eq("endpoint", "resolve-verification")
      .eq("identifier", clientIp)
      .gte("window_start", windowStart)
      .maybeSingle();

    if (rateData && rateData.request_count >= RATE_LIMIT_MAX) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (rateData) {
      await supabaseAdmin
        .from("rate_limits")
        .update({ request_count: rateData.request_count + 1 })
        .eq("id", rateData.id);
    } else {
      await supabaseAdmin
        .from("rate_limits")
        .insert({
          endpoint: "resolve-verification",
          identifier: clientIp,
          request_count: 1,
          window_start: new Date().toISOString(),
        });
    }

    // Parse request body
    const body = await req.json();
    const code = typeof body?.code === "string" ? body.code.trim() : "";

    if (!code || code.length < 20) {
      // Generic error — don't reveal why
      return new Response(
        JSON.stringify({ error: "This link is invalid or has expired." }),
        { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Look up token — must be unused and not expired
    const { data: token, error: lookupError } = await supabaseAdmin
      .from("verification_tokens")
      .select("id, token_hash, type, redirect_path, expires_at, used_at")
      .eq("code", code)
      .maybeSingle();

    if (lookupError || !token) {
      return new Response(
        JSON.stringify({ error: "This link is invalid or has expired." }),
        { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Check expiry
    if (new Date(token.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: "This link is invalid or has expired." }),
        { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Check if already used
    if (token.used_at) {
      return new Response(
        JSON.stringify({ error: "This link has already been used." }),
        { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Mark as used atomically
    const { error: updateError } = await supabaseAdmin
      .from("verification_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("id", token.id)
      .is("used_at", null); // Atomic: only succeeds if still null

    if (updateError) {
      return new Response(
        JSON.stringify({ error: "This link has already been used." }),
        { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Return token_hash and type (never log these)
    return new Response(
      JSON.stringify({
        token_hash: token.token_hash,
        type: token.type,
        redirect_path: token.redirect_path,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    // Never log the code or token_hash in error handlers
    console.error("resolve-verification error (details redacted)");
    return new Response(
      JSON.stringify({ error: "This link is invalid or has expired." }),
      { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
