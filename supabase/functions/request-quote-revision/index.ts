import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { Resend } from "npm:resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[REQUEST-QUOTE-REVISION] ${step}${detailsStr}`);
};

async function hashToken(tokenHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(tokenHex));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { quote_id, token, message, name, email } = await req.json();

    if (!quote_id || !token || !message || !name || !email) {
      return new Response(JSON.stringify({ error: "Missing required fields (quote_id, token, message, name, email)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("id, status, accept_token_hash, accept_token_expires_at, quote_number")
      .eq("id", quote_id)
      .single();

    if (quoteError || !quote) {
      return new Response(JSON.stringify({ error: "Quote not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate token
    const tokenHash = await hashToken(token);
    if (quote.accept_token_hash !== tokenHash) {
      return new Response(JSON.stringify({ error: "Invalid or expired link" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (quote.accept_token_expires_at && new Date(quote.accept_token_expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: "This link has expired" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Allow revision requests from sent, viewed statuses
    const allowedStatuses = ["sent", "viewed", "revision_requested"];
    if (!allowedStatuses.includes(quote.status)) {
      return new Response(JSON.stringify({ error: `Cannot request revision in status: ${quote.status}` }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Insert message
    await serviceClient.from("quote_messages").insert({
      quote_id,
      author_type: "customer",
      author_name: name,
      author_email: email,
      body_markdown: message,
      source: "portal",
    });

    // Update status
    await serviceClient.from("quotes").update({
      status: "revision_requested",
    }).eq("id", quote_id);

    // Log events
    await serviceClient.from("quote_events").insert([
      {
        quote_id,
        event_type: "revision_requested",
        actor_type: "customer",
        actor_email: email,
        metadata: { name },
      },
      {
        quote_id,
        event_type: "message_posted",
        actor_type: "customer",
        actor_email: email,
        metadata: { name, preview: message.substring(0, 100) },
      },
    ]);

    // Notify staff via email
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (resendApiKey) {
      const resend = new Resend(resendApiKey);
      const staffEmail = "support@smarthomesolutions.se";
      await resend.emails.send({
        from: "Smart Home Solutions <offert@mail.smarthomesolutions.se>",
        to: [staffEmail],
        subject: `Ändringsförfrågan: Offert ${quote.quote_number || quote_id}`,
        html: `
          <h2>Kunden begär ändring av offert ${quote.quote_number || ""}</h2>
          <p><strong>Namn:</strong> ${name}</p>
          <p><strong>E-post:</strong> ${email}</p>
          <p><strong>Meddelande:</strong></p>
          <blockquote style="border-left:3px solid #3b82f6;padding-left:12px;color:#333;">${message.replace(/\n/g, "<br>")}</blockquote>
        `,
        text: `Ändringsförfrågan för offert ${quote.quote_number || quote_id}\n\nNamn: ${name}\nE-post: ${email}\n\nMeddelande:\n${message}`,
      });
      logStep("Staff notification sent");
    }

    logStep("Revision requested", { quoteId: quote_id, name });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
