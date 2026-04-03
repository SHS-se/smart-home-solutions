import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getRequestAppOrigin } from "../_shared/app-origin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Rate limit: max 3 attempts per email per 15-minute window
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

function generateSecureCode(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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
  const resendApiKey = Deno.env.get("RESEND_API_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey || !resendApiKey) {
    console.error("send-password-reset: missing env vars");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

  try {
    const body = await req.json();
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!email) {
      return new Response(
        JSON.stringify({ error: "Email is required" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Rate limit by email
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const { data: rateData } = await supabaseAdmin
      .from("rate_limits")
      .select("id, request_count, window_start")
      .eq("endpoint", "send-password-reset")
      .eq("identifier", email)
      .gte("window_start", windowStart)
      .maybeSingle();

    if (rateData && rateData.request_count >= RATE_LIMIT_MAX) {
      // Still return 200 to not leak info about rate limiting
      console.log("send-password-reset: rate limited for", email);
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
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
          endpoint: "send-password-reset",
          identifier: email,
          request_count: 1,
          window_start: new Date().toISOString(),
        });
    }

    // Always return success to prevent email enumeration
    // But only actually send if user exists
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(
      (u) => u.email?.toLowerCase() === email
    );

    if (!existingUser) {
      console.log("send-password-reset: no user found for", email);
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const appOrigin = getRequestAppOrigin(req);

    // Generate recovery link via admin API
    const { data: linkData, error: linkGenError } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email,
    });

    if (linkGenError || !linkData?.properties?.hashed_token) {
      console.error("send-password-reset: failed to generate link:", linkGenError);
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Create branded verification code
    const verificationCode = generateSecureCode();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    const { error: insertError } = await supabaseAdmin
      .from("verification_tokens")
      .insert({
        code: verificationCode,
        token_hash: linkData.properties.hashed_token,
        type: "recovery",
        redirect_path: "/reset-password",
        expires_at: expiresAt,
        email,
      });

    if (insertError) {
      console.error("send-password-reset: failed to store token:", insertError);
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Use the shared frontend URL config so password reset matches other customer emails.
    const verifyUrl = `${appOrigin}/verify?code=${verificationCode}`;

    // Send branded email via Resend
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1a1a1a; margin-bottom: 10px;">Återställ ditt lösenord</h1>
          <p style="color: #666;">Reset your password</p>
        </div>
        
        <p>Vi fick en förfrågan om att återställa ditt lösenord. Klicka på knappen nedan för att välja ett nytt lösenord:</p>
        <p style="color: #666; font-size: 14px;">We received a request to reset your password. Click the button below to choose a new password:</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${escapeHtml(verifyUrl)}" style="background-color: #2D5F8D; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">Återställ lösenord / Reset Password</a>
        </div>
        
        <p>Länken är giltig i 1 timme. Om du inte begärde detta kan du ignorera detta meddelande.</p>
        <p style="color: #666; font-size: 14px;">This link is valid for 1 hour. If you didn't request this, you can safely ignore this email.</p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        
        <p style="color: #666; font-size: 14px;">
          Med vänliga hälsningar,<br>
          Smart Home Solutions
        </p>
      </body>
      </html>
    `;

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <replyonly@mail.smarthomesolutions.se>",
        to: [email],
        subject: "Återställ ditt lösenord / Reset your password",
        html: htmlBody,
      }),
    });

    if (!emailResponse.ok) {
      const errorData = await emailResponse.json();
      console.error("send-password-reset: Resend error:", errorData);
    } else {
      const result = await emailResponse.json();
      console.log("send-password-reset: email sent to", email, "resend_id:", result.id);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("send-password-reset: unexpected error:", error.message);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
