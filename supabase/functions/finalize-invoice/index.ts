import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[FINALIZE-INVOICE] ${step}${detailsStr}`);
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

    const { quote_id } = await req.json();
    if (!quote_id) throw new Error("quote_id is required");
    logStep("Processing quote", { quote_id });

    // Fetch the invoice linked to this quote
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .select('*')
      .eq('quote_id', quote_id)
      .single();

    if (invoiceError || !invoice) throw new Error("No invoice found for this quote");
    if (invoice.status !== 'draft') {
      logStep("Invoice already finalized", { status: invoice.status });
      return new Response(JSON.stringify({
        success: true,
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        status: invoice.status,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Set app environment for the DB function
    await supabaseClient.rpc('set_app_environment', { env: appEnv });

    // Allocate invoice number via the gap-free DB function
    const { data: invoiceNumber, error: allocError } = await supabaseClient
      .rpc('allocate_invoice_number');

    if (allocError || !invoiceNumber) {
      throw new Error(`Failed to allocate invoice number: ${allocError?.message || 'no number returned'}`);
    }
    logStep("Invoice number allocated", { invoiceNumber });

    // Get computed totals
    const { data: totals } = await supabaseClient
      .from('invoice_computed_totals')
      .select('*')
      .eq('invoice_id', invoice.id)
      .single();

    const now = new Date().toISOString();

    // Update local invoice to open status
    const { error: updateError } = await supabaseClient
      .from('invoices')
      .update({
        invoice_number: invoiceNumber,
        status: 'open',
        finalized_at: now,
        issued_at: now,
        subtotal: totals?.subtotal || 0,
        tax: totals?.tax || 0,
        total: totals?.total || 0,
        updated_at: now,
      })
      .eq('id', invoice.id);

    if (updateError) {
      throw new Error(`Failed to update invoice: ${updateError.message}`);
    }

    // Update quote with invoice data
    await supabaseClient.from('quotes').update({
      invoice_status: 'open',
      invoice_number: invoiceNumber,
      invoice_due_date: invoice.due_date,
      invoice_subtotal: totals?.subtotal || 0,
      invoice_vat: totals?.tax || 0,
      invoice_total: totals?.total || 0,
    }).eq('id', quote_id);

    // Create billing event
    await supabaseClient.from('billing_events').insert({
      quote_id,
      event_type: 'invoice_finalized',
      metadata: {
        invoice_number: invoiceNumber,
        invoice_id: invoice.id,
      },
      created_by: user.id,
    });

    // Create invoice event
    await supabaseClient.from('invoice_events').insert({
      invoice_id: invoice.id,
      event_type: 'invoice_finalized',
      metadata: {
        invoice_number: invoiceNumber,
      },
      created_by: user.id,
    });

    logStep("Invoice finalization complete", { invoiceNumber });

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
