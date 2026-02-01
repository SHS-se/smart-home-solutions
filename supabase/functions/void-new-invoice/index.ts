import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[VOID-NEW-INVOICE] ${step}${detailsStr}`);
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

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

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

    const { invoice_id, reason } = await req.json();
    if (!invoice_id) throw new Error("invoice_id is required");
    logStep("Voiding invoice", { invoice_id });

    // Fetch invoice
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .select('*')
      .eq('id', invoice_id)
      .single();

    if (invoiceError || !invoice) throw new Error("Invoice not found");
    if (invoice.status === 'paid') throw new Error("Cannot void a paid invoice");
    if (invoice.status === 'void') {
      return new Response(JSON.stringify({
        success: true,
        status: 'void',
        message: 'Invoice was already voided'
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    logStep("Invoice loaded", { stripeInvoiceId: invoice.stripe_invoice_id, status: invoice.status });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Void in Stripe if it exists and is not draft
    if (invoice.stripe_invoice_id) {
      const stripeInvoice = await stripe.invoices.retrieve(invoice.stripe_invoice_id);
      
      if (stripeInvoice.status === 'draft') {
        // Delete draft invoice
        await stripe.invoices.del(invoice.stripe_invoice_id);
        logStep("Draft invoice deleted in Stripe");
      } else if (stripeInvoice.status !== 'void' && stripeInvoice.status !== 'paid') {
        // Void open invoice
        await stripe.invoices.voidInvoice(invoice.stripe_invoice_id);
        logStep("Invoice voided in Stripe");
      }
    }

    // Update local invoice
    const { error: updateError } = await supabaseClient
      .from('invoices')
      .update({
        status: 'void',
        hosted_invoice_url: null,
        voided_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', invoice_id);

    if (updateError) {
      throw new Error(`Failed to update invoice: ${updateError.message}`);
    }

    // Create event
    await supabaseClient.from('invoice_events').insert({
      invoice_id,
      event_type: 'invoice_voided',
      metadata: {
        reason: reason || null,
        previous_status: invoice.status
      },
      created_by: user.id
    });

    logStep("Invoice void complete");

    return new Response(JSON.stringify({
      success: true,
      status: 'void'
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
