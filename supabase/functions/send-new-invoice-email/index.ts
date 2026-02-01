import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

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
    logStep("Function started");

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) throw new Error("RESEND_API_KEY is not set");

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

    const { 
      invoice_id, 
      to, 
      subject, 
      message,
      include_payment_link = true,
      include_pdf_link = true
    } = await req.json();

    if (!invoice_id) throw new Error("invoice_id is required");
    if (!to) throw new Error("to is required");
    if (!subject) throw new Error("subject is required");
    if (!message) throw new Error("message is required");

    logStep("Sending invoice email", { invoice_id, to });

    // Fetch invoice
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .select('*, customer:customers(org_name, billing_email)')
      .eq('id', invoice_id)
      .single();

    if (invoiceError || !invoice) throw new Error("Invoice not found");
    if (invoice.status === 'draft') throw new Error("Cannot email draft invoices");

    logStep("Invoice loaded", { invoiceNumber: invoice.invoice_number, status: invoice.status });

    // Build email body
    let emailBody = message;

    if (include_payment_link && invoice.hosted_invoice_url) {
      emailBody += `\n\n📋 Betala fakturan: ${invoice.hosted_invoice_url}`;
    }

    if (include_pdf_link && invoice.invoice_pdf_url) {
      emailBody += `\n\n📄 Ladda ner PDF: ${invoice.invoice_pdf_url}`;
    }

    // Send email via Resend
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Smart Home Solutions <faktura@smarthomesolutions.se>',
        to: [to],
        subject: subject,
        text: emailBody
      })
    });

    if (!emailResponse.ok) {
      const errorData = await emailResponse.text();
      throw new Error(`Failed to send email: ${errorData}`);
    }

    const emailResult = await emailResponse.json();
    logStep("Email sent", { emailId: emailResult.id });

    // Update invoice email audit fields
    const { error: updateError } = await supabaseClient
      .from('invoices')
      .update({
        last_emailed_at: new Date().toISOString(),
        last_emailed_to: to,
        last_emailed_type: 'invoice',
        updated_at: new Date().toISOString()
      })
      .eq('id', invoice_id);

    if (updateError) {
      logStep("Error updating invoice email fields", { error: updateError });
    }

    // Create event
    await supabaseClient.from('invoice_events').insert({
      invoice_id,
      event_type: 'email_sent',
      metadata: {
        to,
        subject,
        email_id: emailResult.id,
        include_payment_link,
        include_pdf_link
      },
      created_by: user.id
    });

    logStep("Invoice email complete");

    return new Response(JSON.stringify({
      success: true,
      email_id: emailResult.id
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
