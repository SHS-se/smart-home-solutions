import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

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
    logStep("Function started");

    // WARNING: Use SHS_STRIPE_SECRET_KEY, NOT STRIPE_SECRET_KEY. See _shared/stripe-env.ts for details.
    const stripeKey = Deno.env.get("SHS_STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("SHS_STRIPE_SECRET_KEY is not set");

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

    // Fetch quote
    const { data: quote, error: quoteError } = await supabaseClient
      .from('quotes')
      .select('*')
      .eq('id', quote_id)
      .single();

    if (quoteError || !quote) throw new Error("Quote not found");

    if (!quote.stripe_invoice_id) {
      throw new Error("No invoice exists for this quote");
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Get the invoice first to check its status
    const currentInvoice = await stripe.invoices.retrieve(quote.stripe_invoice_id);
    logStep("Invoice retrieved", { status: currentInvoice.status });

    let invoice = currentInvoice;

    // Only finalize if still draft
    if (currentInvoice.status === 'draft') {
      invoice = await stripe.invoices.finalizeInvoice(quote.stripe_invoice_id);
      logStep("Invoice finalized", { status: invoice.status });
    } else {
      logStep("Invoice already finalized", { status: currentInvoice.status });
    }

    // Update quote with latest invoice data
    const { error: updateError } = await supabaseClient
      .from('quotes')
      .update({
        invoice_status: invoice.status || 'open',
        invoice_hosted_url: invoice.hosted_invoice_url,
        invoice_pdf_url: invoice.invoice_pdf,
        invoice_number: invoice.number,
        invoice_due_date: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().split('T')[0] : null,
        invoice_subtotal: invoice.subtotal ? invoice.subtotal / 100 : null,
        invoice_vat: invoice.tax ? invoice.tax / 100 : null,
        invoice_total: invoice.total ? invoice.total / 100 : null,
      })
      .eq('id', quote_id);

    if (updateError) {
      throw new Error(`Failed to update quote: ${updateError.message}`);
    }

    // Create billing event
    await supabaseClient.from('billing_events').insert({
      quote_id,
      stripe_quote_id: quote.stripe_quote_id,
      stripe_invoice_id: invoice.id,
      event_type: 'invoice_finalized',
      metadata: { 
        invoice_number: invoice.number,
        invoice_status: invoice.status,
        hosted_url: invoice.hosted_invoice_url,
      },
      created_by: user.id,
    });

    logStep("Invoice finalization complete");

    return new Response(JSON.stringify({
      success: true,
      invoice_status: invoice.status,
      hosted_url: invoice.hosted_invoice_url,
      pdf_url: invoice.invoice_pdf,
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
