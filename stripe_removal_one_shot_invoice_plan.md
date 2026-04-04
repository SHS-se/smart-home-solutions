# Stripe Removal And Local Invoice PDF One-Shot Plan

## Goal

Ship one coherent migration that removes all runtime Stripe dependency from this repo while keeping `APP_ENV`, replacing Stripe-hosted invoices with your own generated PDF invoice, and preserving invoice numbering continuity.

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
  - ticket pages using `useSubscription`
- UI assumptions that an invoice has a Stripe id, hosted payment page, and Stripe PDF:
  - `src/components/portal/invoices/InvoicePdfModal.tsx`
  - `src/components/portal/invoices/InvoiceEmailModal.tsx`
  - `src/components/portal/quotes/InvoiceCard.tsx`
  - `src/pages/portal/invoices/InvoiceDetail.tsx`
  - `src/pages/portal/invoices/InvoiceDraftEditor.tsx`
  - `src/pages/portal/invoices/InvoicesList.tsx`
  - `src/pages/portal/Billing.tsx`

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

### 3. Finalized invoices own their PDF

- Generate the PDF locally when an invoice moves from `draft` to `open`.
- Store the canonical PDF in Supabase Storage, not as a temporary Stripe cache.
- Keep a stable storage path on the invoice record, for example `pdf_storage_path`.
- Replace `get-stripe-invoice-pdf` with `get-invoice-pdf` that serves the locally generated document by `invoice_id`.

### 4. Payment status becomes internal, not webhook-driven

Without Stripe, invoices will never become `paid` unless you replace that mechanism.

For this one-shot migration, implement the minimal correct replacement:

- add a `record-invoice-payment` flow for staff
- capture `paid_at`, payment date, amount, method, and external reference
- mark invoice `paid` when fully settled
- compute `overdue` from `status + due_date`, not from Stripe events

Do not block this migration on bank import. Manual payment registration is enough to fully replace Stripe runtime behavior.

### 5. Replace Stripe subscriptions with an internal entitlement source

If Stripe must be removed completely, ticket access can no longer depend on Stripe checkout and portal sessions.

Recommended replacement:

- add a small internal entitlement model on the customer record or in a dedicated table
- keep the existing product rule if you still want it: support tickets require active subscription
- source that rule from your own database, not from Stripe

This is smaller and safer than trying to bolt on a second external billing system inside the same migration.

## Target End State

After the migration:

- quotes are accepted locally as today
- draft invoices are created locally only
- line items remain the source of truth through `invoice_computed_totals`
- finalizing an invoice does all of the following atomically:
  - allocate the next human invoice number using your local numbering rules
  - allocate the numeric OCR payment reference
  - set `status = 'open'`
  - generate the invoice PDF
  - store the PDF in Supabase Storage
  - persist the PDF storage path and public metadata
  - write an `invoice_finalized` event
- emailing an invoice attaches the local PDF and includes Bankgiro payment instructions instead of a hosted payment link
- invoice preview/download in staff and customer views uses the stored PDF
- invoice paid state is updated by your own payment registration flow
- subscription gating reads from your own database
- no runtime code talks to Stripe

## Database Changes In The One-Shot Migration

Add generic local-payment fields before removing Stripe-specific logic:

- `invoices.payment_reference text unique`
- `invoices.pdf_storage_path text`
- `invoices.issued_at timestamptz`
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
  - Stripe metadata in `billing_events` and `invoice_events`
- if you want zero Stripe residue in schema too, drop those columns in the same migration after backfilling anything still needed into generic fields
- if you want lower migration risk, leave legacy Stripe columns in place but unused and unsurfaced

My recommendation is:

- remove all runtime Stripe logic now
- keep legacy Stripe columns only if they preserve historical data you care about
- do not keep any Stripe compatibility code paths

## Invoice Numbering Strategy

You asked for numbering to continue the same way as now, incrementing with gaps.

Implement that as a database function, not in TypeScript:

- create `allocate_invoice_number()` as a `SECURITY DEFINER` Postgres function
- parse only invoice numbers that match the active display pattern
- find the smallest missing positive number in that series
- format it with the active prefix and width
- lock allocation with a transaction-safe mechanism
  - `pg_advisory_xact_lock(...)` is the cleanest option here
- call it only on finalize, never on draft creation

Important guardrail:

- do not reuse numbers that were already issued to real invoices, including voided invoices
- "fill gaps" should mean missing numbers in the sequence, not recycling numbers from an auditable document

Practical pattern:

- visible number in test: `TIN-0004` if that is the sandbox convention you want to keep
- visible number in live: use your chosen live prefix, driven by config
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
  - generate and store PDF
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
  - look up by local invoice id
  - authorize by staff/customer ownership
  - return a signed URL or stream bytes from the canonical storage object
- `send-invoice-email` and `send-new-invoice-email`
  - collapse into one local invoice email sender if possible
  - remove payment-link logic
  - attach the stored PDF
  - optionally include Bankgiro payment details in plain text
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

## Frontend Changes

### Invoice UI

Update all invoice views to become local-document aware:

- `InvoicePdfModal`
  - accept `invoiceId` instead of `stripeInvoiceId`
  - call the new `get-invoice-pdf`
- `InvoiceEmailModal`
  - remove "include payment link"
  - keep "attach PDF"
  - show Bankgiro instruction preview instead
- `InvoiceCard`
  - replace "Open payment" with "Preview invoice" and "Download PDF"
  - remove Stripe wording
- `InvoiceDetail`
  - remove hosted Stripe link
  - add "Record payment" action
  - show payment reference
- `InvoicesList` and `Billing`
  - stop depending on `stripe_invoice_id`
  - stop calling `sync-invoices`
  - show local PDF availability based on `pdf_storage_path`

### Draft editing

`InvoiceDraftEditor` should:

- remain the place for editing line items and due date
- stop syncing lines to Stripe
- finalize locally
- navigate using the local invoice number after finalize

### Subscription UI

Replace the Stripe subscription UX with your own data source:

- `use-subscription` reads internal entitlement
- `Billing.tsx` removes checkout and Stripe portal buttons
- `SubscriptionRequiredAlert` links to your billing/contact process instead of Stripe checkout
- ticket pages continue to gate on a subscription flag if that rule still matters

## Storage Changes

The current `invoice-pdfs` bucket is modeled as a user-scoped Stripe PDF cache. Change it into a canonical invoice-document bucket.

Update it so that:

- staff can generate and replace a PDF for a draft/finalized invoice they are allowed to manage
- customers can read only PDFs for their own invoices
- path convention is invoice-centric, not auth-user-centric
  - for example `invoices/<invoice-id>/invoice-<invoice_number>.pdf`

## Test Changes

Update tests and docs that assume Stripe payment:

- `e2e/migration-validation.spec.ts`
  - remove hosted Stripe payment flow
  - replace with:
    - create invoice
    - finalize invoice
    - send invoice email
    - assert PDF attachment or local PDF link exists
    - record payment as staff
    - assert paid status
- `docs/ui-test-migration-validation-plan.md`
  - remove Stripe hosted invoice and test-card steps
- add unit tests for:
  - invoice number allocation with gaps
  - OCR reference generation
  - QR payload builder
  - PDF generation smoke test
  - local payment recording

## Recommended Implementation Order Inside The One Branch

Do the work in this order, but keep it as one branch and one merge:

1. Add the DB migration for generic invoice/payment/subscription fields and allocation functions.
2. Rewrite the invoice edge functions to be fully local.
3. Add PDF generation and storage.
4. Replace invoice preview/download/email flows in the frontend.
5. Add manual payment recording and paid-state updates.
6. Replace subscription checks with internal entitlement reads.
7. Delete Stripe-only functions and dead UI code.
8. Regenerate Supabase types.
9. Update tests and docs.

## Acceptance Criteria For The One-Shot Migration

- no frontend code calls a Stripe edge function
- no edge function imports Stripe
- no invoice flow depends on `stripe_invoice_id`
- creating a draft invoice works
- finalizing a draft invoice assigns:
  - a visible invoice number
  - a numeric OCR/payment reference
  - a stored PDF
- the PDF resembles the attached invoice structurally
- the PDF shows Bankgiro details and QR instead of an online payment link
- invoice email attaches the generated PDF
- staff can mark an invoice paid without Stripe
- customer billing pages show the local invoice PDF correctly
- subscription-gated ticket pages no longer depend on Stripe
- `APP_ENV` still works

## Notes From External Guidance

- Bankgirot OCR reference control: [bankgirot.se](https://www.bankgirot.se/en/services/incoming-payments/bankgiro-receivables/ocr-reference-control/)
- Bankgirot invoice layout guidance: [bankgirot.se](https://www.bankgirot.se/en/services/incoming-payments/bankgiro-receivables/right-designed-invoice/)

Those sources are why I recommend separating `invoice_number` from `payment_reference` instead of trying to force `TIN-0004` directly into the Bankgiro/OCR/QR path.
