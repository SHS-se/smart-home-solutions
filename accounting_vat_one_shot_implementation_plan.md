# Accounting and VAT One-Shot Implementation Plan

## Goal

Implement a minimal audit-safe accounting subsystem for Swedish bookkeeping and quarterly VAT.

The subsystem must:

- keep operational objects (`customers`, `quotes`, `invoices`, legacy Stripe data) separate from the ledger
- book domestic sales and purchases with double-entry accounting
- preserve immutable evidence and traceability
- support quarterly VAT review, snapshotting, locking, and filing export
- survive ordinary accountant review without destructive edits or hidden recalculation

## Scope

Included in MVP:

- chart of accounts and VAT codes
- fiscal years, monthly accounting periods, quarterly VAT returns
- verifications, journal entries, journal lines
- evidence storage with checksums and provenance
- supplier and purchase-document workflow
- sales invoice integration from existing invoice flow
- payments and allocations for bank giro / bank settlement
- EU purchase handling in VAT and posting flows
- contextual UI help via small `(i)` info buttons for non-accountant users
- period close/lock, corrections, audit log, integrity checks
- VAT snapshot and versioned JSON export for filing

Explicitly out of scope:

- payroll
- fixed assets/depreciation
- annual report/tax return beyond VAT
- full bank-import automation
- domestic reverse charge, import VAT, and other advanced VAT edge cases beyond ordinary EU purchases
- inventory accounting
- multi-company support
- generic accounting rules engine

## Assumptions To Code Against

- base currency is `SEK`
- amounts are stored in integer minor units (`ore`)
- accounting periods are monthly; VAT returns are quarterly
- sales invoices post when the existing invoice reaches finalized/issued state
- future customer payments are expected via bank giro / bank transfer, not Stripe
- browser automation is downstream only; the accounting truth is the VAT snapshot plus export JSON
- corrections post into the next open period unless finance admin explicitly reopens a period
- an opening-balance verification is required before any live historical posting/backfill

Code the first release for domestic VAT plus ordinary EU purchases. ROT/RUT, domestic reverse charge, and import VAT stay out of scope for now, but the data model should remain extensible for them later.

Stripe should be treated as legacy migration scope only. There is one real Stripe invoice to account for; do not build ongoing Stripe settlement complexity into the normal workflow unless later required again.

The accounting UI must assume the main operator is not an accountant. Core accounting and VAT screens need embedded guidance in plain language, not only technical field labels.

## Core Data Model

### Reference and control

- `accounting_settings`
  - singleton company accounting settings
  - includes base currency, fiscal-year settings, default verification series, default VAT frequency
- `fiscal_years`
  - legal accounting years
- `accounting_periods`
  - monthly periods
  - status: `open`, `review`, `closed`, `locked`, `reopened`
  - store close/lock metadata and integrity hash
- `chart_of_accounts`, `accounts`
  - BAS-derived subset only
- `vat_codes`
  - rate, direction, deductibility, declaration-box mapping, review flag, active date range

### Evidence and audit

- `accounting_documents`
  - one row per uploaded or generated file
  - store storage location, filename, mime type, size, `sha256`, uploader, upload time, origin, OCR data, normalized extraction, user-confirmed data
  - support `is_original_evidence` and `supersedes_document_id`
- `verification_documents`
  - links documents to verifications with roles
- `audit_log`
  - append-only record of sensitive actions

### Ledger

- `verifications`
  - legal/business header
  - includes verification number, series, source type/id, source snapshot, posting/review metadata, reversal reference, idempotency key
- `journal_entries`
  - accounting posting header
  - usually one primary entry per verification
- `journal_entry_lines`
  - account, debit/credit amount, VAT code, tax base, description, counterparty refs, optional dimensions

### Purchases and suppliers

- `suppliers`
  - supplier master data
  - include `f_skatt_registered`
- `purchase_documents`
  - receipt or supplier invoice intake object
  - tracks status, document quality, payable status, due date, totals, notes
- `purchase_document_lines`
  - line-level account mapping and VAT classification

### Sales and payments

- `sales_invoice_links`
  - bridge from existing operational `invoices` into accounting
  - store immutable source snapshot at posting time
- `payments`
  - settlement facts from bank giro, bank transfer, or manual entry, with optional legacy Stripe support for migration
  - include source confidence and external refs
- `payment_allocations`
  - allocate payments to receivables, payables, or direct verifications
- `bank_transactions`
  - optional in MVP, but keep the table so matching can grow later

### VAT

- `vat_returns`
  - quarterly review/filling cycle
- `vat_period_snapshots`
  - immutable quarter snapshot with box totals, rules version, source hash, `posted_until_timestamp`
- `tax_filing_exports`
  - versioned JSON payload derived from approved snapshot
  - store payload hash, approver, and usage metadata

## Hard Invariants

- Posted accounting is append-only.
  - no update/delete for posted `verifications`, `journal_entries`, or `journal_entry_lines`
  - corrections use reversal and adjustment entries only
- Posting is allowed only through controlled service/RPC functions.
  - normal roles may create drafts but may not insert posted rows directly
- Every posted journal entry must balance.
  - enforce `total_debit == total_credit` in the posting transaction at DB level
- Draft data must never affect balances, VAT, or reports.
- Verification numbers are assigned by the system at posting time and are sequential per series/fiscal year.
- Posted entries must belong to an `open` accounting period and have a `posting_date` inside that period.
- Payment allocations must not exceed either the payment amount or the target outstanding amount.
- Historical FX data is stored at posting time and never recomputed.
- Evidence files are immutable.
  - never overwrite binaries in place
  - replacements create new document rows
- Deductible input VAT requires adequate evidence.
  - if only derived/non-original evidence exists, posting must block unless an explicit override with reason is recorded
- VAT is calculated per line and stored using integer minor units.
- Period close and VAT snapshot must store deterministic integrity hashes.
- Integrity failures block period close, VAT snapshot generation, and filing export.

## UI Help Requirements

Reuse the same small `(i)` info-button pattern already used in Enhetskatalog rather than inventing a new help system.

Rules:

- place info buttons next to labels and section headings where accounting or Swedish VAT concepts are not obvious
- open concise plain-language help written for a non-accountant user
- explain both what a field means and how it affects bookkeeping/VAT
- separate "normal case" guidance from "ask an accountant" cases
- keep help text specific to the current screen and action; do not dump generic accounting theory
- use the app's normal translation pattern so the help can be shown in Swedish and English

Minimum screens/fields that need info help in v1:

- purchase document intake
  - supplier
  - document date
  - posting date
  - due date
  - document quality
  - original evidence
  - deductible VAT
  - VAT code
  - EU purchase handling
  - `f_skatt_registered` warning
- sales invoice accounting view
  - when invoice posting happens
  - receivable
  - revenue
  - output VAT
  - bank giro payment matching
- payment matching
  - unmatched payment
  - partial payment
  - payment allocation
  - over-allocation prevention
- period and VAT workflow
  - `open`, `review`, `closed`, `locked`
  - why postings are blocked
  - VAT snapshot
  - filing export
  - corrections after filing
- VAT review screen
  - each declaration box shown in MVP
  - what numbers are derived from
  - which boxes are for EU purchases
  - when a warning means "stop and review"

Help content should use this format wherever possible:

- what this is
- when to use it
- how the system uses it
- common mistake to avoid
- when to ask accountant/reviewer

## Posting Rules

### Purchase paid immediately

- debit expense or asset
- debit deductible input VAT when allowed
- credit bank/card/owner-settlement account

### Supplier invoice on terms

- debit expense or asset
- debit deductible input VAT when allowed
- credit accounts payable

### EU supplier invoice

- debit expense or asset for the net purchase amount
- debit deductible input VAT when allowed
- credit accounts payable
- credit output VAT for the acquisition VAT amount

Use line-level VAT codes so ordinary EU purchases can map to the required VAT boxes without introducing separate domestic reverse-charge logic.

### Supplier payment

- debit accounts payable
- credit bank

### Sales invoice

- debit accounts receivable
- credit revenue
- credit output VAT

### Customer payment via bank giro / bank transfer

- debit bank
- credit accounts receivable

### Legacy Stripe payment, if historical backfill requires it

- debit Stripe clearing
- credit accounts receivable

### Legacy Stripe fee, if historical backfill requires it

- debit transaction-fee expense
- credit Stripe clearing

### Legacy Stripe payout to bank, if historical backfill requires it

- debit bank
- credit Stripe clearing

## Workflow Rules

### Purchase intake

1. Upload file and immediately create `accounting_documents` metadata with checksum and provenance.
2. Run optional OCR/extraction, but keep file as source of truth.
3. Create `purchase_document` in draft.
4. Confirm supplier, dates, totals, payable status, and document quality.
5. Classify each line with expense account and VAT code.
6. Block posting if amounts/VAT do not reconcile, required fields are missing, deductible VAT lacks acceptable evidence, or supplier `f_skatt_registered` risk is not acknowledged.
7. Create draft verification/journal entry and post through controlled posting function.
8. If unpaid, leave payable open and settle later through `payments` and `payment_allocations`.
9. Show contextual `(i)` help on the fields that affect VAT treatment, evidence sufficiency, and supplier-risk warnings.

### Sales invoice integration

1. Keep existing `invoices` as operational source only.
2. When invoice is finalized/issued, snapshot source facts and create `sales_invoice_links`.
3. Post receivable, revenue, and output VAT using idempotency key `(source_type, source_id, event_type)`.
4. For future invoices, settle receivables through bank giro / bank transfer payments matched against the receivable.
5. If the one historical Stripe invoice is backfilled in detail rather than handled through opening balances, treat payment, fee, and payout as separate legacy events and use Stripe event IDs for idempotency.
6. Show contextual `(i)` help explaining when invoice posting happens and how later bank payments settle the receivable.

### Corrections

1. Never edit posted lines.
2. Create reversal, reversal-plus-replacement, or adjusting entry.
3. Cross-reference original verification/journal entry.
4. If original period is closed/locked, correction goes into next open period unless reopened by finance admin.

### VAT cycle

1. Move quarter months into `review`.
2. Resolve flagged purchases, unmatched payments, and ambiguous VAT lines.
3. Gather posted VAT-bearing entries where:
   - `posting_date` is inside the quarter
   - `posted_at <= posted_until_timestamp`
4. Run reconciliation checks before snapshot:
   - debits equal credits
   - receivable control matches open receivables
   - payable control matches open payables
   - VAT control accounts match VAT-derived totals
5. Close the periods.
6. Generate immutable `vat_period_snapshot` with box totals, rules version, source hash, and cutoff timestamp.
7. Require explicit review/approval before generating filing export.
8. Generate versioned `tax_filing_export` JSON from the approved snapshot only.
9. Store filing reference and confirmation artifacts after submission.
10. Lock the periods after filing.
11. Show contextual `(i)` help on VAT boxes, period states, warnings, and correction rules so the operator can understand what the system is doing without external accounting knowledge.

## VAT MVP Rules

- implement domestic VAT plus ordinary EU purchases first
- line-level VAT is mandatory
- store tax base, VAT amount, rate, and VAT code on posted lines
- compute quarter totals from posted lines, not from mutable source objects
- preserve filed values permanently; later corrections do not rewrite prior filed quarters

Minimum declaration support:

- box 05
- box 06
- box 07
- box 08
- box 10
- box 11
- box 12
- box 20
- box 21
- box 22
- box 23
- box 24
- box 42
- box 47
- box 48
- box 49

## Required Reports

- journal / transaction list
- general ledger
- trial balance with reconciliation status
- verification list
- AP aging / open supplier invoices
- AR aging / open customer invoices
- quarterly VAT report with drill-down
- structured VAT filing JSON export
- accountant/auditor export package with evidence manifest

All reports must run from posted data only.

## Build Order

### Phase 1: Foundation

- create settings, fiscal year, period, chart, account, VAT-code, and audit tables
- implement roles/permissions
- implement verification numbering strategy

### Phase 2: Ledger core

- create verifications, journal entries, journal lines
- implement controlled posting functions
- enforce balance, immutability, idempotency, and period rules at DB boundary

### Phase 3: Evidence

- create dedicated private accounting bucket
- create `accounting_documents` and `verification_documents`
- implement immutable upload/link/supersede flow

### Phase 4: Purchases

- create suppliers, purchase documents, purchase lines
- implement draft review/post workflow
- support immediate-payment and payable cases
- add contextual `(i)` help to purchase intake and classification fields

### Phase 5: Payments

- create payments, allocations, and optional bank transaction tables
- implement manual matching
- support bank giro / bank transfer settlement as the standard customer payment path
- add only the minimal Stripe backfill flow needed for the one existing real invoice, if it is not handled via opening balances
- add contextual `(i)` help to payment matching and allocation UI

### Phase 6: Sales integration

- create sales invoice link table
- integrate invoice-finalization posting from existing invoice lifecycle
- snapshot invoice facts at posting time
- implement void/reversal handling
- add contextual `(i)` help to invoice-accounting explanations

### Phase 7: VAT

- create VAT return, snapshot, and filing-export tables
- implement quarter review, reconciliation checks, snapshotting, approval, and JSON export
- add contextual `(i)` help to VAT review, box explanations, warnings, and filing screens

### Phase 8: Locking and operations

- implement close/lock/reopen controls
- implement correction workflows
- implement integrity monitoring job and admin visibility
- finish reports and export package

### Phase 9: Cutover

- post opening balance verification
- backfill only historical items with sufficient evidence, otherwise capture them in opening balances/legacy memo
- attach migration memo and supporting evidence to opening balance verification

## Database Constraints To Implement Early

- unique account number within chart version
- unique VAT code within active scope
- unique verification number within series/fiscal year
- unique idempotency key for source-triggered postings
- posted rows require posting date and period
- posting date must fall within assigned period
- posted inserts blocked for non-open periods
- update/delete blocked on posted accounting rows
- allocation overrun blocked transactionally

## Done When

The implementation is complete when the system can:

- post ordinary domestic purchases and sales into an immutable balanced ledger
- trace every posted event back to evidence
- allocate customer and supplier payments correctly, with bank giro / bank transfer as the default customer-payment flow
- generate a quarterly VAT snapshot and versioned filing JSON from posted data only
- lock the filed quarter and handle later corrections without rewriting history
- guide a non-accountant user through the core purchase, payment, and VAT screens using embedded `(i)` help without requiring outside accounting knowledge for normal cases
