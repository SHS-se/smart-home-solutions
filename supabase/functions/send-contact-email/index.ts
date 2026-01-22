import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ContactEmailRequest {
  name: string;
  email: string;
  phone?: string;
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
    const { name, email, phone, message }: ContactEmailRequest = await req.json();

    // Initialize Supabase client with service role for database insert
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      console.error("Missing Supabase environment variables");
    } else {
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
      
      // Insert contact into database
      const { error: insertError } = await supabase.from("contacts").insert({
        name,
        email,
        phone: phone || null,
        message,
      });
      
      if (insertError) {
        console.error("Error inserting contact:", insertError);
      } else {
        console.log("Contact saved to database successfully");
      }
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      throw new Error("Missing RESEND_API_KEY. Please configure backend secrets.");
    }

    const toAddress = Deno.env.get("CONTACT_TO") || "sales@smarthomesolutions.se";

    // Sanitize all user inputs to prevent HTML injection / XSS
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone || "Ej angiven");
    const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");

    const htmlBody = `
      <h2>Nytt meddelande från kontaktformuläret</h2>
      <p><strong>Namn:</strong> ${safeName}</p>
      <p><strong>E-post:</strong> ${safeEmail}</p>
      <p><strong>Telefon:</strong> ${safePhone}</p>
      <hr />
      <h3>Meddelande:</h3>
      <p>${safeMessage}</p>
    `;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <noreply@mail.smarthomesolutions.se>",
        to: [toAddress],
        reply_to: email,
        subject: `Nytt kontaktformulär: ${safeName}`,
        html: htmlBody,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Resend API error:", errorData);
      throw new Error(errorData.message || "Failed to send email via Resend");
    }

    const emailResponse = await response.json();
    console.log("Email sent successfully via Resend:", emailResponse);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in send-contact-email function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
