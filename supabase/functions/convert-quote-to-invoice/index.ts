import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CONVERT-QUOTE-TO-INVOICE] ${step}${detailsStr}`);
};

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

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    // Authenticate staff user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");
    logStep("User authenticated", { userId: user.id });

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

    const { quote_id } = await req.json();
    if (!quote_id) throw new Error("quote_id is required");
    logStep("Processing quote", { quote_id });

    // Fetch quote
    const { data: quote, error: quoteError } = await supabaseClient
      .from('quotes')
      .select('*')
      .eq('id', quote_id)
      .single();

    if (quoteError || !quote) throw new Error("Quote not found");
    logStep("Quote loaded", { stripe_quote_id: quote.stripe_quote_id, stripe_invoice_id: quote.stripe_invoice_id });

    // Check if invoice already exists
    if (quote.stripe_invoice_id) {
      throw new Error("Invoice already exists for this quote");
    }

    if (!quote.stripe_quote_id) {
      throw new Error("Quote has not been sent to Stripe yet");
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Get the Stripe quote
    const stripeQuote = await stripe.quotes.retrieve(quote.stripe_quote_id);
    logStep("Stripe quote retrieved", { status: stripeQuote.status });

    // Stripe quote must be accepted to convert to invoice, but we can also use finalized quotes
    // For draft quotes, we need to finalize and accept them first
    let acceptedQuote = stripeQuote;
    
    if (stripeQuote.status === 'draft') {
      // Finalize the quote first
      acceptedQuote = await stripe.quotes.finalizeQuote(quote.stripe_quote_id);
      logStep("Quote finalized");
    }
    
    if (acceptedQuote.status === 'open') {
      // Accept the quote
      acceptedQuote = await stripe.quotes.accept(quote.stripe_quote_id);
      logStep("Quote accepted");
    }

    // Now the quote should have an invoice
    if (!acceptedQuote.invoice) {
      throw new Error("No invoice was created from the quote");
    }

    const invoiceId = typeof acceptedQuote.invoice === 'string' 
      ? acceptedQuote.invoice 
      : acceptedQuote.invoice.id;

    // Retrieve the full invoice
    let invoice = await stripe.invoices.retrieve(invoiceId);
    logStep("Invoice retrieved", { 
      invoiceId: invoice.id, 
      status: invoice.status,
      number: invoice.number 
    });

    // Stripe draft invoices don't have a number - we need to finalize to get one
    // But we might want to keep it as draft for editing. 
    // Note: The invoice number and due_date are only assigned after finalization.
    // For now, store what we have and the webhook will update when finalized.

    // Also, Stripe Quotes API creates the invoice in draft mode by default.
    // We can optionally finalize it immediately if we want the number right away.
    // Let's finalize it immediately so the customer can pay.
    if (invoice.status === 'draft') {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id);
      logStep("Invoice finalized", { 
        invoiceId: invoice.id, 
        status: invoice.status,
        number: invoice.number 
      });
    }

    // Create or update invoice in invoices table (linked to quote)
    const invoiceData = {
      customer_id: quote.customer_id,
      quote_id: quote_id,
      stripe_invoice_id: invoice.id,
      stripe_quote_id: quote.stripe_quote_id,
      invoice_number: invoice.number,
      status: invoice.status || 'draft',
      currency: (invoice.currency || 'sek').toUpperCase(),
      subtotal: invoice.subtotal ? invoice.subtotal / 100 : null,
      tax: invoice.tax ? invoice.tax / 100 : null,
      total: invoice.total ? invoice.total / 100 : null,
      amount: invoice.amount_due ? invoice.amount_due / 100 : null,
      hosted_invoice_url: invoice.hosted_invoice_url,
      invoice_pdf_url: invoice.invoice_pdf,
      date: invoice.created ? new Date(invoice.created * 1000).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      due_date: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().split('T')[0] : null,
      finalized_at: invoice.status !== 'draft' ? new Date().toISOString() : null,
      bom_id: quote.bom_id,
      bom_version: quote.bom_version,
      quote_number: quote.quote_number,
      created_by: user.id,
      is_test: quote.is_test || false,
    };

    const { data: invoiceRecord, error: invoiceError } = await supabaseClient
      .from('invoices')
      .upsert(invoiceData, { 
        onConflict: 'stripe_invoice_id',
        ignoreDuplicates: false 
      })
      .select('id')
      .single();

    if (invoiceError) {
      logStep("Error creating invoice record", { error: invoiceError });
      throw new Error(`Failed to create invoice: ${invoiceError.message}`);
    }

    logStep("Invoice record created/updated", { invoiceId: invoiceRecord.id });

    // Update quote with invoice reference
    const { error: updateError } = await supabaseClient
      .from('quotes')
      .update({
        stripe_invoice_id: invoice.id,
        invoice_status: invoice.status || 'draft',
        invoice_hosted_url: invoice.hosted_invoice_url,
        invoice_pdf_url: invoice.invoice_pdf,
        invoice_number: invoice.number,
        invoice_due_date: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().split('T')[0] : null,
        invoice_subtotal: invoice.subtotal ? invoice.subtotal / 100 : null,
        invoice_vat: invoice.tax ? invoice.tax / 100 : null,
        invoice_total: invoice.total ? invoice.total / 100 : null,
      })
      .eq('id', quote_id);

    if (updateError) {
      logStep("Error updating quote", { error: updateError });
      // Non-fatal - invoice was created successfully
    }

    // Create billing event
    await supabaseClient.from('billing_events').insert({
      quote_id,
      stripe_quote_id: quote.stripe_quote_id,
      stripe_invoice_id: invoice.id,
      event_type: 'invoice_created',
      metadata: { 
        invoice_number: invoice.number,
        invoice_status: invoice.status,
        amount_due: invoice.amount_due,
        invoice_record_id: invoiceRecord.id,
      },
      created_by: user.id,
    });

    logStep("Invoice created successfully", { invoiceRecordId: invoiceRecord.id });

    return new Response(JSON.stringify({
      success: true,
      invoice_id: invoice.id,
      invoice_number: invoice.number,
      invoice_status: invoice.status,
      hosted_url: invoice.hosted_invoice_url,
      pdf_url: invoice.invoice_pdf,
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
