import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

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
      .select("id, invoice_number, status, due_date, currency, subtotal, tax, total, customer_id, created_at, finalized_at, issued_at, paid_at, voided_at, sent_at, public_token_hash, public_token_expires_at, quote_number")
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

    // Fetch customer info
    const { data: customer } = await serviceClient
      .from("customers_with_identity")
      .select("name, contact_email, billing_street, billing_postcode, billing_city")
      .eq("id", invoice.customer_id)
      .single();

    // Fetch line items
    const { data: lineItems } = await serviceClient
      .from("invoice_line_items")
      .select("id, line_type, description, quantity, unit_price, tax_rate, sku, category, sort_order")
      .eq("invoice_id", invoiceId)
      .order("sort_order");

    // Fetch computed totals
    const { data: totals } = await serviceClient
      .from("invoice_computed_totals")
      .select("*")
      .eq("invoice_id", invoiceId)
      .single();

    // Fetch payment history
    const { data: payments } = await serviceClient
      .from("invoice_payments")
      .select("id, payment_date, amount, method, reference, note, created_at")
      .eq("invoice_id", invoiceId)
      .order("payment_date");

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

    return new Response(JSON.stringify({
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      status: invoice.status,
      due_date: invoice.due_date,
      currency: invoice.currency,
      subtotal: totals?.subtotal ?? invoice.subtotal,
      tax: totals?.tax ?? invoice.tax,
      total: totals?.total ?? invoice.total,
      created_at: invoice.created_at,
      finalized_at: invoice.finalized_at,
      issued_at: invoice.issued_at,
      paid_at: invoice.paid_at,
      voided_at: invoice.voided_at,
      quote_number: invoice.quote_number,
      customer_name: customer?.name || null,
      customer_address: customer ? {
        street: customer.billing_street,
        postcode: customer.billing_postcode,
        city: customer.billing_city,
      } : null,
      line_items: lineItems || [],
      payments: payments || [],
    }), {
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
