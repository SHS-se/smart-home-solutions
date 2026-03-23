import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getStripeSecretKey, getAppEnvironment } from "../_shared/stripe-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[FINALIZE-NEW-INVOICE] ${step}${detailsStr}`);
};


serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const appEnv = getAppEnvironment();
    const stripeKey = getStripeSecretKey();
    logStep("Function started", { environment: appEnv });

    // Authenticate staff user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    // Check if user is staff
    const { data: staffData, error: staffError } = await supabaseClient
      .from('staff_users')
      .select('user_id')
      .eq('user_id', user.id)
      .single();

    if (staffError || !staffData) {
      throw new Error("Access denied: Staff only");
    }
    logStep("Staff verified");

    const { invoice_id } = await req.json();
    if (!invoice_id) throw new Error("invoice_id is required");
    logStep("Finalizing invoice", { invoice_id });

    // Fetch invoice
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .select('*')
      .eq('id', invoice_id)
      .single();

    if (invoiceError || !invoice) throw new Error("Invoice not found");
    if (invoice.status !== 'draft') throw new Error("Can only finalize draft invoices");
    if (!invoice.stripe_invoice_id) throw new Error("Invoice has no Stripe ID");

    logStep("Invoice loaded", { stripeInvoiceId: invoice.stripe_invoice_id });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Get current Stripe invoice
    const currentInvoice = await stripe.invoices.retrieve(invoice.stripe_invoice_id);
    logStep("Stripe invoice retrieved", { status: currentInvoice.status });

    let finalizedInvoice = currentInvoice;

    // Finalize if still draft
    if (currentInvoice.status === 'draft') {
      finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.stripe_invoice_id);
      logStep("Invoice finalized in Stripe", { 
        status: finalizedInvoice.status,
        number: finalizedInvoice.number 
      });
    }

    // Use Stripe's invoice number as our canonical number
    const invoiceNumber = finalizedInvoice.number;
    if (!invoiceNumber) throw new Error("Stripe did not assign an invoice number");
    logStep("Using Stripe invoice number", { invoiceNumber });

    // Capture due_date from Stripe
    const stripeDueDate = finalizedInvoice.due_date
      ? new Date(finalizedInvoice.due_date * 1000).toISOString().split('T')[0]
      : invoice.due_date;
    logStep("Due date", { stripeDueDate });

    // Update local invoice (totals are computed via invoice_computed_totals view)
    const { error: updateError } = await supabaseClient
      .from('invoices')
      .update({
        invoice_number: invoiceNumber,
        status: 'open',
        due_date: stripeDueDate,
        hosted_invoice_url: finalizedInvoice.hosted_invoice_url,
        invoice_pdf_url: finalizedInvoice.invoice_pdf,
        finalized_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', invoice_id);

    if (updateError) {
      logStep("Error updating invoice", { error: updateError });
      throw new Error(`Failed to update invoice: ${updateError.message}`);
    }

    // Create event
    await supabaseClient.from('invoice_events').insert({
      invoice_id,
      event_type: 'invoice_finalized',
      metadata: {
        invoice_number: invoiceNumber,
        stripe_status: finalizedInvoice.status,
        hosted_url: finalizedInvoice.hosted_invoice_url
      },
      created_by: user.id
    });

    // Sync BOM items to match invoice hardware lines and enrich bom_events
    if (invoice.bom_id) {
      // Fetch invoice hardware line items
      const { data: hardwareLines } = await supabaseClient
        .from('invoice_line_items')
        .select('sku_id, quantity')
        .eq('invoice_id', invoice_id)
        .eq('line_type', 'hardware')
        .not('sku_id', 'is', null);

      if (hardwareLines && hardwareLines.length > 0) {
        // Fetch current costs for all SKUs
        const skuIds = hardwareLines.map(l => l.sku_id!);
        const { data: skuCosts } = await supabaseClient
          .from('skus')
          .select('id, cost_ex_vat_computed')
          .in('id', skuIds);
        const costMap = new Map((skuCosts || []).map(s => [s.id, s.cost_ex_vat_computed]));

        // Delete existing BOM items and replace with invoice hardware items
        await supabaseClient
          .from('bom_items')
          .delete()
          .eq('bom_id', invoice.bom_id);

        const bomItems = hardwareLines.map(line => ({
          bom_id: invoice.bom_id,
          sku_id: line.sku_id!,
          quantity: line.quantity,
          cost_ex_vat_at_time: costMap.get(line.sku_id!) ?? null,
        }));

        const { error: bomInsertError } = await supabaseClient
          .from('bom_items')
          .insert(bomItems);

        if (bomInsertError) {
          logStep("Warning: BOM items sync failed", { error: bomInsertError });
        } else {
          logStep("BOM items synced from invoice hardware lines", { count: bomItems.length });
        }
      }

      // Enrich bom_events metadata with Stripe identifiers
      const { data: bomEvents } = await supabaseClient
        .from('bom_events')
        .select('id, metadata')
        .eq('event_type', 'revision_created')
        .filter('metadata->>internal_invoice_id', 'eq', invoice_id);

      if (bomEvents && bomEvents.length > 0) {
        for (const evt of bomEvents) {
          const existingMeta = (evt.metadata as Record<string, unknown>) || {};
          await supabaseClient
            .from('bom_events')
            .update({
              metadata: {
                ...existingMeta,
                source_document_stage: 'finalized',
                stripe_invoice_id: invoice.stripe_invoice_id,
                stripe_invoice_number: invoiceNumber,
              }
            })
            .eq('id', evt.id);
        }
        logStep("Enriched bom_events with Stripe identifiers", { count: bomEvents.length });
      }
    }

    logStep("Invoice finalization complete");

    return new Response(JSON.stringify({
      success: true,
      invoice_id: invoice.id,
      invoice_number: invoiceNumber,
      status: 'open',
      hosted_invoice_url: finalizedInvoice.hosted_invoice_url,
      invoice_pdf_url: finalizedInvoice.invoice_pdf
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
