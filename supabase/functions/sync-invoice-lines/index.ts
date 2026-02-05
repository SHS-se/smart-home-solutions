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
  console.log(`[SYNC-INVOICE-LINES] ${step}${detailsStr}`);
};

const SUPPORTED_VAT_RATES = [0, 0.06, 0.12, 0.25];
const taxRateCache: Map<number, string> = new Map();

function normalizeVatRate(rate: number | undefined | null): number {
  if (rate === undefined || rate === null) return 0.25;
  const decimalRate = rate > 1 ? rate / 100 : rate;
  return SUPPORTED_VAT_RATES.reduce((prev, curr) => Math.abs(curr - decimalRate) < Math.abs(prev - decimalRate) ? curr : prev);
}

async function getOrCreateTaxRate(stripe: Stripe, vatRate: number): Promise<string> {
  const percentage = Math.round(vatRate * 100);
  if (taxRateCache.has(percentage)) return taxRateCache.get(percentage)!;
  
  const existingTaxRates = await stripe.taxRates.list({ limit: 100, active: true });
  const matchingRate = existingTaxRates.data.find((rate: Stripe.TaxRate) => rate.percentage === percentage && rate.country === "SE" && rate.inclusive === false);
  
  if (matchingRate) { taxRateCache.set(percentage, matchingRate.id); return matchingRate.id; }
  
  const newTaxRate = await stripe.taxRates.create({ display_name: percentage === 0 ? "Momsfritt" : `Moms ${percentage}%`, description: `Swedish VAT ${percentage}%`, percentage, country: "SE", inclusive: false });
  taxRateCache.set(percentage, newTaxRate.id);
  return newTaxRate.id;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const appEnv = getAppEnvironment();
    const stripeKey = getStripeSecretKey();
    logStep("Function started", { environment: appEnv });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData } = await supabaseClient.auth.getUser(token);
    if (!userData.user) throw new Error("User not authenticated");

    const { data: staffData } = await supabaseClient.from('staff_users').select('user_id').eq('user_id', userData.user.id).single();
    if (!staffData) throw new Error("Access denied: Staff only");

    const { invoice_id } = await req.json();
    if (!invoice_id) throw new Error("invoice_id is required");

    const { data: invoice } = await supabaseClient.from('invoices').select('*').eq('id', invoice_id).single();
    if (!invoice || invoice.status !== 'draft' || !invoice.stripe_invoice_id) throw new Error("Invoice not found or invalid");

    const { data: customer } = await supabaseClient.from('customers').select('billing_email').eq('id', invoice.customer_id).single();
    if (!customer?.billing_email) throw new Error("Customer has no billing email");

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const stripeCustomers = await stripe.customers.list({ email: customer.billing_email, limit: 1 });
    if (stripeCustomers.data.length === 0) throw new Error("No Stripe customer found");
    const stripeCustomerId = stripeCustomers.data[0].id;

    const { data: lineItems } = await supabaseClient.from('invoice_line_items').select('*').eq('invoice_id', invoice_id).order('sort_order');
    const existingItems = await stripe.invoiceItems.list({ invoice: invoice.stripe_invoice_id, limit: 100 });
    for (const item of existingItems.data) await stripe.invoiceItems.del(item.id);

    let subtotal = 0, taxTotal = 0;
    for (const item of lineItems || []) {
      const amount = Math.round(item.quantity * item.unit_price * 100);
      const normalizedVatRate = normalizeVatRate(item.tax_rate);
      subtotal += amount;
      taxTotal += Math.round(amount * normalizedVatRate);
      const taxRateId = await getOrCreateTaxRate(stripe, normalizedVatRate);
      const price = await stripe.prices.create({ unit_amount: Math.round(item.unit_price * 100), currency: 'sek', product_data: { name: item.description } });
      await stripe.invoiceItems.create({ customer: stripeCustomerId, invoice: invoice.stripe_invoice_id, pricing: { price: price.id }, quantity: item.quantity, description: item.description, tax_rates: [taxRateId] });
    }

    await supabaseClient.from('invoices').update({ updated_at: new Date().toISOString() }).eq('id', invoice_id);
    await supabaseClient.from('invoice_events').insert({ invoice_id, event_type: 'invoice_updated', metadata: { action: 'lines_synced', line_count: lineItems?.length || 0 }, created_by: userData.user.id });

    return new Response(JSON.stringify({ success: true, subtotal: subtotal / 100, tax: taxTotal / 100, total: (subtotal + taxTotal) / 100 }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
  }
});
