import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
};

// Resend webhook payload wraps email metadata in a 'data' property
// Note: Webhooks do NOT include email body - we must fetch it via API
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
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    content_disposition?: string;
    content_id?: string;
  }>;
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
  // Receiving endpoints require an API key that has Receiving permissions.
  // Prefer a dedicated least-privilege key if configured.
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
      console.error(
        "Failed to fetch email content:",
        response.status,
        errorText
      );
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching email content:", error);
    return null;
  }
}

// Fetch attachment content from Resend API
async function fetchAttachmentContent(
  emailId: string,
  attachmentId: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const resendApiKey =
    Deno.env.get("RESEND_RECEIVING_API_KEY") || Deno.env.get("RESEND_API_KEY");
  
  if (!resendApiKey) {
    return null;
  }

  try {
    const response = await fetch(
      `https://api.resend.com/emails/receiving/${emailId}/attachments/${attachmentId}`,
      {
      method: "GET",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
      },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to fetch attachment:", response.status, errorText);
      return null;
    }

    // API returns metadata + signed download_url.
    // We fetch the actual bytes via download_url to avoid large JSON payloads.
    const meta = await response.json();
    if (!meta?.download_url) {
      console.error("Attachment response missing download_url");
      return null;
    }

    const downloadResp = await fetch(meta.download_url);
    if (!downloadResp.ok) {
      const downloadErr = await downloadResp.text();
      console.error(
        "Failed downloading attachment:",
        downloadResp.status,
        downloadErr
      );
      return null;
    }

    return {
      bytes: new Uint8Array(await downloadResp.arrayBuffer()),
      contentType: meta.content_type,
    };
  } catch (error) {
    console.error("Error fetching attachment:", error);
    return null;
  }
}

// Extract email token from To address: support+TOKEN@mail.smarthomesolutions.se
function extractEmailToken(toAddresses: string[]): string | null {
  for (const addr of toAddresses) {
    const match = addr.match(/support\+([a-f0-9]+)@/i);
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

    // Parse the webhook payload - contains metadata only, not email body
    const webhookPayload: ResendWebhookPayload = JSON.parse(rawBody);
    const metadata = webhookPayload.data;
    
    if (!metadata || !metadata.email_id) {
      console.error("No email metadata in webhook payload");
      return new Response(
        JSON.stringify({ error: "Invalid webhook payload" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    console.log("Received inbound email webhook:", {
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

    // Find the ticket by email_token
    const { data: ticket, error: ticketError } = await supabase
      .from("tickets")
      .select("id, customer_id, status, title")
      .eq("email_token", emailToken)
      .maybeSingle();

    if (ticketError) {
      console.error("Error fetching ticket:", ticketError);
      return new Response(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (!ticket) {
      console.error("No ticket found for email token:", emailToken);
      return new Response(
        JSON.stringify({ error: "Ticket not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    console.log("Found ticket:", ticket.id, ticket.title);

    // Fetch the actual email content from Resend API
    const emailContent = await fetchEmailContent(metadata.email_id);

    if (!emailContent) {
      console.error("Failed to fetch email content for:", metadata.email_id);
      // Most common cause: the API key is restricted to sending only.
      return new Response(
        JSON.stringify({
          error:
            "Receiving email content is not configured. Ensure your email provider API key allows Receiving permissions.",
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
    const senderEmail = fromMatch[1] || metadata.from;

    // Create a comment on the ticket
    const { data: comment, error: commentError } = await supabase
      .from("ticket_comments")
      .insert({
        ticket_id: ticket.id,
        body_markdown: emailBody,
        author_type: "customer",
        author_email: senderEmail,
        source: "email",
      })
      .select()
      .single();

    if (commentError) {
      console.error("Error creating comment:", commentError);
      return new Response(
        JSON.stringify({ error: "Failed to create comment" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    console.log("Created comment:", comment.id);

    // Update ticket status to awaiting_response (if not already closed)
    if (ticket.status !== "closed") {
      const { error: updateError } = await supabase
        .from("tickets")
        .update({
          status: "awaiting_response",
          last_activity_at: new Date().toISOString(),
        })
        .eq("id", ticket.id);

      if (updateError) {
        console.error("Error updating ticket status:", updateError);
      } else {
        console.log("Updated ticket status to awaiting_response");
      }
    }

    // Handle attachments if present - fetch content from Resend API
    if (metadata.attachments && metadata.attachments.length > 0) {
      console.log(`Processing ${metadata.attachments.length} attachments`);
      
      for (const attachment of metadata.attachments) {
        try {
          // Fetch attachment content from Resend API
          const attachmentData = await fetchAttachmentContent(metadata.email_id, attachment.id);
          
          if (!attachmentData) {
            console.error("Failed to fetch attachment:", attachment.filename);
            continue;
          }

          const binaryContent = attachmentData.bytes;
          
          // Create storage path
          const storagePath = `customer/${ticket.customer_id}/ticket/${ticket.id}/${Date.now()}-${attachment.filename}`;
          
          // Upload to storage
          const { error: uploadError } = await supabase.storage
            .from("ticket-attachments")
            .upload(storagePath, binaryContent, {
              contentType: attachment.content_type,
            });

          if (uploadError) {
            console.error("Error uploading attachment:", uploadError);
            continue;
          }

          // Create attachment record
          await supabase
            .from("ticket_attachments")
            .insert({
              ticket_id: ticket.id,
              comment_id: comment.id,
              filename: attachment.filename,
              storage_path: storagePath,
              content_type: attachment.content_type,
              size_bytes: binaryContent.length,
            });

          console.log("Saved attachment:", attachment.filename);
        } catch (attachError) {
          console.error("Error processing attachment:", attachError);
        }
      }
    }

    // Trigger notification to staff
    try {
      await supabase.functions.invoke("ticket-notification", {
        body: {
          ticketId: ticket.id,
          action: "comment",
          commentId: comment.id,
        },
      });
      console.log("Notification triggered");
    } catch (notifyError) {
      console.error("Error triggering notification:", notifyError);
    }

    return new Response(
      JSON.stringify({ success: true, commentId: comment.id }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );

  } catch (error: any) {
    console.error("Error in inbound-email-webhook:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
