import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
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

    logStep("Fetching Stripe quote PDF", { stripe_quote_id });

    // Stripe quotes PDF is accessed via files.stripe.com with basic auth
    const pdfUrl = `https://files.stripe.com/v1/quotes/${stripe_quote_id}/pdf`;
    
    // Fetch the PDF from Stripe with authentication
    const pdfResponse = await fetch(pdfUrl, {
      headers: {
        "Authorization": `Bearer ${stripeKey}`,
      },
    });

    if (!pdfResponse.ok) {
      const errorText = await pdfResponse.text();
      logStep("Stripe PDF fetch failed", { status: pdfResponse.status, error: errorText });
      throw new Error(`Failed to fetch PDF: ${pdfResponse.status}`);
    }

    logStep("PDF fetched successfully");

    // Return the PDF directly
    const pdfBlob = await pdfResponse.blob();
    
    return new Response(pdfBlob, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="quote-${stripe_quote_id}.pdf"`,
      },
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
