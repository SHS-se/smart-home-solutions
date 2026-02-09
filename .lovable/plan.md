

# Duplicate-Safe Contact Form Submission

## Problem
When someone submits the contact form with an email that already exists in the `contacts` table, the unique index (`idx_contacts_normalized_email_unique`) causes the insert to fail, returning a 500 error to the visitor. The message is lost and the business never sees it.

## Solution Overview
Make the edge function resilient to all failure modes. No matter what happens on the backend, the visitor always sees "Thank you!" and the business always gets notified. The notification email to the business should clarify what the error was so that manual resolution/reconciliation can happen where possible.

## What Already Exists
- A unique index on `lower(trim(email))` in the `contacts` table -- duplicate detection is already enforced at the database level.
- The edge function uses the service role key, so RLS is bypassed for writes.
- `config.toml` does not list `send-contact-email`, meaning JWT verification defaults to **on** -- but the frontend invokes it via the Supabase client which attaches the anon key automatically, so this works today.

---

## Step 1 -- Database Migration

Create a new `contact_intake_events` table to log every submission attempt (success, duplicate, or failure):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | default `gen_random_uuid()` |
| `created_at` | timestamptz | default `now()` |
| `email` | text | as submitted |
| `email_normalized` | text | `lower(trim(email))` |
| `name` | text | |
| `phone` | text nullable | |
| `payload` | jsonb | full submitted body |
| `result` | text | `saved`, `duplicate`, `save_failed` |
| `matched_entity_type` | text nullable | `contacts` or `customers` |
| `matched_entity_id` | uuid nullable | |
| `error` | jsonb nullable | DB error details |
| `source` | text | default `website_contact_form` |

**RLS**: Enable RLS, add a staff-only SELECT policy. No public access. The edge function writes via the service role so no INSERT policy is needed for anon.

---

## Step 2 -- Edge Function Rewrite (`send-contact-email/index.ts`)

The core logic changes from a linear "insert or fail" to a branching flow:

```text
Parse & validate input
        |
  Normalize email
        |
  Attempt INSERT into contacts
        |
   +----+----+
   |         |
 Success   Error
   |         |
   |    Is it code 23505?
   |     (unique violation)
   |      +------+------+
   |      |             |
   |   Duplicate    Other error
   |      |             |
   |  Look up match  Log intake event
   |  Log intake     as "save_failed"
   |  as "duplicate"  |
   |      |         Send "save_failed"
   |      |         email to sales
   |  Send          |
   |  "duplicate"   Return 200 OK
   |  email to
   |  sales
   |      |
   |  Return 200 OK
   |
 Save contact_message
 Log intake event as "saved"
 Send normal notification email to sales
 Return 200 OK
```

### Key behaviors:

**Duplicate path** (Postgres error code `23505`):
- Query `contacts` by normalized email to find the existing record.
- Query `customers` (via `contacts.converted_to_customer_id`) to check if they are already a customer.
- Log a `contact_intake_events` row with `result = 'duplicate'` and the matched entity info.
- Send a "Duplicate contact detected" email to sales with: submitted name/email/phone/message, existing contact ID, whether they are already a customer, and a timestamp.
- Return `200 { success: true }`.

**Other failure path**:
- Log a `contact_intake_events` row with `result = 'save_failed'` and the error details.
- Send a "Contact form: saving failed" email to sales with submitted details and error info.
- Return `200 { success: true }`.

**Success path** (unchanged logic, plus):
- Log a `contact_intake_events` row with `result = 'saved'`.
- Continue with existing contact_messages insert and notification email (with tokenized reply-to).

**Top-level catch**: Wrap the entire handler body. If anything throws (including email sending), log to console and return `200 { success: true }`. This ensures no 500 ever reaches the client for contact form submissions. Rate-limit 429 responses remain unchanged.

### Email templates for sales notifications:

1. **Duplicate detected** -- Subject: "Kontaktformulär: dubblett upptäckt ({email})"
   - Body includes: submitted name, email, phone, message, existing contact ID, customer status, timestamp.

2. **Save failed** -- Subject: "Kontaktformulär: sparning misslyckades"
   - Body includes: submitted name, email, phone, message, full error details, timestamp.

---

## Step 3 -- Frontend Change (`Contact.tsx`)

Minimal change: the `handleSubmit` function currently throws on any error from the edge function. Since the edge function will now always return 200 for contact submissions, the existing success path will work. However, as a safety net:

- Wrap the `supabase.functions.invoke` call so that **any** non-429 response is treated as success (show the "Thank you" screen).
- Only show the error toast for rate-limit (429) responses.
- This ensures that even if the edge function has a transient issue, the visitor is never shown a scary error.

---

## Files Changed

| File | Action |
|---|---|
| `supabase/migrations/...` | New migration: create `contact_intake_events` table with RLS |
| `supabase/functions/send-contact-email/index.ts` | Major rewrite of the handler with duplicate/failure branches |
| `src/pages/Contact.tsx` | Minor change: treat non-429 responses as success |

## Technical Details

- Postgres unique violation is detected by checking `insertError.code === '23505'`.
- Email normalization: `lower(trim(email))` applied before any DB operation.
- The `contact_intake_events` logging is wrapped in its own try/catch so a failure to log never blocks the email notification to sales.
- The sales notification emails reuse the existing Resend API integration and the `CONTACT_TO` secret.
- No changes to the `contacts` table schema -- the existing unique index on `lower(trim(email))` is already correct.
