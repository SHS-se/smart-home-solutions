import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[INVOICE-WEBHOOK] ${step}${detailsStr}`);
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
    logStep("Webhook received");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Get raw body for signature verification (if webhook secret is configured)
    const body = await req.text();
    let event: Stripe.Event;

    // Try to verify webhook signature if configured
    const webhookSecret = Deno.env.get("STRIPE_INVOICE_WEBHOOK_SECRET");
    const signature = req.headers.get("stripe-signature");

    if (webhookSecret && signature) {
      try {
        event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
        logStep("Webhook signature verified");
      } catch (err) {
        logStep("Webhook signature verification failed", { error: err });
        return new Response(JSON.stringify({ error: "Webhook signature verification failed" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
    } else {
      // Parse body as JSON if no signature verification
      event = JSON.parse(body);
      logStep("Processing webhook without signature verification");
    }

    const invoice = event.data.object as Stripe.Invoice;
    logStep("Processing event", { type: event.type, invoiceId: invoice.id });

    // Find the quote by stripe_invoice_id
    const { data: quote, error: quoteError } = await supabaseClient
      .from('quotes')
      .select('id, stripe_quote_id')
      .eq('stripe_invoice_id', invoice.id)
      .single();

    if (quoteError || !quote) {
      logStep("Quote not found for invoice", { invoiceId: invoice.id });
      // Return 200 to acknowledge receipt - invoice might not be from our system
      return new Response(JSON.stringify({ received: true, matched: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    logStep("Quote found", { quoteId: quote.id });

    let eventType = '';
    let updateData: Record<string, unknown> = {};

    switch (event.type) {
      case 'invoice.paid':
        eventType = 'invoice_paid';
        updateData = {
          invoice_status: 'paid',
          invoice_total: invoice.total ? invoice.total / 100 : null,
        };
        break;

      case 'invoice.voided':
        eventType = 'invoice_voided';
        updateData = {
          invoice_status: 'void',
          invoice_hosted_url: null,
        };
        break;

      case 'invoice.uncollectible':
        eventType = 'invoice_uncollectible';
        updateData = {
          invoice_status: 'uncollectible',
        };
        break;

      case 'invoice.finalized':
        eventType = 'invoice_finalized';
        updateData = {
          invoice_status: invoice.status || 'open',
          invoice_hosted_url: invoice.hosted_invoice_url,
          invoice_pdf_url: invoice.invoice_pdf,
          invoice_number: invoice.number,
        };
        break;

      case 'invoice.updated':
        eventType = 'invoice_updated';
        updateData = {
          invoice_status: invoice.status,
          invoice_hosted_url: invoice.hosted_invoice_url,
          invoice_pdf_url: invoice.invoice_pdf,
          invoice_total: invoice.total ? invoice.total / 100 : null,
        };
        break;

      default:
        logStep("Unhandled event type", { type: event.type });
        return new Response(JSON.stringify({ received: true, handled: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        });
    }

    // Update quote
    if (Object.keys(updateData).length > 0) {
      const { error: updateError } = await supabaseClient
        .from('quotes')
        .update(updateData)
        .eq('id', quote.id);

      if (updateError) {
        logStep("Error updating quote", { error: updateError });
      } else {
        logStep("Quote updated", updateData);
      }
    }

    // Create billing event
    await supabaseClient.from('billing_events').insert({
      quote_id: quote.id,
      stripe_quote_id: quote.stripe_quote_id,
      stripe_invoice_id: invoice.id,
      event_type: eventType,
      metadata: {
        stripe_event_id: event.id,
        invoice_status: invoice.status,
        amount_paid: invoice.amount_paid,
        amount_due: invoice.amount_due,
      },
    });

    logStep("Billing event created", { eventType });

    return new Response(JSON.stringify({ received: true, handled: true }), {
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
