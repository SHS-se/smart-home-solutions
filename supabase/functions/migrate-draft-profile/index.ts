import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  try {
    // Verify user from Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user?.email) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const email = user.email.toLowerCase().trim();

    // Fetch draft answers for this email
    const { data: drafts, error: draftsError } = await supabase
      .from("home_profile_draft_answers")
      .select("question_id, answer_text")
      .eq("email", email);

    if (draftsError) {
      console.error("Error fetching drafts:", draftsError);
      return new Response(JSON.stringify({ error: "Failed to fetch drafts" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const hasDrafts = drafts && drafts.length > 0;

    // Look up or create customer linked to this user (always, even without drafts)
    let customerId: string | null = null;

    // Check if customer already linked by user_id
    const { data: existingCustomer } = await supabase
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingCustomer) {
      customerId = existingCustomer.id;
    } else {
      // Try to find customer by contact email match (auto-link)
      const { data: contactMatch } = await supabase
        .from("contacts")
        .select("id, converted_to_customer_id")
        .ilike("email", email)
        .maybeSingle();

      if (contactMatch?.converted_to_customer_id) {
        // Link existing customer to this user
        const { error: linkError } = await supabase
          .from("customers")
          .update({ user_id: user.id })
          .eq("id", contactMatch.converted_to_customer_id);

        if (!linkError) {
          customerId = contactMatch.converted_to_customer_id;
        }
      }

      // If still no customer, create one with the contact
      if (!customerId) {
        // Find or use existing contact
        let contactId: string | null = null;
        if (contactMatch) {
          contactId = contactMatch.id;
        }

        const { data: newCustomer, error: createError } = await supabase
          .from("customers")
          .insert({
            user_id: user.id,
            contact_id: contactId,
          })
          .select("id")
          .single();

        if (createError) {
          console.error("Error creating customer:", createError);
          return new Response(JSON.stringify({ error: "Failed to create customer" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        customerId = newCustomer.id;
      }
    }

    // Upsert draft answers into home_answers (only if there are drafts)
    if (hasDrafts) {
      const upserts = drafts.map(d => ({
        customer_id: customerId!,
        question_id: d.question_id,
        answer_text: d.answer_text,
        updated_by: user.id,
      }));

      const { error: upsertError } = await supabase
        .from("home_answers")
        .upsert(upserts, { onConflict: "customer_id,question_id" });

      if (upsertError) {
        console.error("Error upserting answers:", upsertError);
        return new Response(JSON.stringify({ error: "Failed to migrate answers" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Delete draft rows
      const { error: deleteError } = await supabase
        .from("home_profile_draft_answers")
        .delete()
        .eq("email", email);

      if (deleteError) {
        console.error("Error deleting drafts:", deleteError);
      }
    }

    const migratedCount = hasDrafts ? drafts.length : 0;
    console.log(`Migrated ${migratedCount} draft answers for ${email} to customer ${customerId}`);

    return new Response(JSON.stringify({ success: true, migrated: migratedCount }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Unhandled error in migrate-draft-profile:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
