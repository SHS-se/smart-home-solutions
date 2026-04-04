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

    const { customer_id, mode } = await req.json();
    if (!customer_id) {
      return new Response(JSON.stringify({ error: "customer_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ── PREVIEW MODE: return a summary of linked data ──
    if (mode === "preview") {
      const [quotesRes, invoicesRes, ticketsRes, bomsRes, homesRes] = await Promise.all([
        supabase.from("quotes").select("id, quote_number, status, total_inc_vat").eq("customer_id", customer_id),
        supabase.from("invoices").select("id, invoice_number, status, amount").eq("customer_id", customer_id),
        supabase.from("tickets").select("id, ticket_number, title, status").eq("customer_id", customer_id),
        supabase.from("boms").select("id, project_name, version").eq("customer_id", customer_id),
        supabase.from("homes").select("id, name").eq("customer_id", customer_id),
      ]);

      const previewError =
        quotesRes.error ||
        invoicesRes.error ||
        ticketsRes.error ||
        bomsRes.error ||
        homesRes.error;

      if (previewError) {
        throw new Error(`Failed to load customer delete preview: ${previewError.message}`);
      }

      // Get customer identity info
      const { data: customerInfo, error: customerInfoError } = await supabase
        .from("customers_with_identity")
        .select("name, billing_email, contact_id")
        .eq("id", customer_id)
        .maybeSingle();

      if (customerInfoError) {
        throw new Error(`Failed to load customer identity: ${customerInfoError.message}`);
      }

      // Check for linked contact
      let contactInfo = null;
      if (customerInfo?.contact_id) {
        const { data: contact, error: contactError } = await supabase
          .from("contacts")
          .select("id, name, email")
          .eq("id", customerInfo.contact_id)
          .maybeSingle();
        if (contactError) {
          throw new Error(`Failed to load linked contact: ${contactError.message}`);
        }
        contactInfo = contact;
      }

      // Count home-related data
      const homeIds = (homesRes.data || []).map(h => h.id);
      let homeAnswerCount = 0;
      let homePhotoCount = 0;
      let deviceCount = 0;
      if (homeIds.length > 0) {
        const [answersRes, photosRes, devicesRes] = await Promise.all([
          supabase.from("home_answers").select("id", { count: "exact", head: true }).eq("customer_id", customer_id),
          supabase.from("home_photos").select("id", { count: "exact", head: true }).eq("customer_id", customer_id),
          supabase.from("device_instances").select("id", { count: "exact", head: true }).eq("customer_id", customer_id),
        ]);
        const countError =
          answersRes.error ||
          photosRes.error ||
          devicesRes.error;
        if (countError) {
          throw new Error(`Failed to load customer linked data counts: ${countError.message}`);
        }
        homeAnswerCount = answersRes.count || 0;
        homePhotoCount = photosRes.count || 0;
        deviceCount = devicesRes.count || 0;
      }

      return new Response(JSON.stringify({
        customer: customerInfo,
        contact: contactInfo,
        quotes: quotesRes.data || [],
        invoices: invoicesRes.data || [],
        tickets: ticketsRes.data || [],
        boms: bomsRes.data || [],
        homes: homesRes.data || [],
        homeAnswerCount,
        homePhotoCount,
        deviceCount,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ── DELETE MODE: cascade delete all linked data ──

    // 1. Get customer info for auth user cleanup
    const { data: customer } = await supabase
      .from("customers")
      .select("id, user_id, contact_id")
      .eq("id", customer_id)
      .single();

    if (!customer) {
      return new Response(JSON.stringify({ error: "Customer not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 2. Get all home IDs for this customer
    const { data: homes } = await supabase.from("homes").select("id").eq("customer_id", customer_id);
    const homeIds = (homes || []).map(h => h.id);

    // 3. Get all quote IDs for event/email cleanup
    const { data: quotes } = await supabase.from("quotes").select("id").eq("customer_id", customer_id);
    const quoteIds = (quotes || []).map(q => q.id);

    // 4. Get all invoice IDs for event cleanup
    const { data: invoices } = await supabase.from("invoices").select("id").eq("customer_id", customer_id);
    const invoiceIds = (invoices || []).map(i => i.id);

    // 5. Get all device instance IDs for profile cleanup
    const { data: devices } = await supabase.from("device_instances").select("id").eq("customer_id", customer_id);
    const deviceIds = (devices || []).map(d => d.id);

    // 6. Delete in dependency order

    // Device profiles and points
    if (deviceIds.length > 0) {
      const { data: profiles } = await supabase.from("device_profiles").select("id").in("device_id", deviceIds);
      const profileIds = (profiles || []).map(p => p.id);
      if (profileIds.length > 0) {
        await supabase.from("device_profile_points").delete().in("profile_id", profileIds);
        await supabase.from("device_profiles").delete().in("device_id", deviceIds);
      }
    }

    // Home device assignments
    if (homeIds.length > 0) {
      await supabase.from("home_device_assignments").delete().in("home_id", homeIds);
      await supabase.from("energy_home_settings").delete().in("home_id", homeIds);
      await supabase.from("home_answers").delete().in("home_id", homeIds);
      await supabase.from("model_runs").delete().in("home_id", homeIds);
    }

    // Device instances
    await supabase.from("device_instances").delete().eq("customer_id", customer_id);

    // Home photos
    await supabase.from("home_photos").delete().eq("customer_id", customer_id);

    // Homes (after all home-linked data)
    // First unlink primary_home_id from customer
    await supabase.from("customers").update({ primary_home_id: null }).eq("id", customer_id);
    await supabase.from("homes").delete().eq("customer_id", customer_id);

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
    }

    // Invoices (unlink quote references first)
    await supabase.from("invoices").delete().eq("customer_id", customer_id);

    // Quotes (unlink parent/supersede references first)
    if (quoteIds.length > 0) {
      await supabase.from("quotes").update({
        parent_quote_id: null,
        supersedes_quote_id: null,
        superseded_by_quote_id: null,
      }).in("id", quoteIds);
    }
    await supabase.from("quotes").delete().eq("customer_id", customer_id);

    // BOMs
    const { data: boms } = await supabase.from("boms").select("id").eq("customer_id", customer_id);
    const bomIds = (boms || []).map(b => b.id);
    if (bomIds.length > 0) {
      await supabase.from("bom_events").delete().in("bom_id", bomIds);
      await supabase.from("bom_items").delete().in("bom_id", bomIds);
    }
    await supabase.from("boms").delete().eq("customer_id", customer_id);

    // Tickets
    await supabase.from("tickets").delete().eq("customer_id", customer_id);

    // Unlink contact
    if (customer.contact_id) {
      await supabase.from("contacts").update({ converted_to_customer_id: null }).eq("id", customer.contact_id);
      await supabase.from("customers").update({ contact_id: null }).eq("id", customer_id);
    }

    // Delete the customer record
    const { error: deleteError } = await supabase.from("customers").delete().eq("id", customer_id);
    if (deleteError) throw deleteError;

    // Delete auth user if exists
    if (customer.user_id) {
      await supabase.auth.admin.deleteUser(customer.user_id);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in delete-customer:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
