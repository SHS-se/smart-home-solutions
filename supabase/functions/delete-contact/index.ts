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
    // Verify caller is staff
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Check staff role
    const { data: staffRow, error: staffError } = await supabase
      .from("staff_users")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (staffError) {
      throw new Error(`Failed to verify staff access: ${staffError.message}`);
    }

    if (!staffRow) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const { contact_id, mode } = await req.json();
    if (!contact_id) {
      return new Response(JSON.stringify({ error: "contact_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Fetch contact
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id, name, email, phone, converted_to_customer_id")
      .eq("id", contact_id)
      .single();

    if (contactError || !contact) {
      return new Response(JSON.stringify({ error: "Contact not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ── PREVIEW MODE ──
    if (mode === "preview") {
      const [messagesRes, draftAnswersRes, intakeRes] = await Promise.all([
        supabase.from("contact_messages").select("id, body, author_type, created_at").eq("contact_id", contact_id).order("created_at", { ascending: false }),
        supabase.from("home_profile_draft_answers").select("id", { count: "exact", head: true }).eq("email", contact.email.toLowerCase().trim()),
        supabase.from("contact_intake_events").select("id", { count: "exact", head: true }).eq("email_normalized", contact.email.toLowerCase().trim()),
      ]);

      const previewError =
        messagesRes.error ||
        draftAnswersRes.error ||
        intakeRes.error;

      if (previewError) {
        throw new Error(`Failed to load contact delete preview: ${previewError.message}`);
      }

      // Check if there's a linked customer
      let linkedCustomer = null;
      if (contact.converted_to_customer_id) {
        const { data: cust, error: customerError } = await supabase
          .from("customers_with_identity")
          .select("id, name, billing_email")
          .eq("id", contact.converted_to_customer_id)
          .maybeSingle();
        if (customerError) {
          throw new Error(`Failed to load linked customer: ${customerError.message}`);
        }
        linkedCustomer = cust;
      }

      // Check if auth user exists
      const { data: { users }, error: usersError } = await supabase.auth.admin.listUsers();
      if (usersError) {
        throw new Error(`Failed to load auth users: ${usersError.message}`);
      }
      const authUser = users?.find(
        (u) => u.email?.toLowerCase().trim() === contact.email.toLowerCase().trim()
      );

      return new Response(JSON.stringify({
        contact: { name: contact.name, email: contact.email, phone: contact.phone },
        messages: messagesRes.data || [],
        draftAnswerCount: draftAnswersRes.count || 0,
        intakeEventCount: intakeRes.count || 0,
        linkedCustomer,
        hasAuthUser: !!authUser,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ── DELETE MODE ──
    const email = contact.email.toLowerCase().trim();

    // 1. Delete draft answers for this email
    await supabase
      .from("home_profile_draft_answers")
      .delete()
      .eq("email", email);

    // 2. Delete auth user if exists (by email lookup)
    const { data: { users } } = await supabase.auth.admin.listUsers();
    const authUser = users?.find(
      (u) => u.email?.toLowerCase().trim() === email
    );
    if (authUser) {
      await supabase.auth.admin.deleteUser(authUser.id);
    }

    // 3. Unlink any customers referencing this contact (nullify FK)
    await supabase
      .from("customers")
      .update({ contact_id: null })
      .eq("contact_id", contact_id);

    // Also clear converted_to_customer_id on the contact to avoid FK issues
    await supabase
      .from("contacts")
      .update({ converted_to_customer_id: null })
      .eq("id", contact_id);

    // 4. Delete contact messages
    await supabase
      .from("contact_messages")
      .delete()
      .eq("contact_id", contact_id);

    // 5. Delete the contact record
    const { error: deleteError } = await supabase
      .from("contacts")
      .delete()
      .eq("id", contact_id);

    if (deleteError) {
      throw deleteError;
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in delete-contact:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
