import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface InviteCustomerRequest {
  customer_id: string;
}

// Escape HTML to prevent injection in email templates
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey || !resendApiKey) {
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  // Verify the caller is staff
  const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!authHeader?.toLowerCase().startsWith("bearer ")) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  const token = authHeader.replace(/^bearer\s+/i, "").trim();
  if (!token) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
  // IMPORTANT: validate the caller JWT using the ANON key (signing-keys compatible).
  const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);

  // Check if caller is staff
  // In edge/runtime there is no persisted session, so pass the token explicitly.
  const { data: { user }, error: userError } = await supabaseAuth.auth.getUser(token);
  if (userError) {
    console.warn("invite-customer: auth.getUser() failed:", userError.message);
  }
  if (!user) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  const { data: staffData } = await supabaseAdmin
    .from("staff_users")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!staffData) {
    return new Response(
      JSON.stringify({ error: "Only staff can invite customers" }),
      { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  try {
    const { customer_id }: InviteCustomerRequest = await req.json();

    if (!customer_id) {
      return new Response(
        JSON.stringify({ error: "Missing customer_id" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Get customer details
    const { data: customer, error: customerError } = await supabaseAdmin
      .from("customers_with_identity")
      .select("id, name, contact_email, user_id")
      .eq("id", customer_id)
      .single();

    if (customerError || !customer) {
      return new Response(
        JSON.stringify({ error: "Customer not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (!customer.contact_email) {
      return new Response(
        JSON.stringify({ error: "Customer has no email set" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (customer.user_id) {
      return new Response(
        JSON.stringify({ error: "Customer already has an account" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Check if user already exists with this email
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(
      (u) => u.email?.toLowerCase() === customer.contact_email?.toLowerCase()
    );

    let userId: string;

    if (existingUser) {
      // User exists, just link them
      userId = existingUser.id;
    } else {
      // Create new user with a random password (they'll reset it)
      const randomPassword = crypto.randomUUID() + crypto.randomUUID();
      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: customer.contact_email,
        password: randomPassword,
        email_confirm: true,
      });

      if (createError) {
        console.error("Error creating user:", createError);
        return new Response(
          JSON.stringify({ error: createError.message || "Failed to create user" }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      userId = newUser.user.id;
    }

    // Link user to customer
    const { error: linkError } = await supabaseAdmin
      .from("customers")
      .update({ user_id: userId })
      .eq("id", customer_id);

    if (linkError) {
      console.error("Error linking user to customer:", linkError);
      return new Response(
        JSON.stringify({ error: "Failed to link user to customer" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Generate password reset link with redirect to our app
    // We need to build a custom URL that points to our app's reset-password page
    const appUrl = "https://smarthomesolutions.lovable.app";
    
    const { data: linkData, error: linkGenError } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: customer.contact_email,
      options: {
        redirectTo: `${appUrl}/reset-password`,
      },
    });

    if (linkGenError || !linkData) {
      console.error("Error generating reset link:", linkGenError);
      return new Response(
        JSON.stringify({ error: "Failed to generate password reset link" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // The generateLink returns a Supabase verify URL. We need to extract the token
    // and build a URL that goes directly to our app with the token in the hash.
    // The action_link format: https://<project>.supabase.co/auth/v1/verify?token=...&type=recovery&redirect_to=...
    const actionLink = linkData.properties?.action_link;
    if (!actionLink) {
      return new Response(
        JSON.stringify({ error: "Failed to generate action link" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Parse the action link to extract the token
    const actionUrl = new URL(actionLink);
    const recoveryToken = actionUrl.searchParams.get("token");
    const tokenType = actionUrl.searchParams.get("type");
    
    if (!recoveryToken) {
      return new Response(
        JSON.stringify({ error: "Failed to extract recovery token" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Build the password reset URL that goes directly to our app
    // Format: https://app.com/reset-password#access_token=...&type=recovery
    // But actually, the verify endpoint needs to be called first to exchange the token.
    // So we'll use the Supabase verify URL but ensure redirect_to is set correctly.
    // The simplest approach: just use the actionLink as-is since we set redirectTo.

    // Send welcome email with password setup link
    const customerName = escapeHtml(customer.name || "Valued Customer");

    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1a1a1a; margin-bottom: 10px;">Welcome to Smart Home Solutions</h1>
        </div>
        
        <p>Hi ${customerName},</p>
        
        <p>Your customer portal account has been created. Click the button below to set your password and access your account:</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${actionLink}" style="background-color: #2D5F8D; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">Set Your Password</a>
        </div>
        
        <p>This link will expire in 24 hours. If you didn't expect this email, you can safely ignore it.</p>
        
        <p>Once you've set your password, you can log in to view your tickets, invoices, and account details.</p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        
        <p style="color: #666; font-size: 14px;">
          Best regards,<br>
          Smart Home Solutions Team
        </p>
      </body>
      </html>
    `;

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <replyonly@mail.smarthomesolutions.se>",
        to: [customer.contact_email],
        subject: "Welcome to the Customer Portal - Set Up Your Account",
        html: htmlBody,
      }),
    });

    if (!emailResponse.ok) {
      const errorData = await emailResponse.json();
      console.error("Resend API error:", errorData);
      // Don't fail the whole operation if email fails - user is still linked
      return new Response(
        JSON.stringify({ 
          success: true, 
          user_id: userId,
          warning: "Account created but email failed to send. Customer may need manual password reset."
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const emailResult = await emailResponse.json();
    console.log("Welcome email sent:", emailResult);

    return new Response(
      JSON.stringify({ success: true, user_id: userId }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in invite-customer:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
