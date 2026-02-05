import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Escape HTML to prevent injection in email templates
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

interface NotificationRequest {
  ticketId: string;
  action: "created" | "comment";
  commentId?: string;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { ticketId, action, commentId }: NotificationRequest = await req.json();

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      console.log("RESEND_API_KEY not configured, skipping notification");
      return new Response(JSON.stringify({ success: true, skipped: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch ticket
    const { data: ticket, error: ticketError } = await supabase
      .from("tickets")
      .select("*, customers:customers_with_identity!tickets_customer_id_fkey(name, contact_email)")
      .eq("id", ticketId)
      .single();

    if (ticketError || !ticket) {
      throw new Error("Ticket not found");
    }

    const ticketNumber = ticket.ticket_number || `TKT-${ticketId.split('-')[0].toUpperCase().slice(0, 5)}`;

    let comment = null;
    if (commentId) {
      const { data } = await supabase
        .from("ticket_comments")
        .select("*")
        .eq("id", commentId)
        .single();
      comment = data;
    }

    const portalUrl = Deno.env.get("PORTAL_URL") || "https://smarthomesolutions.lovable.app";
    const ticketUrl = `${portalUrl}/portal/tickets/${ticketNumber}`;
    const replyTo = `support+${ticket.email_token}@mail.smarthomesolutions.se`;

    // Determine recipient
    let toEmail: string;
    let subject: string;
    let isStaffNotification = false;

    if (action === "created") {
      // New ticket - notify staff
      toEmail = Deno.env.get("SUPPORT_TO") || "support@smarthomesolutions.se";
      // Use simple subject for staff emails to improve email threading
      subject = `[${ticketNumber}] ${ticket.title}`;
      isStaffNotification = true;
    } else if (comment?.author_type === "staff") {
      // Staff replied - notify customer
      toEmail = ticket.customers?.contact_email || "";
      subject = `[${ticketNumber}] Re: ${ticket.title}`;
    } else {
      // Customer replied - notify staff
      toEmail = Deno.env.get("SUPPORT_TO") || "support@smarthomesolutions.se";
      // Use simple subject for staff emails to improve email threading
      subject = `[${ticketNumber}] ${ticket.title}`;
      isStaffNotification = true;
    }

    if (!toEmail) {
      console.log("No recipient email, skipping notification");
      return new Response(JSON.stringify({ success: true, skipped: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const statusLabels: Record<string, string> = {
      submitted: "Open",
      awaiting_response: "Awaiting response",
      awaiting_customer: "Awaiting customer",
      closed: "Closed",
    };
    const statusLabel = statusLabels[ticket.status as string] || ticket.status;

    const htmlBody = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2D5F8D;">${escapeHtml(subject)}</h2>
        <p><strong>Ticket ID:</strong> ${escapeHtml(ticketNumber)}</p>
        <p><strong>Title:</strong> ${escapeHtml(ticket.title)}</p>
        <p><strong>Status:</strong> ${escapeHtml(statusLabel)}</p>
        <p><strong>Customer:</strong> ${escapeHtml(ticket.customers?.name || "N/A")}</p>
        <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 20px 0;" />
        ${comment ? `
          <h3>Latest message:</h3>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 8px;">
            <p style="white-space: pre-wrap;">${escapeHtml(comment.body_markdown)}</p>
          </div>
        ` : ""}
        <p style="margin-top: 20px;">
          <a href="${ticketUrl}" style="background: #2D5F8D; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
            View Ticket
          </a>
        </p>
        <p style="color: #666; font-size: 12px; margin-top: 20px;">
          Reply to this email to add a comment to the ticket.
        </p>
      </div>
    `;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <replyonly@mail.smarthomesolutions.se>",
        to: [toEmail],
        reply_to: replyTo,
        subject,
        html: htmlBody,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Resend API error:", errorData);
      throw new Error(errorData.message || "Failed to send email");
    }

    const emailResponse = await response.json();
    console.log("Notification sent:", emailResponse);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in ticket-notification:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
};

serve(handler);
