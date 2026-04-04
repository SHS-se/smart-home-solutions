import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { getRequestAppOrigin } from "../_shared/app-origin.ts";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { buildInvoicePaymentDetails } from "../_shared/invoice-document.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[SEND-INVOICE-EMAIL] ${step}${detailsStr}`);
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
    logStep("Staff verified");

    // Accept either quote_id or invoice_id — resolve to the invoice
    const body = await req.json();
    const { quote_id, invoice_id: directInvoiceId, to, subject: customSubject, message: customMessage } = body;

    let invoice;
    if (directInvoiceId) {
      const { data, error } = await serviceClient
        .from('invoices')
        .select('*, customer:customers_with_identity!invoices_customer_id_fkey(name, contact_email, billing_email)')
        .eq('id', directInvoiceId)
        .single();
      if (error || !data) throw new Error("Invoice not found");
      invoice = data;
    } else if (quote_id) {
      const { data, error } = await serviceClient
        .from('invoices')
        .select('*, customer:customers_with_identity!invoices_customer_id_fkey(name, contact_email, billing_email)')
        .eq('quote_id', quote_id)
        .single();
      if (error || !data) throw new Error("No invoice found for this quote");
      invoice = data;
    } else {
      throw new Error("Either invoice_id or quote_id is required");
    }

    if (invoice.status === 'draft') throw new Error("Cannot email draft invoices — finalize first");
    logStep("Invoice loaded", { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number });

    const customer = (invoice as any).customer;
    const recipientEmail = to || customer?.billing_email || customer?.contact_email;
    if (!recipientEmail) throw new Error("No recipient email address available");
    const customerName = customer?.name || "Kund";

    const appOrigin = getRequestAppOrigin(req);

    // Generate public access token (same pattern as send-quote-email)
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const tokenHex = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const tokenHash = await hashToken(tokenHex);
    const tokenExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days

    const previousTokenState = {
      public_token_hash: invoice.public_token_hash ?? null,
      public_token_expires_at: invoice.public_token_expires_at ?? null,
    };

    // Store the new token first so the emailed link becomes valid.
    // If email delivery fails we restore the previous token state below.
    const { error: tokenUpdateError } = await serviceClient.from('invoices').update({
      public_token_hash: tokenHash,
      public_token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    }).eq('id', invoice.id);
    if (tokenUpdateError) {
      throw new Error(`Failed to prepare public invoice link: ${tokenUpdateError.message}`);
    }

    const viewUrl = `${appOrigin}/portal/invoice/${invoice.id}?token=${tokenHex}`;

    // Get computed totals
    const { data: totals } = await serviceClient
      .from('invoice_computed_totals')
      .select('*')
      .eq('invoice_id', invoice.id)
      .single();

    const total = Number(totals?.total ?? 0);
    const dueDate = invoice.due_date
      ? new Date(invoice.due_date).toLocaleDateString("sv-SE")
      : "—";

    const emailSubject = customSubject || `Faktura ${invoice.invoice_number} från Smart Home Solutions`;
    const invoiceNumber = invoice.invoice_number || invoice.id;
    const paymentDetails = await buildInvoicePaymentDetails({
      invoiceNumber,
      amount: total,
      dueDate: invoice.due_date,
      currency: invoice.currency,
    });

    // Build email HTML
    const htmlBody = `<!DOCTYPE html>
<html lang="sv">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background-color:#1a1a2e;padding:32px 24px;text-align:center;">
  <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Smart Home Solutions</h1>
  <p style="margin:8px 0 0;color:#a0a0b8;font-size:14px;">Faktura ${invoiceNumber}</p>
</td></tr>
<tr><td style="padding:32px 24px 16px;">
  <p style="margin:0;font-size:16px;color:#1a1a2e;">Hej ${customerName},</p>
  <p style="margin:12px 0 0;font-size:15px;color:#4a4a68;line-height:1.5;">${customMessage || 'Här kommer din faktura. Klicka på knappen nedan för att se fakturan och betalningsinformation.'}</p>
</td></tr>
<tr><td style="padding:8px 24px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f8fc;border-radius:8px;border:1px solid #e8e8ef;">
  <tr><td style="padding:12px 16px 4px;font-size:14px;color:#4a4a68;">Fakturanummer</td><td style="padding:12px 16px 4px;font-size:14px;color:#1a1a2e;text-align:right;font-weight:500;">${invoiceNumber}</td></tr>
  <tr><td style="padding:4px 16px;font-size:14px;color:#4a4a68;">Förfallodatum</td><td style="padding:4px 16px;font-size:14px;color:#1a1a2e;text-align:right;font-weight:500;">${dueDate}</td></tr>
  <tr><td colspan="2" style="padding:8px 16px 0;"><hr style="border:none;border-top:1px solid #e0e0e8;margin:0;"></td></tr>
  <tr><td style="padding:12px 16px;font-size:18px;color:#1a1a2e;font-weight:700;">Att betala</td><td style="padding:12px 16px;font-size:18px;color:#1a1a2e;text-align:right;font-weight:700;">${formatSEK(total)}</td></tr>
</table>
</td></tr>
<tr><td style="padding:0 24px 24px;">
  <a href="${viewUrl}" target="_blank" style="display:block;background-color:#3b82f6;color:#ffffff;text-decoration:none;text-align:center;padding:16px;border-radius:8px;font-size:16px;font-weight:600;line-height:1;">Visa faktura</a>
</td></tr>
<tr><td style="padding:24px;border-top:1px solid #e8e8ef;">
  <p style="margin:0;font-size:13px;color:#8a8aa0;text-align:center;line-height:1.5;">
    Har du frågor? Kontakta oss på<br>
    <a href="mailto:support@smarthomesolutions.se" style="color:#3b82f6;text-decoration:none;">support@smarthomesolutions.se</a>
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

    const textBody = `Faktura ${invoiceNumber} från Smart Home Solutions\n\nHej ${customerName},\n\n${customMessage || 'Här kommer din faktura.'}\n\nFakturanummer: ${invoiceNumber}\nFörfallodatum: ${dueDate}\nAtt betala: ${formatSEK(total)}\nBankgiro: ${paymentDetails.bankgiro_number || 'Ej konfigurerat'}\nBetalningsreferens: ${paymentDetails.payment_reference || invoiceNumber}\n\nVisa faktura: ${viewUrl}\n\nFrågor? Kontakta oss: support@smarthomesolutions.se\n`;

    let emailResult;
    try {
      const resend = new Resend(resendApiKey);
      emailResult = await resend.emails.send({
        from: "Smart Home Solutions <faktura@mail.smarthomesolutions.se>",
        to: [recipientEmail],
        subject: emailSubject,
        html: htmlBody,
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
    logStep("Email sent", { emailId: emailResult.data?.id, to: recipientEmail });

    const sentAt = new Date().toISOString();
    await serviceClient.from('invoices').update({
      sent_at: sentAt,
      last_emailed_at: sentAt,
      last_emailed_to: recipientEmail,
      last_emailed_type: 'invoice',
      updated_at: sentAt,
    }).eq('id', invoice.id);

    // Create invoice event
    await serviceClient.from('invoice_events').insert({
      invoice_id: invoice.id,
      event_type: 'email_sent',
      metadata: {
        to: recipientEmail,
        subject: emailSubject,
        email_id: emailResult.data?.id,
        public_url: viewUrl,
      },
      created_by: userData.user.id,
    });

    // Also log billing event if this was a quote-origin invoice
    if (invoice.quote_id) {
      await serviceClient.from('billing_events').insert({
        quote_id: invoice.quote_id,
        event_type: 'invoice_emailed',
        metadata: {
          to: recipientEmail,
          subject: emailSubject,
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
        },
        created_by: userData.user.id,
      });
    }

    logStep("Done");

    return new Response(JSON.stringify({
      success: true,
      email_id: emailResult.data?.id,
      public_url: viewUrl,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
