import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

async function notifyStaff(subject: string, html: string, text: string) {
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) return;
  try {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <offert@mail.smarthomesolutions.se>",
        to: ["sales@smarthomesolutions.se"],
        subject,
        html,
        text,
      }),
    });
    if (!emailRes.ok) throw new Error(`Resend API ${emailRes.status}`);
    console.log("[CUSTOMER-QUOTE-ACTION] Staff notification sent");
  } catch (err) {
    console.log("[CUSTOMER-QUOTE-ACTION] Staff notification failed (non-blocking)", String(err));
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CUSTOMER-QUOTE-ACTION] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { quote_id, action, reason, message } = await req.json();

    if (!quote_id || !action) {
      return new Response(JSON.stringify({ error: "Missing required fields (quote_id, action)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user auth via JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Create user-scoped client to verify identity
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Authenticated user", { userId: user.id, email: user.email });

    // Service client for privileged operations
    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    // Fetch quote
    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("id, status, customer_id, quote_number")
      .eq("id", quote_id)
      .single();

    if (quoteError || !quote) {
      return new Response(JSON.stringify({ error: "Quote not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify ownership: customer must belong to this user
    const { data: customer, error: customerError } = await serviceClient
      .from("customers")
      .select("id")
      .eq("id", quote.customer_id)
      .eq("user_id", user.id)
      .single();

    if (customerError || !customer) {
      logStep("Unauthorized - customer not matched", { customerId: quote.customer_id, userId: user.id });
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get customer identity for logging
    const { data: identity } = await serviceClient
      .from("customers_with_identity")
      .select("name, contact_name, contact_email")
      .eq("id", quote.customer_id)
      .single();

    const customerName = identity?.name || identity?.contact_name || "Unknown";
    const customerEmail = identity?.contact_email || user.email || "unknown";

    // Block all actions on superseded quotes
    if (quote.status === "superseded") {
      return new Response(
        JSON.stringify({ error: "Offerten har ersatts av en nyare version" }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Perform action
    switch (action) {
      case "accept": {
        const acceptableStatuses = ["sent", "viewed"];
        if (!acceptableStatuses.includes(quote.status)) {
          if (quote.status === "accepted") {
            return new Response(
              JSON.stringify({ error: "Offerten är redan godkänd", already_accepted: true }),
              { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify({ error: `Cannot accept quote in status: ${quote.status}` }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const clientIp =
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          req.headers.get("x-real-ip") ||
          "unknown";
        const userAgent = req.headers.get("user-agent") || "unknown";

        const { error: updateError } = await serviceClient
          .from("quotes")
          .update({
            status: "accepted",
            accepted_at: new Date().toISOString(),
            accepted_by_name: customerName,
            accepted_by_email: customerEmail,
            accepted_ip: clientIp,
            accepted_user_agent: userAgent,
          })
          .eq("id", quote_id);

        if (updateError) throw new Error(`Failed to update quote: ${updateError.message}`);

        await serviceClient.from("quote_events").insert({
          quote_id,
          event_type: "accepted",
          actor_type: "customer",
          actor_email: customerEmail,
          metadata: { name: customerName, source: "customer_portal", ip: clientIp },
        });

        logStep("Quote accepted via portal", { quoteId: quote_id, name: customerName });

        await notifyStaff(
          `✅ Offert accepterad: ${customerName} – ${quote.quote_number || quote_id}`,
          `<h2>Kunden har accepterat offerten</h2>
           <p><strong>Kund:</strong> ${customerName}</p>
           <p><strong>E-post:</strong> ${customerEmail}</p>
           <p><strong>Offert:</strong> ${quote.quote_number || quote_id}</p>
           <p><strong>Tid:</strong> ${new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })}</p>`,
          `Offert accepterad\nKund: ${customerName}\nE-post: ${customerEmail}\nOffert: ${quote.quote_number || quote_id}`
        );
        break;
      }

      case "decline": {
        const declinableStatuses = ["sent", "viewed", "revision_requested"];
        if (!declinableStatuses.includes(quote.status)) {
          return new Response(
            JSON.stringify({ error: `Cannot decline quote in status: ${quote.status}` }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { error: updateError } = await serviceClient
          .from("quotes")
          .update({
            status: "declined",
            declined_at: new Date().toISOString(),
            status_reason: reason || null,
          })
          .eq("id", quote_id);

        if (updateError) throw new Error(`Failed to update quote: ${updateError.message}`);

        await serviceClient.from("quote_events").insert({
          quote_id,
          event_type: "declined",
          actor_type: "customer",
          actor_email: customerEmail,
          metadata: reason
            ? { reason, source: "customer_portal" }
            : { source: "customer_portal" },
        });

        logStep("Quote declined via portal", { quoteId: quote_id });

        await notifyStaff(
          `❌ Offert avvisad: ${customerName} – ${quote.quote_number || quote_id}`,
          `<h2>Kunden har avvisat offerten</h2>
           <p><strong>Kund:</strong> ${customerName}</p>
           <p><strong>E-post:</strong> ${customerEmail}</p>
           <p><strong>Offert:</strong> ${quote.quote_number || quote_id}</p>
           ${reason ? `<p><strong>Anledning:</strong> ${reason}</p>` : ""}
           <p><strong>Tid:</strong> ${new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })}</p>`,
          `Offert avvisad\nKund: ${customerName}\nE-post: ${customerEmail}\nOffert: ${quote.quote_number || quote_id}${reason ? `\nAnledning: ${reason}` : ""}`
        );
        break;
      }

      case "revision_request": {
        const revisionStatuses = ["sent", "viewed", "revision_requested"];
        if (!revisionStatuses.includes(quote.status)) {
          return new Response(
            JSON.stringify({ error: `Cannot request revision in status: ${quote.status}` }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        if (!message) {
          return new Response(JSON.stringify({ error: "Message is required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Insert message
        await serviceClient.from("quote_messages").insert({
          quote_id,
          author_type: "customer",
          author_name: customerName,
          author_email: customerEmail,
          body_markdown: message,
          source: "portal",
        });

        // Update status
        await serviceClient
          .from("quotes")
          .update({ status: "revision_requested" })
          .eq("id", quote_id);

        // Log events
        await serviceClient.from("quote_events").insert([
          {
            quote_id,
            event_type: "revision_requested",
            actor_type: "customer",
            actor_email: customerEmail,
            metadata: { name: customerName, source: "customer_portal" },
          },
          {
            quote_id,
            event_type: "message_posted",
            actor_type: "customer",
            actor_email: customerEmail,
            metadata: {
              name: customerName,
              preview: message.substring(0, 100),
            },
          },
        ]);

        logStep("Revision requested via portal", { quoteId: quote_id, name: customerName });

        await notifyStaff(
          `📝 Ändringsförfrågan: ${customerName} – ${quote.quote_number || quote_id}`,
          `<h2>Kunden begär ändring av offert</h2>
           <p><strong>Kund:</strong> ${customerName}</p>
           <p><strong>E-post:</strong> ${customerEmail}</p>
           <p><strong>Offert:</strong> ${quote.quote_number || quote_id}</p>
           <p><strong>Meddelande:</strong></p>
           <blockquote style="border-left:3px solid #3b82f6;padding-left:12px;color:#333;">${message.replace(/\n/g, "<br>")}</blockquote>`,
          `Ändringsförfrågan\nKund: ${customerName}\nE-post: ${customerEmail}\nOffert: ${quote.quote_number || quote_id}\n\nMeddelande:\n${message}`
        );
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
