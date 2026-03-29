# Migration Validation UI Test Plan

## Summary

- Build an on-demand Playwright migration-validation suite that runs only against the migrated test system, not against the old Lovable-backed stack and not against production.
- Use a real IMAP inbox with plus-addressing for the customer email. The concrete pattern should be `e2e-migration+<runId>@<your-test-domain>`. Example: `e2e-migration+20260329T154500@smarthomesolutions.se`.
- Keep the suite stateful and serial: test 1 creates the customer journey, test 2 reuses that same customer. This matches the intended real business journey.
- Treat this as a post-migration validation suite, not per-PR CI. Optimize for reliability and observability over speed.

## Interfaces And Test Inputs

- Add a dedicated e2e env contract:
  - `E2E_BASE_URL`: migrated test deployment URL.
  - `E2E_ALLOWED_SUPABASE_URL`: the new Supabase project URL.
  - `E2E_BLOCKED_SUPABASE_URL`: the old Lovable Supabase URL or project ref to explicitly fail on if any request still hits it.
  - `E2E_STAFF_EMAIL`, `E2E_STAFF_PASSWORD`: seeded staff account on the migrated test system.
  - `E2E_IMAP_HOST`, `E2E_IMAP_PORT`, `E2E_IMAP_USER`, `E2E_IMAP_PASS`, `E2E_IMAP_TLS`: shared inbox access.
  - `E2E_MAIL_FROM_ALIAS_PREFIX`: default `e2e-migration`.
- Add a shared test run context object for:
  - `runId`
  - `customerEmail`
  - `customerPassword`
  - `customerName`
  - `projectName`
  - `quoteIds`
  - `invoiceId`
- Use IMAP helpers, not Supabase admin reads, to fetch:
  - the invite or onboarding email with a `/verify?code=...` link
  - the quote email with the public quote link
  - the invoice email with the Stripe hosted invoice link
- Add a network guard in Playwright that fails the run if any app request targets the old Supabase project or any unexpected Supabase host. This is part of the migration validation, not just test plumbing.

## Implementation Changes

- Create one serial Playwright spec for the two flows plus small helpers for:
  - staff login
  - IMAP polling and HTML link extraction
  - customer email alias generation
  - network allowlist and blocklist enforcement
  - eventual-consistency polling for quote and invoice status changes
- Test 1 should run in this exact order, because of the current app behavior:
  1. Customer submits `/contact` with the generated alias email.
  2. Staff logs in, opens the new contact, and converts it to a customer.
  3. Customer inbox is polled for the latest onboarding or invite email created after conversion.
  4. Customer clicks the verify link, sets a password, and enters the portal.
  5. Customer updates account details on the account page.
  6. Customer fills and saves the home profile, then reloads to confirm persistence.
- Test 2 should reuse the customer from test 1 in the same serial run:
  1. Staff creates a BOM with a unique project name and assigns the customer from test 1.
  2. Staff adds a small stable SKU set, ideally 2 existing SKUs that are unlikely to change in the test catalog.
  3. Staff creates the quote and sends it by email.
  4. Customer reads the quote email from IMAP, opens the public quote page, and requests a revision.
  5. Staff creates a BOM revision, adds one additional SKU, creates the new quote version, and sends it.
  6. Customer reads the updated quote email, opens the newest quote link, and accepts the quote.
  7. Staff creates the invoice from the accepted quote, finalizes it if needed, and emails it.
  8. Customer reads the invoice email, opens the Stripe hosted invoice page, and pays with Stripe test card details in the browser.
  9. Staff verifies the invoice reaches paid status in the app, with polling or reload to wait for the webhook update.
- Prefer assertions on user-visible outcomes plus network destination checks:
  - success banners
  - persisted form values after reload
  - quote version increment and new SKU visibility
  - accepted quote state
  - invoice paid indicator in the quote and invoice UI
  - no requests to the old Supabase project

## Test Cases And Acceptance

- Email-address strategy acceptance:
  - generated alias is unique per run
  - IMAP polling finds the correct message by recipient alias, subject pattern, and test start timestamp
  - extracted links open valid pages in the migrated environment
- Test 1 acceptance:
  - contact submission succeeds
  - contact can be found and converted by staff
  - onboarding email arrives
  - password setup succeeds
  - account save succeeds
  - home profile save succeeds and survives reload
- Test 2 acceptance:
  - BOM can be created and edited
  - first quote email arrives and public revision request works
  - BOM revision can be created and new SKU appears in the reissued quote
  - second quote email arrives and acceptance works
  - invoice email arrives with a valid Stripe payment link
  - Stripe payment succeeds in test mode
  - app eventually shows invoice paid
- Migration-specific acceptance:
  - all Supabase network traffic goes to the new account
  - no edge function or REST request hits the old Lovable project
  - the suite is green on the migrated test system before the production migration is trusted

## Assumptions And Defaults

- Run the suite serially in one spec because test 2 intentionally depends on the customer created in test 1.
- Use a real shared IMAP inbox with plus-addressing. If the mailbox does not support plus aliases, switch to a catch-all e2e subdomain that routes to the same inbox.
- Use the invite email generated after staff conversion as the canonical onboarding email for test 1. The earlier contact-form onboarding email is not reliable for portal access before the customer record exists.
- Keep cleanup best-effort only:
  - attempt to delete the test customer after test 2
  - accept that Stripe test invoices will remain in Stripe
  - do not block the suite on cleanup success
- Because this suite is for migration validation and will not run often, favor explicit waits, traces, screenshots, and verbose failure artifacts over minimizing runtime.
