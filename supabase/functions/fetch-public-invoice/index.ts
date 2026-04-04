import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { loadInvoiceDocumentData } from "../_shared/invoice-document.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[FETCH-PUBLIC-INVOICE] ${step}${detailsStr}`);
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
    const url = new URL(req.url);
    const invoiceId = url.searchParams.get("invoice_id");
    const token = url.searchParams.get("token");

    if (!invoiceId || !token) {
      return new Response(JSON.stringify({ error: "Missing invoice_id or token" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Fetch invoice
    const { data: invoice, error: invoiceError } = await serviceClient
      .from("invoices")
      .select("id, invoice_number, status, due_date, currency, customer_id, created_at, finalized_at, issued_at, paid_at, voided_at, sent_at, public_token_hash, public_token_expires_at, quote_number")
      .eq("id", invoiceId)
      .single();

    if (invoiceError || !invoice) {
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate token
    const tokenHash = await hashToken(token);
    if (invoice.public_token_hash !== tokenHash) {
      logStep("Token mismatch");
      return new Response(JSON.stringify({ error: "Invalid or expired link" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check token expiry
    if (invoice.public_token_expires_at && new Date(invoice.public_token_expires_at) < new Date()) {
      logStep("Token expired");
      return new Response(JSON.stringify({ error: "This link has expired" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const invoiceDocument = await loadInvoiceDocumentData(serviceClient, invoiceId);

    // Update last_public_viewed_at
    await serviceClient.from("invoices").update({
      last_public_viewed_at: new Date().toISOString(),
    }).eq("id", invoiceId);

    // Log view event
    await serviceClient.from("invoice_events").insert({
      invoice_id: invoiceId,
      event_type: "public_viewed",
      metadata: {},
    });

    logStep("Invoice fetched successfully", { invoiceId, status: invoice.status });

    return new Response(JSON.stringify(invoiceDocument), {
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
