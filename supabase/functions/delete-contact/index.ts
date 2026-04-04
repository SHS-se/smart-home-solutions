import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function deleteCustomerCascade(supabase: ReturnType<typeof createClient>, customerId: string) {
  // Get customer info
  const { data: customer } = await supabase
    .from("customers")
    .select("id, user_id, contact_id")
    .eq("id", customerId)
    .single();

  if (!customer) return;

  // Get all linked IDs
  const { data: homes } = await supabase.from("homes").select("id").eq("customer_id", customerId);
  const homeIds = (homes || []).map((h: { id: string }) => h.id);

  const { data: quotes } = await supabase.from("quotes").select("id").eq("customer_id", customerId);
  const quoteIds = (quotes || []).map((q: { id: string }) => q.id);

  const { data: invoices } = await supabase.from("invoices").select("id").eq("customer_id", customerId);
  const invoiceIds = (invoices || []).map((i: { id: string }) => i.id);

  const { data: devices } = await supabase.from("device_instances").select("id").eq("customer_id", customerId);
  const deviceIds = (devices || []).map((d: { id: string }) => d.id);

  // Device profiles and points
  if (deviceIds.length > 0) {
    const { data: profiles } = await supabase.from("device_profiles").select("id").in("device_id", deviceIds);
    const profileIds = (profiles || []).map((p: { id: string }) => p.id);
    if (profileIds.length > 0) {
      await supabase.from("device_profile_points").delete().in("profile_id", profileIds);
      await supabase.from("device_profiles").delete().in("device_id", deviceIds);
    }
  }

  // Home-linked data
  if (homeIds.length > 0) {
    await supabase.from("home_device_assignments").delete().in("home_id", homeIds);
    await supabase.from("energy_home_settings").delete().in("home_id", homeIds);
    await supabase.from("home_answers").delete().in("home_id", homeIds);
    await supabase.from("model_runs").delete().in("home_id", homeIds);
  }

  await supabase.from("device_instances").delete().eq("customer_id", customerId);
  await supabase.from("home_photos").delete().eq("customer_id", customerId);

  // Unlink primary_home_id then delete homes
  await supabase.from("customers").update({ primary_home_id: null }).eq("id", customerId);
  await supabase.from("homes").delete().eq("customer_id", customerId);

  // Quote-related data
  if (quoteIds.length > 0) {
    await supabase.from("quote_events").delete().in("quote_id", quoteIds);
    await supabase.from("quote_emails").delete().in("quote_id", quoteIds);
    await supabase.from("quote_lines").delete().in("quote_id", quoteIds);
    await supabase.from("quote_messages").delete().in("quote_id", quoteIds);
    await supabase.from("billing_events").delete().in("quote_id", quoteIds);
  }

  // Invoice-related data
  if (invoiceIds.length > 0) {
    await supabase.from("invoice_events").delete().in("invoice_id", invoiceIds);
    await supabase.from("invoice_line_items").delete().in("invoice_id", invoiceIds);
    await supabase.from("invoice_payments").delete().in("invoice_id", invoiceIds);
  }

  await supabase.from("invoices").delete().eq("customer_id", customerId);

  // Quotes (unlink self-references first)
  if (quoteIds.length > 0) {
    await supabase.from("quotes").update({
      parent_quote_id: null,
      supersedes_quote_id: null,
      superseded_by_quote_id: null,
    }).in("id", quoteIds);
  }
  await supabase.from("quotes").delete().eq("customer_id", customerId);

  // BOMs
  const { data: boms } = await supabase.from("boms").select("id").eq("customer_id", customerId);
  const bomIds = (boms || []).map((b: { id: string }) => b.id);
  if (bomIds.length > 0) {
    await supabase.from("bom_events").delete().in("bom_id", bomIds);
    await supabase.from("bom_items").delete().in("bom_id", bomIds);
  }
  await supabase.from("boms").delete().eq("customer_id", customerId);

  // Tickets
  await supabase.from("tickets").delete().eq("customer_id", customerId);

  // Unlink contact FK on customer side
  if (customer.contact_id) {
    await supabase.from("customers").update({ contact_id: null }).eq("id", customerId);
  }

  // Delete customer record
  const { error: deleteError } = await supabase.from("customers").delete().eq("id", customerId);
  if (deleteError) throw deleteError;

  // Delete auth user if exists
  if (customer.user_id) {
    await supabase.auth.admin.deleteUser(customer.user_id);
  }
}

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

      const previewError = messagesRes.error || draftAnswersRes.error || intakeRes.error;
      if (previewError) {
        throw new Error(`Failed to load contact delete preview: ${previewError.message}`);
      }

      // Check if there's a linked customer and gather its data
      let linkedCustomer = null;
      let customerData: {
        quotes: unknown[];
        invoices: unknown[];
        tickets: unknown[];
        boms: unknown[];
        homes: unknown[];
        homeAnswerCount: number;
        homePhotoCount: number;
        deviceCount: number;
      } | null = null;

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

        if (linkedCustomer) {
          const cid = linkedCustomer.id;
          const [quotesRes, invoicesRes, ticketsRes, bomsRes, homesRes, answersRes, photosRes, devicesRes] = await Promise.all([
            supabase.from("quotes").select("id, quote_number, status").eq("customer_id", cid),
            supabase.from("invoices").select("id, invoice_number, status").eq("customer_id", cid),
            supabase.from("tickets").select("id, ticket_number, title, status").eq("customer_id", cid),
            supabase.from("boms").select("id, project_name, version").eq("customer_id", cid),
            supabase.from("homes").select("id, name").eq("customer_id", cid),
            supabase.from("home_answers").select("id", { count: "exact", head: true }).eq("customer_id", cid),
            supabase.from("home_photos").select("id", { count: "exact", head: true }).eq("customer_id", cid),
            supabase.from("device_instances").select("id", { count: "exact", head: true }).eq("customer_id", cid),
          ]);

          customerData = {
            quotes: quotesRes.data || [],
            invoices: invoicesRes.data || [],
            tickets: ticketsRes.data || [],
            boms: bomsRes.data || [],
            homes: homesRes.data || [],
            homeAnswerCount: answersRes.count || 0,
            homePhotoCount: photosRes.count || 0,
            deviceCount: devicesRes.count || 0,
          };
        }
      }

      // Check if auth user exists
      const { data: { users }, error: usersError } = await supabase.auth.admin.listUsers();
      if (usersError) {
        throw new Error(`Failed to load auth users: ${usersError.message}`);
      }
      const authUser = users?.find(
        (u: { email?: string }) => u.email?.toLowerCase().trim() === contact.email.toLowerCase().trim()
      );

      return new Response(JSON.stringify({
        contact: { name: contact.name, email: contact.email, phone: contact.phone },
        messages: messagesRes.data || [],
        draftAnswerCount: draftAnswersRes.count || 0,
        intakeEventCount: intakeRes.count || 0,
        linkedCustomer,
        customerData,
        hasAuthUser: !!authUser,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ── DELETE MODE ──
    const email = contact.email.toLowerCase().trim();

    // 1. Delete linked customer (cascade) if exists
    if (contact.converted_to_customer_id) {
      // Clear the FK from contact first to avoid circular issues
      await supabase.from("contacts").update({ converted_to_customer_id: null }).eq("id", contact_id);
      await deleteCustomerCascade(supabase, contact.converted_to_customer_id);
    }

    // 2. Delete draft answers for this email
    await supabase.from("home_profile_draft_answers").delete().eq("email", email);

    // 3. Delete auth user if exists (and wasn't already deleted by customer cascade)
    const { data: { users } } = await supabase.auth.admin.listUsers();
    const authUser = users?.find(
      (u: { email?: string }) => u.email?.toLowerCase().trim() === email
    );
    if (authUser) {
      await supabase.auth.admin.deleteUser(authUser.id);
    }

    // 4. Unlink any customers still referencing this contact
    await supabase.from("customers").update({ contact_id: null }).eq("contact_id", contact_id);

    // 5. Delete contact messages
    await supabase.from("contact_messages").delete().eq("contact_id", contact_id);

    // 6. Delete the contact record
    const { error: deleteError } = await supabase.from("contacts").delete().eq("id", contact_id);
    if (deleteError) throw deleteError;

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error in delete-contact:", error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
