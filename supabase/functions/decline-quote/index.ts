import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[DECLINE-QUOTE] ${step}${detailsStr}`);
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
    const { quote_id, token, reason } = await req.json();

    if (!quote_id || !token) {
      return new Response(JSON.stringify({ error: "Missing required fields (quote_id, token)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("id, status, accept_token_hash, accept_token_expires_at")
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

    // Allow declining from sent, viewed, or revision_requested
    const declinableStatuses = ["sent", "viewed", "revision_requested"];
    if (!declinableStatuses.includes(quote.status)) {
      if (quote.status === "superseded") {
        return new Response(JSON.stringify({ error: "Offerten har ersatts av en nyare version" }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `Quote cannot be declined in status: ${quote.status}` }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update quote
    const { error: updateError } = await serviceClient
      .from("quotes")
      .update({
        status: "declined",
        declined_at: new Date().toISOString(),
        status_reason: reason || null,
        accept_token_expires_at: new Date().toISOString(), // Invalidate token
      })
      .eq("id", quote_id);

    if (updateError) throw new Error(`Failed to update quote: ${updateError.message}`);

    // Log event
    await serviceClient.from("quote_events").insert({
      quote_id,
      event_type: "declined",
      actor_type: "customer",
      metadata: reason ? { reason } : {},
    });

    // Resolve customer identity for notification
    let customerName = "Kund";
    let customerEmail = "";
    const { data: qFull } = await serviceClient
      .from("quotes")
      .select("customer_id, quote_number")
      .eq("id", quote_id)
      .single();

    if (qFull?.customer_id) {
      const { data: cust } = await serviceClient
        .from("customers_with_identity")
        .select("name, contact_name, contact_email")
        .eq("id", qFull.customer_id)
        .single();
      if (cust) {
        customerName = cust.name || cust.contact_name || "Kund";
        customerEmail = cust.contact_email || "";
      }
    }

    logStep("Quote declined", { quoteId: quote_id });

    // Notify staff via email
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (resendApiKey) {
      try {
        const resend = new Resend(resendApiKey);
        await resend.emails.send({
          from: "Smart Home Solutions <offert@mail.smarthomesolutions.se>",
          to: ["sales@smarthomesolutions.se"],
          subject: `❌ Offert avvisad: ${customerName} – ${qFull?.quote_number || quote_id}`,
          html: `
            <h2>Kunden har avvisat offerten</h2>
            <p><strong>Kund:</strong> ${customerName}</p>
            <p><strong>E-post:</strong> ${customerEmail}</p>
            <p><strong>Offert:</strong> ${qFull?.quote_number || quote_id}</p>
            ${reason ? `<p><strong>Anledning:</strong> ${reason}</p>` : ""}
            <p><strong>Tid:</strong> ${new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })}</p>
          `,
          text: `Offert avvisad\n\nKund: ${customerName}\nE-post: ${customerEmail}\nOffert: ${qFull?.quote_number || quote_id}${reason ? `\nAnledning: ${reason}` : ""}`,
        });
        logStep("Staff notification sent");
      } catch (emailErr) {
        logStep("Staff notification failed (non-blocking)", { error: String(emailErr) });
      }
    }

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
