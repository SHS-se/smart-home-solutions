

# Stop Using Stripe Quotes -- Own the Quote Lifecycle

## Overview

Replace the current Stripe Quotes flow with a fully app-owned quote system. Quotes will be managed entirely in the database, sent via custom HTML email (Resend), and customers can accept/decline/request changes via a token-based public page -- no login required. Stripe remains for invoicing and payments only.

## What Gets Removed

- Edge functions: `create-stripe-quote`, `accept-stripe-quote`, `get-stripe-quote-pdf`, `get-stripe-quote-totals`, `convert-quote-to-invoice`, `cleanup-quote-pdfs`
- Frontend: All Stripe Quote PDF preview logic, `OfferPdfModal` component (Stripe-based), Stripe Quote totals fetching in `Offers.tsx`
- The "Skicka till Stripe offert" button and related Stripe PDF preview on the QuotePreparation page
- Customer `Offers.tsx` page's Stripe-dependent accept flow

## What Gets Added/Changed

---

### Phase 1: Database Schema

**A) Alter `quotes` table** -- add columns for the new lifecycle:

| Column | Type | Purpose |
|--------|------|---------|
| `expires_at` | timestamptz | When the quote expires |
| `sent_at` | timestamptz | When sent via email |
| `accepted_at` | timestamptz | When accepted |
| `declined_at` | timestamptz | When declined |
| `accepted_by_name` | text | Name typed during acceptance |
| `accepted_by_email` | text | Email typed during acceptance |
| `accepted_ip` | text | IP recorded on acceptance |
| `accepted_user_agent` | text | Browser UA on acceptance |
| `accept_token_hash` | text | SHA-256 of the access token |
| `accept_token_expires_at` | timestamptz | Token expiry |
| `last_viewed_at` | timestamptz | Last time customer viewed |

**B) New table: `quote_events`**

Replaces the `billing_events` table for quote-specific events. Columns: `id`, `quote_id`, `event_type`, `actor_type`, `actor_email`, `metadata`, `created_at`. RLS: staff can read/insert; public access via a DB function for token-validated inserts.

Event types: `created`, `sent`, `viewed`, `accept_opened`, `accepted`, `declined`, `revision_requested`, `message_posted`, `invoice_created`

**C) New table: `quote_messages`**

For customer-staff communication on revision requests. Columns: `id`, `quote_id`, `author_type` (customer/staff), `author_name`, `author_email`, `body_markdown`, `source` (portal/email), `created_at`. RLS: staff full access; token-validated inserts for customers.

**D) New table: `document_sequences`**

Atomic quote number generation. Columns: `key` (text PK), `next_value` (int). Initialized with `key='quote'`, `next_value=1`.

**E) Postgres function: `generate_next_quote_number()`**

Atomically increments `document_sequences.next_value` and returns formatted string. Uses `APP_ENV` setting to determine prefix:
- LIVE: `Q-00000001`  
- TEST: `TQ-00000001`

---

### Phase 2: Edge Functions

**A) `send-quote-email`** (new)

Staff-authenticated. Flow:
1. If `quote_number` is null, call `generate_next_quote_number()` RPC and save it
2. Generate a 32-byte random token, store `sha256(token)` and expiry (30 days) on the quote
3. Build responsive HTML email via Resend with:
   - Subject: "Offert {number} fran Smart Home Solutions"
   - Customer greeting, summary box (hardware/labor/other/VAT/total), big CTA button, expiry date, contact info
   - Plain text fallback
4. Send via Resend (`offert@mail.smarthomesolutions.se`)
5. Update `quotes.status = 'sent'`, set `sent_at`
6. Insert `quote_events` with `event_type = 'sent'`

**B) `fetch-public-quote`** (new)

No auth required (`verify_jwt = false`). Accepts `quote_id` + `token` as query params.
1. Validates token hash + expiry
2. Returns quote data: line items, totals, customer name, status, expiry
3. Logs `quote_events.viewed`, updates `last_viewed_at`

**C) `accept-quote`** (rewrite existing)

No auth required. Accepts POST with `quote_id`, `token`, `name`, `email`, consent flag.
1. Validates token hash + expiry
2. Validates quote status is `sent` or `viewed`
3. Stores acceptance metadata (name, email, IP, user agent)
4. Sets status = `accepted`, `accepted_at`
5. Invalidates token (sets `accept_token_expires_at` to now)
6. Logs `quote_events.accepted`

**D) `decline-quote`** (new)

No auth required. Accepts POST with `quote_id`, `token`, optional `reason`.
1. Validates token
2. Sets status = `declined`, `declined_at`
3. Logs `quote_events.declined`

**E) `request-quote-revision`** (new)

No auth required. Accepts POST with `quote_id`, `token`, `message`, `name`, `email`.
1. Validates token
2. Inserts into `quote_messages`
3. Sets status = `revision_requested`
4. Logs `quote_events.revision_requested` + `message_posted`
5. Sends notification email to staff (`support@smarthomesolutions.se`)

**F) `create-invoice-from-quote`** (rewrite existing `convert-quote-to-invoice`)

Staff-authenticated. Creates a Stripe Invoice directly from quote line items (no Stripe Quote involved).
1. Creates Stripe customer if needed
2. Creates Stripe Invoice with line items mirroring quote_lines
3. Finalizes invoice
4. Stores invoice record in `invoices` table
5. Updates quote with `stripe_invoice_id`, `invoice_number`, etc.
6. Logs `quote_events.invoice_created`

**G) Update `cancel-quote`** -- remove Stripe Quote cancellation logic, keep local DB cancel only.

---

### Phase 3: Public Customer Quote Page

**New route: `/portal/quote/:id`** (note: singular, not plural like staff `/quotes`)

A standalone page (no login required) that:
1. Reads `token` from URL query param
2. Calls `fetch-public-quote` edge function
3. Shows mobile-first, clean layout:
   - Company logo + quote number + date
   - Status badge
   - Sections: Hardvara, Arbete, Resa/Ovrigt
   - VAT breakdown
   - Prominent total inc VAT
   - Three action buttons: Acceptera / Avvisa / Begir andring
4. Accept flow: modal with name + email + consent checkbox
5. Decline flow: optional reason textarea
6. Revision request: message textarea + name/email
7. After acceptance: confirmation message with "next steps"

---

### Phase 4: Internal UI Changes (QuotePreparation page)

**Summary sidebar updates:**
- Replace "Skicka till Stripe offert" button with **"Skicka offert via e-post"**
- Add **"Forhandsgranska e-post"** button (shows email preview in a modal)
- Keep "Skapa faktura" button but remove the `stripe_quote_id` requirement -- enable it when status is `accepted`
- Show quote status prominently
- Show `quote_events` timeline (replace `BillingEventLog`)
- Show customer messages when `revision_requested`

**QuotesList updates:**
- Remove Stripe PDF preview button
- Status badges updated for new statuses (`sent`, `viewed`, `accepted`, `declined`, `revision_requested`, `expired`, `invoiced`)

**Offers.tsx (customer portal) updates:**
- Remove Stripe totals fetching
- Use `quote_computed_totals` view for totals
- Remove Stripe-based accept flow (customer now accepts on public page)
- Keep as a simple list with status + link to the public quote page

**InvoiceCard updates:**
- Remove `stripe_quote_id` requirement for invoice creation
- Enable "Create invoice" when quote status is `accepted`

---

### Phase 5: Cleanup

- Delete edge functions: `create-stripe-quote`, `accept-stripe-quote`, `get-stripe-quote-pdf`, `get-stripe-quote-totals`, `convert-quote-to-invoice`, `cleanup-quote-pdfs`
- Delete `OfferPdfModal` component (Stripe-based)
- Clean up `_shared/stripe-env.ts` -- keep it for invoice functions only
- Remove `stripe_status` references from frontend code

---

## Technical Details

### Token Security
- 32 random bytes generated server-side
- Only `SHA-256(token)` stored in DB
- Token sent in URL as hex string
- 30-day expiry
- Single-use: invalidated on accept/decline

### Quote Number Generation (Postgres function)
```text
CREATE FUNCTION generate_next_quote_number()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  v_next int;
  v_prefix text;
  v_env text;
BEGIN
  v_env := current_setting('app.environment', true);
  IF v_env = 'live' THEN
    v_prefix := 'Q-';
  ELSE
    v_prefix := 'TQ-';
  END IF;

  UPDATE document_sequences
    SET next_value = next_value + 1
    WHERE key = 'quote'
    RETURNING next_value - 1 INTO v_next;

  RETURN v_prefix || LPAD(v_next::text, 8, '0');
END;
$$;
```

The edge function calls `set_app_environment()` before calling this RPC to ensure correct prefix.

### Email HTML Design
- Single-column, max-width 600px
- Inline CSS only (email client compatibility)
- Large summary box with section totals
- Prominent CTA button (48px tall, full width)
- Mobile-responsive (fluid widths)
- Plain text fallback included

### RLS Policies for New Tables
- `quote_events`: Staff can SELECT/INSERT. Service role used for public inserts via edge functions.
- `quote_messages`: Staff can SELECT/INSERT/UPDATE/DELETE. Service role for customer inserts.
- `document_sequences`: Only accessible via `SECURITY DEFINER` function.

### Implementation Order
1. Database migration (tables, functions, RLS)
2. Edge functions (send-quote-email, fetch-public-quote, accept-quote, decline-quote, request-quote-revision, create-invoice-from-quote)
3. Public quote page component
4. Internal UI changes (QuotePreparation, QuotesList, Offers, InvoiceCard)
5. Delete old Stripe Quote edge functions
6. Test end-to-end

