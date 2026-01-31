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
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    // Verify user is staff
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

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

    // Create line items for quote
    const lineItems: Stripe.QuoteCreateParams.LineItem[] = [];

    // Add itemized hardware items
    for (const item of hardware_items) {
      if (item.quantity > 0 && item.unit_price_ex_vat > 0) {
        lineItems.push({
          price_data: {
            currency: "sek",
            product_data: {
              name: item.name,
              description: `SKU: ${item.sku}`,
            },
            unit_amount: Math.round(item.unit_price_ex_vat * 100),
          },
          quantity: item.quantity,
        });
      }
    }

    // Add itemized labor lines
    for (const line of labor_lines) {
      if (line.quantity > 0 && line.unit_price_ex_vat > 0) {
        lineItems.push({
          price_data: {
            currency: "sek",
            product_data: {
              name: line.description || "Installation & konfiguration",
              description: `${line.quantity} timmar`,
            },
            unit_amount: Math.round(line.unit_price_ex_vat * 100),
          },
          quantity: line.quantity,
        });
      }
    }

    // Add itemized travel lines
    for (const line of travel_lines) {
      if (line.quantity > 0 && line.unit_price_ex_vat > 0) {
        lineItems.push({
          price_data: {
            currency: "sek",
            product_data: {
              name: line.description || "Resa & övrigt",
            },
            unit_amount: Math.round(line.unit_price_ex_vat * 100),
          },
          quantity: line.quantity,
        });
      }
    }

    // Fallback to summarized totals if no itemized data was provided
    if (lineItems.length === 0) {
      if (hardware_total > 0) {
        lineItems.push({
          price_data: {
            currency: "sek",
            product_data: {
              name: "Hårdvara för smart home-installation",
              description: "Hardware for smart home installation",
            },
            unit_amount: Math.round(hardware_total * 100),
          },
          quantity: 1,
        });
      }

      if (labor_total > 0) {
        lineItems.push({
          price_data: {
            currency: "sek",
            product_data: {
              name: "Installation & konfiguration",
              description: "Installation and configuration services",
            },
            unit_amount: Math.round(labor_total * 100),
          },
          quantity: 1,
        });
      }

      if (travel_total > 0) {
        lineItems.push({
          price_data: {
            currency: "sek",
            product_data: {
              name: "Resa & övrigt",
              description: "Travel and miscellaneous costs",
            },
            unit_amount: Math.round(travel_total * 100),
          },
          quantity: 1,
        });
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
