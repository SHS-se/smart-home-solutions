import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getRequestAppOrigin } from "../_shared/app-origin.ts";

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
  website?: string;
  draft_answers?: Array<{ question_id: string; answer_text: string; answer_value?: unknown }>;
}

interface RateLimitRecord {
  request_count: number;
  window_start: string;
}

const RATE_LIMIT = 5;
const RATE_WINDOW_MINUTES = 60;

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function generateSecureCode(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function getClientIP(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
}

async function checkRateLimit(
  supabase: SupabaseClient,
  identifier: string,
  endpoint: string
): Promise<{ allowed: boolean; remaining: number }> {
  const windowStart = new Date(Date.now() - RATE_WINDOW_MINUTES * 60 * 1000).toISOString();

  const { data: existing, error: selectError } = await supabase
    .from('rate_limits')
    .select('request_count, window_start')
    .eq('identifier', identifier)
    .eq('endpoint', endpoint)
    .single();

  if (selectError && selectError.code !== 'PGRST116') {
    console.error('Rate limit check error:', selectError);
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  const now = new Date().toISOString();
  const record = existing as RateLimitRecord | null;

  if (record) {
    if (new Date(record.window_start) < new Date(windowStart)) {
      await supabase
        .from('rate_limits')
        .update({ request_count: 1, window_start: now })
        .eq('identifier', identifier)
        .eq('endpoint', endpoint);
      return { allowed: true, remaining: RATE_LIMIT - 1 };
    }

    if (record.request_count >= RATE_LIMIT) {
      return { allowed: false, remaining: 0 };
    }

    await supabase
      .from('rate_limits')
      .update({ request_count: record.request_count + 1 })
      .eq('identifier', identifier)
      .eq('endpoint', endpoint);
    return { allowed: true, remaining: RATE_LIMIT - record.request_count - 1 };
  } else {
    await supabase
      .from('rate_limits')
      .insert({ identifier, endpoint, request_count: 1, window_start: now });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
}

async function logIntakeEvent(
  supabase: SupabaseClient,
  data: {
    email: string;
    emailNormalized: string;
    name: string;
    phone?: string | null;
    payload: Record<string, unknown>;
    result: 'saved' | 'duplicate' | 'save_failed';
    matchedEntityType?: string | null;
    matchedEntityId?: string | null;
    error?: Record<string, unknown> | null;
  }
) {
  try {
    await supabase.from('contact_intake_events').insert({
      email: data.email,
      email_normalized: data.emailNormalized,
      name: data.name,
      phone: data.phone ?? null,
      payload: data.payload,
      result: data.result,
      matched_entity_type: data.matchedEntityType ?? null,
      matched_entity_id: data.matchedEntityId ?? null,
      error: data.error ?? null,
      source: 'website_contact_form',
    });
  } catch (err) {
    console.error('Failed to log intake event:', err);
  }
}

async function sendSalesEmail(
  resendApiKey: string,
  toAddress: string,
  subject: string,
  htmlBody: string
) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <replyonly@mail.smarthomesolutions.se>",
        to: [toAddress],
        subject,
        html: htmlBody,
      }),
    });
    if (!res.ok) {
      const errData = await res.json();
      console.error("Resend API error (sales notification):", errData);
    }
  } catch (err) {
    console.error("Failed to send sales notification email:", err);
  }
}

function buildDuplicateEmailHtml(
  submitted: { name: string; email: string; phone?: string; message: string },
  existingContactId: string,
  isCustomer: boolean,
  customerId?: string | null
): string {
  const ts = new Date().toISOString();
  const safeName = escapeHtml(submitted.name);
  const safeEmail = escapeHtml(submitted.email);
  const safePhone = escapeHtml(submitted.phone || 'Not provided');
  const safeMessage = escapeHtml(submitted.message).replace(/\n/g, '<br>');

  return `
    <h2>Contact form: duplicate detected</h2>
    <p>Someone submitted the contact form with an email that already exists in the system.</p>
    <hr />
    <h3>Submitted details</h3>
    <p><strong>Name:</strong> ${safeName}</p>
    <p><strong>Email:</strong> ${safeEmail}</p>
    <p><strong>Phone:</strong> ${safePhone}</p>
    <h3>Message:</h3>
    <p>${safeMessage}</p>
    <hr />
    <h3>Matched record</h3>
    <p><strong>Existing contact ID:</strong> ${escapeHtml(existingContactId)}</p>
    <p><strong>Already a customer:</strong> ${isCustomer ? `Yes (customer ID: ${escapeHtml(customerId || 'unknown')})` : 'No'}</p>
    <hr />
    <p><em>Timestamp: ${ts}</em></p>
  `;
}

function buildSaveFailedEmailHtml(
  submitted: { name: string; email: string; phone?: string; message: string },
  errorDetails: Record<string, unknown>
): string {
  const ts = new Date().toISOString();
  const safeName = escapeHtml(submitted.name);
  const safeEmail = escapeHtml(submitted.email);
  const safePhone = escapeHtml(submitted.phone || 'Not provided');
  const safeMessage = escapeHtml(submitted.message).replace(/\n/g, '<br>');

  return `
    <h2>Contact form: save failed</h2>
    <p>The contact form submission could not be saved to the database. Details are included below for manual handling.</p>
    <hr />
    <h3>Submitted details</h3>
    <p><strong>Name:</strong> ${safeName}</p>
    <p><strong>Email:</strong> ${safeEmail}</p>
    <p><strong>Phone:</strong> ${safePhone}</p>
    <h3>Message:</h3>
    <p>${safeMessage}</p>
    <hr />
    <h3>Error details</h3>
    <pre>${escapeHtml(JSON.stringify(errorDetails, null, 2))}</pre>
    <hr />
    <p><em>Timestamp: ${ts}</em></p>
  `;
}

// ---------------------------------------------------------------------------
// Save draft answers (best-effort, never throws)
// ---------------------------------------------------------------------------
async function saveDraftAnswers(
  supabase: SupabaseClient,
  email: string,
  draftAnswers: Array<{ question_id: string; answer_text: string; answer_value?: unknown }>
) {
  if (!draftAnswers || draftAnswers.length === 0) return;

  try {
    // Validate question_ids exist and are displayable on contact form
    const questionIds = draftAnswers.map(d => d.question_id);
    const { data: validQuestions } = await supabase
      .from('home_questions')
      .select('id')
      .in('id', questionIds)
      .eq('is_active', true)
      .eq('display_on_contact_form', true);

    const validIds = new Set((validQuestions || []).map(q => q.id));

    const validDrafts = draftAnswers
      .filter(d => validIds.has(d.question_id))
      .map(d => ({
        email: email.toLowerCase().trim(),
        question_id: d.question_id,
        answer_text: d.answer_text.substring(0, 500),
        answer_value: d.answer_value !== undefined ? d.answer_value : null,
      }));

    if (validDrafts.length > 0) {
      const { error } = await supabase
        .from('home_profile_draft_answers')
        .upsert(validDrafts, { onConflict: 'email,question_id' });

      if (error) {
        console.error('Error saving draft answers:', error);
      } else {
        console.log(`Saved ${validDrafts.length} draft answers for ${email}`);
      }
    }
  } catch (err) {
    console.error('Failed to save draft answers:', err);
  }
}

// ---------------------------------------------------------------------------
// Onboarding: check auth.users and send magic link
// ---------------------------------------------------------------------------
async function handleOnboarding(
  supabase: SupabaseClient,
  resendApiKey: string,
  email: string,
  name: string,
  appUrl: string
): Promise<boolean> {
  try {
    const emailNorm = email.toLowerCase().trim();

    // Check if email already exists in auth.users
    const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();

    if (listError) {
      console.error('Error listing users:', listError);
      return false;
    }

    const existingUser = (users || []).find(u => u.email?.toLowerCase() === emailNorm);

    if (existingUser) {
      // Check if this auth user is actually linked to a customer
      const { data: linkedCustomer } = await supabase
        .from('customers')
        .select('id')
        .eq('user_id', existingUser.id)
        .maybeSingle();

      if (linkedCustomer) {
        console.log(`User already exists AND has customer for ${emailNorm}, skipping onboarding`);
        return false;
      }

      // Auth user exists but no customer linked — delete the orphan auth user
      // so we can cleanly re-create via generateLink below
      console.log(`Orphan auth user found for ${emailNorm}, deleting and re-creating`);
      await supabase.auth.admin.deleteUser(existingUser.id);
    }

    // Generate magic link (this creates the auth user automatically)
    const redirectTo = `${appUrl}/onboarding/set-password`;
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: emailNorm,
      options: {
        redirectTo,
      },
    });

    if (linkError || !linkData?.properties?.hashed_token) {
      console.error('Error generating magic link:', linkError);
      return false;
    }

    // Create branded verification code (same pattern as invite-customer)
    const verificationCode = generateSecureCode();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error: insertError } = await supabase
      .from('verification_tokens')
      .insert({
        code: verificationCode,
        token_hash: linkData.properties.hashed_token,
        type: 'magiclink',
        redirect_path: '/onboarding/set-password',
        expires_at: expiresAt,
        email: emailNorm,
      });

    if (insertError) {
      console.error('Error storing verification token:', insertError);
      return false;
    }

    // Build branded verification URL
    const verifyUrl = `${appUrl}/verify?code=${verificationCode}`;

    // Send branded onboarding email via Resend
    const safeName = escapeHtml(name);
    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #1a1a1a; margin-bottom: 16px;">Hej ${safeName}!</h2>
        <p style="color: #4a4a4a; font-size: 16px; line-height: 1.6;">
          Tack för att du kontaktade oss! Vill du spara tid? Bekräfta din e-post för att fylla i din hemprofil och ladda upp bilder. Det hjälper oss hjälpa dig snabbare.
        </p>
        <div style="margin: 32px 0; text-align: center;">
          <a href="${verifyUrl}" style="background-color: #2563eb; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 16px; display: inline-block;">
            Fyll i din hemprofil
          </a>
        </div>
        <p style="color: #6b6b6b; font-size: 14px; line-height: 1.5;">
          Länken är giltig i 24 timmar. Om du inte begärde detta kan du bortse från mejlet.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 32px 0;" />
        <p style="color: #999; font-size: 12px;">
          Smart Home Solutions · Täby, Sverige
        </p>
      </div>
    `;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Smart Home Solutions <replyonly@mail.smarthomesolutions.se>",
        to: [emailNorm],
        subject: "Fyll i din hemprofil – Smart Home Solutions",
        html: emailHtml,
      }),
    });

    if (!res.ok) {
      const errData = await res.json();
      console.error("Error sending onboarding email:", errData);
      return false;
    }

    console.log(`Onboarding branded verification link sent to ${emailNorm}`);
    return true;
  } catch (err) {
    console.error('Onboarding error:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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

    // ---- Rate limit ----
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
            ...corsHeaders,
          },
        }
      );
    }

    const { name, email, phone, message, website, draft_answers }: ContactEmailRequest = await req.json();

    // ---- Honeypot ----
    if (website && website.trim() !== '') {
      console.log(`Honeypot triggered from IP: ${clientIP}`);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---- Validation ----
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

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedPhone = phone?.trim() || null;
    const trimmedMessage = message.trim();
    const emailNormalized = trimmedEmail.toLowerCase();
    const submittedPayload = { name: trimmedName, email: trimmedEmail, phone: trimmedPhone, message: trimmedMessage };

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const toAddress = Deno.env.get("CONTACT_TO") || "sales@smarthomesolutions.se";

    if (!resendApiKey) {
      console.error("Missing RESEND_API_KEY");
    }

    // ---- Save draft answers (regardless of contact insert result) ----
    if (draft_answers && draft_answers.length > 0) {
      await saveDraftAnswers(supabase, emailNormalized, draft_answers);
    }

    // ---- Attempt INSERT into contacts ----
    const { data: newContact, error: insertError } = await supabase
      .from("contacts")
      .insert({
        name: trimmedName,
        email: trimmedEmail,
        phone: trimmedPhone,
        message: trimmedMessage,
      })
      .select("id, email_token")
      .single();

    // ===== DUPLICATE PATH =====
    if (insertError && insertError.code === '23505') {
      console.log("Duplicate contact detected for email:", emailNormalized);

      let matchedEntityType: string | null = 'contacts';
      let matchedEntityId: string | null = null;
      let isCustomer = false;
      let customerId: string | null = null;

      const { data: existingContact } = await supabase
        .from('contacts')
        .select('id, converted_to_customer_id')
        .ilike('email', emailNormalized)
        .maybeSingle();

      if (existingContact) {
        matchedEntityId = existingContact.id;
        if (existingContact.converted_to_customer_id) {
          isCustomer = true;
          customerId = existingContact.converted_to_customer_id;
          matchedEntityType = 'customers';
          matchedEntityId = customerId;
        }
      }

      await logIntakeEvent(supabase, {
        email: trimmedEmail,
        emailNormalized,
        name: trimmedName,
        phone: trimmedPhone,
        payload: submittedPayload,
        result: 'duplicate',
        matchedEntityType,
        matchedEntityId,
        error: { code: insertError.code, message: insertError.message },
      });

      if (resendApiKey) {
        await sendSalesEmail(
          resendApiKey,
          toAddress,
          `Contact form: duplicate detected (${escapeHtml(trimmedEmail)})`,
          buildDuplicateEmailHtml(
            { name: trimmedName, email: trimmedEmail, phone: trimmedPhone || undefined, message: trimmedMessage },
            existingContact?.id || 'okänt',
            isCustomer,
            customerId
          )
        );
      }

      // For duplicates: still try onboarding if user doesn't exist in auth
      let onboardingSent = false;
      if (resendApiKey) {
        const appOrigin = getRequestAppOrigin(req);
        onboardingSent = await handleOnboarding(supabase, resendApiKey, emailNormalized, trimmedName, appOrigin);
      }

      return new Response(JSON.stringify({ success: true, onboarding: onboardingSent }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": String(remaining), ...corsHeaders },
      });
    }

    // ===== OTHER FAILURE PATH =====
    if (insertError || !newContact) {
      console.error("Error inserting contact:", insertError);

      const errorDetails = insertError
        ? { code: insertError.code, message: insertError.message, details: insertError.details, hint: insertError.hint }
        : { message: 'Insert returned no data' };

      await logIntakeEvent(supabase, {
        email: trimmedEmail,
        emailNormalized,
        name: trimmedName,
        phone: trimmedPhone,
        payload: submittedPayload,
        result: 'save_failed',
        error: errorDetails,
      });

      if (resendApiKey) {
        await sendSalesEmail(
          resendApiKey,
          toAddress,
          'Contact form: save failed',
          buildSaveFailedEmailHtml(
            { name: trimmedName, email: trimmedEmail, phone: trimmedPhone || undefined, message: trimmedMessage },
            errorDetails
          )
        );
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": String(remaining), ...corsHeaders },
      });
    }

    // ===== SUCCESS PATH =====
    console.log("Contact saved to database:", newContact.id);

    // Store initial message in contact_messages
    const { error: messageError } = await supabase
      .from("contact_messages")
      .insert({
        contact_id: newContact.id,
        body: trimmedMessage,
        author_type: "lead",
        author_email: trimmedEmail,
        source: "form",
      });

    if (messageError) {
      console.error("Error inserting initial message:", messageError);
    } else {
      console.log("Initial message saved to contact_messages");
    }

    // Log intake event
    await logIntakeEvent(supabase, {
      email: trimmedEmail,
      emailNormalized,
      name: trimmedName,
      phone: trimmedPhone,
      payload: submittedPayload,
      result: 'saved',
      matchedEntityType: 'contacts',
      matchedEntityId: newContact.id,
    });

    // Send normal notification email to sales
    if (resendApiKey) {
      const safeName = escapeHtml(trimmedName);
      const safeEmail = escapeHtml(trimmedEmail);
      const safePhone = escapeHtml(trimmedPhone || "Not provided");
      const safeMessage = escapeHtml(trimmedMessage).replace(/\n/g, "<br>");

      const htmlBody = `
        <h2>New message from the contact form</h2>
        <p><strong>Name:</strong> ${safeName}</p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <p><strong>Phone:</strong> ${safePhone}</p>
        <hr />
        <h3>Message:</h3>
        <p>${safeMessage}</p>
      `;

      const replyToAddress = `sales+${newContact.email_token}@mail.smarthomesolutions.se`;

      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "Smart Home Solutions <replyonly@mail.smarthomesolutions.se>",
            to: [toAddress],
            reply_to: replyToAddress,
            subject: `Contact form inquiry: ${safeName}`,
            html: htmlBody,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          console.error("Resend API error:", errorData);
        } else {
          const emailResponse = await response.json();
          console.log("Email sent successfully via Resend:", emailResponse);
        }
      } catch (emailErr) {
        console.error("Failed to send normal notification email:", emailErr);
      }
    }

    // ---- Onboarding: check if new user and send magic link ----
    let onboardingSent = false;
    if (resendApiKey) {
      const appOrigin = getRequestAppOrigin(req);
      onboardingSent = await handleOnboarding(supabase, resendApiKey, emailNormalized, trimmedName, appOrigin);
    }

    return new Response(JSON.stringify({ success: true, onboarding: onboardingSent }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
        ...corsHeaders,
      },
    });
  } catch (error: any) {
    console.error("Unhandled error in send-contact-email:", error);
    return new Response(
      JSON.stringify({ error: error?.message || "Unexpected error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
