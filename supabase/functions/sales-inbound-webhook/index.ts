import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
};

// Resend webhook payload wraps email metadata in a 'data' property
interface ResendWebhookPayload {
  type: string;
  created_at: string;
  data: ResendEmailMetadata;
}

interface ResendEmailMetadata {
  email_id: string;
  from: string;
  to: string[];
  subject: string;
  cc?: string[];
  bcc?: string[];
  message_id?: string;
}

// Email content fetched from Resend API
interface ResendEmailContent {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
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

// Verify Resend webhook signature using Svix
async function verifyWebhookSignature(
  payload: string,
  headers: Headers
): Promise<boolean> {
  const signingSecret = Deno.env.get("RESEND_SIGNING_SECRET");
  
  if (!signingSecret) {
    console.error("RESEND_SIGNING_SECRET not configured - rejecting request for security");
    return false;
  }

  const svixId = headers.get("svix-id");
  const svixTimestamp = headers.get("svix-timestamp");
  const svixSignature = headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    console.error("Missing Svix headers");
    return false;
  }

  // Check timestamp is within 5 minutes
  const timestamp = parseInt(svixTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    console.error("Webhook timestamp too old");
    return false;
  }

  // Verify signature
  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
  
  // Extract the secret (remove "whsec_" prefix if present)
  const secretBytes = signingSecret.startsWith("whsec_")
    ? Uint8Array.from(atob(signingSecret.slice(6)), c => c.charCodeAt(0))
    : new TextEncoder().encode(signingSecret);

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedContent)
  );

  const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

  // Svix signature header can contain multiple signatures (v1,signature v1,signature2)
  const signatures = svixSignature.split(" ");
  for (const sig of signatures) {
    const [version, signature] = sig.split(",");
    if (version === "v1" && signature === expectedSignature) {
      return true;
    }
  }

  console.error("Webhook signature verification failed");
  return false;
}

// Fetch email content from Resend API
async function fetchEmailContent(emailId: string): Promise<ResendEmailContent | null> {
  const resendApiKey =
    Deno.env.get("RESEND_RECEIVING_API_KEY") || Deno.env.get("RESEND_API_KEY");
  
  if (!resendApiKey) {
    console.error("RESEND_API_KEY not configured");
    return null;
  }

  try {
    const response = await fetch(
      `https://api.resend.com/emails/receiving/${emailId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to fetch email content:", response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching email content:", error);
    return null;
  }
}

// Extract email token from To address: sales+TOKEN@mail.smarthomesolutions.se
function extractEmailToken(toAddresses: string[]): string | null {
  for (const addr of toAddresses) {
    const match = addr.match(/sales\+([a-f0-9]+)@/i);
    if (match) {
      return match[1];
    }
  }
  return null;
}

// Extract plain text from HTML if no text version available
function extractTextFromHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

// Clean up email reply by removing quoted content
function cleanEmailBody(text: string): string {
  const lines = text.split('\n');
  const cleanedLines: string[] = [];
  
  for (const line of lines) {
    if (
      line.match(/^On .+ wrote:$/i) ||
      line.match(/^-{3,}\s*Original Message/i) ||
      line.match(/^>{2,}/) ||
      line.match(/^From:\s+/i) && cleanedLines.length > 0 ||
      line.match(/^Sent:\s+/i) ||
      line.match(/^>?\s*Den \d+.*skrev.*:$/i)
    ) {
      break;
    }
    
    if (!line.startsWith('>')) {
      cleanedLines.push(line);
    }
  }
  
  return cleanedLines.join('\n').trim();
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Read the raw body for signature verification
    const rawBody = await req.text();
    
    // Verify webhook signature
    const isValid = await verifyWebhookSignature(rawBody, req.headers);
    if (!isValid) {
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse the webhook payload
    const webhookPayload: ResendWebhookPayload = JSON.parse(rawBody);
    const metadata = webhookPayload.data;
    
    if (!metadata || !metadata.email_id) {
      console.error("No email metadata in webhook payload");
      return new Response(
        JSON.stringify({ error: "Invalid webhook payload" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    console.log("Received sales inbound email webhook:", {
      emailId: metadata.email_id,
      from: metadata.from,
      to: metadata.to,
      subject: metadata.subject,
    });

    // Extract the email token from the To addresses
    const emailToken = extractEmailToken(metadata.to);
    
    if (!emailToken) {
      console.error("No valid email token found in To addresses:", metadata.to);
      return new Response(
        JSON.stringify({ error: "Invalid recipient address" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    console.log("Extracted email token:", emailToken);

    // Find the contact by email_token
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id, name, email, email_token")
      .eq("email_token", emailToken)
      .maybeSingle();

    if (contactError) {
      console.error("Error fetching contact:", contactError);
      return new Response(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (!contact) {
      console.error("No contact found for email token:", emailToken);
      return new Response(
        JSON.stringify({ error: "Contact not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    console.log("Found contact:", contact.id, contact.name);

    // Fetch the actual email content from Resend API
    const emailContent = await fetchEmailContent(metadata.email_id);

    if (!emailContent) {
      console.error("Failed to fetch email content for:", metadata.email_id);
      return new Response(
        JSON.stringify({
          error: "Receiving email content is not configured. Ensure your email provider API key allows Receiving permissions.",
        }),
        { status: 503, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Extract and clean the email body
    let emailBody = emailContent.text || (emailContent.html ? extractTextFromHtml(emailContent.html) : "");
    emailBody = cleanEmailBody(emailBody);

    if (!emailBody) {
      console.error("Empty email body after processing");
      return new Response(
        JSON.stringify({ error: "Empty email body" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Extract sender email
    const fromMatch = metadata.from.match(/<([^>]+)>/) || [null, metadata.from];
    const senderEmail = (fromMatch[1] || metadata.from).toLowerCase().trim();

    // Determine author type based on sender email
    const isFromLead = senderEmail === contact.email.toLowerCase().trim();
    const authorType = isFromLead ? "lead" : "staff";

    console.log(`Sender: ${senderEmail}, Contact email: ${contact.email}, Author type: ${authorType}`);

    // Store the message in contact_messages
    const { data: message, error: messageError } = await supabase
      .from("contact_messages")
      .insert({
        contact_id: contact.id,
        body: emailBody,
        author_type: authorType,
        author_email: senderEmail,
        source: "email",
      })
      .select()
      .single();

    if (messageError) {
      console.error("Error creating message:", messageError);
      return new Response(
        JSON.stringify({ error: "Failed to create message" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    console.log("Created contact message:", message.id);

    // Send notification to the "other party"
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      console.error("RESEND_API_KEY not configured for sending notifications");
    } else {
      // Determine recipient
      const notifyEmail = isFromLead
        ? (Deno.env.get("CONTACT_TO") || "sales@smarthomesolutions.se")
        : contact.email;

      // Build notification email
      const safeName = escapeHtml(contact.name);
      const safeBody = escapeHtml(emailBody).replace(/\n/g, "<br>");
      const senderLabel = isFromLead ? safeName : "Staff";

      const htmlBody = `
        <h2>${isFromLead ? "Nytt svar från lead" : "Svar skickat till lead"}: ${safeName}</h2>
        <p><strong>Från:</strong> ${escapeHtml(senderEmail)}</p>
        <hr />
        <h3>Meddelande:</h3>
        <p>${safeBody}</p>
      `;

      const subject = isFromLead
        ? `Svar från ${contact.name}: Kontaktförfrågan`
        : `Svar till ${contact.name}: Kontaktförfrågan`;

      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "Smart Home Solutions <noreply@mail.smarthomesolutions.se>",
            to: [notifyEmail],
            reply_to: `sales+${contact.email_token}@mail.smarthomesolutions.se`,
            subject: subject,
            html: htmlBody,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          console.error("Failed to send notification email:", errorData);
        } else {
          console.log(`Notification sent to ${notifyEmail}`);
        }
      } catch (emailError) {
        console.error("Error sending notification email:", emailError);
      }
    }

    return new Response(
      JSON.stringify({ success: true, messageId: message.id }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );

  } catch (error: any) {
    console.error("Error in sales-inbound-webhook:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
