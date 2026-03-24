# Accounting and VAT Implementation Plan

## 1. Executive Summary

### Purpose

This subsystem will add a conservative, audit-ready accounting layer to the existing application so the business can record Swedish business events, preserve supporting evidence, maintain a traceable general ledger, and produce quarterly VAT figures that can be reviewed before filing.

### Immediate business goal

The immediate goal is to make the app operationally ready for Swedish bookkeeping and quarterly VAT handling before the first VAT declaration. "Ready" means:

- sales invoices can flow into accounting in a controlled way
- purchase receipts and supplier invoices can be captured and booked
- every booked event can be traced to evidence
- VAT can be calculated, reviewed, closed per quarter, and reproduced later
- locked periods and correction flows exist so the records survive basic audit scrutiny

### High-level implementation philosophy

- Audit-ready first: prioritize traceability, evidence retention, reproducibility, and reviewability over convenience.
- Append-only accounting: posted accounting records are not edited in place; mistakes are corrected through reversal and adjustment entries.
- Documents linked to entries: the original uploaded file, extraction results, confirmed business facts, verification, journal entry, payment, and VAT period must remain connected.
- VAT-ready, not "fully automated tax intelligence": the system should calculate and report Swedish VAT reliably for the common domestic cases in MVP, while routing ambiguous cases to human review.
- Phased delivery: build the ledger, evidence, expense workflow, invoice integration, VAT snapshots, and locking in deliberate phases rather than trying to ship a full ERP at once.

### Planning assumptions

- The current app already has operational tables and workflows for `customers`, `quotes`, `quote_lines`, `invoices`, `invoice_line_items`, Stripe invoice sync/finalization, and Supabase Storage patterns.
- The accounting subsystem should be separate from those operational objects. Operational records remain the business workflow; accounting records become the legal/audit trail.
- This plan assumes Swedish bookkeeping and VAT practice as reflected in current BFN and Skatteverket guidance reviewed on March 24, 2026. Where classification or VAT treatment depends on business facts, the system should require human review rather than guess.

## 2. Scope and Non-Goals

### In scope for v1

- Core double-entry general ledger
- Swedish-oriented chart of accounts setup based on a chosen BAS-derived account plan
- Fiscal years and accounting periods
- Quarterly VAT periods and VAT return support
- Verifications and verification numbering
- Expense and purchase bookkeeping
- Supplier master data
- Evidence document storage, hashing, metadata, and linkage
- Draft versus posted workflows
- Customer invoice accounting integration from the existing invoice flow
- Payment recording and allocation
- Stripe payment matching for sales invoices
- Manual or semi-manual matching for supplier payments
- Audit logs for important actions
- Period closing and locking
- Exportable review outputs for internal review or external accountant/auditor use
- Seven-year retention design for accounting information and linked evidence

### Out of scope for now

- Payroll and employer declarations
- Full fixed asset module with depreciation schedules
- Annual report generation and filing
- Full tax return generation outside VAT support
- Full bank-import automation for all banks
- OCR perfection or AI-only document classification
- Advanced EU VAT edge cases beyond a clear warning/review path
- Intrastat, OSS/IOSS, triangulation, and complex cross-border chain transactions
- Inventory valuation and COGS automation tied to stock movements
- Full project accounting or cost-center reporting beyond simple dimensions if needed later
- Automated legal judgment without human review
- Multi-company accounting inside the same app instance

### Scope boundary statement

The first release should solve the business's domestic bookkeeping and quarterly VAT readiness problem. It should not attempt to become a complete accounting suite.

## 3. Compliance-Oriented Functional Requirements

The system must satisfy the following business and system requirements:

- Every business event with accounting impact must be recordable.
- Every booked event must have a verification or equivalent supporting basis.
- Digital copies of receipts, invoices, and other supporting documents must be preserved in a retrievable way.
- Original uploaded documents must not be silently overwritten.
- Corrections must preserve visible history of what changed, when, and by whom.
- Posted bookkeeping must be exportable and reviewable outside the app.
- VAT must be calculated from transaction facts, normally at line level where different rates or deductibility rules can apply.
- VAT reporting periods must be closable and reproducible after filing.
- Accounting information must be retained for seven years after the relevant fiscal year end according to Swedish retention rules.
- Booked periods must be lockable so postings and edits cannot drift after review.
- An audit trail must exist for create, update, post, reverse, void, close, lock, unlock, reopen, and export actions.
- The system must support traceability from source event to verification to journal lines to balances to VAT report snapshot.
- Uploaded evidence must store provenance information such as uploader, upload time, storage location, and checksum.
- The system must support a review queue for incomplete or ambiguous documents rather than forcing unreliable automation.
- The system must distinguish document date, posting date, due date, and payment date.
- The system must preserve the filed VAT figures even if later corrections are posted in later periods.
- Posted entries must remain balanced at all times.

## 4. System Design Principles

- Separate operational objects from accounting objects.
  Existing `quotes`, `invoices`, `invoice_events`, Stripe objects, and storage artifacts are upstream sources, not the ledger itself.
- Finalized source events feed the accounting layer.
  A quote draft has no accounting effect. A finalized sales invoice does.
- Immutable or append-only accounting records after posting.
  Drafts may be edited. Posted records are corrected, not mutated.
- Original uploaded files are evidence objects.
  They are not transient UI attachments.
- Preserve source snapshots at posting time.
  The accounting layer should store the relevant source facts used for the posting so later operational edits do not change accounting interpretation.
- Human review where accounting judgment is required.
  The system may suggest accounts and VAT codes, but should not silently decide ambiguous tax treatment.
- Avoid destructive updates.
  Use replacement versions, superseded states, reversal entries, and audit logs instead of overwrite/delete semantics.
- Reproducibility over convenience.
  A VAT snapshot generated today must be reproducible later from locked facts and preserved report metadata.
- Minimize hidden automation.
  Posting logic should be explicit, inspectable, idempotent, and testable.
- Prefer database-enforced invariants for core trust boundaries.
  Balance, uniqueness, posting immutability, and lock constraints should not rely only on UI behavior.

## 5. Proposed Domain Model

### Naming approach

The logical entity names below are written without prefixes for clarity. In implementation, use either:

- `public.accounting_*` style physical names for new accounting tables, or
- a separate `accounting` schema if the team is comfortable extending Supabase tooling around non-public schemas.

For MVP, prefixed tables in `public` are the more pragmatic option because the existing app already lives there.

### Core reference and period entities

| Entity | Why it exists | Major fields | Key relationships | Mutability |
| --- | --- | --- | --- | --- |
| `accounting_settings` | Stores singleton company accounting configuration without over-engineering multi-company support. | legal_name, org_number, vat_number, base_currency, fiscal_year_start_month, default_verification_series, default_vat_frequency, current_chart_version_id | references `chart_of_accounts`, `vat_codes`, `fiscal_years` | Mutable by finance admin only; changes audited |
| `fiscal_years` | Defines legal accounting years and year-end status. | id, code, start_date, end_date, status, closed_at, closed_by | parent of `accounting_periods`, `vat_returns` | Open year mutable; closed year locked except audited reopen |
| `accounting_periods` | Provides month-level control, close discipline, and posting locks even though VAT is quarterly. | fiscal_year_id, period_no, start_date, end_date, status, locked_at, locked_by | belongs to `fiscal_years`; referenced by `journal_entries` and `vat_returns` | Mutable while open; closed/locked states tightly controlled |
| `chart_of_accounts` | Versioned account plan so future changes do not corrupt historical interpretation. | id, name, version, effective_from, effective_to, status | parent of `accounts` | New versions added; old versions preserved |
| `accounts` | Defines ledger accounts and account behavior. | chart_id, account_no, name, account_type, normal_balance, is_active, allow_manual_posting, vat_category_hint | referenced by `journal_entry_lines`, posting rules, reports | Mutable while active; historical rows preserved, no renumbering in place |
| `vat_codes` | Encapsulates VAT logic and reporting mapping. | code, description, rate, direction, deductibility_percent, declaration_box_map, reverse_charge_flag, active_from, active_to, requires_review | referenced by purchase lines, invoice lines, journal lines, VAT snapshots | Version by new row/effective dates; avoid destructive edits |

### Verification and evidence entities

| Entity | Why it exists | Major fields | Key relationships | Mutability |
| --- | --- | --- | --- | --- |
| `verifications` | Legal/accounting header for a booked business event; carries numbering and traceability. | verification_no, series, fiscal_year_id, accounting_period_id, status, document_date, posting_date, description, source_type, source_id, source_snapshot_json, created_by, posted_by, posted_at, reversal_of_verification_id | parent of `journal_entries`; linked to `verification_documents` | Draft editable; posted immutable except status transitions like reversed |
| `journal_entries` | Posting header for a verification. Keeps accounting state separate from evidence and source references. In MVP this should usually be one primary journal entry per verification. | verification_id, status, posting_date, currency, total_debit, total_credit, posted_at, posted_by, reversal_of_journal_entry_id | belongs to `verifications`; parent of `journal_entry_lines` | Draft editable; posted immutable |
| `journal_entry_lines` | The actual debit and credit postings that make up the ledger. | journal_entry_id, line_no, account_id, debit_amount, credit_amount, line_description, vat_code_id, tax_base_amount, counterparty_type, counterparty_id, dimension_json | belongs to `journal_entries`; references `accounts`, `vat_codes`, counterparties | Immutable after posting |
| `accounting_documents` | Canonical metadata row for each evidence file and derivative extraction artifact. | document_type, original_filename, storage_bucket, storage_path, mime_type, size_bytes, sha256, uploaded_at, uploaded_by, source_origin, source_ref, ocr_raw_json, extracted_normalized_json, user_confirmed_json, supersedes_document_id, retention_until | linked to `verification_documents`, `purchase_documents`, and sales-side source records | Binary never replaced in place; metadata append-only except enrichment fields with audit |
| `verification_documents` | Join table linking one verification to one or more documents with roles. | verification_id, document_id, role, linked_at, linked_by | belongs to `verifications` and `accounting_documents` | Additive only; unlink requires audited supersede flow |
| `audit_log` | Cross-cutting record of sensitive actions. | entity_type, entity_id, action, actor_id, actor_type, reason, occurred_at, before_json, after_json, request_id, external_ref | references many entities logically | Append-only, never updated |

### Purchase and supplier entities

| Entity | Why it exists | Major fields | Key relationships | Mutability |
| --- | --- | --- | --- | --- |
| `suppliers` | Counterparty master data for expenses and supplier invoices. | name, org_number, vat_number, address fields, payment_terms_days, default_expense_account_id, default_vat_code_id, f_skatt_registered, active | parent of `purchase_documents`, linked to `payments` | Mutable, but key master-data changes audited |
| `purchase_documents` | Represents a receipt, simplified invoice, or supplier invoice before and after bookkeeping. More precise than a generic `expenses` table. | supplier_id, primary_document_id, external_invoice_no, receipt_no, document_date, received_date, currency, gross_amount, net_amount, vat_amount, status, document_quality_status, payable_status, due_date, description, created_from, review_notes | links to `accounting_documents`, `verifications`, `payments`, `payment_allocations` | Draft and reviewed states editable; after posting mostly locked with additive links |
| `purchase_document_lines` | Holds line-level classification, VAT, and account mapping. | purchase_document_id, description, qty, unit_amount, net_amount, vat_amount, gross_amount, expense_account_id, vat_code_id, cost_center, needs_review | belongs to `purchase_documents` | Editable until posting; then locked |

### Sales entities and payment entities

| Entity | Why it exists | Major fields | Key relationships | Mutability |
| --- | --- | --- | --- | --- |
| `customers` | Existing operational customer master used on the sales side. It remains a business object, but accounting needs stable linkage to it for receivables and audit traceability. | id, billing details, contact linkage, test/live markers, customer identity fields from existing views | existing source for `invoices`; referenced indirectly by `sales_invoice_links`, `payments`, and ledger reports | Mutable operational record; accounting must snapshot the relevant facts at posting time |
| `sales_invoices` | Existing operational `invoices` table that represents customer invoices, numbering, due dates, Stripe ids, and lifecycle state. It is accounting-relevant once finalized, but is not itself the ledger. | operational invoice id, customer_id, invoice_number, due_date, status, amount, issued/finalized/paid/voided timestamps, Stripe references | source for `sales_invoice_links`, `payments`, and accounting posting | Mutable operational record; accounting uses immutable snapshots, not live values |
| `sales_invoice_links` | Bridges existing operational sales invoices to accounting-specific interpretation without mutating the operational invoice model into a ledger model. | operational_invoice_id, verification_id, source_snapshot_json, revenue_recognition_status, posted_at | links existing `sales_invoices` to `verifications` | Additive, mostly immutable after posting |
| `payments` | Canonical payment record from bank, Stripe, cash, card, or manual entry. | payment_date, amount, currency, method, direction, external_ref, source_system, payer_or_payee_type, payer_or_payee_id, status, bank_transaction_id, stripe_event_id, created_by | linked to `payment_allocations`, `bank_transactions`, `verifications` | Can remain draft/unmatched; matched/posted payment facts become locked |
| `payment_allocations` | Resolves payments against invoices, supplier liabilities, or reimbursements. | payment_id, target_type, target_id, allocated_amount, allocated_at, allocation_status | belongs to `payments`; targets `purchase_documents`, `sales_invoice_links`, or direct `verifications` | Additive adjustments; prior allocations should be reversed, not overwritten |
| `bank_transactions` | Stores imported or manually entered bank statement lines and later enables reconciliation. | booking_date, value_date, amount, currency, description, reference, account_identifier, import_batch_id, match_status, raw_payload_json | linked to `payments` and reconciliation workflows | Raw imported facts immutable; matching state audited |

### VAT entities

| Entity | Why it exists | Major fields | Key relationships | Mutability |
| --- | --- | --- | --- | --- |
| `vat_returns` | Represents one quarterly VAT return review and filing cycle. | fiscal_year_id, quarter, period_start, period_end, status, generated_at, generated_by, reviewed_at, filed_at, filed_by, filing_reference, notes | parent of `vat_period_snapshots`; linked to included posted entries | Draft mutable; filed rows locked except amendment metadata |
| `vat_period_snapshots` | Immutable preserved output of what was included and what values were shown at filing/review time. | vat_return_id, snapshot_version, included_entry_ids_json, box_totals_json, source_hash, generated_from_posted_until, generation_rules_version, created_at | belongs to `vat_returns` | Append-only; once created never edited |

### Existing operational entities to integrate, not replace

- `customers` and `customers_with_identity`
- `quotes` and `quote_lines`
- `invoices`, `invoice_line_items`, `invoice_events`, and existing Stripe flows
- existing storage metadata patterns such as `ticket_attachments` and `home_photos`

These remain operational sources. They should not become accounting tables by incremental mutation.

## 6. Data Integrity and Auditability Requirements

### Evidence integrity

- Every uploaded evidence file must get a stable `accounting_documents` row before it is used in bookkeeping.
- Store a strong checksum such as SHA-256 for every uploaded binary.
- Store original filename, mime type, byte size, upload timestamp, uploader identity, and storage location.
- Never replace the original binary in place.
- If a user uploads a corrected scan or a clearer image, create a new document row and link it as `supersedes_document_id` or via `verification_documents.role`.
- Preserve the original evidence file even when a replacement version is added.

### Record immutability

- Posted `verifications`, `journal_entries`, and `journal_entry_lines` must not support hard delete.
- Posted accounting records should not support general update operations.
- Corrections must be modeled as:
  - reversal entry
  - adjusting entry
  - replacement verification with clear cross-reference
- Draft accounting records may be editable, but those edits should still be auditable if the record is likely to become part of the accounting trail.

### Traceability chain

The system must preserve and expose the following chain:

`source document -> document metadata -> purchase/sales source record -> verification -> journal entry -> journal entry lines -> payment/payment allocation -> VAT return snapshot`

This chain must be queryable from any point:

- from a document, find the verification and ledger impact
- from a journal line, find the underlying evidence
- from a VAT box total, find included transactions
- from a payment, find the liability/receivable it settled

### Audit logging

Audit log coverage should include at minimum:

- create draft verification
- update draft verification
- upload document
- replace/supersede document
- post journal entry
- reverse journal entry
- void or cancel accounting-related draft objects
- match or unmatch payment
- close period
- lock period
- unlock or reopen period
- generate VAT snapshot
- mark VAT return as filed
- export reports or evidence package

### Permissions

Recommended initial roles:

- `finance_admin`: manage chart, VAT codes, periods, reopen/lock/export, full evidence access
- `finance_user`: upload evidence, classify drafts, post entries, match payments, generate review reports
- `staff_user`: limited operational access, possibly allowed to upload expense evidence and create draft intake items only
- `system_actor`: Stripe webhooks and background jobs, limited to source-event creation and idempotent sync

### Delete policy

- No delete for posted accounting records
- No delete for accounting evidence documents
- Drafts should prefer `discarded`, `cancelled`, or `superseded` states over deletion
- If a rare administrative hard-delete path is ever needed for malformed unattached uploads, it should be postponed until after MVP and heavily audited

## 7. Accounting Workflow Design

### Expense receipt workflow

1. User uploads receipt or supplier invoice.
2. System creates an `accounting_documents` row immediately and stores checksum, uploader, upload time, and storage path.
3. System optionally performs OCR or extraction and stores raw output plus normalized candidate fields.
4. User or finance staff confirms:
   - supplier
   - document date
   - description
   - currency
   - gross amount
   - net amount
   - VAT amount
   - due date, if supplier invoice
   - whether the receipt is sufficient for deductible VAT
5. System assigns or creates a `purchase_document` in `draft` state.
6. User classifies each line with expense account and VAT code, or accepts suggestions.
7. System validates:
   - amounts add up
   - VAT code is consistent with rate
   - missing supplier or missing document quality is flagged
   - if simplified receipt/full invoice rules are relevant, warn accordingly
8. System creates a draft `verification` and draft `journal_entry`.
9. Finance user posts the entry.
10. On posting:
    - verification number is assigned
    - journal entry is locked
    - line balances are checked
    - the posting is attached to an accounting period
11. The document is marked:
    - `paid_immediately` if settled at purchase time
    - `payable_open` if awaiting payment
12. Later, payment is matched through `payments` and `payment_allocations`.

### Sales invoice workflow

1. Staff creates and finalizes a business invoice using the existing quote/invoice flow.
2. Existing operational objects remain the source of truth for the customer-facing invoice lifecycle.
3. When the invoice reaches the accounting trigger state, recommended as finalized/issued and not merely drafted:
   - system snapshots relevant invoice facts
   - system creates a `sales_invoice_links` row
   - system creates a draft or auto-posted verification based on configured policy
4. Posting creates:
   - debit accounts receivable
   - credit revenue account(s)
   - credit output VAT account(s)
5. Stripe or bank payment events create `payments`.
6. Payment is matched to the receivable through `payment_allocations`.
7. If Stripe fees are present, they must be booked explicitly, ideally via a clearing-account flow rather than hidden netting.

### Correction workflow

1. User identifies an error in a posted record.
2. System does not allow direct edit of posted journal lines.
3. User chooses:
   - full reversal
   - reversal plus replacement
   - adjusting entry
4. System creates a new verification referencing the original.
5. Original record remains visible and linked.
6. Audit log captures reason, actor, and timestamp.
7. If the original period is locked or VAT-filed, correction posts into the next allowed open period unless a controlled reopen occurs.

### VAT period workflow

1. Finance user selects the quarter.
2. System gathers all posted entries with VAT impact whose posting date falls in the quarter.
3. System runs completeness and integrity checks:
   - unposted purchase documents
   - unmatched invoice states
   - ambiguous VAT-coded lines
   - documents missing evidence or review flags
4. System generates draft VAT totals and a `vat_returns` record in `draft`.
5. System generates an immutable `vat_period_snapshot` containing:
   - included entries
   - box totals
   - generation timestamp
   - rules version
   - source hash
6. Finance user reviews and confirms the values for filing.
7. Once filed, system marks the VAT return as `filed` and preserves the filed values.
8. The quarter's accounting periods are closed or locked according to policy.
9. Later corrections affecting that quarter are handled via future-period adjustments, not by rewriting the filed snapshot.

### Document retention workflow

1. Evidence is uploaded to a dedicated private accounting bucket.
2. Metadata, hash, provenance, and link records are stored.
3. Backup and restore policy covers both database metadata and storage binaries.
4. Retrieval UI supports lookup by:
   - verification number
   - supplier
   - customer invoice number
   - period
   - amount
   - checksum
5. Retention runs for at least the required Swedish period.
6. Operational cleanup jobs must not touch accounting evidence.

## 8. Posting Model / Double-Entry Logic

### Core posting model

- Use standard double-entry bookkeeping.
- Every posted journal entry must have at least two lines.
- Sum of debits must equal sum of credits for each posted entry.
- A `verification` is the business/legal header.
- A `journal_entry` is the accounting posting attached to that verification.
- `journal_entry_lines` carry account, amount, debit/credit side, VAT metadata, and optional dimension data.

### State model

- `draft`: editable, not part of the official ledger
- `posted`: part of the official ledger, immutable
- `reversed`: original remains posted, but a reversing entry exists
- `cancelled` or `discarded`: only for drafts, never for posted entries

### Dates that must be separate

- `document_date`: date on receipt or invoice
- `posting_date`: date used for accounting period and VAT period assignment
- `due_date`: payment due date for receivables/payables
- `payment_date`: actual settlement date
- `uploaded_at`: evidence arrival timestamp
- `posted_at`: timestamp the system committed the entry

### Typical posting patterns for MVP

#### Purchase paid immediately

- debit expense or asset account
- debit deductible input VAT account as applicable
- credit bank/card/owner-settlement account

#### Supplier invoice on terms

- debit expense or asset account
- debit deductible input VAT account as applicable
- credit accounts payable

#### Supplier payment

- debit accounts payable
- credit bank

#### Sales invoice

- debit accounts receivable
- credit revenue
- credit output VAT

#### Customer payment via Stripe

- debit Stripe clearing or bank-in-transit
- credit accounts receivable

#### Stripe fee

- debit bank/transaction fee expense
- credit Stripe clearing

This avoids hiding fees inside net receipts and makes reconciliation easier.

### Reversal and adjustment rules

- No direct editing of posted lines
- Reversal entry should mirror the original amounts with opposite sides
- Adjustment entry should correct only the difference
- Reversal and adjustment entries must cross-reference the original verification or journal entry

### Configurable versus hard-coded posting rules

For MVP, do not build a generic rules engine.

Recommended split:

- Hard-code workflow-specific posting orchestration in application services or RPCs
- Keep the following configurable in tables or admin settings:
  - default revenue account
  - default expense accounts by supplier/category
  - VAT code mappings
  - payment clearing accounts
  - receivable and payable control accounts
- Keep the following non-configurable at runtime:
  - balance enforcement
  - posting immutability
  - locked-period checks
  - mandatory verification linkage
  - audit logging

This gives flexibility where needed without creating an unreviewable mini-ERP rule engine.

## 9. VAT Design

### VAT code structure

Each VAT-sensitive line should reference a `vat_code`, not only a raw rate. A VAT code should express:

- tax rate: for example 25, 12, 6, or 0
- direction: input or output
- declaration mapping: which VAT box or boxes are affected
- deductibility percent: 0, partial, or full
- reverse-charge behavior where relevant
- review requirement flag

### Rate handling

- Store VAT rates as explicit numeric values, not implied from account number
- Preserve the exact rate used at posting time
- Use line-level VAT for mixed-rate documents
- Derive document-level totals from lines, not the other way around

### Input versus output VAT

- Output VAT is created from sales postings
- Input VAT is created from purchases only when documentation and business use support deductibility
- Non-deductible VAT should be posted either:
  - entirely to expense, or
  - split between deductible VAT and non-deductible cost, depending on the case

### Per-line versus document-level handling

MVP should support line-level VAT because the following are realistic:

- invoices with multiple VAT rates
- partially deductible expenses
- mixed-content purchases
- Stripe or service documents where fee and tax treatment can differ

### Simplified receipts versus full invoices

Current Skatteverket guidance allows simplified invoices in some cases, including when the total amount does not exceed 4,000 SEK including VAT. This matters for VAT deductibility.

System behavior should be:

- store a `document_quality_status` such as `full_invoice`, `simplified_invoice`, `insufficient`, `manual_override`
- if the document is above the simplified-invoice threshold and lacks full-invoice details, flag for review before allowing deductible input VAT
- allow booking of the expense even when VAT is not deductible
- require explicit reason for any manual override

### Incomplete or ambiguous documents

If a receipt is incomplete or ambiguous:

- allow the business event to be captured
- do not auto-claim input VAT
- place the item in a review queue
- support posting with non-deductible treatment if the business chooses to proceed

### Quarterly VAT periods

- Use calendar quarters for VAT returns:
  - Q1: January-March
  - Q2: April-June
  - Q3: July-September
  - Q4: October-December
- Store filing due date as data, not hard-coded logic, because due dates depend on registration circumstances
- Note on filing frequency: Swedish businesses with annual taxable turnover above 40 MSEK must file monthly. Businesses below that threshold typically file quarterly. Some businesses voluntarily file monthly. The system's `accounting_settings` or `vat_returns` frequency configuration should support both quarterly and monthly VAT periods even if the MVP only exercises quarterly.

### VAT snapshots for filed returns

For each quarterly return preserve:

- generated totals by declaration box
- included posted entry ids
- source hash
- generation time
- filer/reviewer identity
- any manual adjustment note entered before filing

### Corrections after filing

- Do not rewrite a filed quarter
- Post correction in the next open period unless the quarter is formally reopened
- Preserve a link from the correction to the originally affected quarter
- Allow a later amended snapshot if the business chooses to refile or document adjustment reasoning

### ROT/RUT deductions

ROT (rotavdrag) and RUT (rutavdrag) are Swedish tax deductions for qualifying labor on residential properties. They are highly relevant for any business billing labor for home installation, renovation, or home-service work.

Under the system:

- The customer is entitled to deduct 30% (ROT) or 50% (RUT) of the qualifying labor cost directly from the invoice.
- The business invoices the customer for only the post-deduction amount.
- The business then claims the deduction directly from Skatteverket.

VAT applies to the full labor cost before the deduction, meaning the customer still pays VAT on the full labor amount even though they pay reduced cash.

Typical posting for a ROT invoice:

- debit accounts receivable (customer portion)
- debit accounts receivable – Skatteverket ROT claim
- credit revenue (full labor cost)
- credit output VAT (on full labor cost)

The business must track:

- whether each labor line is ROT-qualifying
- the ROT-deductible percentage per line
- the outstanding Skatteverket receivable separately from the customer receivable
- payment of the ROT claim from Skatteverket as a separate settlement event

**Decision required before implementation**: Confirm with the business owner whether the company performs qualifying ROT/RUT work. If yes, the invoice model, posting logic, and receivable tracking must account for split receivables at the outset, as retrofitting this later is difficult.

### Recommended VAT box scope for MVP

MVP should at least support the common boxes needed for domestic sales and ordinary purchases, matching the Swedish momsdeklaration (SKV 4700):

- box 05: total taxable domestic sales excluding VAT (sum of boxes 06–08)
- box 06: taxable sales at 25%
- box 07: taxable sales at 12%
- box 08: taxable sales at 6%
- box 10: output VAT at 25%
- box 11: output VAT at 12%
- box 12: output VAT at 6%
- box 42: VAT-exempt sales (zero-rated exports, etc.)
- box 47: corrections and rounding adjustments
- box 48: deductible input VAT
- box 49: VAT payable or refundable

Box 05 should always be derived as the sum of 06 + 07 + 08, never entered independently.

If the business expects reverse charge, EU purchases, or import VAT before MVP release, then also include:

- box 20: purchases of services from other EU countries (reverse charge)
- box 21: purchases of goods from other EU countries (acquisition VAT)
- boxes 22, 23, 24: acquisition VAT by rate (25%, 12%, 6%)
- box 30: purchases of services from outside the EU (reverse charge)
- box 31: domestic reverse charge purchases (e.g. construction services)
- boxes 32, 33, 34: reverse-charge VAT on box 31 purchases by rate
- box 35: import VAT reported to Skatteverket
- boxes 36, 37, 38: import VAT by rate

The SKV 4700 form ends at box 49. There are no boxes 50, 60–62 or higher in the standard Swedish momsdeklaration.

Otherwise design the `vat_codes` model for them now but postpone UI/reporting depth until after MVP.

## 10. Document and Receipt Storage Design

### What must be stored for each uploaded accounting document

- original file binary
- original filename
- mime type
- file size
- storage bucket
- storage path
- checksum/hash
- upload timestamp
- uploader identity
- source/origin:
  - staff upload
  - customer upload
  - Stripe download
  - email ingestion
  - manual import
- OCR raw extraction payload
- normalized extracted fields
- user-confirmed fields
- document type:
  - purchase receipt
  - supplier invoice
  - customer invoice PDF
  - credit note
  - bank support
  - contract/supporting document
- relation to verification, purchase document, or sales invoice

### Storage rules

- Use a dedicated private storage bucket for accounting evidence, separate from temporary invoice PDF caches and unrelated attachments.
- Never replace an existing binary in place.
- Every new upload or replacement creates a new `accounting_documents` row and a new object path.
- Preserve the original evidence object even if a later version is clearer or corrected.
- Treat OCR output and normalized extraction as derived metadata, not as a replacement for the file itself.
- Store a stable checksum to detect duplicates and support audit validation.

### Suggested storage path shape

Example only:

`accounting-evidence/{fiscal_year}/{document_type}/{document_id}/{uploaded_at_iso}_{safe_filename}`

The important point is immutability and deterministic retrieval, not the exact path format.

### Retrieval requirements

The app should make it easy to retrieve:

- the exact evidence used for a posting
- all evidence for a quarter
- all evidence linked to a supplier
- all evidence included in a VAT snapshot export

### Retention note

BFN guidance after the July 1, 2024 rule change allows destruction of original paper after compliant transfer in some cases, but the system should still behave conservatively:

- keep the uploaded digital original
- do not rely on destructive cleanup
- preserve evidence lineage inside the app even if the physical paper is later discarded outside the app

## 11. Period Closing and Locking

### Fiscal years

- One fiscal year per legal accounting year
- Statuses:
  - `open`
  - `year_end_in_progress`
  - `closed`

### Accounting periods

Recommended MVP choice:

- use monthly accounting periods for operational control
- use separate quarterly VAT returns that aggregate posted entries across three monthly periods

This is stricter than quarter-only bookkeeping but far more manageable for review and corrections.

### Period states

Recommended period states:

- `open`: normal posting allowed
- `closed`: reviewed, no ordinary posting or editing
- `locked`: hard lock after VAT filing or year-end close
- `reopened`: exceptional administrative state, should be rare and audited

### Lock rules

- New postings cannot use a locked period
- Drafts cannot be posted into a closed or locked period
- Evidence can still be uploaded after close, but any posting must go to an allowed period or follow a reopen process
- Report exports remain available for all periods regardless of status

### What can still happen after close

- read access
- exports
- creation of correction proposals referencing earlier periods
- evidence linkage to support later explanations, if done through additive metadata and audit logs

### Corrections after close

- Default rule: correction posts in the next open period
- If a filed quarter is affected, preserve the old filed snapshot and show the correction separately
- Do not silently move or rewrite original entries

### Reopening policy

If reopening is supported at all:

- restrict to `finance_admin`
- require a reason
- create an `audit_log` entry
- record who reopened, when, and which period
- ideally require explicit close again after the corrective work is finished

The safer default is "reopen rarely and only under explicit finance control."

## 12. Reporting Requirements

### Essential MVP reports

- Journal / transaction list
  - filter by date, period, verification number, account, supplier, customer
- General ledger
  - account activity and running balance
- Verification list
  - verification number, dates, description, source, totals, linked evidence count
- VAT report by quarter
  - declaration-box totals
  - drill-down to included entries
- Unpaid supplier invoices / payable overview
  - supplier, due date, amount outstanding
- Paid/unpaid customer invoices / receivable overview
  - invoice number, customer, due date, payment state, outstanding amount
- Account balances / trial-balance style overview
- Export package for audit or external accountant
  - CSV or similar tabular exports
  - evidence manifest
  - linked PDFs/images where feasible

### Recommended later-phase reports

- SIE export for external accounting migration/interoperability (SKV SIE4 format; high priority if company uses an external accountant)
- richer VAT exception reports
- supplier spend by category
- cash-basis versus accrual comparison if ever needed
- year-end and annual statement support
- asset register and depreciation reports

### Report design requirements

- Reports must be reproducible from posted data only
- Reports must clearly indicate whether they include draft items
- Default reports should exclude drafts
- Every report should show generation timestamp and user

## 13. Implementation Phases

### Phase 0: Discovery, rule confirmation, design approval

**Objective**

Confirm accounting policy choices and approve the implementation design before schema work begins.

**Included features**

- confirm fiscal year structure
- confirm chart-of-accounts basis
- confirm VAT box scope for MVP
- confirm sales invoice posting trigger
- confirm expense review policy
- confirm lock/reopen policy
- confirm retention and export expectations

**Dependencies**

- business owner input
- accountant or finance-review input where needed
- approval of this plan

**Acceptance criteria**

- open questions resolved or explicitly deferred
- documented MVP scope approved
- posting examples approved
- migration policy for existing invoices agreed

**Risks / open questions**

- unresolved BAS account mapping
- ambiguity around Stripe fee treatment
- scope creep into payroll or annual reporting

### Phase 1: Core ledger and reference data

**Objective**

Create the accounting foundation that all later workflows depend on.

**Included features**

- `accounting_settings`
- `fiscal_years`
- `accounting_periods`
- `chart_of_accounts`
- `accounts`
- `vat_codes`
- `audit_log` skeleton
- verification number sequencing design

**Dependencies**

- Phase 0 approval

**Acceptance criteria**

- accounts can be configured and versioned
- periods exist and support open/closed states
- VAT codes can express the required domestic scenarios
- verification numbering approach approved and testable

**Risks / open questions**

- choosing account numbering and account type conventions
- deciding whether to reuse or extend the existing `document_sequences` pattern

### Phase 2: Evidence storage and verification workflow

**Objective**

Make evidence capture and verification creation trustworthy before expense posting begins.

**Included features**

- dedicated accounting evidence bucket
- `accounting_documents`
- checksum and provenance handling
- OCR metadata storage
- `verifications`
- `verification_documents`
- draft verification UI

**Dependencies**

- Phase 1

**Acceptance criteria**

- a file upload creates immutable evidence metadata
- evidence can be linked to a draft verification
- a verification can carry source metadata and references
- superseding a document creates a new version rather than overwrite

**Risks / open questions**

- storage path design
- access control for evidence files
- how much extraction automation to ship in MVP

### Phase 3: Expense bookkeeping and supplier flow

**Objective**

Support domestic purchase bookkeeping with evidence-first workflow.

**Included features**

- `suppliers`
- `purchase_documents`
- `purchase_document_lines`
- draft-to-posted purchase verification flow
- payable versus paid-at-purchase handling
- basic purchase validation and review queue

**Dependencies**

- Phase 2

**Acceptance criteria**

- a receipt or supplier invoice can be uploaded, classified, and posted
- posted purchase entry is balanced and immutable
- payable status is tracked
- evidence is retrievable from the posted entry

**Risks / open questions**

- mixed VAT/deductibility cases
- staff reimbursement versus direct company purchase handling

### Phase 4: Payment capture and matching

**Objective**

Connect ledger liabilities/receivables to settlement events.

**Included features**

- `payments`
- `payment_allocations`
- optional minimal `bank_transactions`
- manual payment matching UI
- Stripe payment ingestion support for accounting allocation

**Dependencies**

- Phase 3 for supplier side
- existing invoice and Stripe flows for customer side

**Acceptance criteria**

- supplier payment can settle an open payable
- customer payment can settle an open receivable
- partial payments can be represented
- unmatched payments remain visible and reviewable

**Risks / open questions**

- Stripe payout timing
- net versus gross settlement modeling
- bank import scope for MVP

### Phase 5: Sales invoice accounting integration

**Objective**

Turn the existing operational invoice flow into posted accounting events without turning the operational invoice tables into the ledger.

**Included features**

- `sales_invoice_links`
- source snapshotting from existing `invoices` and `invoice_line_items`
- revenue/output-VAT posting logic
- idempotent invoice posting
- invoice void/reversal handling rules

**Dependencies**

- Phase 1
- existing invoice lifecycle understanding
- Phase 4 for payment allocation completeness

**Acceptance criteria**

- finalized/issued sales invoices create reproducible accounting entries
- receivable and output VAT are booked correctly
- duplicate postings from repeated webhooks or retries are prevented
- void or correction flow preserves history

**Risks / open questions**

- exact posting trigger: finalize versus send versus open
- legacy invoices already in the app
- treatment of invoice regeneration or voiding after posting

### Phase 6: VAT quarter handling and reporting

**Objective**

Generate reviewable quarterly VAT figures and preserve filed snapshots.

**Included features**

- `vat_returns`
- `vat_period_snapshots`
- VAT validation checks
- declaration-box mapping
- quarter review UI
- VAT drill-down report

**Dependencies**

- Phases 3 through 5

**Acceptance criteria**

- posted VAT-bearing entries for a quarter can be gathered deterministically
- box totals are generated consistently
- a filed quarter preserves snapshot values and included entries
- later corrections do not rewrite the filed snapshot

**Risks / open questions**

- whether MVP supports only domestic boxes or also reverse-charge/import boxes
- whether output is advisory only or filing-ready enough to upload elsewhere

### Phase 7: Locking, corrections, exports, and rollout hardening

**Objective**

Make the subsystem safe to operate in production before the first filing cycle.

**Included features**

- close/lock/reopen controls
- correction and reversal flows
- audit export package
- report polish
- migration/backfill support for existing invoices and documents
- production checklist and runbook

**Dependencies**

- Phases 1 through 6

**Acceptance criteria**

- locked periods reject new postings
- correction flows work without destructive edits
- export package is usable by an accountant or auditor
- known legacy data is either backfilled or explicitly excluded with documentation

**Risks / open questions**

- incomplete historical evidence
- operational readiness of finance users
- hidden dependencies on existing invoice state transitions

## 14. Database and Migration Planning

### Recommended migration order

1. accounting configuration and period tables
2. chart of accounts and VAT code tables
3. evidence metadata tables and storage policies
4. verification and journal tables
5. supplier and purchase tables
6. payment and allocation tables
7. sales invoice link tables
8. VAT return and snapshot tables
9. reporting views and export support
10. lock enforcement and audit hardening

### Foundational tables first

Do not start with OCR or UI. Start with:

- accounts
- periods
- VAT codes
- verifications
- journal entries
- journal lines

Without these, later workflows will hard-code too much logic in the wrong place.

### Backfill strategy for existing invoices and documents

- Identify the earliest fiscal date that must be represented in-app for the first VAT declaration.
- Backfill existing operational `invoices` that belong in that period.
- For each existing invoice:
  - snapshot relevant invoice data
  - create accounting link record
  - create posted sales verification only if source data is complete enough
- If historical completeness is poor, use an opening-balance or legacy-import strategy rather than pretending old data is fully auditable.
- If existing invoice PDFs are only stored as remote URLs or temporary cache artifacts, document whether the stored artifact is:
  - original evidence
  - regenerated derivative
  - missing

### Constraints and indexes

Recommended constraints:

- unique account number within chart version
- unique verification number within series and fiscal year
- unique VAT code within active version scope
- unique idempotency key for accounting postings from a given source event
- check constraint that posted entries have posting date and period
- check constraint that draft entries cannot be attached to locked periods

Recommended indexes:

- `journal_entries(posting_date)`
- `journal_entries(accounting_period_id, status)`
- `journal_entry_lines(account_id, posting_date via parent join helper view)`
- `verifications(verification_no)`
- `purchase_documents(supplier_id, document_date, status)`
- `payments(payment_date, status, source_system)`
- `payment_allocations(target_type, target_id)`
- `vat_returns(fiscal_year_id, quarter, status)`
- `accounting_documents(sha256)`
- `accounting_documents(uploaded_at, document_type)`

### Foreign keys

Use explicit foreign keys for:

- period and fiscal-year membership
- verification to journal entry
- journal lines to accounts
- purchase documents to suppliers
- payments to bank transactions where applicable
- VAT snapshots to VAT returns
- document linkage tables

### State transition enforcement

Core state transitions should be enforced by a combination of:

- application service layer or RPCs for business workflow
- database checks/triggers for trust boundaries

### Triggers versus application logic

Recommended approach:

- Use application services or SQL functions/RPCs for posting workflows, because posting usually spans several tables and validations.
- Use narrow database triggers only for invariants such as:
  - preventing updates to immutable posted rows
  - recording `updated_at` where still appropriate
  - audit log inserts for lock/reopen operations if not already handled by service layer
- Avoid large trigger chains that create hidden side effects.

### Append-only concerns

- prefer insert-only correction records
- do not model "latest amount" by updating posted lines
- if a document is replaced, create a new row and link it, do not mutate the original row into the new one

### Avoiding recursion and unsafe Postgres triggers

- do not use triggers that update the same table row repeatedly
- avoid trigger-driven posting orchestration across many tables
- prefer explicit functions for multi-row posting operations
- if balance validation needs deferred checks, use deferrable constraints or end-of-transaction validation logic rather than recursive write triggers

## 15. Integration Considerations

### General integration rule

Operational objects are not accounting records unless and until a defined trigger posts them into the accounting subsystem.

### BOMs

- BOMs remain operational/pricing artifacts
- they may influence quote and invoice line composition
- they do not create accounting entries directly

### Quotes

- quotes remain sales workflow objects
- accepted quotes alone should not create ledger impact in MVP
- a quote becomes accounting-relevant only once it results in a finalized invoice or another clearly defined accounting event

### Invoices

- existing `invoices` remain the operational customer invoice table
- accounting uses a snapshot of invoice facts at posting time
- invoice status changes after posting should create accounting actions only when they represent real business events, such as payment, credit, or void requiring reversal logic

### Stripe

- Stripe should remain an external source system, not the ledger
- use Stripe event ids for idempotency where possible
- separate:
  - invoice creation/finalization
  - payment confirmation
  - fee recognition
  - payout settlement
- do not infer all accounting from a single mutable invoice status field

### File storage

- reuse Supabase Storage patterns already present in the app
- do not reuse temporary invoice PDF caches as the accounting evidence model
- accounting evidence needs stronger immutability and metadata than current temporary cache buckets

### Customers and suppliers

- continue using existing `customers` and related views for sales-side counterparties
- add dedicated `suppliers` rather than overloading SKU supplier strings or customer tables

### Future bank import and matching

- design `bank_transactions` now so the model can grow into imported bank statements later
- do not block MVP on fully automated bank ingestion
- manual payment registration is acceptable in MVP if the reconciliation model is not painted into a corner

## 16. Risks and Hard Parts

- VAT edge cases are real.
  Domestic 25 percent sales and ordinary purchases are straightforward. Representation, cars, mixed-use expenses, reverse charge, imports, and special exemptions are not.
- Evidence immutability is easy to get wrong.
  Supabase Storage allows object replacement patterns unless the application forbids them.
- Stripe timing is awkward.
  Invoice finalization, payment capture, fees, and payouts happen at different times and should not collapse into one accounting event.
- Silent edits are a major trust risk.
  If draft and posted states are not clearly separated, users will accidentally rewrite accounting history.
- Period corrections after a filed VAT return are uncomfortable by design.
  The system has to prefer accuracy and traceability over convenience.
- Attachment lifecycle can become messy.
  OCR retries, clearer uploads, customer-forwarded PDFs, and regenerated invoice PDFs must not blur the line between original evidence and derived copies.
- Legacy migration may be incomplete.
  Existing invoices may exist without full evidence or without enough historical classification detail.
- Over-automation of accounting judgment will create false confidence.
  The system should suggest, warn, and queue for review; it should not hallucinate deductibility.
- Permissions are easy to under-design.
  Operational staff may need to upload evidence without gaining power to post or reopen periods.

## 17. Open Questions / Decisions Needed

- Which chart-of-accounts basis will be adopted for MVP?
  Recommendation: use a current BAS-based chart confirmed by the company's accountant, with only the needed subset active.
- What is the exact trigger for sales invoice posting?
  Recommendation: post on finalized/issued invoice, not on quote acceptance and not on Stripe draft creation.
- Should supplier invoices and cash receipts both use the same intake UI with different states?
- How much account suggestion automation is acceptable?
  Recommendation: suggestions okay, auto-posting only for narrow trusted cases.
- Will bank import be included in MVP or postponed in favor of manual payment entry and Stripe-driven matching?
- What is the exact workflow for missing or insufficient receipts?
  Recommendation: allow expense booking with non-deductible VAT or suspense/review handling, but never silent deductible treatment.
- Are manually created verifications allowed in MVP?
  Recommendation: yes, for opening balances, corrections, bank fees, and exceptional cases, but only for finance users.
- How strict should period reopening be?
  Recommendation: very strict, finance-admin only, reason required, fully audited.
- Is VAT reporting in v1 advisory/reviewable only, or should it be structured to support file upload preparation immediately?
- Must the first rollout include reverse-charge, EU purchase, and import VAT handling, or can those remain review-only warnings until needed?
- How should owner outlays and reimbursements be modeled if the business uses them?
- Should the app produce an SIE export in MVP, or is a strong CSV/PDF evidence package sufficient for the first declaration cycle?
  Note: Swedish accountants and bookkeeping firms near-universally expect SIE4 format for year-end review and tax filing support. If the company uses an external accountant, SIE export should be treated as high priority even if phased into Phase 7 or an early post-MVP release.
- Does the business perform qualifying ROT or RUT work?
  If yes, the invoice model must support split receivables (customer portion vs. Skatteverket ROT/RUT claim), and the accounting posting logic and payment matching must handle two separate settlement flows. This cannot be easily retrofitted. Confirm before coding Phase 5.
- Should the supplier master track f-skatt (F-skatt) registration status?
  In Sweden, if a supplier does not hold F-skatt, the buyer may be obligated to withhold preliminary tax (arbetsgivaravgifter) on payments for work. This is especially relevant for individual subcontractors or sole traders. The `suppliers` table includes `f_skatt_registered` for this purpose, and the purchase document workflow should warn when posting a payment to a supplier without F-skatt registration on file.

## 18. Recommended MVP Definition

### MVP should include

- Monthly accounting periods and quarterly VAT returns
- Core chart of accounts and VAT codes
- Verification numbering and posting
- Immutable posted ledger with reversal/adjustment flows
- Evidence upload, hashing, metadata, and retrieval
- Supplier master data
- Purchase document intake and posting
- Existing sales invoice integration into receivable/revenue/output-VAT postings
- Payment capture and allocation
- Stripe payment matching sufficient for customer invoice settlement
- VAT snapshot and quarterly review report
- Locking of reviewed/closed periods
- Audit log for sensitive actions
- Essential reports and export package

### MVP should be considered successful if it is sufficient for

- bookkeeping ordinary domestic expenses and sales
- preserving receipts and invoices with audit traceability
- producing quarterly VAT figures that can be reviewed and reproduced
- surviving a reasonable accountant or auditor review of traceability, evidence, and correction handling

### Postpone until after MVP

- payroll
- full bank import automation
- advanced VAT edge-case automation
- annual report generation
- fixed assets and depreciation
- inventory accounting
- deep management reporting
- multi-company support
- generic workflow/rules engine
- SIE export, unless the accountant requires it before the first filing cycle

## Appendix A: Practical engineering notes

### Recommended implementation posture

- Build the subsystem behind finance-only UI first.
- Treat the initial release as internal operations software, not customer-facing product surface.
- Write integration tests around posting invariants and period locking before adding workflow polish.
- Prefer explicit service methods such as:
  - create draft purchase document
  - post purchase verification
  - post sales invoice verification
  - record payment
  - allocate payment
  - generate VAT snapshot
  - close period
  - reopen period

### Existing app alignment

This plan fits the current repository direction:

- existing `invoices` and `invoice_line_items` provide an operational sales source
- existing `invoice_events` pattern shows the app already keeps lifecycle logs
- existing storage metadata tables such as `ticket_attachments` and `home_photos` provide a pattern for document metadata rows plus storage object paths
- existing `document_sequences` can likely be extended or mirrored for verification numbering

The accounting subsystem should build on those patterns without collapsing accounting truth into mutable operational records.

## Appendix B: Official reference baseline

These references are not a substitute for accounting advice, but they are the main official guidance points this plan is anchored to.

- BFN, "Bokforing" guidance:
  - supports the requirements around ongoing bookkeeping, verifications, correction visibility, and archived accounting information
  - practical implication for this plan: posted records and corrected verifications must preserve the original trail
- BFN overview pages on bookkeeping obligations:
  - support the baseline expectations that all business events are booked, every booked item has a verification, and accounting information is archived for seven years
  - practical implication for this plan: evidence retention, verification linkage, and period/audit controls are MVP concerns, not polish
- Skatteverket, "Momslagens regler om fakturering":
  - supports the invoice-content requirements, distinction between full and simplified invoices, and the current simplified-invoice threshold of 4,000 SEK including VAT
  - practical implication for this plan: deductible input VAT must depend on document sufficiency, not only on the amount entered by the user
- Skatteverket, momsdeklaration (SKV 4700):
  - the standard Swedish VAT return form with boxes 05–49
  - practical implication for this plan: all VAT code declaration-box mappings must correspond to actual boxes on SKV 4700; there are no boxes higher than 49 on this form
- Skatteverket, "ROT- och RUT-arbete":
  - if the business bills qualifying residential labor, the ROT/RUT deduction system applies and affects invoice amounts, receivable split, and settlement from Skatteverket
  - practical implication for this plan: confirm whether the business performs qualifying work before implementing the sales invoice integration in Phase 5
- Skatteverket, "F-skatt":
  - businesses paying for work to individuals or sole traders without F-skatt must withhold preliminary tax
  - practical implication for this plan: the supplier master should record F-skatt status and the purchase workflow should warn when it is absent

Recommended reviewer note:

- Before coding begins, confirm the chosen account plan and any business-specific VAT scenarios against the company's accountant, especially if the business expects imported goods/services, reverse charge, representation, car-related costs, owner reimbursements, or qualifying ROT/RUT labor during MVP.
