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
- AI-assisted filing by export, not hidden logic: for this business/use case, filing to Skatteverket should be supported through a structured JSON export derived from a locked VAT snapshot and consumed by AI/browser automation with human review before submission.
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
- Versioned JSON export of VAT filing data for AI-assisted browser automation against Skatteverket web forms
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
- Fully autonomous tax filing with no human verification step inside the Skatteverket browser session
- Direct Skatteverket API integration assumptions for this private-business use case

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
- Verification numbers must be sequential within their series and fiscal year. Numbers must never be reused. Any gap must be explainable by audit-visible cancelled or discarded drafts. This is an audit expectation under Swedish bookkeeping law.
- Before VAT snapshot generation, the system must perform a reconciliation checkpoint verifying that total debits equal total credits across all posted entries in the period, and that control account balances match derived totals for accounts receivable, accounts payable, and VAT accounts. VAT snapshot generation must be blocked if any reconciliation check fails.
- VAT filing data must be exportable as a versioned, machine-readable JSON payload derived from an approved VAT snapshot.
- The exported filing payload must be reproducible later from the same locked snapshot and generation rules version.
- The system must preserve the JSON payload hash, generation time, and approver identity for each filing export used in practice.
- The system must support storing filing confirmation evidence from the Skatteverket browser workflow, such as confirmation numbers, screenshots, or downloaded receipts.
- Every human review or approval action on a VAT return, high-risk verification, or adjustment must store the reviewer identity and timestamp separately from the poster identity and timestamp. Posting and approval are not the same action.

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
- Controlled posting entry points only.
  No posted accounting record may be created by direct table insert into `journal_entries`, `journal_entry_lines`, or `verifications` in posted state. Posting must happen through controlled service-layer functions such as `post_verification()` or `post_journal_entry()` so validation, idempotency, lock checks, and audit logging cannot be bypassed.
- Browser automation is a downstream consumer, not a source of truth.
  The AI/browser agent should read an exported payload from the accounting subsystem and fill the web form from that payload; it should not infer VAT figures from loose UI text or recalculate from live mutable data.
- VAT export is authoritative; browser automation is optional.
  The structured VAT JSON export is the authoritative filing output. Browser automation is a convenience layer only, and manual filing must remain possible from the same approved data if automation is unavailable.
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
| `accounting_periods` | Provides month-level control, close discipline, and posting locks even though VAT is quarterly. | fiscal_year_id, period_no, start_date, end_date, status, locked_at, locked_by, integrity_hash, integrity_hash_computed_at | belongs to `fiscal_years`; referenced by `journal_entries` and `vat_returns` | Mutable while open; closed/locked states tightly controlled |
| `chart_of_accounts` | Versioned account plan so future changes do not corrupt historical interpretation. | id, name, version, effective_from, effective_to, status | parent of `accounts` | New versions added; old versions preserved |
| `accounts` | Defines ledger accounts and account behavior. | chart_id, account_no, name, account_type, normal_balance, is_active, allow_manual_posting, vat_category_hint | referenced by `journal_entry_lines`, posting rules, reports | Mutable while active; historical rows preserved, no renumbering in place |
| `vat_codes` | Encapsulates VAT logic and reporting mapping. | code, description, rate, direction, deductibility_percent, declaration_box_map, reverse_charge_flag, active_from, active_to, requires_review | referenced by purchase lines, invoice lines, journal lines, VAT snapshots | Version by new row/effective dates; avoid destructive edits |

### Verification and evidence entities

| Entity | Why it exists | Major fields | Key relationships | Mutability |
| --- | --- | --- | --- | --- |
| `verifications` | Legal/accounting header for a booked business event; carries numbering and traceability. | verification_no, series, fiscal_year_id, accounting_period_id, status, document_date, posting_date, description, source_type, source_id, source_snapshot_json, created_by, posted_by, posted_at, reviewed_by, reviewed_at, reversal_of_verification_id | parent of `journal_entries`; linked to `verification_documents` | Draft editable; posted immutable except status transitions like reversed |
| `journal_entries` | Posting header for a verification. Keeps accounting state separate from evidence and source references. In MVP this should usually be one primary journal entry per verification. | verification_id, status, posting_date, currency, total_debit, total_credit, posted_at, posted_by, reversal_of_journal_entry_id | belongs to `verifications`; parent of `journal_entry_lines` | Draft editable; posted immutable |
| `journal_entry_lines` | The actual debit and credit postings that make up the ledger. | journal_entry_id, line_no, account_id, debit_amount_minor, credit_amount_minor, original_amount_minor, original_currency, exchange_rate, converted_amount_minor, line_description, vat_code_id, tax_base_amount_minor, counterparty_type, counterparty_id, dimension_json | belongs to `journal_entries`; references `accounts`, `vat_codes`, counterparties | Immutable after posting |
| `accounting_documents` | Canonical metadata row for each evidence file and derivative extraction artifact. | document_type, is_original_evidence, original_filename, storage_bucket, storage_path, mime_type, size_bytes, sha256, uploaded_at, uploaded_by, source_origin, source_ref, ocr_raw_json, extracted_normalized_json, user_confirmed_json, supersedes_document_id, retention_until | linked to `verification_documents`, `purchase_documents`, and sales-side source records | Binary never replaced in place; metadata append-only except enrichment fields with audit |
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
| `payments` | Canonical payment record from bank, Stripe, cash, card, or manual entry. | payment_date, amount, currency, method, direction, external_ref, source_system, source_confidence, payer_or_payee_type, payer_or_payee_id, status, bank_transaction_id, stripe_event_id, created_by | linked to `payment_allocations`, `bank_transactions`, `verifications` | Can remain draft/unmatched; matched/posted payment facts become locked |
| `payment_allocations` | Resolves payments against invoices, supplier liabilities, or reimbursements. | payment_id, target_type, target_id, allocated_amount, allocated_at, allocation_status | belongs to `payments`; targets `purchase_documents`, `sales_invoice_links`, or direct `verifications` | Additive adjustments; prior allocations should be reversed, not overwritten |
| `bank_transactions` | Stores imported or manually entered bank statement lines and later enables reconciliation. | booking_date, value_date, amount, currency, description, reference, account_identifier, import_batch_id, match_status, raw_payload_json | linked to `payments` and reconciliation workflows | Raw imported facts immutable; matching state audited |

### VAT entities

| Entity | Why it exists | Major fields | Key relationships | Mutability |
| --- | --- | --- | --- | --- |
| `vat_returns` | Represents one quarterly VAT return review and filing cycle. | fiscal_year_id, quarter, period_start, period_end, status, generated_at, generated_by, reviewed_at, filed_at, filed_by, filing_reference, notes | parent of `vat_period_snapshots`; linked to posted entries selected by cutoff rules | Draft mutable; filed rows locked except amendment metadata |
| `vat_period_snapshots` | Immutable preserved output of what was included and what values were shown at filing/review time. | vat_return_id, snapshot_version, included_entry_ids_json, box_totals_json, source_hash, ledger_integrity_hash, posted_until_timestamp, generation_rules_version, created_at | belongs to `vat_returns` | Append-only; once created never edited |
| `tax_filing_exports` | Stores the machine-readable JSON payload generated from a locked VAT snapshot for AI-assisted Skatteverket filing and later audit reproduction. | vat_return_id, vat_period_snapshot_id, export_format, schema_version, payload_json, payload_hash, generated_at, generated_by, approved_at, approved_by, used_at, export_status | belongs to `vat_returns` and `vat_period_snapshots`; linked through audit logs and filing confirmation documents | Append-only payload; status metadata changes audited |

### Currency and monetary storage model

- `accounting_settings.base_currency` must be `SEK`.
- All posted accounting amounts must be stored in base currency minor units, not floating-point values.
- Foreign-currency transactions must preserve:
  - `original_amount_minor`
  - `original_currency`
  - `exchange_rate`
  - `converted_amount_minor` in SEK
- These fields should exist on the source line and/or `journal_entry_lines` so the final posted ledger can be audited without recomputing historical conversions.

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
- Every document must carry an `is_original_evidence` boolean:
  - `true`: the file is the original document received from the counterparty (supplier invoice, customer invoice, bank statement, receipt)
  - `false`: the file is derived or generated (system-generated invoice PDF, regenerated copy, export manifest, screenshot)
- Only original-evidence documents are valid as the primary basis for deductible VAT treatment. Derived documents can be retained as supporting context but must not substitute for originals in VAT decisions.
- The workflow must warn and require explicit override if a VAT-deductible purchase is linked only to non-original documents.

### Record immutability

- Posted `verifications`, `journal_entries`, and `journal_entry_lines` must not support hard delete.
- Posted accounting records must not support general update operations.
- This must be enforced at the database level through triggers or row security policies that reject UPDATE and DELETE on these tables when the record is in posted state. Application-level guards alone are insufficient.
- Corrections must be modeled as:
  - reversal entry
  - adjusting entry
  - replacement verification with clear cross-reference
- Draft accounting records may be editable, but those edits should still be auditable if the record is likely to become part of the accounting trail.

### Controlled posting boundary

- No direct inserts are allowed into `journal_entries`, `journal_entry_lines`, or `verifications` in posted state from normal application roles.
- Posting must occur only through controlled service-layer functions such as `post_verification()` and `post_journal_entry()` or equivalent trusted RPC/service entry points.
- Database permissions must prevent ordinary application users from bypassing those entry points.
- Only trusted service roles may perform final posting operations.
- This rule exists to ensure every posting passes the same validation, idempotency, lock checks, balance enforcement, and audit logging path.

### Payment allocation constraints

- The sum of all `payment_allocations` for a given payment must never exceed the payment's original amount.
- The sum of all allocations against a given target (invoice receivable, supplier payable, etc.) must never exceed the outstanding amount on that target.
- Both constraints must be enforced transactionally: allocation inserts must verify remaining available amounts within the same transaction and fail atomically if either limit would be exceeded.
- Over-allocation is an accounting error, not just a business warning. The system must make it structurally impossible.

### Ledger integrity hash

Each accounting period, when closed, and each VAT period snapshot must store a deterministic integrity fingerprint of all posted `journal_entry_lines` included in that scope.

The fingerprint must be:
- computed as a deterministic hash over a stable, ordered serialization of all included posted line amounts, account references, and posting dates
- stored alongside the period close metadata or VAT snapshot record
- recomputed during integrity checks and compared to the stored value

Purpose:
- detect silent corruption of posted data
- detect unauthorized row-level mutation that bypasses application controls
- provide cryptographic confirmation that the data used for a VAT filing matches the stored snapshot

If the recomputed hash does not match the stored hash, the integrity check must fail, surface an alert, and block further period progression until the discrepancy is investigated. A mismatch is not a warning; it is a hard failure.

### Database-enforced balance integrity

- The system must enforce `total_debit == total_credit` for every posted journal entry at the database level.
- Application-side checks are necessary but insufficient.
- The final balance check must happen in the same transaction that marks an entry as posted.
- If the entry is imbalanced, posting must fail atomically and no partial journal state may remain committed.

### Currency integrity

- Base currency for the ledger is SEK.
- Historical foreign-currency conversions must be stored at posting time and must not be recomputed later.
- The stored exchange rate and converted SEK amount become part of the immutable posted record.
- VAT calculations, VAT snapshots, and report totals must use the stored SEK amounts, not later retranslation.

### Verification number integrity

Verification numbers are legally significant under Swedish bookkeeping rules and are the primary human-readable reference for audit trail traceability.

- Verification numbers must be assigned sequentially within a given series and fiscal year. The sequence must never skip or reset mid-year without an explicit, audited reason.
- Once assigned, a verification number must never be reused, even after a reversal or cancellation of the original verification.
- A cancelled or discarded draft that was issued a number must retain that number as a visible, voided record so auditors can account for the gap.
- The system must provide a report showing all gaps or voided numbers within a series, accessible to finance admin at any time.
- Numbering must be generated by the system at posting time, not pre-assigned by users. User-defined numbers are only acceptable for manually created opening-balance verifications if explicitly required.

### Traceability chain

The system must preserve and expose the following chain:

`source document -> document metadata -> purchase/sales source record -> verification -> journal entry -> journal entry lines -> payment/payment allocation -> VAT return snapshot -> tax filing export -> filing confirmation evidence`

This chain must be queryable from any point:

- from a document, find the verification and ledger impact
- from a journal line, find the underlying evidence
- from a VAT box total, find included transactions
- from a payment, find the liability/receivable it settled

### Continuous integrity monitoring

The system must run periodic integrity checks, ideally as a daily background job, rather than relying only on quarter-end or VAT-time validation.

Minimum checks:

- global debit total equals global credit total across all posted entries
- no orphaned `journal_entries` or `journal_entry_lines`
- no broken foreign key relationships or missing reference rows
- VAT totals remain internally consistent with posted lines and VAT accounts
- unmatched payments and stale reconciliation exceptions are surfaced

Operational requirements:

- failures must be logged and alerted, not silently ignored
- exceptions must appear in an operational integrity report or admin dashboard and remain visible until resolved
- integrity check failures must actively block VAT snapshot generation and period close; logging alone is insufficient
- a ledger integrity hash mismatch must block all period progression and trigger an immediate alert to finance admin
- the system must not allow VAT filing to proceed while any unresolved integrity failure exists

### Payment source confidence

Not all payments carry equal audit weight. The `payments` table includes a `source_confidence` field with the following levels:

- `bank_import`: payment fact was imported from a bank statement; highest objective reliability
- `stripe`: payment fact originated from a verified Stripe event with an external reference id
- `manual`: payment was entered manually by a user with no external corroboration

Manual payments are the highest audit risk because they depend entirely on user input. The system should:

- flag manually entered payments visibly in reconciliation views
- require mandatory notes or reference fields for manual payments above a configurable threshold
- allow auditors and finance users to filter reports by source confidence level
- never treat a manual payment the same as a bank-imported or Stripe-confirmed payment when assessing settlement completeness

This distinction must be preserved in audit exports and VAT snapshots where payment state is referenced.

### Reviewer and approval accountability

Posting an entry and approving it for inclusion in a VAT return or filing are distinct acts that may be performed by different people at different times.

The system must track both:

- `posted_by` / `posted_at`: the user and time the entry was committed to the ledger
- `reviewed_by` / `reviewed_at`: the user and time the entry or document was explicitly reviewed and cleared for filing or period close

These fields apply to:

- `verifications`: especially for manually created entries, adjustments, and high-value postings
- `vat_returns`: a `reviewed_by` and `reviewed_at` must be recorded before the VAT return can be moved from `review` to `filed`
- `purchase_documents`: for documents that required classification review

The system should not allow a single user to both post and be the sole reviewer for their own manual entries above a risk threshold, though this policy can be relaxed for small teams if explicitly overridden.

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
- move period to review state
- close period
- lock period
- unlock or reopen period
- run pre-snapshot reconciliation check
- generate VAT snapshot
- approve VAT return for filing
- generate tax filing export
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
   - if the linked supplier has `f_skatt_registered = false` (or is unknown/null), the system must display a prominent warning that the buyer may have an obligation to withhold preliminary tax on labor payments. The entry cannot be posted without an explicit acknowledgment or override with a recorded reason. This is a legal risk, not a cosmetic warning.
   - if the linked document has `is_original_evidence = false` and the line claims deductible input VAT, the system must flag the line for review and block posting without an explicit override.
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
   - the posting carries an idempotency key of `(source_type='sales_invoice', source_id=invoice_id, event_type='finalized')`, enforced by a unique database constraint; repeat triggers are safe no-ops
4. Invoice finalization posting creates:
   - debit accounts receivable
   - credit revenue account(s)
   - credit output VAT account(s)
5. Payment capture is a separate accounting event. Stripe or bank payment events create `payments`, each with their own idempotency key derived from the Stripe event id or bank transaction reference.
6. Payment recognition settles the receivable into a clearing account; it is not the same event as revenue recognition.
7. Stripe fees are separate accounting events and must be posted explicitly, never hidden inside net settlement.
8. Bank settlement is a separate accounting event again: when a Stripe payout reaches the bank account, the posting moves value from Stripe clearing to the bank account.
9. Payment and settlement are matched through `payment_allocations` and reconciliation flows.

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

1. Finance user moves the quarter's monthly periods to `review` state. New postings are blocked; corrections are still allowed.
2. Finance user works through the review queue: resolving incomplete documents, unmatched payments, ambiguous VAT-coded lines, and review flags until the period is clean.
3. System gathers all posted entries with VAT impact whose posting date falls in the quarter.
4. System runs completeness and integrity checks:
   - unposted purchase documents
   - unmatched invoice states
   - ambiguous VAT-coded lines
   - documents missing evidence or review flags
5. System runs the pre-snapshot reconciliation checkpoint:
   - total debits must equal total credits
   - control account balances must match derived receivable, payable, and VAT totals
   - If any check fails, generation is blocked until the discrepancy is resolved
6. Finance user confirms the period is ready. System moves periods to `closed`.
7. System records a `posted_until_timestamp` at the moment of snapshot generation to define the exact inclusion boundary.
8. System generates an immutable `vat_period_snapshot` containing:
   - optional included-entry references for drill-down
   - box totals
   - generation timestamp
   - `posted_until_timestamp`
   - rules version
   - source hash
9. Finance user reviews the draft VAT totals in-app and explicitly approves them. System records `reviewed_by` and `reviewed_at` on the `vat_returns` row. The return cannot proceed without this step.
10. System generates a versioned `tax_filing_export` JSON payload from the approved snapshot for AI-assisted browser automation. Records `approved_by` and `approved_at` on the export row.
11. The JSON export is handed to the filing agent or workflow that fills the Skatteverket web form.
12. Human reviewer verifies the populated browser form before submission.
13. After submission, the system stores the filing reference and any confirmation artifacts such as screenshots or receipts.
14. System marks the VAT return as `filed` and preserves both the filed values and the exact JSON export used.
15. The quarter's accounting periods are locked according to policy.
16. Later corrections affecting that quarter are handled via future-period adjustments, not by rewriting the filed snapshot or the prior filing export.

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

### Controlled posting entry point

- No posted accounting data may be inserted directly into `journal_entries`, `journal_entry_lines`, or `verifications` in posted state.
- Posting must happen through controlled service-layer functions or equivalent trusted RPC/service entry points, for example:
  - `post_verification()`
  - `post_journal_entry()`
- These entry points must perform, in one controlled flow:
  - idempotency checks
  - period lock checks
  - balance validation
  - currency conversion capture
  - audit log writes
  - state transition to `posted`
- Normal application roles may prepare drafts, but they must not be able to bypass the posting entry point.

### Database-enforced balance

- Balance must be enforced at the database level for every posted journal entry.
- `total_debit == total_credit` must be validated by constraint, deferred validation, or transaction-level validation in the posting transaction.
- Application-level checks alone are insufficient because they can be bypassed by race conditions, bad migrations, privileged scripts, or integration mistakes.
- If imbalance exists, posting must fail atomically and leave no partial posted state behind.

### Idempotency

Each source event must produce exactly one accounting result, even under retries, duplicate webhooks, or concurrent requests.

- Every posting from a known source event must carry an idempotency key derived from `(source_type, source_id, event_type)`.
- This combination must have a unique constraint enforced at the database level, not only in application logic.
- A duplicate insert attempt must be a safe no-op or return the existing result, never create a second posting.
- This applies to: sales invoice finalizations, Stripe payment events, Stripe fee events, and any other external trigger that can fire more than once.
- The `verifications` or `journal_entries` table should carry this idempotency key column with the database-level unique constraint.

Without this, webhook retries or deploys under load can produce doubled revenue, doubled VAT, or doubled receivable postings that are extremely difficult to trace.

### State model

- `draft`: editable, not part of the official ledger
- `posted`: part of the official ledger, immutable
- `reversed`: original remains posted, but a reversing entry exists
- `cancelled` or `discarded`: only for drafts, never for posted entries

### Draft isolation

Draft records must be strictly isolated from all accounting outputs:

- Draft `journal_entries` and `journal_entry_lines` must never affect account balances.
- Draft entries must never appear in VAT calculations, VAT snapshots, or VAT reports.
- Draft entries must never appear in the trial balance or any balance-derived report.
- All reporting, reconciliation, and VAT logic must operate exclusively on posted records.

This is an invariant, not a UI filtering preference. Any report or calculation that can accidentally include draft data will produce incorrect accounting figures. The query layer must enforce posted-only filtering at its foundation, not as an optional parameter.

### Dates that must be separate

- `document_date`: date on receipt or invoice
- `posting_date`: date used for accounting period and VAT period assignment
- `due_date`: payment due date for receivables/payables
- `payment_date`: actual settlement date
- `uploaded_at`: evidence arrival timestamp
- `posted_at`: timestamp the system committed the entry

### Currency handling

- Base currency for the ledger is SEK.
- All posted accounting amounts must be stored in base currency minor units.
- Foreign-currency transactions must also store:
  - original amount
  - original currency
  - exchange rate used at posting time
  - converted SEK amount
- Conversion happens at posting time and becomes immutable after posting.
- The system must never recompute historical conversions for already posted entries.
- VAT calculations and VAT reporting must use the stored converted SEK values.

### Monetary precision and rounding

- All monetary values must be stored in minor units (`ore`) as integers.
- Rounding strategy must be deterministic and consistent across the system.
- Rounding should occur at line level.
- Totals must be derived from already rounded lines, not from separate floating-point recomputation.
- VAT must be calculated per line and then summed.
- Inconsistent rounding will break VAT reconciliation, payment matching, and audit reproduction, so the rounding rules must be centralized and immutable once entries are posted.

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

#### Stripe payout reaches bank account

- debit bank
- credit Stripe clearing

This avoids hiding fees inside net receipts and makes reconciliation easier.

### Stripe timing model

- Revenue recognition occurs at invoice finalization.
- Payment recognition occurs when payment is captured or confirmed by Stripe or another payment source.
- Bank settlement occurs when the payout reaches the actual bank account.
- These are separate accounting events and must not be collapsed into one.
- Stripe fees must be explicit entries.
- A clearing account must be used to bridge invoice payment, fee recognition, and bank payout timing.

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

### Monetary precision and rounding

- All VAT-relevant monetary values must be stored in minor units (`ore`) as integers.
- VAT must be calculated per line and then summed to document and period totals.
- Rounding must occur at line level, not only at document total level.
- Document and VAT-return totals must be derived from already rounded lines.
- Rounding rules must be deterministic and reproducible across UI, posting logic, exports, and reports.
- Inconsistent rounding will break VAT reconciliation and create filing differences, so the rounding implementation must be centralized and fixed.

### VAT arithmetic invariants

The following relationships must hold for every VAT-bearing journal line and must be stored, not recomputed after the fact:

- `vat_amount` must equal `tax_base_amount × vat_rate`, computed using the system's canonical rounding rules
- `tax_base_amount + vat_amount` must equal the gross amount for that line
- these relationships must be validated before posting and must remain permanently consistent afterward; any line that fails these checks must be rejected at posting time

These are not advisory checks. A line where the stored vat_amount does not match the rate-derived amount indicates a data quality problem that will produce incorrect VAT returns. The posting entry point must validate and reject, not warn and continue.

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
- Note on filing frequency: Swedish businesses with annual taxable turnover above 40 MSEK must file monthly. Businesses below that threshold typically file quarterly. Some businesses voluntarily file monthly. For this business, MVP should implement quarterly filing only, but the period and settings model should avoid blocking a later monthly expansion if filing frequency changes.

### VAT snapshots for filed returns

For each quarterly return preserve:

- generated totals by declaration box
- `included_entry_ids_json` only as an optional convenience/debugging field
- source hash
- `posted_until_timestamp`: the exact timestamp used as the upper cutoff for entry inclusion; entries posted after this timestamp are excluded even if their `posting_date` falls within the quarter. This makes the snapshot reproducible regardless of when later entries are added.
- generation time
- filer/reviewer identity
- any manual adjustment note entered before filing

Authoritative snapshot definition:

- `posting_date` must fall within the VAT period
- `posted_at` must be less than or equal to `posted_until_timestamp`

`included_entry_ids_json` is not the authoritative definition of the snapshot. It is optional and exists only for convenience, debugging, and drill-down. The authoritative snapshot must be reproducible from the cutoff rules above plus the source hash and generation rules version.

The `posted_until_timestamp` is required for reproducibility. Without it, regenerating the same snapshot later may produce different results if new entries were posted into the same period after the snapshot was originally created.

### Pre-snapshot reconciliation checkpoint

Before generating a VAT period snapshot, the system must run the following checks and block snapshot generation if any fail:

- total debits equal total credits across all posted entries within the period
- accounts receivable control account balance matches the sum of open customer invoice receivables
- accounts payable control account balance matches the sum of open supplier invoice liabilities
- output VAT account balance matches the sum of output VAT amounts on posted sales lines
- input VAT account balance matches the sum of deductible input VAT amounts on posted purchase lines
- no posted entries reference accounts with deactivated or missing account records
- no VAT-bearing lines reference vat_codes that are outside their active date range for the period

If any check fails, the system must display which check failed and provide a drill-down to the affected entries. The finance user must resolve the discrepancy before proceeding.

### AI-assisted Skatteverket filing export

Because the filing workflow is expected to use AI assistance and browser automation rather than a direct Skatteverket API for this business/use case, the accounting subsystem should produce a dedicated JSON export from the approved VAT snapshot.

This export should be treated as a formal filing artifact, not an ad hoc convenience dump.

Required properties:

- generated only from an approved and locked `vat_period_snapshot`
- stored with schema version and payload hash
- reproducible from the same source snapshot
- safe for an external AI/browser agent to consume without direct database access
- explicit about which fields are authoritative and which are informational only
- tied back to the `vat_return` used for filing

Minimum JSON content:

- export metadata
  - schema version
  - export timestamp
  - app/environment identifier
  - export id
- business identity
  - legal name
  - organization number
  - VAT number if applicable
- filing context
  - filing type: VAT return
  - Skatteverket form identifier or expected web form context
  - fiscal year
  - quarter or filing period
  - filing frequency setting
- declaration box payload
  - every relevant box id
  - numeric value
  - currency
  - whether value is system-derived or manually adjusted
- review metadata
  - approved by
  - approved at
  - warning flags
  - unresolved issues list, if any
- traceability metadata
  - `vat_return_id`
  - `vat_period_snapshot_id`
  - source hash
  - generation rules version

Recommended optional JSON content:

- per-box drilldown references for audit or troubleshooting
- counts of included transactions
- note fields for manual reviewer context
- filing instructions for the automation agent, such as "fill only listed boxes" and "do not infer missing values"

Operational rule:

- the VAT JSON export is the authoritative filing output from the accounting subsystem
- browser automation is optional convenience only
- the same approved data must support manual filing if automation is unavailable or fails
- the automation agent should fill only what the JSON payload declares
- the automation agent should not recalculate totals
- the human reviewer should approve the web form before final submission
- automation failure must not affect accounting correctness, VAT snapshot correctness, or the ability to complete filing manually

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
  - VAT filing JSON export manifest
  - Skatteverket filing receipt or confirmation screenshot
  - contract/supporting document
- relation to verification, purchase document, or sales invoice

### Storage rules

- Use a dedicated private storage bucket for accounting evidence, separate from temporary invoice PDF caches and unrelated attachments.
- Never replace an existing binary in place.
- Every new upload or replacement creates a new `accounting_documents` row and a new object path.
- Preserve the original evidence object even if a later version is clearer or corrected.
- Treat OCR output and normalized extraction as derived metadata, not as a replacement for the file itself.
- Store a stable checksum to detect duplicates and support audit validation.
- Set `is_original_evidence = true` only for files that were received directly from a counterparty or external source: supplier invoices, supplier receipts, customer invoice PDFs issued by the company, bank statement downloads, and equivalent source documents.
- Set `is_original_evidence = false` for: system-generated invoice PDFs (regenerated copies), OCR extraction artifacts, export manifests, filing JSON payloads, and screenshots.
- A VAT deduction must not rely solely on a non-original document. If the only linked document has `is_original_evidence = false`, the purchase document line must be flagged for review before posting.

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
- `review`: no new postings allowed; corrections to existing entries still allowed; used during VAT period review before filing
- `closed`: review complete, no posting or editing of any kind; VAT snapshot generation allowed
- `locked`: hard lock after VAT filing or year-end close; no changes of any kind
- `reopened`: exceptional administrative state, should be rare and audited

The lifecycle for a period moving toward VAT filing is: `open` → `review` → `closed` → `locked`.

The `review` state is important because it allows the finance user to work through the period's entries and make corrections without new business postings arriving and changing the figures mid-review. A period should enter `review` at the start of the VAT review cycle and remain there until the finance user confirms it is ready for snapshot generation.

### Lock rules

- New postings cannot use a `review`, `closed`, or `locked` period
- Corrections to existing entries are allowed in `review` but not in `closed` or `locked`
- Drafts cannot be posted into any period other than `open`
- Evidence can still be uploaded after close, but any posting must go to an allowed period or follow a reopen process
- Report exports remain available for all periods regardless of status

### DB-level period lock enforcement

Period status enforcement must not rely solely on application-layer checks. The database must enforce that:

- no `journal_entry` may be inserted with an `accounting_period_id` whose status is not `open`
- no existing `journal_entry` may be updated to reference a period that is not `open`
- the `posting_date` of every `journal_entry` must fall within the `start_date` and `end_date` of its assigned `accounting_period`; entries outside the period's date range must be rejected

These rules must be enforced via database-level triggers or check constraints so they cannot be bypassed by privileged scripts, migrations, or service-layer mistakes. An attempt to insert or update in violation of these rules must produce a hard database error, not a silent failure.

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
- Structured JSON export for AI-assisted Skatteverket filing
  - generated from approved VAT snapshot
  - versioned schema
  - payload hash
  - filing context and box values
- Unpaid supplier invoices / payable overview
  - supplier, due date, amount outstanding
- Paid/unpaid customer invoices / receivable overview
  - invoice number, customer, due date, payment state, outstanding amount
- Trial balance with reconciliation status
  - total debits vs credits
  - control account reconciliation: receivable, payable, VAT
  - flagged discrepancies before period close or VAT snapshot
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
- Reports must never include draft items in balance, VAT, or trial-balance calculations; draft inclusion is not a display toggle but a correctness constraint
- Reports that optionally show draft items for review purposes must clearly separate and label draft rows and must never aggregate them with posted figures
- Every report should show generation timestamp and user

### Operational integrity monitoring

The system should include an operations-facing integrity report backed by a periodic background job, ideally daily.

Minimum monitored conditions:

- global debit total equals global credit total
- orphaned journal entries or journal lines
- broken foreign key relationships or missing reference data
- VAT inconsistencies between posted lines, VAT codes, and VAT account balances
- unmatched payments or stale reconciliation exceptions

Operational behavior:

- failures must produce alerts or logged incidents
- integrity failures should remain visible until resolved
- the system must not rely only on VAT-period validation to discover broken ledger state

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
- controlled posting service entry points and permission model

**Dependencies**

- Phase 0 approval

**Acceptance criteria**

- accounts can be configured and versioned
- periods exist and support open/closed states
- VAT codes can express the required domestic scenarios
- verification numbering approach approved and testable
- direct inserts into posted accounting paths are blocked for normal application roles

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
- `tax_filing_exports`
- VAT validation checks
- declaration-box mapping
- quarter review UI
- VAT drill-down report
- Skatteverket filing JSON export generation

**Dependencies**

- Phases 3 through 5

**Acceptance criteria**

- posted VAT-bearing entries for a quarter can be gathered deterministically
- box totals are generated consistently
- a filed quarter preserves snapshot values, cutoff rules, and reproducibility metadata
- a versioned JSON export can be generated from the approved snapshot without exposing live database access to the filing agent
- the export contains enough structured information for AI/browser automation to fill the Skatteverket form deterministically
- later corrections do not rewrite the filed snapshot

**Risks / open questions**

- whether MVP supports only domestic boxes or also reverse-charge/import boxes
- whether output is advisory only or filing-ready enough to upload elsewhere
- how brittle the browser automation flow will be when Skatteverket changes web form markup or wording

### Phase 7: Locking, corrections, exports, and rollout hardening

**Objective**

Make the subsystem safe to operate in production before the first filing cycle.

**Included features**

- close/lock/reopen controls
- correction and reversal flows
- audit export package
- background integrity checks and alerting
- report polish
- migration/backfill support for existing invoices and documents
- production checklist and runbook

**Dependencies**

- Phases 1 through 6

**Acceptance criteria**

- locked periods reject new postings
- correction flows work without destructive edits
- export package is usable by an accountant or auditor
- periodic integrity checks surface broken ledger state before VAT filing time
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
9. tax filing export tables and filing-artifact linkage
10. reporting views and export support
11. lock enforcement and audit hardening

### Foundational tables first

Do not start with OCR or UI. Start with:

- accounts
- periods
- VAT codes
- verifications
- journal entries
- journal lines

Without these, later workflows will hard-code too much logic in the wrong place.

### Opening balance and migration strategy

Before any transaction history can be reliably posted, the ledger must start from a controlled and auditable initial state.

**Opening balance verification**

Create a dedicated `opening_balance_verification` at the start of the first active accounting period. This verification establishes the initial balance for every account that carries a non-zero opening position. At minimum, for a business migrating from an existing operational state, the opening balance must include:

- bank account(s): confirm balance from bank statement on the opening date
- accounts receivable: the sum of outstanding customer invoices as at the opening date
- accounts payable: the sum of outstanding supplier liabilities as at the opening date
- VAT account(s): any outstanding VAT liability or receivable from prior periods
- equity/owner's capital or retained earnings: the residual to make the entry balance

This verification must be:
- supported by documentary evidence (bank statement, debtors list, creditors list, prior VAT filing)
- reviewed and explicitly approved by the finance admin before posting; it cannot be self-posted without a separate reviewer
- treated as immutable once posted; it is the ledger's anchor point and must never be reversed without extraordinary justification and full audit trail
- the chronologically first posted entry in the ledger; the system must reject any attempt to post a journal entry with a `posting_date` earlier than the opening balance date

No transaction history may be posted to the ledger until the opening balance verification has been created, approved, and posted. This must be enforced by the system, not by convention.

**Principles**

- The system must not assume historical completeness.
- Any period before the opening date is "legacy" and must not be treated as fully auditable accounting unless explicitly and carefully reconstructed.
- If the business already has invoices in the app that predate the accounting start, those invoices must either be individually posted into the accounting layer with sufficient evidence, or captured as a lump-sum receivable in the opening balance. Do not silently ignore them.
- Document the chosen approach in an internal migration memo and attach it to the opening balance verification as supporting evidence.

### Backfill strategy for existing invoices and documents

- Identify the earliest fiscal date that must be represented in-app for the first VAT declaration.
- Backfill existing operational `invoices` that belong in that period.
- For each existing invoice:
  - snapshot relevant invoice data
  - create accounting link record
  - create posted sales verification only if source data is complete enough
- If historical completeness is poor, use an opening-balance or legacy-import strategy rather than pretending old data is fully auditable.
- If existing invoice PDFs are only stored as remote URLs or temporary cache artifacts, document whether the stored artifact is:
  - original evidence (`is_original_evidence = true`)
  - regenerated derivative (`is_original_evidence = false`)
  - missing

### Constraints and indexes

Recommended constraints:

- unique account number within chart version
- unique verification number within series and fiscal year; gaps must be traceable to cancelled drafts, not silent skips
- unique VAT code within active version scope
- unique `(source_type, source_id, event_type)` on `verifications` or `journal_entries` — enforced at the database level to prevent duplicate posting from retried or duplicated source events
- check constraint that posted entries have posting date and period
- check constraint that `posting_date` falls within the assigned `accounting_period.start_date` and `accounting_period.end_date`
- check constraint or trigger that rejects inserts or updates to `journal_entries` referencing a period whose status is not `open`
- check constraint that draft entries cannot be attached to locked periods
- database-enforced balance validation so `total_debit == total_credit` for every posted journal entry
- check or trigger that rejects UPDATE and DELETE on posted rows in `verifications`, `journal_entries`, and `journal_entry_lines`
- transactional constraint or application-level guard that prevents `payment_allocations` from exceeding `payments.amount` or the target's outstanding balance

Recommended indexes:

- `journal_entries(posting_date)`
- `journal_entries(accounting_period_id, status)`
- `journal_entry_lines(account_id, posting_date via parent join helper view)`
- `verifications(verification_no)`
- `purchase_documents(supplier_id, document_date, status)`
- `payments(payment_date, status, source_system)`
- `payment_allocations(target_type, target_id)`
- `vat_returns(fiscal_year_id, quarter, status)`
- `tax_filing_exports(vat_return_id, export_format, generated_at)`
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

### Controlled posting entry point and permissions

- Revoke direct insert permission on `journal_entries` and `journal_entry_lines` from normal application roles.
- Prevent normal application roles from inserting `verifications` directly in posted state or changing a draft verification to posted outside the controlled posting path.
- Expose trusted posting operations only through controlled service-layer functions or equivalent RPCs such as `post_verification()` and `post_journal_entry()`.
- Only trusted service roles may execute those posting operations.
- Those operations must perform idempotency checks, balance validation, audit logging, lock enforcement, and final state transition in one transaction.

### Triggers versus application logic

Recommended approach:

- Use application services or SQL functions/RPCs for posting workflows, because posting usually spans several tables and validations.
- Use narrow database triggers only for invariants such as:
  - rejecting direct mutation of posted records
  - rejecting direct inserts into posted-state paths that bypass the service entry point
  - preventing updates to immutable posted rows
  - rejecting journal entry inserts or period-references for non-open periods
  - validating that `posting_date` falls within the assigned period's date range
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

### AI-assisted browser automation

- The accounting subsystem should export a deterministic JSON payload and should not require the filing agent to inspect live database tables directly.
- The browser automation agent should be treated as an external integration consumer, similar to a downstream system.
- The JSON export should be the only authoritative input for filling Skatteverket web forms.
- After filing, the automation workflow should write back:
  - filing reference
  - submission timestamp
  - confirmation screenshots or receipts
  - any automation warnings or partial-failure notes

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
- Browser automation is brittle by nature.
  Skatteverket page changes, login/session flows, MFA, or wording changes can break automated form filling even when the accounting data is correct.
- JSON schema drift is a real operational risk.
  If the export format changes without versioning discipline, the AI/browser workflow can silently file incorrect values or fill the wrong fields.
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
- Should the first filing workflow include only JSON export, or also capture filing confirmation artifacts back into the app as mandatory evidence?
- What exact JSON schema should the browser automation agent consume, and which fields are mandatory versus optional?
- Who is the required human approver before browser submission is allowed?
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
- Versioned JSON export for AI-assisted Skatteverket filing, generated from the approved VAT snapshot
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
