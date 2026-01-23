import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  website?: string; // Honeypot field - should always be empty
}

interface RateLimitRecord {
  request_count: number;
  window_start: string;
}

// Rate limiting configuration
const RATE_LIMIT = 5; // Max requests per window
const RATE_WINDOW_MINUTES = 60; // 1 hour window

// HTML escape to prevent XSS in email content
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Get client IP from request headers
function getClientIP(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() 
    || req.headers.get('x-real-ip') 
    || 'unknown';
}

// Check and update rate limit using database
async function checkRateLimit(
  supabase: SupabaseClient,
  identifier: string,
  endpoint: string
): Promise<{ allowed: boolean; remaining: number }> {
  const windowStart = new Date(Date.now() - RATE_WINDOW_MINUTES * 60 * 1000).toISOString();
  
  // Get current rate limit record
  const { data: existing, error: selectError } = await supabase
    .from('rate_limits')
    .select('request_count, window_start')
    .eq('identifier', identifier)
    .eq('endpoint', endpoint)
    .single();
  
  if (selectError && selectError.code !== 'PGRST116') {
    // PGRST116 = no rows found, which is fine
    console.error('Rate limit check error:', selectError);
    // Allow request on error to avoid blocking legitimate users
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  
  const now = new Date().toISOString();
  const record = existing as RateLimitRecord | null;
  
  if (record) {
    // Check if window has expired
    if (new Date(record.window_start) < new Date(windowStart)) {
      // Window expired, reset counter
      await supabase
        .from('rate_limits')
        .update({ request_count: 1, window_start: now })
        .eq('identifier', identifier)
        .eq('endpoint', endpoint);
      
      return { allowed: true, remaining: RATE_LIMIT - 1 };
    }
    
    // Window still active, check count
    if (record.request_count >= RATE_LIMIT) {
      return { allowed: false, remaining: 0 };
    }
    
    // Increment counter
    await supabase
      .from('rate_limits')
      .update({ request_count: record.request_count + 1 })
      .eq('identifier', identifier)
      .eq('endpoint', endpoint);
    
    return { allowed: true, remaining: RATE_LIMIT - record.request_count - 1 };
  } else {
    // No existing record, create new one
    await supabase
      .from('rate_limits')
      .insert({ identifier, endpoint, request_count: 1, window_start: now });
    
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Initialize Supabase client with service role for database operations
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error("Missing Supabase environment variables");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
  
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  try {
    const clientIP = getClientIP(req);
    
    // Check rate limit before processing
    const { allowed, remaining } = await checkRateLimit(supabase, clientIP, 'contact_form');
    
    if (!allowed) {
      console.log(`Rate limit exceeded for IP: ${clientIP}`);
      return new Response(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        { 
          status: 429, 
          headers: { 
            "Content-Type": "application/json",
            "X-RateLimit-Remaining": "0",
            "Retry-After": String(RATE_WINDOW_MINUTES * 60),
            ...corsHeaders 
          } 
        }
      );
    }

    const { name, email, phone, message, website }: ContactEmailRequest = await req.json();

    // Honeypot check - if website field is filled, it's likely a bot
    if (website && website.trim() !== '') {
      console.log(`Honeypot triggered from IP: ${clientIP}`);
      // Return success to not reveal the honeypot mechanism
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    
    // Server-side validation
    if (!name || name.trim().length === 0 || name.length > 100) {
      return new Response(
        JSON.stringify({ error: "Invalid name" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
      return new Response(
        JSON.stringify({ error: "Invalid email" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    if (!message || message.trim().length < 10 || message.length > 5000) {
      return new Response(
        JSON.stringify({ error: "Invalid message" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    if (phone && phone.length > 20) {
      return new Response(
        JSON.stringify({ error: "Invalid phone" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    // Insert contact into database and get the created record with email_token
    const { data: newContact, error: insertError } = await supabase
      .from("contacts")
      .insert({
        name: name.trim(),
        email: email.trim(),
        phone: phone?.trim() || null,
        message: message.trim(),
      })
      .select("id, email_token")
      .single();
    
    if (insertError || !newContact) {
      console.error("Error inserting contact:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to save contact" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    console.log("Contact saved to database:", newContact.id);

    // Store the initial form message in contact_messages
    const { error: messageError } = await supabase
      .from("contact_messages")
      .insert({
        contact_id: newContact.id,
        body: message.trim(),
        author_type: "lead",
        author_email: email.trim(),
        source: "form",
      });

    if (messageError) {
      console.error("Error inserting initial message:", messageError);
      // Continue anyway - the contact was saved
    } else {
      console.log("Initial message saved to contact_messages");
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      throw new Error("Missing RESEND_API_KEY. Please configure backend secrets.");
    }

    const toAddress = Deno.env.get("CONTACT_TO") || "sales@smarthomesolutions.se";

    // Sanitize all user inputs to prevent HTML injection / XSS
    const safeName = escapeHtml(name.trim());
    const safeEmail = escapeHtml(email.trim());
    const safePhone = escapeHtml(phone?.trim() || "Ej angiven");
    const safeMessage = escapeHtml(message.trim()).replace(/\n/g, "<br>");

    const htmlBody = `
      <h2>Nytt meddelande från kontaktformuläret</h2>
      <p><strong>Namn:</strong> ${safeName}</p>
      <p><strong>E-post:</strong> ${safeEmail}</p>
      <p><strong>Telefon:</strong> ${safePhone}</p>
      <hr />
      <h3>Meddelande:</h3>
      <p>${safeMessage}</p>
    `;

    // Use tokenized Reply-To for bidirectional email sync
    const replyToAddress = `sales+${newContact.email_token}@mail.smarthomesolutions.se`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <noreply@mail.smarthomesolutions.se>",
        to: [toAddress],
        reply_to: replyToAddress,
        subject: `Kontaktförfrågan: ${safeName}`,
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
      headers: { 
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
        ...corsHeaders 
      },
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
