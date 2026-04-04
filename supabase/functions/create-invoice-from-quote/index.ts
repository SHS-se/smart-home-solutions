import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { normalizeInvoiceLineType } from "../_shared/invoice-line-types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CREATE-INVOICE-FROM-QUOTE] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let createdInvoiceId: string | null = null;

  try {
    const appEnv = getAppEnvironment();
    logStep("Function started", { environment: appEnv });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);

    // Verify staff
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !userData.user) throw new Error("Unauthorized");

    const { data: staffCheck } = await serviceClient
      .from("staff_users").select("user_id").eq("user_id", userData.user.id).single();
    if (!staffCheck) throw new Error("Staff access required");
    logStep("Staff verified");

    const { quote_id } = await req.json();
    if (!quote_id) throw new Error("quote_id is required");

    // Load quote
    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("*")
      .eq("id", quote_id)
      .single();

    if (quoteError || !quote) throw new Error("Quote not found");
    logStep("Quote loaded", { quoteId: quote.id, status: quote.status });

    // Check if an invoice already exists for this quote
    const { data: existingInvoice } = await serviceClient
      .from("invoices")
      .select("id")
      .eq("quote_id", quote_id)
      .maybeSingle();

    if (existingInvoice) {
      throw new Error("Invoice already exists for this quote");
    }

    if (quote.status !== "accepted") {
      throw new Error("Quote must be accepted before creating an invoice");
    }

    // Load quote line items
    const { data: lineItems } = await serviceClient
      .from("quote_lines")
      .select("*")
      .eq("quote_id", quote_id)
      .order("section")
      .order("created_at");

    if (!lineItems || lineItems.length === 0) throw new Error("No line items found");

    // Create local invoice record (draft — no invoice number yet)
    const invoiceData = {
      customer_id: quote.customer_id,
      quote_id,
      status: "draft",
      currency: "SEK",
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      bom_id: quote.bom_id,
      bom_version: quote.bom_version,
      quote_number: quote.quote_number,
      created_by: userData.user.id,
      is_test: quote.is_test,
    };

    const { data: invoiceRecord, error: invoiceError } = await serviceClient
      .from("invoices")
      .insert(invoiceData)
      .select("id")
      .single();

    if (invoiceError) throw new Error(`Failed to create invoice record: ${invoiceError.message}`);
    logStep("Invoice record created", { invoiceId: invoiceRecord.id });
    createdInvoiceId = invoiceRecord.id;

    // Copy quote_lines to invoice_line_items
    const invoiceLineItems = lineItems.map((item, idx) => ({
      invoice_id: invoiceRecord.id,
      description: item.description,
      quantity: item.quantity || 1,
      unit_price: item.unit_price_ex_vat || item.unit_price || 0,
      tax_rate: Math.round((item.vat_rate || 0.25) * 100),
      line_type: normalizeInvoiceLineType(item.section),
      sort_order: idx,
      sku: item.original_sku_code || null,
      sku_id: item.sku_id || null,
      category: item.section,
    }));

    const { error: lineItemsError } = await serviceClient
      .from("invoice_line_items")
      .insert(invoiceLineItems);

    if (lineItemsError) {
      throw new Error(`Failed to create invoice lines: ${lineItemsError.message}`);
    }

    logStep("Line items copied", { count: invoiceLineItems.length });

    // Update quote to reflect invoice creation
    const { error: quoteUpdateError } = await serviceClient
      .from("quotes")
      .update({
        invoice_status: "draft",
        status: "invoiced",
      })
      .eq("id", quote_id);

    if (quoteUpdateError) {
      throw new Error(`Failed to update quote status: ${quoteUpdateError.message}`);
    }

    // Log event
    const { error: quoteEventError } = await serviceClient.from("quote_events").insert({
      quote_id,
      event_type: "invoice_created",
      actor_type: "staff",
      actor_email: userData.user.email,
      metadata: {
        invoice_id: invoiceRecord.id,
      },
    });

    if (quoteEventError) {
      logStep("Quote event insert failed", { quoteId: quote_id, error: quoteEventError });
    }

    logStep("Done", { invoiceId: invoiceRecord.id });

    return new Response(JSON.stringify({
      success: true,
      invoice_id: invoiceRecord.id,
      status: "draft",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (createdInvoiceId) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error: cleanupError } = await serviceClient
        .from("invoices")
        .delete()
        .eq("id", createdInvoiceId)
        .eq("status", "draft");

      if (cleanupError) {
        logStep("Cleanup failed", { invoiceId: createdInvoiceId, error: cleanupError });
      } else {
        logStep("Cleaned up partial draft invoice", { invoiceId: createdInvoiceId });
      }
    }
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
