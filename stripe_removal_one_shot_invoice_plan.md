# Stripe Removal And Local Invoice PDF One-Shot Plan

## Goal

Ship one coherent migration that removes all runtime Stripe dependency from this repo while keeping `APP_ENV`, replacing Stripe-hosted invoices with your own invoice page and on-demand PDF generation, and preserving invoice numbering continuity.

This is not a phased rollout plan. It is one implementation slice on one branch, followed by one verification pass and one deploy.

## What The Repo Looks Like Today

Stripe is currently wired into three separate areas:

- Invoice lifecycle in Supabase Edge Functions:
  - `supabase/functions/create-invoice-from-quote/index.ts`
  - `supabase/functions/create-draft-invoice/index.ts`
  - `supabase/functions/finalize-invoice/index.ts`
  - `supabase/functions/finalize-new-invoice/index.ts`
  - `supabase/functions/sync-invoice-lines/index.ts`
  - `supabase/functions/void-invoice/index.ts`
  - `supabase/functions/void-new-invoice/index.ts`
  - `supabase/functions/invoice-webhook/index.ts`
  - `supabase/functions/sync-invoices/index.ts`
  - `supabase/functions/get-stripe-invoice-pdf/index.ts`
  - `supabase/functions/send-invoice-email/index.ts`
  - `supabase/functions/send-new-invoice-email/index.ts`
- Customer subscription and billing portal:
  - `supabase/functions/check-subscription/index.ts`
  - `supabase/functions/create-checkout/index.ts`
  - `supabase/functions/customer-portal/index.ts`
  - `src/hooks/use-subscription.ts`
  - `src/pages/portal/Billing.tsx`
  - `src/components/portal/SubscriptionRequiredAlert.tsx`
  - `src/pages/portal/NewTicket.tsx` (uses `useSubscription`)
  - `src/pages/portal/TicketDetail.tsx` (uses `useSubscription`)
  - `src/pages/portal/TicketsList.tsx` (uses `useSubscription`)
- UI assumptions that an invoice has a Stripe id, hosted payment page, and Stripe PDF:
  - `src/components/portal/invoices/InvoicePdfModal.tsx`
  - `src/components/portal/invoices/InvoiceEmailModal.tsx`
  - `src/components/portal/quotes/InvoiceCard.tsx`
  - `src/pages/portal/invoices/InvoiceDetail.tsx`
  - `src/pages/portal/invoices/InvoiceDraftEditor.tsx`
  - `src/pages/portal/invoices/InvoicesList.tsx`
  - `src/pages/portal/Billing.tsx`
  - `src/pages/portal/quotes/QuotePreparation.tsx` (checks `quote.stripe_invoice_id` to determine if invoice exists)
  - `src/lib/stripe-dashboard.ts` (helper to build Stripe Dashboard URLs for invoices/customers)
  - `src/components/portal/quotes/QuoteCancelDialog.tsx` (cancel dialog text mentions "Stripe")
  - `src/components/portal/quotes/BillingEventLog.tsx` (event label "Quote sent to Stripe")
- Diagnostics page displaying Stripe key info:
  - `src/pages/portal/ERDiagram.tsx` (calls `check-env`, displays `SHS_STRIPE_SECRET_KEY` and `STRIPE_SECRET_KEY` prefixes)
- Edge functions that import `stripe-env.ts` for non-Stripe reasons:
  - `supabase/functions/send-quote-email/index.ts` (imports `getAppEnvironment` from `stripe-env.ts`)
  - `supabase/functions/cancel-quote/index.ts` (comment referencing "no Stripe" — benign but the import chain may pull in `stripe-env.ts`)
  - `supabase/functions/dump-database/index.ts` (lists `SHS_STRIPE_SECRET_KEY` and `STRIPE_INVOICE_WEBHOOK_SECRET` in its env dump)
- Configuration and test infrastructure:
  - `supabase/config.toml` (function config entry for `get-stripe-invoice-pdf`)
  - `scripts/setup-secrets.sh` (prompts for `SHS_STRIPE_SECRET_KEY` and `STRIPE_INVOICE_WEBHOOK_SECRET`)
  - `e2e/helpers/env.ts` (defines `stripe` test card config: card number, expiry, CVC, postal code)

The current invoice number assignment is also tied to Stripe finalization in the active paths, even though the schema already has local invoice fields and an unused local sequence.

## Key Design Decisions

### 1. Keep `APP_ENV`, remove Stripe env usage

- Keep `APP_ENV`.
- Delete Stripe runtime usage and the helper centered on `SHS_STRIPE_SECRET_KEY`.
- Replace `supabase/functions/_shared/stripe-env.ts` with a small `app-env.ts` helper if you still want environment-aware prefixes, test watermarks, or profile selection.
- Remove `SHS_STRIPE_SECRET_KEY`, `STRIPE_SECRET_KEY`, and `STRIPE_INVOICE_WEBHOOK_SECRET` from the runtime contract.

### 2. Separate visible invoice numbers from bank payment references

This is the most important design correction.

Your attached sample invoice at [/Users/phil/Documents/SHS/Invoice-swedish.pdf](/Users/phil/Documents/SHS/Invoice-swedish.pdf) uses a human-readable number like `TIN-0004`. That is fine for display, but it is a poor OCR reference for Bankgiro/internet bank payment entry.

Bankgirot's OCR guidance expects a numeric OCR reference with modulus-10 check digit handling, and Bankgirot's invoice-layout guidance explicitly recommends not relying on decorative invoice numbers with dashes or leading zeros as the payment reference.

Recommended model:

- `invoice_number`: immutable, human-visible, same style you already want to keep.
- `payment_reference`: immutable, numeric OCR reference used for Bankgiro payment and QR payload.

That lets you keep the visible numbering style while still generating something bank apps reliably accept.

### 3. Invoice delivery should mirror the quote workflow

Use the existing public quote pattern as the model, not email attachments and not stored PDFs.

Recommended flow:

- when an invoice is sent, generate a unique 32-byte token like `send-quote-email` already does
- store only the token hash and expiry on the invoice record
- email the customer a hard-to-guess public URL on your own site
- render the invoice and payment details on that page without requiring login
- show payment status on that page
- if the customer wants a PDF, generate it on demand from the same invoice data and stream it directly back

This is closer to the repo's existing design than a stored-PDF workflow because public quote links already exist in:

- `supabase/functions/send-quote-email/index.ts`
- `supabase/functions/fetch-public-quote/index.ts`
- `src/pages/portal/PublicQuotePage.tsx`

The invoice implementation should reuse that architecture instead of inventing a second model.

### 4. Payment status becomes internal, not webhook-driven

Without Stripe, invoices will never become `paid` unless you replace that mechanism.

For this one-shot migration, implement the minimal correct replacement:

- add a `record-invoice-payment` flow for staff
- capture `paid_at`, payment date, amount, method, and external reference
- mark invoice `paid` when fully settled
- compute `overdue` from `status + due_date`, not from Stripe events

Do not block this migration on bank import. Manual payment registration is enough to fully replace Stripe runtime behavior.

## Target End State

After the migration:

- quotes are accepted locally as today
- draft invoices are created locally only
- line items remain the source of truth through `invoice_computed_totals`
- finalizing an invoice does all of the following atomically:
  - allocate the next human invoice number using your local numbering rules
  - allocate the numeric OCR payment reference
  - set `status = 'open'`
  - write an `invoice_finalized` event
- sending an invoice does all of the following:
  - generates a quote-style public access token
  - stores only the token hash and expiry
  - sends an email containing the public invoice URL on your own site
- the public invoice page shows:
  - invoice details
  - Bankgiro payment details
  - QR code
  - current payment status
- logged-in customers see the same invoices in billing history
- logged-in invoice detail and public invoice detail share the same rendering code
- PDF download is generated on demand and never persisted
- invoice paid state is updated by your own payment registration flow
- subscription gating reads from your own database
- no runtime code talks to Stripe

## Database Changes In The One-Shot Migration

Add generic local-payment fields before removing Stripe-specific logic:

- `invoices.payment_reference text unique`
- `invoices.issued_at timestamptz`
- `invoices.public_token_hash text`
- `invoices.public_token_expires_at timestamptz`
- `invoices.last_public_viewed_at timestamptz`
- `invoices.sent_at timestamptz`
- `invoices.last_emailed_to text`
- `invoices.last_emailed_at timestamptz`
- `invoices.payment_method text` or keep this on a separate payments table
- `invoices.outstanding_amount numeric` only if you want denormalized convenience
- `customers.subscription_active boolean` and `customers.subscription_expires_at timestamptz`
  - or a dedicated `customer_subscriptions` table if you expect more than a single boolean soon

Recommended but optional in the same slice:

- `invoice_payments`
  - `id`
  - `invoice_id`
  - `payment_date`
  - `amount`
  - `method`
  - `reference`
  - `note`
  - `created_by`

Stripe-specific schema handling:

- stop all runtime reads and writes to:
  - `invoices.stripe_invoice_id`
  - `quotes.stripe_invoice_id`
  - `quotes.stripe_status`
  - `quotes.invoice_hosted_url`
  - `invoices.hosted_invoice_url`
  - `customers.stripe_customer_id` (used by `create-invoice-from-quote`, `create-draft-invoice`, `sync-invoice-lines`, `sync-invoices`, `check-subscription`, `create-checkout`, `customer-portal` to look up or create Stripe customers)
  - Stripe metadata in `billing_events` and `invoice_events`
- if you want zero Stripe residue in schema too, drop those columns in the same migration after backfilling anything still needed into generic fields
- if you want lower migration risk, leave legacy Stripe columns in place but unused and unsurfaced

My recommendation is:

- remove all runtime Stripe logic now
- keep legacy Stripe columns only if they preserve historical data you care about
- do not keep any Stripe compatibility code paths

For the public-link model, keep it simple and mirror quotes:

- store one active public invoice token hash directly on `invoices`
- overwrite it when the invoice is re-sent
- hash-compare the incoming token in the public invoice fetch function

Do not add a PDF storage column or bucket.

## Invoice Numbering Strategy

You asked for invoice numbers to be strictly sequential with no gaps.

Implement that as a database function, not in TypeScript:

- create `allocate_invoice_number()` as a `SECURITY DEFINER` Postgres function
- parse only invoice numbers that match the active display pattern
- find the highest existing issued number in that series
- allocate the next number after that
- format it with the active prefix and width
- lock allocation with a transaction-safe mechanism
  - `pg_advisory_xact_lock(...)` is the cleanest option here
- call it only at the point where you are certain the invoice is being issued
- keep the number allocation, invoice state transition, and event write in one transaction so a failed issue does not burn a number

Important guardrail:

- do not reuse numbers that were already issued to real invoices, including voided invoices
- do not have any code path that skips a number after allocation
- if staff can cancel before issue, do that while still in `draft`
- once issued, a voided invoice keeps its number so the live sequence remains auditable and gap-free

Practical pattern:

- visible number in test: `TIN-0004` if that is the sandbox convention you want to keep
- visible number in live: `IN-0001` use your chosen live prefix, driven by config
- numeric OCR reference: separate number, checksum-protected, no formatting characters

## Bankgiro, OCR, And QR Design

The new invoice should keep the visual structure of the attached sample:

- A4 portrait
- sender block on the left
- recipient block on the right
- invoice metadata near the top
- one strong headline with amount and due date
- simple line-item table
- totals block bottom-right
- SHS logo top-right

Replace the current "Betala online" link with a payment block containing:

- Bankgiro number
- OCR/payment reference
- amount
- due date
- payee name
- QR code
- short fallback instruction for manual payment entry

That same payment block should appear in:

- the public invoice page reached from the email link
- the logged-in customer invoice detail
- the generated PDF

Implementation approach:

- create a shared invoice document module, for example `supabase/functions/_shared/invoice-pdf.ts`
- generate the PDF with `pdf-lib`
- embed one local logo asset and, if you want closer visual parity, bundled Inter font files
- generate the QR bitmap with a QR library and place it into the PDF

For the payment payload:

- use the Bankgiro number plus numeric OCR reference plus amount plus payee metadata
- do not encode the human invoice number as the payment reference
- add golden tests around the payload builder
- verify the output with real bank-app scans before deploy

Required business inputs before coding:

- bankgiro number
- payee name exactly as it should appear
- whether you have Bankgiro OCR control configured
- the desired live invoice prefix
- whether sandbox should keep `TIN-` or use a separate test marker elsewhere on the PDF

## Supabase Function Changes

Replace or rewrite these functions:

- `create-invoice-from-quote`
  - stop creating Stripe customers and invoices
  - create the local invoice row and copy quote lines only
  - do not assign the final invoice number yet
- `create-draft-invoice`
  - local draft only
  - no Stripe customer lookup
  - no Stripe invoice id
- `finalize-invoice`
  - convert to local finalize logic for quote-origin invoices
  - allocate invoice number and payment reference
- `finalize-new-invoice`
  - same local finalize behavior for generic draft invoices
- `sync-invoice-lines`
  - delete this function entirely or replace it with a local "recompute preview PDF" helper if needed
- `void-invoice` and `void-new-invoice`
  - local status change only
  - keep audit events
  - never call Stripe
- `get-stripe-invoice-pdf`
  - replace with `get-invoice-pdf`
  - look up by local invoice id or by validated public token flow
  - render PDF bytes on demand from invoice data
  - stream the response directly
  - do not write to storage
- `send-invoice-email` and `send-new-invoice-email`
  - collapse into one local invoice email sender if possible
  - generate a new public invoice token exactly like the quote flow
  - email the customer the public invoice URL
  - include Bankgiro payment details in plain text if useful
  - do not attach a stored PDF
- add `fetch-public-invoice`
  - mirror `fetch-public-quote`
  - validate `invoice_id + token`
  - return invoice lines, totals, payment block, customer-safe metadata, and current payment status
- add `send-public-invoice-email` if you want the naming to match the public-link intent more clearly
- `invoice-webhook`
  - delete entirely
- `sync-invoices`
  - delete entirely
- `check-subscription`
  - rewrite to read your internal entitlement state
- `create-checkout`
  - delete or replace with your future non-Stripe billing flow
- `customer-portal`
  - delete
- `check-env`
  - remove Stripe key diagnostics, keep `APP_ENV` only if this function still serves a purpose
- `send-quote-email`
  - change import from `stripe-env.ts` to the new `app-env.ts` for `getAppEnvironment`
- `cancel-quote`
  - verify no residual `stripe-env.ts` import; update if needed
- `dump-database`
  - remove `SHS_STRIPE_SECRET_KEY` and `STRIPE_INVOICE_WEBHOOK_SECRET` from the env dump listing
- `supabase/config.toml`
  - remove the `[functions.get-stripe-invoice-pdf]` entry
  - add config entries for new functions (`get-invoice-pdf`, `fetch-public-invoice`, etc.)
- `scripts/setup-secrets.sh`
  - remove `SHS_STRIPE_SECRET_KEY` and `STRIPE_INVOICE_WEBHOOK_SECRET` prompts
  - keep the script structure for any remaining secrets (Resend, Supabase, etc.)

## Frontend Changes

### Invoice UI

Update all invoice views to become shared-document aware:

- add a reusable invoice presentation component, for example `InvoiceDocumentView`
  - accepts invoice data plus mode flags
  - renders the invoice body, payment details, QR, and payment status
  - is used by both the public page and the logged-in page
- add a public invoice route mirroring quotes
  - likely similar to `/portal/invoice/:id?token=...`
  - or another public path if you want a cleaner customer-facing URL
- add a `PublicInvoicePage` mirroring `PublicQuotePage`
  - fetches via the new `fetch-public-invoice`
  - no login required
  - shows status but no edit actions

- `InvoicePdfModal`
  - accept `invoiceId` or a token-backed public invoice descriptor
  - call the new `get-invoice-pdf`
  - download bytes generated on demand
- `InvoiceEmailModal`
  - change from attachment-oriented UX to public-link-oriented UX
  - preview the public invoice URL and payment details
- `InvoiceCard`
  - replace "Open payment" with "Open invoice" and "Download PDF"
  - remove Stripe wording
- `InvoiceDetail`
  - remove hosted Stripe link and stored-PDF assumptions
  - add "Record payment" action
  - show payment reference
  - share main content rendering with the public page
- `InvoicesList` and `Billing`
  - stop depending on `stripe_invoice_id`
  - stop calling `sync-invoices`
  - show invoice status and allow opening the local invoice page
  - allow PDF download on demand

### Stripe Dashboard helper

`src/lib/stripe-dashboard.ts` should be deleted entirely. Any UI that links to the Stripe Dashboard (e.g. staff shortcuts to view invoices/customers in Stripe) should be removed or replaced with links to the local invoice detail.

### Quote cancel dialog and billing event log

- `QuoteCancelDialog.tsx`: remove "in Stripe" from the cancel confirmation text
- `BillingEventLog.tsx`: change "Quote sent to Stripe" label to something local (e.g. "Quote sent")

### Quote preparation

`QuotePreparation.tsx` should:

- replace the `quote.stripe_invoice_id` check with a local invoice existence check (e.g. check for a linked invoice row directly)
- remove any logic that assumes the invoice is a Stripe object

### Diagnostics page

`ERDiagram.tsx` should:

- remove Stripe key display from the environment diagnostics panel
- keep `APP_ENV` display if still useful

### Draft editing

`InvoiceDraftEditor` should:

- remain the place for editing line items and due date
- stop syncing lines to Stripe
- finalize locally
- navigate using the local invoice number after finalize
- use send-email to generate or refresh the public invoice token when the invoice is sent

### Subscription UI

Replace the Stripe subscription UX with your own data source:

- `use-subscription` reads internal entitlement
- `Billing.tsx` removes checkout and Stripe portal buttons
- `SubscriptionRequiredAlert` links to your billing/contact process instead of Stripe checkout
- ticket pages continue to gate on a subscription flag if that rule still matters

## Public Invoice Access Model

Mirror the existing quote access pattern instead of inventing a new auth scheme.

Recommended design:

- invoice email sender creates a random token and stores only its SHA-256 hash
- customer gets a URL like `/portal/invoice/<invoice-id>?token=<raw-token>`
- public invoice fetch function validates:
  - invoice exists
  - token hash matches
  - token is not expired
- successful public fetch updates `last_public_viewed_at`
- invoice status shown publicly is read from the live invoice record

This keeps the implementation aligned with:

- `send-quote-email`
- `fetch-public-quote`
- `PublicQuotePage`

and avoids building a second token architecture unless you later need multiple simultaneous invoice links.

## PDF Generation Model

Do not store PDFs in Supabase Storage.

Recommended behavior:

- build a shared invoice-to-PDF renderer
- when the user clicks "Download PDF", call `get-invoice-pdf`
- that function fetches current invoice data, renders PDF bytes, and returns them immediately
- the browser downloads the file
- nothing is persisted

Benefits:

- no wasted storage
- no stale PDF copies after status changes
- public page, logged-in page, and PDF all stay based on one data model

Delete the old cache behavior around:

- `supabase/functions/get-stripe-invoice-pdf/index.ts`
- the `invoice-pdfs` bucket, its storage policies, and the migration that created them (`supabase/migrations/20260203144743_f7a20972-0d2f-4807-a163-ee9d6201f3af.sql` — add a new migration to drop the bucket and policies rather than editing the old migration)

## Test Changes

Update tests and docs that assume Stripe payment:

- `e2e/migration-validation.spec.ts`
  - remove hosted Stripe payment flow
  - replace with:
    - create invoice
    - finalize invoice
    - send invoice email
    - assert the email contains a valid public invoice URL on your domain
    - open the public invoice page and verify payment details and status are visible
    - click download PDF and verify bytes are returned
    - record payment as staff
    - assert paid status updates both in staff view and public invoice page
- `docs/ui-test-migration-validation-plan.md`
  - remove Stripe hosted invoice and test-card steps
- `accounting_vat_implementation_plan.md`
  - review and update Stripe references throughout (payment matching, Stripe fee handling, Stripe payout timing, source system references)
  - some sections describe future Stripe integration for accounting — these should be rewritten to reflect the new payment model
- `e2e/helpers/env.ts`
  - remove the `stripe` test card configuration object (`cardNumber`, `expiry`, `cvc`, `postalCode`)
  - remove any `E2E_STRIPE_*` environment variable references
- add unit tests for:
  - invoice number allocation is strictly sequential under repeated issue operations
  - concurrent finalize attempts cannot allocate the same or skip an invoice number
  - OCR reference generation
  - QR payload builder
  - PDF generation smoke test
  - public invoice token hashing and expiry checks
  - local payment recording

## Recommended Implementation Order Inside The One Branch

Do the work in this order, but keep it as one branch and one merge:

1. Add the DB migration for generic invoice/payment/subscription fields and allocation functions.
2. Add quote-style public invoice token fields and fetch/send functions.
3. Rewrite the invoice edge functions to be fully local.
4. Add on-demand PDF generation.
5. Replace invoice preview/download/email flows in the frontend with shared public/logged-in rendering.
6. Add manual payment recording and paid-state updates.
7. Replace subscription checks with internal entitlement reads.
8. Delete Stripe-only functions, PDF storage cache logic (`invoice-pdfs` bucket + policies), `src/lib/stripe-dashboard.ts`, and dead UI code.
9. Regenerate Supabase types.
10. Update tests and docs.

## Acceptance Criteria For The One-Shot Migration

- no frontend code calls a Stripe edge function
- no edge function imports Stripe
- no invoice flow depends on `stripe_invoice_id`
- creating a draft invoice works
- finalizing a draft invoice assigns:
  - a visible invoice number
  - a numeric OCR/payment reference
  - no stored PDF artifact
- sending an invoice emails a unique hard-to-guess public URL on your domain
- the public invoice page loads without login and shows:
  - invoice details
  - payment details
  - QR code
  - payment status
- the logged-in invoice detail reuses the same main rendering code
- the PDF resembles the attached invoice structurally
- the PDF shows Bankgiro details and QR instead of an online payment link
- PDF download works on demand and nothing is stored
- staff can mark an invoice paid without Stripe
- customer billing pages show invoices in history when logged in
- subscription-gated ticket pages no longer depend on Stripe
- `APP_ENV` still works

## Notes From External Guidance

- Bankgirot OCR reference control: [bankgirot.se](https://www.bankgirot.se/en/services/incoming-payments/bankgiro-receivables/ocr-reference-control/)
- Bankgirot invoice layout guidance: [bankgirot.se](https://www.bankgirot.se/en/services/incoming-payments/bankgiro-receivables/right-designed-invoice/)

Those sources are why I recommend separating `invoice_number` from `payment_reference` instead of trying to force `TIN-0004` directly into the Bankgiro/OCR/QR path.
