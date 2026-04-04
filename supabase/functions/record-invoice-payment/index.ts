import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[RECORD-INVOICE-PAYMENT] ${step}${detailsStr}`);
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
    logStep("Function started", { environment: appEnv });

    // Authenticate staff user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    const { data: staffData } = await supabaseClient
      .from('staff_users')
      .select('user_id')
      .eq('user_id', user.id)
      .single();

    if (!staffData) throw new Error("Access denied: Staff only");
    logStep("Staff verified");

    const { invoice_id, payment_date, amount, method, reference, note } = await req.json();
    if (!invoice_id) throw new Error("invoice_id is required");
    if (!payment_date) throw new Error("payment_date is required");
    if (amount === undefined || amount === null) throw new Error("amount is required");

    // Fetch invoice
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .select('*')
      .eq('id', invoice_id)
      .single();

    if (invoiceError || !invoice) throw new Error("Invoice not found");
    if (invoice.status === 'void') throw new Error("Cannot record payment on a voided invoice");
    if (invoice.status === 'draft') throw new Error("Cannot record payment on a draft invoice");

    logStep("Invoice loaded", { invoiceId: invoice.id, status: invoice.status });

    // Insert payment record
    const { data: payment, error: paymentError } = await supabaseClient
      .from('invoice_payments')
      .insert({
        invoice_id,
        payment_date,
        amount: parseFloat(amount),
        method: method || 'bankgiro',
        reference: reference || null,
        note: note || null,
        created_by: user.id,
      })
      .select()
      .single();

    if (paymentError) throw new Error(`Failed to record payment: ${paymentError.message}`);
    logStep("Payment recorded", { paymentId: payment.id, amount });

    // Calculate total payments for this invoice
    const { data: allPayments } = await supabaseClient
      .from('invoice_payments')
      .select('amount')
      .eq('invoice_id', invoice_id);

    const totalPaid = (allPayments || []).reduce((sum, p) => sum + parseFloat(String(p.amount)), 0);
    const invoiceTotal = invoice.total || 0;

    logStep("Payment totals", { totalPaid, invoiceTotal });

    // If fully paid, mark invoice as paid
    if (totalPaid >= invoiceTotal) {
      await supabaseClient.from('invoices').update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', invoice_id);
      logStep("Invoice marked as paid");
    }

    // Create invoice event
    await supabaseClient.from('invoice_events').insert({
      invoice_id,
      event_type: 'payment_recorded',
      metadata: {
        payment_id: payment.id,
        amount: parseFloat(amount),
        method: method || 'bankgiro',
        reference,
        total_paid: totalPaid,
        fully_paid: totalPaid >= invoiceTotal,
      },
      created_by: user.id,
    });

    return new Response(JSON.stringify({
      success: true,
      payment_id: payment.id,
      total_paid: totalPaid,
      fully_paid: totalPaid >= invoiceTotal,
      invoice_status: totalPaid >= invoiceTotal ? 'paid' : invoice.status,
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
