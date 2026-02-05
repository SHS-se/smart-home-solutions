import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getStripeSecretKey, getAppEnvironment } from "../_shared/stripe-env.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const appEnv = getAppEnvironment();
    const stripeKey = getStripeSecretKey();
    console.log(`[VOID-NEW-INVOICE] Running in ${appEnv} mode`);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    const { data: userData } = await supabaseClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!userData.user) throw new Error("User not authenticated");

    const { data: staffData } = await supabaseClient.from('staff_users').select('user_id').eq('user_id', userData.user.id).single();
    if (!staffData) throw new Error("Access denied: Staff only");

    const { invoice_id, reason } = await req.json();
    if (!invoice_id) throw new Error("invoice_id is required");

    const { data: invoice } = await supabaseClient.from('invoices').select('*').eq('id', invoice_id).single();
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status === 'paid') throw new Error("Cannot void a paid invoice");
    if (invoice.status === 'void') return new Response(JSON.stringify({ success: true, status: 'void', message: 'Already voided' }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    if (invoice.stripe_invoice_id) {
      const stripeInvoice = await stripe.invoices.retrieve(invoice.stripe_invoice_id);
      if (stripeInvoice.status === 'draft') await stripe.invoices.del(invoice.stripe_invoice_id);
      else if (stripeInvoice.status !== 'void' && stripeInvoice.status !== 'paid') await stripe.invoices.voidInvoice(invoice.stripe_invoice_id);
    }

    await supabaseClient.from('invoices').update({ status: 'void', hosted_invoice_url: null, voided_at: new Date().toISOString() }).eq('id', invoice_id);
    await supabaseClient.from('invoice_events').insert({ invoice_id, event_type: 'invoice_voided', metadata: { reason, previous_status: invoice.status }, created_by: userData.user.id });

    return new Response(JSON.stringify({ success: true, status: 'void' }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[VOID-NEW-INVOICE] ERROR:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
  }
});
