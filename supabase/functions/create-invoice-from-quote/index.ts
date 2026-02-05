import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getStripeSecretKey, getAppEnvironment } from "../_shared/stripe-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CREATE-INVOICE-FROM-QUOTE] ${step}${detailsStr}`);
};

// Swedish VAT rates
const SUPPORTED_VAT_RATES = [0, 0.06, 0.12, 0.25];

function normalizeVatRate(rate: number | undefined | null): number {
  if (rate === undefined || rate === null) return 0.25;
  return SUPPORTED_VAT_RATES.reduce((prev, curr) =>
    Math.abs(curr - rate) < Math.abs(prev - rate) ? curr : prev
  );
}

const taxRateCache: Map<number, string> = new Map();

async function getOrCreateTaxRate(stripe: Stripe, vatRate: number): Promise<string> {
  const percentage = Math.round(vatRate * 100);
  if (taxRateCache.has(percentage)) return taxRateCache.get(percentage)!;

  const existing = await stripe.taxRates.list({ limit: 100, active: true });
  const match = existing.data.find(
    (r: Stripe.TaxRate) => r.percentage === percentage && r.country === "SE" && r.inclusive === false
  );

  if (match) {
    taxRateCache.set(percentage, match.id);
    return match.id;
  }

  const displayName = percentage === 0 ? "Momsfritt" : `Moms ${percentage}%`;
  const newRate = await stripe.taxRates.create({
    display_name: displayName,
    description: `Swedish VAT ${percentage}%`,
    percentage,
    country: "SE",
    inclusive: false,
  });
  taxRateCache.set(percentage, newRate.id);
  return newRate.id;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const appEnv = getAppEnvironment();
    const stripeKey = getStripeSecretKey();
    logStep("Function started", { environment: appEnv });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);

    // Verify staff
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !userData.user) throw new Error("Unauthorized");

    const { data: staffCheck } = await serviceClient
      .from("staff_users").select("user_id").eq("user_id", userData.user.id).single();
    if (!staffCheck) throw new Error("Staff access required");
    logStep("Staff verified");

    const { quote_id } = await req.json();
    if (!quote_id) throw new Error("quote_id is required");

    // Load quote
    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("*")
      .eq("id", quote_id)
      .single();

    if (quoteError || !quote) throw new Error("Quote not found");
    logStep("Quote loaded", { quoteId: quote.id, status: quote.status });

    if (quote.stripe_invoice_id) {
      throw new Error("Invoice already exists for this quote");
    }

    if (quote.status !== "accepted") {
      throw new Error("Quote must be accepted before creating an invoice");
    }

    // Load customer
    const { data: customer } = await serviceClient
      .from("customers_with_identity")
      .select("name, contact_email, billing_street, billing_postcode, billing_city")
      .eq("id", quote.customer_id)
      .single();

    if (!customer) throw new Error("Customer not found");

    // Load quote line items
    const { data: lineItems } = await serviceClient
      .from("quote_lines")
      .select("*")
      .eq("quote_id", quote_id)
      .order("section")
      .order("created_at");

    if (!lineItems || lineItems.length === 0) throw new Error("No line items found");

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Find or create Stripe customer by email
    let stripeCustomer: Stripe.Customer;
    if (customer.contact_email) {
      const existing = await stripe.customers.list({ email: customer.contact_email, limit: 1 });
      if (existing.data.length > 0) {
        stripeCustomer = existing.data[0];
      } else {
        stripeCustomer = await stripe.customers.create({
          name: customer.name || undefined,
          email: customer.contact_email,
          address: customer.billing_street ? {
            line1: customer.billing_street,
            postal_code: customer.billing_postcode || undefined,
            city: customer.billing_city || undefined,
            country: "SE",
          } : undefined,
        });
      }
    } else {
      stripeCustomer = await stripe.customers.create({
        name: customer.name || "Kund",
      });
    }
    logStep("Stripe customer", { customerId: stripeCustomer.id });

    // Create Stripe Invoice
    const stripeInvoice = await stripe.invoices.create({
      customer: stripeCustomer.id,
      currency: "sek",
      collection_method: "send_invoice",
      days_until_due: 30,
      metadata: {
        internal_quote_id: quote_id,
        quote_number: quote.quote_number || "",
      },
    });
    logStep("Invoice created", { invoiceId: stripeInvoice.id });

    // Add line items
    for (const item of lineItems) {
      const unitAmountCents = Math.round((item.unit_price_ex_vat || item.unit_price || 0) * 100);
      const normalizedVat = normalizeVatRate(item.vat_rate);
      const taxRateId = await getOrCreateTaxRate(stripe, normalizedVat);

      const sectionLabel = item.section === "hardware" ? "Hårdvara"
        : item.section === "labor" ? "Arbete"
        : "Resa & övrigt";

      await stripe.invoiceItems.create({
        customer: stripeCustomer.id,
        invoice: stripeInvoice.id,
        description: `[${sectionLabel}] ${item.description}`,
        quantity: item.quantity || 1,
        unit_amount: unitAmountCents,
        currency: "sek",
        tax_rates: [taxRateId],
      });
    }

    // Finalize the invoice
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(stripeInvoice.id);
    logStep("Invoice finalized", { number: finalizedInvoice.number, status: finalizedInvoice.status });

    // Create local invoice record
    const invoiceData = {
      customer_id: quote.customer_id,
      quote_id,
      stripe_invoice_id: finalizedInvoice.id,
      invoice_number: finalizedInvoice.number,
      status: finalizedInvoice.status || "open",
      currency: "SEK",
      amount: finalizedInvoice.amount_due ? finalizedInvoice.amount_due / 100 : null,
      hosted_invoice_url: finalizedInvoice.hosted_invoice_url,
      invoice_pdf_url: finalizedInvoice.invoice_pdf,
      due_date: finalizedInvoice.due_date
        ? new Date(finalizedInvoice.due_date * 1000).toISOString().split("T")[0]
        : null,
      finalized_at: new Date().toISOString(),
      bom_id: quote.bom_id,
      bom_version: quote.bom_version,
      quote_number: quote.quote_number,
      created_by: userData.user.id,
      is_test: quote.is_test,
    };

    const { data: invoiceRecord, error: invoiceError } = await serviceClient
      .from("invoices")
      .insert(invoiceData)
      .select("id")
      .single();

    if (invoiceError) throw new Error(`Failed to create invoice record: ${invoiceError.message}`);
    logStep("Invoice record created", { invoiceId: invoiceRecord.id });

    // Copy quote_lines to invoice_line_items
    const invoiceLineItems = lineItems.map((item, idx) => ({
      invoice_id: invoiceRecord.id,
      description: item.description,
      quantity: item.quantity || 1,
      unit_price: item.unit_price_ex_vat || item.unit_price || 0,
      tax_rate: Math.round((item.vat_rate || 0.25) * 100),
      line_type: item.section,
      sort_order: idx,
      sku: item.original_sku_code || null,
      sku_id: item.sku_id || null,
      category: item.section,
    }));

    await serviceClient.from("invoice_line_items").insert(invoiceLineItems);

    // Update quote with invoice reference
    await serviceClient.from("quotes").update({
      stripe_invoice_id: finalizedInvoice.id,
      invoice_status: finalizedInvoice.status || "open",
      invoice_hosted_url: finalizedInvoice.hosted_invoice_url,
      invoice_pdf_url: finalizedInvoice.invoice_pdf,
      invoice_number: finalizedInvoice.number,
      invoice_due_date: finalizedInvoice.due_date
        ? new Date(finalizedInvoice.due_date * 1000).toISOString().split("T")[0]
        : null,
      invoice_subtotal: finalizedInvoice.subtotal ? finalizedInvoice.subtotal / 100 : null,
      invoice_vat: finalizedInvoice.tax ? finalizedInvoice.tax / 100 : null,
      invoice_total: finalizedInvoice.total ? finalizedInvoice.total / 100 : null,
      status: "invoiced",
    }).eq("id", quote_id);

    // Log event
    await serviceClient.from("quote_events").insert({
      quote_id,
      event_type: "invoice_created",
      actor_type: "staff",
      actor_email: userData.user.email,
      metadata: {
        invoice_number: finalizedInvoice.number,
        invoice_id: invoiceRecord.id,
        stripe_invoice_id: finalizedInvoice.id,
      },
    });

    logStep("Done", { invoiceNumber: finalizedInvoice.number });

    return new Response(JSON.stringify({
      success: true,
      invoice_id: invoiceRecord.id,
      stripe_invoice_id: finalizedInvoice.id,
      invoice_number: finalizedInvoice.number,
      hosted_url: finalizedInvoice.hosted_invoice_url,
      pdf_url: finalizedInvoice.invoice_pdf,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
