import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[VOID-INVOICE] ${step}${detailsStr}`);
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

    const { data: staffData, error: staffError } = await serviceClient
      .from('staff_users')
      .select('user_id')
      .eq('user_id', user.id)
      .single();

    if (staffError || !staffData) {
      throw new Error("Access denied: Staff only");
    }
    logStep("Staff verified");

    const { quote_id, reason } = await req.json();
    if (!quote_id) throw new Error("quote_id is required");
    logStep("Processing quote", { quote_id });

    // Fetch the invoice linked to this quote
    const { data: invoice, error: invoiceError } = await serviceClient
      .from('invoices')
      .select('*')
      .eq('quote_id', quote_id)
      .single();

    if (invoiceError || !invoice) throw new Error("No invoice found for this quote");

    // Check if already voided
    if (invoice.status === 'void') {
      logStep("Invoice already voided");
      return new Response(JSON.stringify({
        success: true,
        invoice_status: 'void',
        message: 'Invoice was already voided',
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    if (invoice.status === 'paid') {
      throw new Error("Cannot void a paid invoice");
    }

    // Void the invoice locally
    await serviceClient.from('invoices').update({
      status: 'void',
      voided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', invoice.id);

    // Update quote
    await serviceClient.from('quotes').update({
      invoice_status: 'void',
    }).eq('id', quote_id);

    // Create billing event
    await serviceClient.from('billing_events').insert({
      quote_id,
      event_type: 'invoice_voided',
      metadata: {
        invoice_number: invoice.invoice_number,
        invoice_id: invoice.id,
        reason: reason || null,
      },
      created_by: user.id,
    });

    // Create invoice event
    await serviceClient.from('invoice_events').insert({
      invoice_id: invoice.id,
      event_type: 'invoice_voided',
      metadata: { reason: reason || null, previous_status: invoice.status },
      created_by: user.id,
    });

    logStep("Invoice void complete");

    return new Response(JSON.stringify({
      success: true,
      invoice_status: 'void',
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
