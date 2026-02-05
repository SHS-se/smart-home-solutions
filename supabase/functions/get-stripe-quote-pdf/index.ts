import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getStripeSecretKey, getAppEnvironment } from "../_shared/stripe-env.ts";

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
    const appEnv = getAppEnvironment();
    const stripeKey = getStripeSecretKey();
    logStep("Function started", { environment: appEnv });

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    // Create client with anon key for auth validation
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
    
    // Create service role client for storage operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    if (!userData.user) throw new Error("User not authenticated");

    const userId = userData.user.id;

    const { quoteId, stripe_quote_id: directStripeQuoteId } = await req.json();
    
    // Check if user is staff
    const { data: staffData } = await supabaseAdmin
      .from('staff_users')
      .select('user_id')
      .eq('user_id', userId)
      .single();
    
    const isStaff = !!staffData;
    
    let stripeQuoteId: string;
    
    if (isStaff) {
      // Staff can access any quote directly with stripe_quote_id
      if (directStripeQuoteId) {
        stripeQuoteId = directStripeQuoteId;
      } else if (quoteId) {
        // Look up the quote
        const { data: quote, error: quoteError } = await supabaseAdmin
          .from('quotes')
          .select('stripe_quote_id')
          .eq('id', quoteId)
          .single();
        
        if (quoteError || !quote?.stripe_quote_id) {
          throw new Error("Quote not found or has no Stripe quote");
        }
        stripeQuoteId = quote.stripe_quote_id;
      } else {
        throw new Error("stripe_quote_id or quoteId is required");
      }
    } else {
      // Customer - must verify they own the quote
      if (!quoteId) throw new Error("quoteId is required");
      
      // Get customer for this user
      const { data: customer } = await supabaseAdmin
        .from('customers')
        .select('id')
        .eq('user_id', userId)
        .single();
      
      if (!customer) throw new Error("Customer not found");
      
      // Verify quote belongs to this customer and is accessible
      const { data: quote, error: quoteError } = await supabaseAdmin
        .from('quotes')
        .select('stripe_quote_id, status')
        .eq('id', quoteId)
        .eq('customer_id', customer.id)
        .single();
      
      if (quoteError || !quote) {
        throw new Error("Quote not found or access denied");
      }
      
      if (!quote.stripe_quote_id) {
        throw new Error("Quote has no PDF available");
      }
      
      // Customers can only download non-draft, non-cancelled quotes
      if (quote.status === 'draft' || quote.status === 'cancelled') {
        throw new Error("This quote is not available for download");
      }
      
      stripeQuoteId = quote.stripe_quote_id;
      logStep("Customer accessing own quote", { customerId: customer.id, quoteId });
    }

    // Use user-scoped path for session-based caching
    const fileName = `${userId}/${stripeQuoteId}.pdf`;

    logStep("Checking if PDF exists in storage", { fileName });

    // Check if PDF already exists in storage
    const { data: existingFiles } = await supabaseAdmin
      .storage
      .from('quote-pdfs')
      .list(userId, { search: `${stripeQuoteId}.pdf` });

    const pdfExists = existingFiles && existingFiles.some(f => f.name === `${stripeQuoteId}.pdf`);

    if (pdfExists) {
      logStep("PDF already cached, generating signed URL");
      
      // Generate a signed URL for existing file (valid for 5 minutes)
      const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin
        .storage
        .from('quote-pdfs')
        .createSignedUrl(fileName, 300);

      if (signedUrlError) {
        throw new Error(`Failed to generate signed URL: ${signedUrlError.message}`);
      }

      return new Response(
        JSON.stringify({ 
          url: signedUrlData.signedUrl,
          fileName,
          expiresIn: 300,
          cached: true,
        }), 
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    logStep("Fetching Stripe quote PDF", { stripeQuoteId });

    // Fetch the PDF from Stripe
    const pdfUrl = `https://files.stripe.com/v1/quotes/${stripeQuoteId}/pdf`;
    
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

    logStep("PDF fetched successfully from Stripe");

    // Get PDF as ArrayBuffer for storage upload
    const pdfArrayBuffer = await pdfResponse.arrayBuffer();
    const pdfUint8Array = new Uint8Array(pdfArrayBuffer);
    
    logStep("Uploading PDF to storage", { fileName });

    // Upload to Supabase storage using service role
    const { data: uploadData, error: uploadError } = await supabaseAdmin
      .storage
      .from('quote-pdfs')
      .upload(fileName, pdfUint8Array, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      logStep("Storage upload failed", { error: uploadError.message });
      throw new Error(`Failed to upload PDF to storage: ${uploadError.message}`);
    }

    logStep("PDF uploaded to storage", { path: uploadData.path });

    // Generate a signed URL (valid for 5 minutes)
    const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin
      .storage
      .from('quote-pdfs')
      .createSignedUrl(fileName, 300);

    if (signedUrlError) {
      logStep("Signed URL generation failed", { error: signedUrlError.message });
      throw new Error(`Failed to generate signed URL: ${signedUrlError.message}`);
    }

    logStep("Signed URL generated successfully");

    return new Response(
      JSON.stringify({ 
        url: signedUrlData.signedUrl,
        fileName,
        expiresIn: 300,
        cached: false,
      }), 
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
