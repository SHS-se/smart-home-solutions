import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface HardwareItem {
  name: string;
  sku: string;
  quantity: number;
  unit_price_ex_vat: number;
}

interface ServiceLine {
  description: string;
  quantity: number;
  unit_price_ex_vat: number;
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
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

    // Helper to create a product and return a line item with price_data referencing it
    // Stripe Quotes API requires product ID, not nested product_data
    async function createLineItem(
      name: string, 
      description: string | undefined, 
      unitAmountCents: number, 
      quantity: number
    ): Promise<Stripe.QuoteCreateParams.LineItem> {
      const product = await stripe.products.create({
        name,
        description: description || undefined,
      });
      
      return {
        price_data: {
          currency: "sek",
          product: product.id,
          unit_amount: unitAmountCents,
        },
        quantity,
      };
    }

    // Create line items for quote
    const lineItems: Stripe.QuoteCreateParams.LineItem[] = [];

    // Add itemized hardware items
    for (const item of hardware_items) {
      const lineItem = await createLineItem(
        item.name,
        `SKU: ${item.sku}`,
        Math.round((item.unit_price_ex_vat || 0) * 100),
        item.quantity || 1
      );
      lineItems.push(lineItem);
    }

    // Add itemized labor lines
    for (const line of labor_lines) {
      const lineItem = await createLineItem(
        line.description || "Installation & konfiguration",
        `${line.quantity || 1} timmar`,
        Math.round((line.unit_price_ex_vat || 0) * 100),
        line.quantity || 1
      );
      lineItems.push(lineItem);
    }

    // Add itemized travel lines
    for (const line of travel_lines) {
      const lineItem = await createLineItem(
        line.description || "Resa & övrigt",
        undefined,
        Math.round((line.unit_price_ex_vat || 0) * 100),
        line.quantity || 1
      );
      lineItems.push(lineItem);
    }

    // Fallback to summarized totals if no itemized data was provided
    if (lineItems.length === 0) {
      if (hardware_total > 0) {
        const lineItem = await createLineItem(
          "Hårdvara för smart home-installation",
          "Hardware for smart home installation",
          Math.round(hardware_total * 100),
          1
        );
        lineItems.push(lineItem);
      }

      if (labor_total > 0) {
        const lineItem = await createLineItem(
          "Installation & konfiguration",
          "Installation and configuration services",
          Math.round(labor_total * 100),
          1
        );
        lineItems.push(lineItem);
      }

      if (travel_total > 0) {
        const lineItem = await createLineItem(
          "Resa & övrigt",
          "Travel and miscellaneous costs",
          Math.round(travel_total * 100),
          1
        );
        lineItems.push(lineItem);
      }
    }

    // Create Stripe Quote
    const stripeQuote = await stripe.quotes.create({
      customer: stripeCustomer.id,
      line_items: lineItems,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
      metadata: {
        internal_quote_id: quote_id,
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
