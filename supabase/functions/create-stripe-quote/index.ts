import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getStripeSecretKey, getAppEnvironment } from "../_shared/stripe-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface HardwareItem {
  name: string;
  sku: string;
  quantity: number;
  unit_price_ex_vat: number;
  vat_rate: number;
}

interface ServiceLine {
  description: string;
  quantity: number;
  unit_price_ex_vat: number;
  vat_rate: number;
}

interface RequestBody {
  quote_id: string;
  customer_name: string;
  hardware_items: HardwareItem[];
  labor_lines: ServiceLine[];
  travel_lines: ServiceLine[];
  hardware_total: number;
  labor_total: number;
  travel_total: number;
}

// Swedish VAT rates we support
const SUPPORTED_VAT_RATES = [0, 0.06, 0.12, 0.25];

// In-memory cache for tax rate IDs during this function invocation
const taxRateCache: Map<number, string> = new Map();

// In-memory cache for product IDs during this function invocation
const productCache: Map<string, string> = new Map();

/**
 * Get or create a Stripe product using idempotent lookup by SKU/identifier.
 * Caches results to avoid repeated API calls within the same invocation.
 */
async function getOrCreateProduct(
  stripe: Stripe,
  identifier: string,
  name: string,
  description?: string
): Promise<string> {
  // Check in-memory cache first
  if (productCache.has(identifier)) {
    return productCache.get(identifier)!;
  }

  // Search for existing product by metadata
  const existingProducts = await stripe.products.search({
    query: `metadata['sku_identifier']:'${identifier}'`,
    limit: 1,
  });

  if (existingProducts.data.length > 0) {
    const productId = existingProducts.data[0].id;
    productCache.set(identifier, productId);
    return productId;
  }

  // Create new product with metadata for future lookups
  const newProduct = await stripe.products.create({
    name,
    description: description || undefined,
    metadata: {
      sku_identifier: identifier,
      source: 'smart-home-solutions',
    },
  });

  productCache.set(identifier, newProduct.id);
  return newProduct.id;
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

/**
 * Normalize VAT rate to nearest supported rate.
 * Falls back to 25% if rate is unexpected.
 */
function normalizeVatRate(rate: number | undefined | null): number {
  if (rate === undefined || rate === null) {
    return 0.25; // Default to 25%
  }
  
  // Find closest supported rate
  const closest = SUPPORTED_VAT_RATES.reduce((prev, curr) => 
    Math.abs(curr - rate) < Math.abs(prev - rate) ? curr : prev
  );
  
  return closest;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const appEnv = getAppEnvironment();
    const stripeKey = getStripeSecretKey();
    console.log(`[CREATE-STRIPE-QUOTE] Running in ${appEnv} mode`);

    // Verify user is staff
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    // Create client with user's auth context for RLS
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: authHeader }
        }
      }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError || !userData.user) {
      throw new Error("Unauthorized");
    }

    const { data: staffData } = await supabaseClient
      .from("staff_users")
      .select("role")
      .eq("user_id", userData.user.id)
      .single();

    if (!staffData) {
      throw new Error("Staff access required");
    }

    const body: RequestBody = await req.json();
    const { 
      quote_id, 
      customer_name, 
      hardware_items = [], 
      labor_lines = [], 
      travel_lines = [],
      hardware_total,
      labor_total,
      travel_total 
    } = body;

    // Fetch quote to get quote_number
    const { data: quote, error: quoteError } = await supabaseClient
      .from("quotes")
      .select("quote_number")
      .eq("id", quote_id)
      .single();

    if (quoteError || !quote) {
      throw new Error("Quote not found");
    }

    // CRITICAL: quote_number is our legally valid identifier - must be present
    if (!quote.quote_number) {
      throw new Error("Quote number is missing - cannot create Stripe quote without a valid quote_number");
    }

    const quoteNumber = quote.quote_number;
    console.log(`[CREATE-STRIPE-QUOTE] Creating Stripe quote for ${quoteNumber}`);

    const stripe = new Stripe(stripeKey, {
      apiVersion: "2025-08-27.basil",
    });

    // Find or create Stripe customer
    let stripeCustomer;
    const customers = await stripe.customers.list({ limit: 1, email: `${customer_name.toLowerCase().replace(/\s+/g, '')}@example.com` });
    
    if (customers.data.length > 0) {
      stripeCustomer = customers.data[0];
    } else {
      stripeCustomer = await stripe.customers.create({
        name: customer_name,
      });
    }

    // Helper to create a line item with idempotent product lookup
    async function createLineItem(
      identifier: string,
      name: string, 
      description: string | undefined, 
      unitAmountCents: number, 
      quantity: number,
      vatRate: number
    ): Promise<Stripe.QuoteCreateParams.LineItem> {
      // Get or create product using idempotent lookup
      const productId = await getOrCreateProduct(stripe, identifier, name, description);
      
      // Get tax rate ID for this line's VAT rate
      const normalizedVatRate = normalizeVatRate(vatRate);
      const taxRateId = await getOrCreateTaxRate(stripe, normalizedVatRate);
      
      return {
        price_data: {
          currency: "sek",
          product: productId,
          unit_amount: unitAmountCents,
        },
        quantity,
        tax_rates: [taxRateId],
      };
    }

    // Create line items for quote
    const lineItems: Stripe.QuoteCreateParams.LineItem[] = [];

    // Add itemized hardware items with per-line VAT
    for (const item of hardware_items) {
      const lineItem = await createLineItem(
        `sku:${item.sku}`, // Use SKU code as unique identifier
        item.name,
        `SKU: ${item.sku}`,
        Math.round((item.unit_price_ex_vat || 0) * 100),
        item.quantity || 1,
        item.vat_rate
      );
      lineItems.push(lineItem);
    }

    // Add itemized labor lines with per-line VAT
    for (const line of labor_lines) {
      const lineItem = await createLineItem(
        `service:labor:${line.description || 'installation'}`, // Unique identifier for labor services
        line.description || "Installation & konfiguration",
        `${line.quantity || 1} timmar`,
        Math.round((line.unit_price_ex_vat || 0) * 100),
        line.quantity || 1,
        line.vat_rate
      );
      lineItems.push(lineItem);
    }

    // Add itemized travel lines with per-line VAT
    for (const line of travel_lines) {
      const lineItem = await createLineItem(
        `service:travel:${line.description || 'travel'}`, // Unique identifier for travel services
        line.description || "Resa & övrigt",
        undefined,
        Math.round((line.unit_price_ex_vat || 0) * 100),
        line.quantity || 1,
        line.vat_rate
      );
      lineItems.push(lineItem);
    }

    // Fallback to summarized totals if no itemized data was provided
    if (lineItems.length === 0) {
      // Use default 25% VAT for fallback totals
      const defaultVatRate = 0.25;
      
      if (hardware_total > 0) {
        const lineItem = await createLineItem(
          "fallback:hardware",
          "Hårdvara för smart home-installation",
          "Hardware for smart home installation",
          Math.round(hardware_total * 100),
          1,
          defaultVatRate
        );
        lineItems.push(lineItem);
      }

      if (labor_total > 0) {
        const lineItem = await createLineItem(
          "fallback:labor",
          "Installation & konfiguration",
          "Installation and configuration services",
          Math.round(labor_total * 100),
          1,
          defaultVatRate
        );
        lineItems.push(lineItem);
      }

      if (travel_total > 0) {
        const lineItem = await createLineItem(
          "fallback:travel",
          "Resa & övrigt",
          "Travel and miscellaneous costs",
          Math.round(travel_total * 100),
          1,
          defaultVatRate
        );
        lineItems.push(lineItem);
      }
    }

    // Create Stripe Quote WITHOUT default_tax_rates (using per-line tax_rates instead)
    // Include our quote number as the visible quote number, description, and in metadata
    const stripeQuote = await stripe.quotes.create({
      customer: stripeCustomer.id,
      description: `Offert ${quoteNumber}`,
      line_items: lineItems,
      // No default_tax_rates - each line has its own tax_rates
      expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
      metadata: {
        internal_quote_id: quote_id,
        shs_quote_number: quoteNumber,
      },
    });

    // Finalize the quote so it can be sent
    await stripe.quotes.finalizeQuote(stripeQuote.id);

    return new Response(
      JSON.stringify({ 
        stripe_quote_id: stripeQuote.id,
        pdf_url: stripeQuote.pdf,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Error creating Stripe quote:", error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
