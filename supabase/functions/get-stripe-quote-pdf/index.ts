import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[GET-STRIPE-QUOTE-PDF] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    if (!userData.user) throw new Error("User not authenticated");

    const { stripe_quote_id } = await req.json();
    if (!stripe_quote_id) throw new Error("stripe_quote_id is required");

    logStep("Fetching Stripe quote", { stripe_quote_id });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Retrieve the quote from Stripe
    const quote = await stripe.quotes.retrieve(stripe_quote_id);
    logStep("Quote retrieved", { status: quote.status });

    // The PDF is available via the quote's pdf property
    // For draft quotes, we need to finalize first or use a different approach
    if (!quote.pdf) {
      // Try to get the PDF URL by finalizing if it's a draft
      if (quote.status === 'draft') {
        logStep("Quote is draft, finalizing to get PDF");
        const finalizedQuote = await stripe.quotes.finalizeQuote(stripe_quote_id);
        
        if (finalizedQuote.pdf) {
          return new Response(JSON.stringify({ pdf_url: finalizedQuote.pdf }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
          });
        }
      }
      throw new Error("PDF not available for this quote");
    }

    return new Response(JSON.stringify({ pdf_url: quote.pdf }), {
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
