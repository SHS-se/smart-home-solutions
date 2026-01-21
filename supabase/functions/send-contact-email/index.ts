import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { SMTPClient } from "https://esm.sh/emailjs@4.0.3";

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

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { name, email, phone, message }: ContactEmailRequest = await req.json();

    const smtpPort = parseInt(Deno.env.get("SMTP_PORT") || "587");
    
    // Create SMTP client using emailjs
    const client = new SMTPClient({
      user: Deno.env.get("SMTP_USER"),
      password: Deno.env.get("SMTP_PASS"),
      host: Deno.env.get("SMTP_HOST"),
      port: smtpPort,
      ssl: smtpPort === 465,
      tls: smtpPort === 587,
    });

    // Send email via SMTP
    const emailMessage = await client.sendAsync({
      from: `Smart Home Solutions <noreply@smarthomesolutions.se>`,
      "reply-to": email,
      to: "sales@smarthomesolutions.se",
      subject: `Nytt kontaktformulär: ${name}`,
      attachment: [
        {
          data: `
            <h2>Nytt meddelande från kontaktformuläret</h2>
            <p><strong>Namn:</strong> ${name}</p>
            <p><strong>E-post:</strong> ${email}</p>
            <p><strong>Telefon:</strong> ${phone || 'Ej angiven'}</p>
            <hr />
            <h3>Meddelande:</h3>
            <p>${message.replace(/\n/g, '<br>')}</p>
          `,
          alternative: true
        }
      ]
    });

    console.log("Email sent successfully via SMTP:", emailMessage);

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
