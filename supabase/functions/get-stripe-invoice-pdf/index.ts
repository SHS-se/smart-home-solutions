import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[GET-STRIPE-INVOICE-PDF] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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

    // Check if user is staff
    const { data: staffData } = await supabaseAdmin
      .from('staff_users')
      .select('user_id')
      .eq('user_id', userId)
      .single();
    
    const isStaff = !!staffData;
    logStep("User role check", { userId, isStaff });

    const { stripe_invoice_id, is_test } = await req.json();
    if (!stripe_invoice_id) throw new Error("stripe_invoice_id is required");

    // Default to test mode if not specified
    const isTest = is_test ?? true;
    const stripeKey = getStripeKey(isTest);
    logStep("Using Stripe mode", { isTest });

    // If not staff, verify the invoice belongs to the customer
    if (!isStaff) {
      // Get customer_id for this user
      const { data: customerData } = await supabaseAdmin
        .from('customers')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (!customerData) {
        throw new Error("No customer record found for this user");
      }

      // Verify the invoice belongs to this customer and has an allowed status
      const { data: invoiceData, error: invoiceError } = await supabaseAdmin
        .from('invoices')
        .select('id, status')
        .eq('stripe_invoice_id', stripe_invoice_id)
        .eq('customer_id', customerData.id)
        .single();

      if (invoiceError || !invoiceData) {
        throw new Error("Invoice not found or access denied");
      }

      // Only allow PDF access for open, paid, overdue invoices (not void or draft)
      const allowedStatuses = ['open', 'paid', 'overdue'];
      if (!invoiceData.status || !allowedStatuses.includes(invoiceData.status.toLowerCase())) {
        throw new Error("PDF not available for this invoice status");
      }

      logStep("Customer access verified", { customerId: customerData.id, invoiceStatus: invoiceData.status });
    }

    // Use user-scoped path for session-based caching
    const fileName = `${userId}/${stripe_invoice_id}.pdf`;

    logStep("Checking if PDF exists in storage", { fileName });

    // Check if PDF already exists in storage
    const { data: existingFiles } = await supabaseAdmin
      .storage
      .from('invoice-pdfs')
      .list(userId, { search: `${stripe_invoice_id}.pdf` });

    const pdfExists = existingFiles && existingFiles.some(f => f.name === `${stripe_invoice_id}.pdf`);

    if (pdfExists) {
      logStep("PDF already cached, generating signed URL");
      
      // Generate a signed URL for existing file (valid for 5 minutes)
      const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin
        .storage
        .from('invoice-pdfs')
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

    logStep("Fetching Stripe invoice", { stripe_invoice_id });

    // First, fetch the invoice to get the PDF URL
    const invoiceResponse = await fetch(`https://api.stripe.com/v1/invoices/${stripe_invoice_id}`, {
      headers: {
        "Authorization": `Bearer ${stripeKey}`,
      },
    });

    if (!invoiceResponse.ok) {
      const errorText = await invoiceResponse.text();
      logStep("Stripe invoice fetch failed", { status: invoiceResponse.status, error: errorText });
      throw new Error(`Failed to fetch invoice: ${invoiceResponse.status}`);
    }

    const invoice = await invoiceResponse.json();
    const pdfUrl = invoice.invoice_pdf;

    if (!pdfUrl) {
      throw new Error("Invoice does not have a PDF URL. It may not be finalized yet.");
    }

    logStep("Fetching PDF from Stripe", { pdfUrl });

    // Fetch the PDF from Stripe
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
      .from('invoice-pdfs')
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
      .from('invoice-pdfs')
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
