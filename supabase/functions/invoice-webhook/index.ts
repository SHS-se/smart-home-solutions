import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { crypto } from "https://deno.land/std@0.190.0/crypto/mod.ts";
import { getAppEnvironment } from "../_shared/stripe-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[INVOICE-WEBHOOK] ${step}${detailsStr}`);
};

// Manual signature verification for Deno compatibility
async function verifyStripeSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const parts = signature.split(",");
  let timestamp = "";
  let sig = "";
  
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") timestamp = value;
    if (key === "v1") sig = value;
  }
  
  if (!timestamp || !sig) return false;
  
  // Check timestamp is within tolerance (5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;
  
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );
  
  const expectedSig = Array.from(new Uint8Array(signatureBytes))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  
  return sig === expectedSig;
}

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

    // Helper to get the appropriate Stripe key based on livemode
    const getStripeKey = (livemode: boolean): string => {
      if (!livemode) {
        const testKey = Deno.env.get("STRIPE_SECRET_KEY");
        if (!testKey) throw new Error("STRIPE_SECRET_KEY (test) is not set");
        return testKey;
      } else {
        const liveKey = Deno.env.get("STRIPE_SECRET_KEY_LIVE");
        if (!liveKey) throw new Error("STRIPE_SECRET_KEY_LIVE is not set");
        return liveKey;
      }
    };

    // Get raw body for signature verification
    const body = await req.text();
    let event: Stripe.Event;

    const webhookSecret = Deno.env.get("STRIPE_INVOICE_WEBHOOK_SECRET");
    const signature = req.headers.get("stripe-signature");

    if (webhookSecret && signature) {
      const isValid = await verifyStripeSignature(body, signature, webhookSecret);
      if (!isValid) {
        logStep("Webhook signature verification failed");
        return new Response(JSON.stringify({ error: "Webhook signature verification failed" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
      logStep("Webhook signature verified");
      event = JSON.parse(body);
    } else {
      event = JSON.parse(body);
      logStep("Processing webhook without signature verification");
    }

    const stripeInvoice = event.data.object as Stripe.Invoice;
    
    // Determine if this is a live or test event based on Stripe's livemode flag
    const livemode = event.livemode ?? false;
    logStep("Processing event", { type: event.type, invoiceId: stripeInvoice.id, livemode });

    // Find the invoice by stripe_invoice_id in the new invoices table
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .select('id, customer_id')
      .eq('stripe_invoice_id', stripeInvoice.id)
      .single();

    if (invoiceError || !invoice) {
      logStep("Invoice not found in invoices table", { invoiceId: stripeInvoice.id });
      // Return 200 to acknowledge receipt - invoice might not be from our system
      return new Response(JSON.stringify({ received: true, matched: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    logStep("Invoice found", { invoiceId: invoice.id });

    let eventType = '';
    let updateData: Record<string, unknown> = {};

    // Note: subtotal, tax, total columns have been removed from invoices table
    // Totals are now computed via invoice_computed_totals view from line items
    switch (event.type) {
      case 'invoice.paid':
        eventType = 'invoice_paid';
        updateData = {
          status: 'paid',
          paid_at: new Date().toISOString(),
        };
        break;

      case 'invoice.voided':
        eventType = 'invoice_voided';
        updateData = {
          status: 'void',
          voided_at: new Date().toISOString(),
          hosted_invoice_url: null,
        };
        break;

      case 'invoice.uncollectible':
        eventType = 'invoice_uncollectible';
        updateData = {
          status: 'uncollectible',
        };
        break;

      case 'invoice.created':
        eventType = 'invoice_created';
        updateData = {
          status: stripeInvoice.status || 'draft',
          invoice_number: stripeInvoice.number,
          due_date: stripeInvoice.due_date ? new Date(stripeInvoice.due_date * 1000).toISOString() : null,
        };
        break;

      case 'invoice.finalized':
        eventType = 'invoice_finalized';
        updateData = {
          status: stripeInvoice.status || 'open',
          hosted_invoice_url: stripeInvoice.hosted_invoice_url,
          invoice_pdf_url: stripeInvoice.invoice_pdf,
          invoice_number: stripeInvoice.number,
          finalized_at: new Date().toISOString(),
        };
        break;

      case 'invoice.updated':
        eventType = 'invoice_updated';
        updateData = {
          status: stripeInvoice.status,
          hosted_invoice_url: stripeInvoice.hosted_invoice_url,
          invoice_pdf_url: stripeInvoice.invoice_pdf,
        };
        break;

      default:
        logStep("Unhandled event type", { type: event.type });
        return new Response(JSON.stringify({ received: true, handled: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        });
    }

    // Update invoice
    if (Object.keys(updateData).length > 0) {
      updateData.updated_at = new Date().toISOString();
      
      const { error: updateError } = await supabaseClient
        .from('invoices')
        .update(updateData)
        .eq('id', invoice.id);

      if (updateError) {
        logStep("Error updating invoice", { error: updateError });
      } else {
        logStep("Invoice updated", updateData);
      }
    }

    // Create invoice event
    await supabaseClient.from('invoice_events').insert({
      invoice_id: invoice.id,
      event_type: eventType,
      metadata: {
        stripe_event_id: event.id,
        stripe_invoice_id: stripeInvoice.id,
        invoice_status: stripeInvoice.status,
        amount_paid: stripeInvoice.amount_paid,
        amount_due: stripeInvoice.amount_due,
      },
    });

    logStep("Invoice event created", { eventType });

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
