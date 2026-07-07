// Manual staff trigger for quote expiry. Scheduled expiry runs in Postgres
// via pg_cron (public.expire_due_quotes()); this endpoint just lets staff
// force a run without waiting for the next tick.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaff } from "../_shared/staff-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const auth = await requireStaff(req, corsHeaders);
    if (auth instanceof Response) return auth;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Find quotes that should be expired:
    // - expires_at is in the past
    // - status is one of the active non-terminal statuses
    // - NOT draft (drafts are safe from auto-expiry)
    const { data: expiredQuotes, error: selectError } = await supabase
      .from("quotes")
      .select("id")
      .not("expires_at", "is", null)
      .lt("expires_at", new Date().toISOString())
      .in("status", ["sent", "viewed", "revision_requested"]);

    if (selectError) {
      console.error("Error selecting quotes to expire:", selectError);
      return new Response(
        JSON.stringify({ error: selectError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!expiredQuotes || expiredQuotes.length === 0) {
      console.log("No quotes to expire");
      return new Response(
        JSON.stringify({ expired_count: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const quoteIds = expiredQuotes.map((q) => q.id);

    const { error: updateError } = await supabase
      .from("quotes")
      .update({
        status: "expired",
        status_reason: "auto_expired",
      })
      .in("id", quoteIds);

    if (updateError) {
      console.error("Error updating quotes:", updateError);
      return new Response(
        JSON.stringify({ error: updateError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log expiry events
    const events = quoteIds.map((qId) => ({
      quote_id: qId,
      event_type: "expired",
      actor_type: "system",
      metadata: { reason: "auto_expired" },
    }));

    await supabase.from("quote_events").insert(events);

    console.log(`Expired ${quoteIds.length} quotes: ${quoteIds.join(", ")}`);

    return new Response(
      JSON.stringify({ expired_count: quoteIds.length, quote_ids: quoteIds }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
