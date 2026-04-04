import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { getRequestAppOrigin } from "../_shared/app-origin.ts";
import { getAppEnvironment } from "../_shared/app-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[SEND-QUOTE-EMAIL] ${step}${detailsStr}`);
};

function formatSEK(amount: number): string {
  return new Intl.NumberFormat("sv-SE", { style: "decimal", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(amount)) + " kr";
}

function buildQuoteEmailHtml(params: {
  customerName: string;
  quoteNumber: string;
  hardwareTotal: number;
  laborTotal: number;
  travelTotal: number;
  subtotalExVat: number;
  vatTotal: number;
  totalIncVat: number;
  expiresAt: string;
  viewUrl: string;
}): string {
  const { customerName, quoteNumber, hardwareTotal, laborTotal, travelTotal, subtotalExVat, vatTotal, totalIncVat, expiresAt, viewUrl } = params;
  const expiryDate = new Date(expiresAt).toLocaleDateString("sv-SE");

  return `<!DOCTYPE html>
<html lang="sv">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;">

<!-- Header -->
<tr><td style="background-color:#1a1a2e;padding:32px 24px;text-align:center;">
  <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Smart Home Solutions</h1>
  <p style="margin:8px 0 0;color:#a0a0b8;font-size:14px;">Offert ${quoteNumber}</p>
</td></tr>

<!-- Greeting -->
<tr><td style="padding:32px 24px 16px;">
  <p style="margin:0;font-size:16px;color:#1a1a2e;">Hej ${customerName},</p>
  <p style="margin:12px 0 0;font-size:15px;color:#4a4a68;line-height:1.5;">Vi har tagit fram en offert åt dig. Klicka på knappen nedan för att se hela offerten och godkänna den.</p>
</td></tr>

<!-- Summary Box -->
<tr><td style="padding:8px 24px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f8fc;border-radius:8px;border:1px solid #e8e8ef;">
  ${hardwareTotal > 0 ? `<tr><td style="padding:12px 16px 4px;font-size:14px;color:#4a4a68;">Hårdvara</td><td style="padding:12px 16px 4px;font-size:14px;color:#1a1a2e;text-align:right;font-weight:500;">${formatSEK(hardwareTotal)}</td></tr>` : ""}
  ${laborTotal > 0 ? `<tr><td style="padding:4px 16px;font-size:14px;color:#4a4a68;">Arbete</td><td style="padding:4px 16px;font-size:14px;color:#1a1a2e;text-align:right;font-weight:500;">${formatSEK(laborTotal)}</td></tr>` : ""}
  ${travelTotal > 0 ? `<tr><td style="padding:4px 16px;font-size:14px;color:#4a4a68;">Resa &amp; övrigt</td><td style="padding:4px 16px;font-size:14px;color:#1a1a2e;text-align:right;font-weight:500;">${formatSEK(travelTotal)}</td></tr>` : ""}
  <tr><td colspan="2" style="padding:8px 16px 0;"><hr style="border:none;border-top:1px solid #e0e0e8;margin:0;"></td></tr>
  <tr><td style="padding:8px 16px 4px;font-size:14px;color:#4a4a68;">Summa exkl. moms</td><td style="padding:8px 16px 4px;font-size:14px;color:#1a1a2e;text-align:right;">${formatSEK(subtotalExVat)}</td></tr>
  <tr><td style="padding:4px 16px;font-size:14px;color:#4a4a68;">Moms</td><td style="padding:4px 16px;font-size:14px;color:#1a1a2e;text-align:right;">${formatSEK(vatTotal)}</td></tr>
  <tr><td colspan="2" style="padding:8px 16px 0;"><hr style="border:none;border-top:1px solid #e0e0e8;margin:0;"></td></tr>
  <tr><td style="padding:12px 16px;font-size:18px;color:#1a1a2e;font-weight:700;">Totalt inkl. moms</td><td style="padding:12px 16px;font-size:18px;color:#1a1a2e;text-align:right;font-weight:700;">${formatSEK(totalIncVat)}</td></tr>
</table>
</td></tr>

<!-- CTA Button -->
<tr><td style="padding:0 24px 24px;">
  <a href="${viewUrl}" target="_blank" style="display:block;background-color:#3b82f6;color:#ffffff;text-decoration:none;text-align:center;padding:16px;border-radius:8px;font-size:16px;font-weight:600;line-height:1;">Visa offert</a>
</td></tr>

<!-- Expiry -->
<tr><td style="padding:0 24px 24px;">
  <p style="margin:0;font-size:13px;color:#8a8aa0;text-align:center;">Offerten är giltig till ${expiryDate}</p>
</td></tr>

<!-- Footer -->
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
}

function buildPlainText(params: {
  customerName: string;
  quoteNumber: string;
  hardwareTotal: number;
  laborTotal: number;
  travelTotal: number;
  subtotalExVat: number;
  vatTotal: number;
  totalIncVat: number;
  expiresAt: string;
  viewUrl: string;
}): string {
  const { customerName, quoteNumber, hardwareTotal, laborTotal, travelTotal, subtotalExVat, vatTotal, totalIncVat, expiresAt, viewUrl } = params;
  const expiryDate = new Date(expiresAt).toLocaleDateString("sv-SE");
  let text = `Offert ${quoteNumber} från Smart Home Solutions\n\nHej ${customerName},\n\nVi har tagit fram en offert åt dig.\n\n`;
  if (hardwareTotal > 0) text += `Hårdvara: ${formatSEK(hardwareTotal)}\n`;
  if (laborTotal > 0) text += `Arbete: ${formatSEK(laborTotal)}\n`;
  if (travelTotal > 0) text += `Resa & övrigt: ${formatSEK(travelTotal)}\n`;
  text += `\nSumma exkl. moms: ${formatSEK(subtotalExVat)}\nMoms: ${formatSEK(vatTotal)}\nTotalt inkl. moms: ${formatSEK(totalIncVat)}\n`;
  text += `\nVisa offert: ${viewUrl}\n\nOfferten är giltig till ${expiryDate}\n\nFrågor? Kontakta oss: support@smarthomesolutions.se\n`;
  return text;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const appEnv = getAppEnvironment();
    logStep("Function started", { environment: appEnv });

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

    const { quote_id, expires_in_days } = await req.json();
    if (!quote_id) throw new Error("quote_id is required");
    const validityDays = typeof expires_in_days === "number" && expires_in_days >= 1 ? expires_in_days : 7;

    // Load quote with customer info
    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("*, customers_with_identity!quotes_customer_id_fkey(name, contact_email)")
      .eq("id", quote_id)
      .single();

    if (quoteError || !quote) throw new Error("Quote not found");
    logStep("Quote loaded", { quoteId: quote.id, status: quote.status });

    const customer = (quote as any).customers_with_identity;
    if (!customer?.contact_email) throw new Error("Customer has no email address");
    const customerName = customer.name || "Kund";
    const customerEmail = customer.contact_email;
    const appOrigin = getRequestAppOrigin(req);

    // Get totals from the computed view
    const { data: totals } = await serviceClient
      .from("quote_computed_totals")
      .select("*")
      .eq("quote_id", quote_id)
      .single();

    const hardwareTotal = totals?.hardware_total || 0;
    const laborTotal = totals?.labor_total || 0;
    const travelTotal = totals?.travel_total || 0;
    const subtotalExVat = totals?.subtotal_ex_vat || 0;
    const vatTotal = totals?.vat_total || 0;
    const totalIncVat = totals?.total_inc_vat || 0;

    // Quote number is auto-assigned on insert via database trigger
    const quoteNumber = quote.quote_number;
    if (!quoteNumber) throw new Error("Quote has no quote_number — this should not happen");

    // Generate token: 32 random bytes
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const tokenHex = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, "0")).join("");

    // Hash the token
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(tokenHex));
    const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

    const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString();
    // Token expiry: 30 days (longer than quote validity to allow viewing after expiry)
    const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Build customer-facing links from the shared frontend URL config.
    const viewUrl = `${appOrigin}/portal/quote/${quote_id}?token=${tokenHex}`;

    // Build email
    const emailParams = {
      customerName,
      quoteNumber,
      hardwareTotal,
      laborTotal,
      travelTotal,
      subtotalExVat,
      vatTotal,
      totalIncVat,
      expiresAt,
      viewUrl,
    };

    const htmlBody = buildQuoteEmailHtml(emailParams);
    const textBody = buildPlainText(emailParams);
    const subject = `Offert ${quoteNumber} från Smart Home Solutions`;

    // Send via Resend
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) throw new Error("RESEND_API_KEY not configured");
    const resend = new Resend(resendApiKey);

    const emailResult = await resend.emails.send({
      from: "Smart Home Solutions <offert@mail.smarthomesolutions.se>",
      to: [customerEmail],
      subject,
      html: htmlBody,
      text: textBody,
    });
    logStep("Email sent", { emailId: emailResult.data?.id, to: customerEmail });

    // Update quote
    const { error: updateError } = await serviceClient
      .from("quotes")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        expires_at: expiresAt,
        accept_token_hash: hashHex,
        accept_token_expires_at: tokenExpiresAt,
      })
      .eq("id", quote_id);

    if (updateError) logStep("Warning: failed to update quote", { error: updateError });

    // Log event
    await serviceClient.from("quote_events").insert({
      quote_id,
      event_type: "sent",
      actor_type: "staff",
      actor_email: userData.user.email,
      metadata: { recipient_email: customerEmail, quote_number: quoteNumber },
    });

    // Store email record
    await serviceClient.from("quote_emails").insert({
      quote_id,
      email_type: "quote_sent",
      recipient_email: customerEmail,
      subject,
      body: htmlBody,
      sent_by: userData.user.id,
    });

    logStep("Done");

    return new Response(JSON.stringify({
      success: true,
      quote_number: quoteNumber,
      recipient_email: customerEmail,
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
