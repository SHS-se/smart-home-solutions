import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";

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

    const { data: finalizedInvoice, error: finalizeError } = await supabaseClient.rpc(
      'finalize_local_invoice',
      {
        p_invoice_id: invoice_id,
        p_app_env: appEnv,
        p_created_by: user.id,
      },
    );

    if (finalizeError || !finalizedInvoice) {
      throw new Error(`Failed to finalize invoice: ${finalizeError?.message || 'no data returned'}`);
    }

    const invoiceNumber = (finalizedInvoice as { invoice_number: string }).invoice_number;
    logStep("Invoice number allocated", { invoiceNumber });

    // Sync BOM items to match invoice hardware lines
    if (invoice.bom_id) {
      const { data: hardwareLines } = await supabaseClient
        .from('invoice_line_items')
        .select('sku_id, quantity')
        .eq('invoice_id', invoice_id)
        .eq('line_type', 'hardware')
        .not('sku_id', 'is', null);

      if (hardwareLines && hardwareLines.length > 0) {
        const skuIds = hardwareLines.map(l => l.sku_id!);
        const { data: skuCosts } = await supabaseClient
          .from('skus')
          .select('id, cost_ex_vat_computed')
          .in('id', skuIds);
        const costMap = new Map((skuCosts || []).map(s => [s.id, s.cost_ex_vat_computed]));

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

      // Enrich bom_events metadata with invoice identifiers
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
                invoice_number: invoiceNumber,
              }
            })
            .eq('id', evt.id);
        }
        logStep("Enriched bom_events with invoice identifiers", { count: bomEvents.length });
      }
    }

    logStep("Invoice finalization complete");

    return new Response(JSON.stringify({
      success: true,
      invoice_id: invoice.id,
      invoice_number: invoiceNumber,
      status: 'open',
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
