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
  console.log(`[SYNC-INVOICES] ${step}${detailsStr}`);
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

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    // Get customer_id from database
    const { data: customerData, error: customerError } = await supabaseClient
      .from('customers')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (customerError) throw new Error(`Error fetching customer: ${customerError.message}`);
    if (!customerData) throw new Error("No customer record found for this user");
    
    const customerId = customerData.id;
    logStep("Found customer in database", { customerId });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    
    // Find Stripe customer
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    if (customers.data.length === 0) {
      logStep("No Stripe customer found, nothing to sync");
      return new Response(JSON.stringify({ synced: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const stripeCustomerId = customers.data[0].id;
    logStep("Found Stripe customer", { stripeCustomerId });

    // Fetch invoices from Stripe
    const stripeInvoices = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: 100,
    });
    logStep("Fetched Stripe invoices", { count: stripeInvoices.data.length });

    let syncedCount = 0;

    for (const invoice of stripeInvoices.data) {
      const status = invoice.status || 'draft';

      const finalizedAt = invoice.status_transitions?.finalized_at ?? null;
      const paidAt = invoice.status_transitions?.paid_at ?? null;
      const voidedAt = invoice.status_transitions?.voided_at ?? null;

      // If invoice is finalized, use finalized_at as the issue date; otherwise fall back to created.
      const issuedAtTs = finalizedAt ?? invoice.created ?? null;

      const invoiceData = {
        customer_id: customerId,
        stripe_invoice_id: invoice.id,
        invoice_number: invoice.number || null,
        issued_at: issuedAtTs ? new Date(issuedAtTs * 1000).toISOString() : null,
        finalized_at: finalizedAt ? new Date(finalizedAt * 1000).toISOString() : null,
        paid_at: paidAt ? new Date(paidAt * 1000).toISOString() : null,
        voided_at: voidedAt ? new Date(voidedAt * 1000).toISOString() : null,
        due_date: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().split('T')[0] : null,
        // Store the actual invoice total (minor units -> major units)
        amount: (typeof invoice.total === 'number' ? invoice.total : (invoice.amount_due ?? 0)) / 100,
        currency: (invoice.currency || 'sek').toUpperCase(),
        status,
        hosted_invoice_url: invoice.hosted_invoice_url || null,
        invoice_pdf_url: invoice.invoice_pdf || null,
        updated_at: new Date().toISOString(),
      };

      // Upsert invoice by stripe_invoice_id (now has UNIQUE constraint)
      const { error: upsertError } = await supabaseClient
        .from('invoices')
        .upsert(invoiceData, { 
          onConflict: 'stripe_invoice_id',
          ignoreDuplicates: false 
        });

      if (upsertError) {
        logStep("Error upserting invoice", { invoiceId: invoice.id, error: upsertError.message });
        continue;
      }
      
      syncedCount++;
    }

    logStep("Sync complete", { syncedCount });

    return new Response(JSON.stringify({ synced: syncedCount }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR in sync-invoices", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
