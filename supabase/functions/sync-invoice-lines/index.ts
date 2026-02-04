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

// Swedish VAT rates we support
const SUPPORTED_VAT_RATES = [0, 0.06, 0.12, 0.25];

// In-memory cache for tax rate IDs during this function invocation
const taxRateCache: Map<number, string> = new Map();

/**
 * Normalize VAT rate to nearest supported rate.
 * Falls back to 25% if rate is unexpected.
 */
function normalizeVatRate(rate: number | undefined | null): number {
  if (rate === undefined || rate === null) {
    return 0.25; // Default to 25%
  }
  // Convert from percentage (25) to decimal (0.25) if needed
  const decimalRate = rate > 1 ? rate / 100 : rate;
  
  // Find closest supported rate
  const closest = SUPPORTED_VAT_RATES.reduce((prev, curr) => 
    Math.abs(curr - decimalRate) < Math.abs(prev - decimalRate) ? curr : prev
  );
  
  return closest;
}

/**
 * Get or create a Stripe tax rate for a given VAT percentage.
 * Caches results to avoid repeated API calls within the same invocation.
 */
async function getOrCreateTaxRate(
  stripe: Stripe,
  vatRate: number
): Promise<string> {
  // Normalize VAT rate to percentage (e.g., 0.25 -> 25)
  const percentage = Math.round(vatRate * 100);
  
  // Check in-memory cache first
  if (taxRateCache.has(percentage)) {
    return taxRateCache.get(percentage)!;
  }
  
  // Search for existing tax rate in Stripe
  const existingTaxRates = await stripe.taxRates.list({ 
    limit: 100, 
    active: true 
  });
  
  const matchingRate = existingTaxRates.data.find(
    (rate: Stripe.TaxRate) => 
      rate.percentage === percentage && 
      rate.country === "SE" && 
      rate.inclusive === false
  );
  
  if (matchingRate) {
    taxRateCache.set(percentage, matchingRate.id);
    return matchingRate.id;
  }
  
  // Create new tax rate if not found
  const displayName = percentage === 0 ? "Momsfritt" : `Moms ${percentage}%`;
  const newTaxRate = await stripe.taxRates.create({
    display_name: displayName,
    description: `Swedish VAT ${percentage}%`,
    percentage: percentage,
    country: "SE",
    inclusive: false,
  });
  
  taxRateCache.set(percentage, newTaxRate.id);
  return newTaxRate.id;
}

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

    // Helper to get the appropriate Stripe key
    const getStripeKey = (isTest: boolean): string => {
      if (isTest) {
        const testKey = Deno.env.get("STRIPE_SECRET_KEY");
        if (!testKey) throw new Error("STRIPE_SECRET_KEY (test) is not set");
        return testKey;
      } else {
        const liveKey = Deno.env.get("STRIPE_SECRET_KEY_LIVE");
        if (!liveKey) throw new Error("STRIPE_SECRET_KEY_LIVE is not set");
        return liveKey;
      }
    };

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

    // Initialize Stripe with the correct key based on is_test flag
    const isTest = invoice.is_test ?? true;
    const stripeKey = getStripeKey(isTest);
    logStep("Using Stripe mode", { isTest });
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

    // Create new invoice items with tax rates
    let subtotal = 0;
    let taxTotal = 0;

    for (const item of lineItems || []) {
      const amount = Math.round(item.quantity * item.unit_price * 100); // Convert to cents/öre
      const normalizedVatRate = normalizeVatRate(item.tax_rate);
      const taxAmount = Math.round(amount * normalizedVatRate);
      
      subtotal += amount;
      taxTotal += taxAmount;

      // Get or create tax rate for this item
      const taxRateId = await getOrCreateTaxRate(stripe, normalizedVatRate);
      logStep("Tax rate for item", { description: item.description, tax_rate: item.tax_rate, normalizedVatRate, taxRateId });

      // Create a price for this line item
      const price = await stripe.prices.create({
        unit_amount: Math.round(item.unit_price * 100),
        currency: 'sek',
        product_data: {
          name: item.description
        }
      });

      // Create the invoice item with customer and tax rate
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        invoice: invoice.stripe_invoice_id,
        pricing: { price: price.id },
        quantity: item.quantity,
        description: item.description,
        tax_rates: [taxRateId], // Per-line tax rate
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
