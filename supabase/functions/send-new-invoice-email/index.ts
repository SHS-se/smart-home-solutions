/**
 * Legacy entry point for emailing locally issued invoices that do not come
 * from a quote. Kept for backwards-compatible frontend callers.
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { getRequestAppOrigin } from "../_shared/app-origin.ts";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { buildInvoicePaymentDetails } from "../_shared/invoice-document.ts";
import { loadBusinessSettings } from "../_shared/invoice-company.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[SEND-NEW-INVOICE-EMAIL] ${step}${detailsStr}`);
};

function formatSEK(amount: number): string {
  return new Intl.NumberFormat("sv-SE", { style: "decimal", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(amount)) + " kr";
}

async function hashToken(tokenHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(tokenHex));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const appEnv = getAppEnvironment();
    logStep("Function started", { environment: appEnv });

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) throw new Error("RESEND_API_KEY is not set");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);

    // Verify staff
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !userData.user) throw new Error("Unauthorized");

    const { data: staffCheck } = await serviceClient
      .from("staff_users").select("user_id").eq("user_id", userData.user.id).single();
    if (!staffCheck) throw new Error("Staff access required");

    const { invoice_id, to, subject: customSubject, message: customMessage } = await req.json();
    if (!invoice_id) throw new Error("invoice_id is required");

    // Load invoice with customer
    const { data: invoice, error: invoiceError } = await serviceClient
      .from('invoices')
      .select('*, customer:customers_with_identity!invoices_customer_id_fkey(name, contact_email, billing_email)')
      .eq('id', invoice_id)
      .single();

    if (invoiceError || !invoice) throw new Error("Invoice not found");
    if (invoice.status === 'draft') throw new Error("Cannot email draft invoices — finalize first");

    const customer = (invoice as any).customer;
    const recipientEmail = to || customer?.billing_email || customer?.contact_email;
    if (!recipientEmail) throw new Error("No recipient email address available");
    const customerName = customer?.name || "Kund";

    const appOrigin = getRequestAppOrigin(req);

    // Generate public access token
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const tokenHex = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const tokenHash = await hashToken(tokenHex);
    const tokenExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const previousTokenState = {
      public_token_hash: invoice.public_token_hash ?? null,
      public_token_expires_at: invoice.public_token_expires_at ?? null,
    };

    const { error: tokenUpdateError } = await serviceClient.from('invoices').update({
      public_token_hash: tokenHash,
      public_token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    }).eq('id', invoice.id);
    if (tokenUpdateError) {
      throw new Error(`Failed to prepare public invoice link: ${tokenUpdateError.message}`);
    }

    const viewUrl = `${appOrigin}/portal/invoice/${invoice.id}?token=${tokenHex}`;

    const { data: totals } = await serviceClient
      .from('invoice_computed_totals')
      .select('*')
      .eq('invoice_id', invoice.id)
      .single();

    const total = Number(totals?.total ?? 0);
    const dueDate = invoice.due_date
      ? new Date(invoice.due_date).toLocaleDateString("sv-SE")
      : "—";
    const invoiceNumber = invoice.invoice_number || invoice.id;
    const emailSubject = customSubject || `Faktura ${invoiceNumber} från Smart Home Solutions`;
    const company = await loadBusinessSettings(serviceClient);
    const paymentDetails = await buildInvoicePaymentDetails({
      invoiceNumber,
      amount: total,
      dueDate: invoice.due_date,
      currency: invoice.currency,
      settings: company,
    });

    const textBody = `Faktura ${invoiceNumber} från Smart Home Solutions\n\nHej ${customerName},\n\n${customMessage || 'Här kommer din faktura.'}\n\nFakturanummer: ${invoiceNumber}\nFörfallodatum: ${dueDate}\nAtt betala: ${formatSEK(total)}\nBankgiro: ${paymentDetails.bankgiro_number || 'Ej konfigurerat'}\nBetalningsreferens: ${paymentDetails.payment_reference || invoiceNumber}\n\nVisa faktura: ${viewUrl}\n\nFrågor? Kontakta oss: ${company.supportEmail}\n`;

    let emailResult;
    try {
      const resend = new Resend(resendApiKey);
      emailResult = await resend.emails.send({
        from: "Smart Home Solutions <faktura@mail.smarthomesolutions.se>",
        to: [recipientEmail],
        subject: emailSubject,
        text: textBody,
      });
    } catch (emailError) {
      await serviceClient.from('invoices').update({
        public_token_hash: previousTokenState.public_token_hash,
        public_token_expires_at: previousTokenState.public_token_expires_at,
        updated_at: new Date().toISOString(),
      }).eq('id', invoice.id);
      throw emailError;
    }

    const sentAt = new Date().toISOString();
    await serviceClient.from('invoices').update({
      sent_at: sentAt,
      last_emailed_at: sentAt,
      last_emailed_to: recipientEmail,
      last_emailed_type: 'invoice',
      updated_at: sentAt,
    }).eq('id', invoice_id);

    await serviceClient.from('invoice_events').insert({
      invoice_id,
      event_type: 'email_sent',
      metadata: { to: recipientEmail, subject: emailSubject, email_id: emailResult.data?.id, public_url: viewUrl },
      created_by: userData.user.id,
    });

    return new Response(JSON.stringify({ success: true, email_id: emailResult.data?.id, public_url: viewUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500,
    });
  }
});
