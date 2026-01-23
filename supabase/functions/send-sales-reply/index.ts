import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface SendReplyRequest {
  contact_id: string;
  message: string;
}

// HTML escape to prevent XSS in email content
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify the user is authenticated and is staff
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Check if user is staff
    const { data: staffUser, error: staffError } = await supabase
      .from("staff_users")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (staffError || !staffUser) {
      return new Response(
        JSON.stringify({ error: "Staff access required" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const { contact_id, message }: SendReplyRequest = await req.json();

    if (!contact_id || !message?.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing contact_id or message" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Fetch the contact
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id, name, email, email_token")
      .eq("id", contact_id)
      .single();

    if (contactError || !contact) {
      console.error("Error fetching contact:", contactError);
      return new Response(
        JSON.stringify({ error: "Contact not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Send email to the lead
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return new Response(
        JSON.stringify({ error: "Email service not configured" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const safeName = escapeHtml(contact.name);
    const safeMessage = escapeHtml(message.trim()).replace(/\n/g, "<br>");

    const htmlBody = `
      <p>Hej ${safeName},</p>
      <p>${safeMessage}</p>
      <hr />
      <p style="font-size: 12px; color: #666;">
        Svara på detta mail för att fortsätta konversationen.
      </p>
    `;

    const replyToAddress = `sales+${contact.email_token}@mail.smarthomesolutions.se`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <replyonly@mail.smarthomesolutions.se>",
        to: [contact.email],
        reply_to: replyToAddress,
        subject: `Svar: Kontaktförfrågan`,
        html: htmlBody,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Resend API error:", errorData);
      return new Response(
        JSON.stringify({ error: "Failed to send email" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const emailResponse = await response.json();
    console.log("Email sent to lead:", emailResponse);

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );

  } catch (error: any) {
    console.error("Error in send-sales-reply:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
