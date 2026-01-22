import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
};

interface ResendInboundEmail {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    content: string;
    content_type: string;
  }>;
}

// Verify Resend webhook signature using Svix
async function verifyWebhookSignature(
  payload: string,
  headers: Headers
): Promise<boolean> {
  const signingSecret = Deno.env.get("RESEND_SIGNING_SECRET");
  
  if (!signingSecret) {
    console.warn("RESEND_SIGNING_SECRET not configured, skipping verification");
    return true; // Allow in development
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

// Extract email token from To address: support+TOKEN@mail.smarthomesolutions.se
function extractEmailToken(toAddress: string): string | null {
  const match = toAddress.match(/support\+([a-f0-9]+)@/i);
  return match ? match[1] : null;
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

    // Parse the webhook payload (already read as text for signature verification)
    const payload: ResendInboundEmail = JSON.parse(rawBody);
    
    console.log("Received inbound email:", {
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
    });

    // Extract the email token from the To address
    const emailToken = extractEmailToken(payload.to);
    
    if (!emailToken) {
      console.error("No valid email token found in To address:", payload.to);
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

    // Extract and clean the email body
    let emailBody = payload.text || (payload.html ? extractTextFromHtml(payload.html) : "");
    emailBody = cleanEmailBody(emailBody);

    if (!emailBody) {
      console.error("Empty email body");
      return new Response(
        JSON.stringify({ error: "Empty email body" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Extract sender email
    const fromMatch = payload.from.match(/<([^>]+)>/) || [null, payload.from];
    const senderEmail = fromMatch[1] || payload.from;

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

    // Handle attachments if present
    if (payload.attachments && payload.attachments.length > 0) {
      console.log(`Processing ${payload.attachments.length} attachments`);
      
      for (const attachment of payload.attachments) {
        try {
          // Decode base64 attachment content
          const binaryContent = Uint8Array.from(atob(attachment.content), c => c.charCodeAt(0));
          
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
