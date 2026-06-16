import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { normalizeInvoiceLineType } from "../_shared/invoice-line-types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CREATE-DRAFT-INVOICE] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceClient = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );
  const anonClient = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { auth: { persistSession: false } }
  );
  let createdInvoiceId: string | null = null;

  const cleanupDraftInvoice = async (invoiceId: string, reason: string) => {
    const { error } = await serviceClient
      .from("invoices")
      .delete()
      .eq("id", invoiceId)
      .eq("status", "draft");

    if (error) {
      logStep("Cleanup failed", { invoiceId, reason, error });
      return;
    }

    logStep("Cleaned up partial draft invoice", { invoiceId, reason });
  };

  try {
    const appEnv = getAppEnvironment();
    logStep("Function started", { environment: appEnv });

    // Authenticate staff user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    // Check if user is staff
    const { data: staffData, error: staffError } = await serviceClient
      .from('staff_users')
      .select('user_id')
      .eq('user_id', user.id)
      .single();

    if (staffError || !staffData) {
      throw new Error("Access denied: Staff only");
    }
    logStep("Staff verified");

    const {
      customer_id,
      bom_id,
      quote_id,
      due_date,
      line_items = []
    } = await req.json();

    if (!customer_id) throw new Error("customer_id is required");
    logStep("Creating draft invoice", { customer_id, bom_id, quote_id });

    // Fetch BOM if provided
    let bom = null;
    let bomVersion = null;
    if (bom_id) {
      const { data: bomData, error: bomError } = await serviceClient
        .from('boms')
        .select('*, bom_items(*, sku:skus(*))')
        .eq('id', bom_id)
        .single();

      if (!bomError && bomData) {
        bom = bomData;
        bomVersion = bomData.version;
      }
    }

    // Fetch Quote if provided
    let quote = null;
    let quoteNumber = null;
    if (quote_id) {
      const { data: quoteData, error: quoteError } = await serviceClient
        .from('quotes')
        .select('*, quote_lines(*)')
        .eq('id', quote_id)
        .single();

      if (!quoteError && quoteData) {
        quote = quoteData;
        quoteNumber = quoteData.quote_number;
      }
    }

    // Create the invoice record in our database (draft — no invoice number yet)
    const { data: invoice, error: invoiceError } = await serviceClient
      .from('invoices')
      .insert({
        customer_id,
        bom_id: bom_id || null,
        bom_version: bomVersion,
        quote_id: quote_id || null,
        quote_number: quoteNumber,
        status: 'draft',
        due_date: due_date || null,
        currency: 'SEK',
        created_by: user.id,
        is_test: appEnv === 'test',
      })
      .select()
      .single();

    if (invoiceError) {
      logStep("Error creating invoice record", { error: invoiceError });
      throw new Error(`Failed to create invoice: ${invoiceError.message}`);
    }

    logStep("Invoice record created", { invoiceId: invoice.id });
    createdInvoiceId = invoice.id;

    // Insert line items from various sources
    const lineItemsToInsert: Array<{
      invoice_id: string;
      line_type: string;
      description: string;
      sku?: string;
      sku_id?: string;
      quantity: number;
      unit_price: number;
      unit?: string;
      tax_rate: number;
      category?: string;
      sort_order: number;
      source_bom_id?: string | null;
      source_bom_item_id?: string | null;
      source_bom_version?: number | null;
    }> = [];

    // If line_items are passed directly, use them
    if (line_items.length > 0) {
      line_items.forEach((item: { line_type: string; description: string; sku?: string; sku_id?: string; quantity: number; unit_price: number; unit?: string; tax_rate?: number; category?: string; source_bom_id?: string; source_bom_item_id?: string; source_bom_version?: number }, idx: number) => {
        lineItemsToInsert.push({
          invoice_id: invoice.id,
          line_type: normalizeInvoiceLineType(item.line_type),
          description: item.description,
          sku: item.sku,
          sku_id: item.sku_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          unit: item.unit,
          tax_rate: typeof item.tax_rate === "number" ? item.tax_rate : 25,
          category: item.category,
          sort_order: idx,
          source_bom_id: item.source_bom_id ?? null,
          source_bom_item_id: item.source_bom_item_id ?? null,
          source_bom_version: item.source_bom_version ?? null
        });
      });
    }
    // Otherwise, populate from quote lines (preserving the BOM-item linkage)
    else if (quote && quote.quote_lines) {
      quote.quote_lines.forEach((line: { section: string; description: string; original_sku_code?: string; sku_id?: string; quantity: number; unit_price_ex_vat?: number; unit_price?: number; source_bom_id?: string; source_bom_item_id?: string; source_bom_version?: number }, idx: number) => {
        lineItemsToInsert.push({
          invoice_id: invoice.id,
          line_type: normalizeInvoiceLineType(line.section),
          description: line.description,
          sku: line.original_sku_code,
          sku_id: line.sku_id,
          quantity: line.quantity,
          unit_price: line.unit_price_ex_vat ?? line.unit_price ?? 0,
          tax_rate: 25,
          sort_order: idx,
          source_bom_id: line.source_bom_id ?? null,
          source_bom_item_id: line.source_bom_item_id ?? null,
          source_bom_version: line.source_bom_version ?? null
        });
      });
    }
    // Or from BOM items (hardware only) — link each line to the BOM item it fulfills
    else if (bom && bom.bom_items) {
      bom.bom_items.forEach((item: { id: string; sku: { sku: string; name: string; category: string; sell_price_ex_vat: number }; sku_id: string; quantity: number }, idx: number) => {
        lineItemsToInsert.push({
          invoice_id: invoice.id,
          line_type: 'hardware',
          description: item.sku?.name || 'Unknown',
          sku: item.sku?.sku,
          sku_id: item.sku_id,
          quantity: item.quantity,
          unit_price: item.sku?.sell_price_ex_vat || 0,
          tax_rate: 25,
          category: item.sku?.category,
          sort_order: idx,
          source_bom_id: bom_id,
          source_bom_item_id: item.id,
          source_bom_version: bomVersion
        });
      });
    }

    if (lineItemsToInsert.length > 0) {
      const { error: lineItemsError } = await serviceClient
        .from('invoice_line_items')
        .insert(lineItemsToInsert);

      if (lineItemsError) {
        logStep("Error inserting line items", { error: lineItemsError });
        throw new Error(`Failed to create invoice lines: ${lineItemsError.message}`);
      }

      logStep("Line items inserted", { count: lineItemsToInsert.length });
    }

    // Create invoice event
    const { error: invoiceEventError } = await serviceClient.from('invoice_events').insert({
      invoice_id: invoice.id,
      event_type: 'invoice_created',
      metadata: {
        source: quote_id ? 'quote' : bom_id ? 'bom' : 'manual'
      },
      created_by: user.id
    });

    if (invoiceEventError) {
      logStep("Invoice event insert failed", { invoiceId: invoice.id, error: invoiceEventError });
    }

    logStep("Draft invoice created successfully");

    return new Response(JSON.stringify({
      success: true,
      invoice_id: invoice.id,
      status: 'draft'
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    if (createdInvoiceId) {
      await cleanupDraftInvoice(createdInvoiceId, error instanceof Error ? error.message : String(error));
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
