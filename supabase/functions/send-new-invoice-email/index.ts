import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { getStripeSecretKey, getAppEnvironment } from "../_shared/stripe-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[SEND-NEW-INVOICE-EMAIL] ${step}${detailsStr}`);
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
    const appEnv = getAppEnvironment();
    const stripeKey = getStripeSecretKey();
    logStep("Function started", { environment: appEnv });

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) throw new Error("RESEND_API_KEY is not set");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    const { data: staffData } = await supabaseClient.from('staff_users').select('user_id').eq('user_id', user.id).single();
    if (!staffData) throw new Error("Access denied: Staff only");
    logStep("Staff verified");

    const { invoice_id, to, subject, message, include_payment_link = true, attach_pdf = false } = await req.json();
    if (!invoice_id || !to || !subject || !message) throw new Error("Missing required fields");

    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .select('*, customer:customers_with_identity!invoices_customer_id_fkey(name, contact_email)')
      .eq('id', invoice_id)
      .single();

    if (invoiceError || !invoice) throw new Error("Invoice not found");
    if (invoice.status === 'draft') throw new Error("Cannot email draft invoices");

    let emailBody = message;
    if (include_payment_link && invoice.hosted_invoice_url) {
      emailBody += `\n\n📋 Betala fakturan: ${invoice.hosted_invoice_url}`;
    }

    const attachments: Array<{ filename: string; content: string }> = [];
    
    if (attach_pdf && invoice.stripe_invoice_id) {
      const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
      const stripeInvoice = await stripe.invoices.retrieve(invoice.stripe_invoice_id);
      
      if (stripeInvoice.invoice_pdf) {
        const pdfResponse = await fetch(stripeInvoice.invoice_pdf);
        if (pdfResponse.ok) {
          const pdfBuffer = await pdfResponse.arrayBuffer();
          const pdfBase64 = btoa(String.fromCharCode(...new Uint8Array(pdfBuffer)));
          attachments.push({ filename: `Faktura-${invoice.invoice_number || invoice.id}.pdf`, content: pdfBase64 });
        }
      }
    }

    const emailPayload: Record<string, unknown> = {
      from: 'Smart Home Solutions <faktura@mail.smarthomesolutions.se>',
      to: [to],
      subject,
      text: emailBody,
    };
    if (attachments.length > 0) emailPayload.attachments = attachments;

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload)
    });

    if (!emailResponse.ok) throw new Error(`Failed to send email: ${await emailResponse.text()}`);
    const emailResult = await emailResponse.json();

    await supabaseClient.from('invoices').update({ last_emailed_at: new Date().toISOString(), last_emailed_to: to, last_emailed_type: 'invoice' }).eq('id', invoice_id);
    await supabaseClient.from('invoice_events').insert({ invoice_id, event_type: 'email_sent', metadata: { to, subject, email_id: emailResult.id }, created_by: user.id });

    return new Response(JSON.stringify({ success: true, email_id: emailResult.id }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
  }
});
