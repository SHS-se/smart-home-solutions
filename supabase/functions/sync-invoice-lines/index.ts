import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[SYNC-INVOICE-LINES] ${step}${detailsStr}`);
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

    const { invoice_id } = await req.json();
    if (!invoice_id) throw new Error("invoice_id is required");
    logStep("Syncing invoice", { invoice_id });

    // Fetch invoice
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .select('*')
      .eq('id', invoice_id)
      .single();

    if (invoiceError || !invoice) throw new Error("Invoice not found");
    if (invoice.status !== 'draft') throw new Error("Can only sync draft invoices");
    if (!invoice.stripe_invoice_id) throw new Error("Invoice has no Stripe ID");

    logStep("Invoice loaded", { stripeInvoiceId: invoice.stripe_invoice_id, status: invoice.status });

    // Get the customer to find Stripe customer ID
    const { data: customer, error: customerError } = await supabaseClient
      .from('customers')
      .select('billing_email, org_name')
      .eq('id', invoice.customer_id)
      .single();

    if (customerError || !customer) throw new Error("Customer not found");
    if (!customer.billing_email) throw new Error("Customer has no billing email");

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Find Stripe customer by email
    const stripeCustomers = await stripe.customers.list({ 
      email: customer.billing_email, 
      limit: 1 
    });

    if (stripeCustomers.data.length === 0) {
      throw new Error("No Stripe customer found for this billing email");
    }

    const stripeCustomerId = stripeCustomers.data[0].id;
    logStep("Found Stripe customer", { stripeCustomerId });

    // Fetch line items
    const { data: lineItems, error: lineItemsError } = await supabaseClient
      .from('invoice_line_items')
      .select('*')
      .eq('invoice_id', invoice_id)
      .order('sort_order', { ascending: true });

    if (lineItemsError) throw new Error(`Failed to fetch line items: ${lineItemsError.message}`);

    logStep("Line items loaded", { count: lineItems?.length || 0 });

    // Get existing Stripe invoice items
    const existingItems = await stripe.invoiceItems.list({
      invoice: invoice.stripe_invoice_id,
      limit: 100
    });

    logStep("Existing Stripe items", { count: existingItems.data.length });

    // Delete all existing invoice items
    for (const item of existingItems.data) {
      await stripe.invoiceItems.del(item.id);
    }

    logStep("Deleted existing items");

    // Create new invoice items
    let subtotal = 0;
    let taxTotal = 0;

    for (const item of lineItems || []) {
      const amount = Math.round(item.quantity * item.unit_price * 100); // Convert to cents/öre
      const taxAmount = Math.round(amount * (item.tax_rate / 100));
      
      subtotal += amount;
      taxTotal += taxAmount;

      // Create a price for this line item
      const price = await stripe.prices.create({
        unit_amount: Math.round(item.unit_price * 100),
        currency: 'sek',
        product_data: {
          name: item.description
        }
      });

      // Create the invoice item with customer
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        invoice: invoice.stripe_invoice_id,
        pricing: { price: price.id },
        quantity: item.quantity,
        description: item.description,
        metadata: {
          line_type: item.line_type,
          sku: item.sku || '',
          local_id: item.id
        }
      });
    }

    logStep("Created invoice items in Stripe");

    // Update invoice timestamp (totals are computed via invoice_computed_totals view)
    const { error: updateError } = await supabaseClient
      .from('invoices')
      .update({
        updated_at: new Date().toISOString()
      })
      .eq('id', invoice_id);

    if (updateError) {
      logStep("Error updating invoice", { error: updateError });
    }

    // Create event
    await supabaseClient.from('invoice_events').insert({
      invoice_id,
      event_type: 'invoice_updated',
      metadata: {
        action: 'lines_synced',
        line_count: lineItems?.length || 0,
        subtotal: subtotal / 100,
        tax: taxTotal / 100
      },
      created_by: user.id
    });

    logStep("Sync complete");

    return new Response(JSON.stringify({
      success: true,
      subtotal: subtotal / 100,
      tax: taxTotal / 100,
      total: (subtotal + taxTotal) / 100,
      line_count: lineItems?.length || 0
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
