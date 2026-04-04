import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const appEnv = getAppEnvironment();
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
    if (invoice.status === 'void') {
      return new Response(JSON.stringify({ success: true, status: 'void', message: 'Already voided' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    // Void locally — if still draft, just mark void; if open, also void
    await supabaseClient.from('invoices').update({
      status: 'void',
      voided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', invoice_id);

    await supabaseClient.from('invoice_events').insert({
      invoice_id,
      event_type: 'invoice_voided',
      metadata: { reason, previous_status: invoice.status },
      created_by: userData.user.id,
    });

    return new Response(JSON.stringify({ success: true, status: 'void' }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[VOID-NEW-INVOICE] ERROR:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500,
    });
  }
});
