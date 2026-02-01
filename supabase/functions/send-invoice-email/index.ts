import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[SEND-INVOICE-EMAIL] ${step}${detailsStr}`);
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

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) throw new Error("RESEND_API_KEY is not set");

    // Authenticate staff user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

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

    const { quote_id, to, subject, body, include_payment_link, include_pdf_link } = await req.json();
    
    if (!quote_id) throw new Error("quote_id is required");
    if (!to) throw new Error("recipient email is required");
    if (!subject) throw new Error("subject is required");
    if (!body) throw new Error("body is required");

    logStep("Processing email", { quote_id, to });

    // Fetch quote with invoice data
    const { data: quote, error: quoteError } = await supabaseClient
      .from('quotes')
      .select('*')
      .eq('id', quote_id)
      .single();

    if (quoteError || !quote) throw new Error("Quote not found");

    // Build email HTML
    let htmlBody = `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        ${body.replace(/\n/g, '<br>')}
    `;

    if (include_payment_link && quote.invoice_hosted_url) {
      htmlBody += `
        <p style="margin-top: 20px;">
          <a href="${quote.invoice_hosted_url}" 
             style="display: inline-block; background-color: #0070f3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
            Betala faktura
          </a>
        </p>
      `;
    }

    if (include_pdf_link && quote.invoice_pdf_url) {
      htmlBody += `
        <p style="margin-top: 10px;">
          <a href="${quote.invoice_pdf_url}" style="color: #0070f3;">
            Ladda ner PDF
          </a>
        </p>
      `;
    }

    htmlBody += `
        <hr style="margin-top: 30px; border: none; border-top: 1px solid #eee;" />
        <p style="font-size: 12px; color: #666;">
          Smart Home Solutions AB<br>
          support@smarthomesolutions.se
        </p>
      </div>
    `;

    // Send email via Resend
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <faktura@mail.smarthomesolutions.se>",
        to: [to],
        subject: subject,
        html: htmlBody,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      logStep("Resend API error", errorData);
      throw new Error(errorData.message || "Failed to send email via Resend");
    }

    const emailResponse = await response.json();
    logStep("Email sent successfully", { id: emailResponse.id });

    // Store email record
    await supabaseClient.from('quote_emails').insert({
      quote_id,
      invoice_id: quote.stripe_invoice_id,
      email_type: 'invoice',
      recipient_email: to,
      subject,
      body,
      sent_by: user.id,
    });

    // Create billing event
    await supabaseClient.from('billing_events').insert({
      quote_id,
      stripe_quote_id: quote.stripe_quote_id,
      stripe_invoice_id: quote.stripe_invoice_id,
      event_type: 'invoice_emailed',
      metadata: { 
        to,
        subject,
        include_payment_link,
        include_pdf_link,
      },
      created_by: user.id,
    });

    logStep("Email record stored");

    return new Response(JSON.stringify({
      success: true,
      email_id: emailResponse.id,
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
