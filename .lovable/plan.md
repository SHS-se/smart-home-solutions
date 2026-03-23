

# Plan: Extend BOM Revision Lifecycle to Invoices

## Overview
Invoices will participate in the same BOM revision lifecycle as quotes. Adding SKUs from the invoice draft editor can trigger a new BOM revision (if locked) or reuse an existing editable one. The revision locks when the invoice is finalized, mirroring quote behavior exactly.

## Changes

### 1. UI: Move BOM metadata out of Hardware card into header row
**File:** `src/pages/portal/invoices/InvoiceDraftEditor.tsx`

- Remove "(från BOM #X)" from the Hardware CardTitle
- Remove "Visa hela BOM" link from inside the Hardware card
- Add to the metadata row (near Kund/Utkast/Projekt):
  - "Invoice based on BOM #X" (original `bom_version` stored on invoice)
  - "Current BOM: #Y" (live query of latest BOM version in group, with editable/locked indicator)
  - Link to view the BOM

### 2. UI: Add SKU picker button to Hardware section
**File:** `src/pages/portal/invoices/InvoiceDraftEditor.tsx`

- Add "+ Add SKU" button (left of existing "+ Add row") that opens the existing `SKUSelector` component
- Pass `existingSkuIds` from current hardware line items to dim already-added SKUs
- When SKU is selected: add it as an invoice line item immediately, then trigger BOM revision logic

### 3. BOM revision logic from invoice (new hook or inline)
**File:** New file `src/hooks/use-invoice-bom-revision.ts`

Core logic when adding a SKU from invoice:

1. **Check if BOM exists** on the invoice. If no BOM linked, just add line item (no BOM interaction).
2. **Check if BOM is locked** (any quote or finalized invoice linked to current BOM version in statuses: sent, viewed, accepted, revision_requested; or invoice finalized).
3. **Case B — Editable revision exists:** Find a BOM in the same `bom_group_id` with a higher version that has no locking documents. If found, add SKU to both invoice lines and BOM items silently.
4. **Case A — No editable revision:** Show confirmation dialog. On confirm:
   - Create new BOM revision (copy items + add new SKU)
   - Log `bom_events` with `event_type: "revision_created"` and metadata including `source_document_type: "invoice"`, `source_document_stage: "draft"`, `internal_invoice_id`
   - Update invoice's `bom_id` to new revision
   - Show toast: "New BOM revision #N created..."
5. On cancel: just add line item to invoice, no BOM changes.

### 4. Confirmation modal for BOM revision
**File:** `src/pages/portal/invoices/InvoiceDraftEditor.tsx` (inline Dialog)

- Title: "Create new BOM revision?"
- Body: "Adding this item will create a new editable BOM revision. The BOM will remain editable until the invoice is finalized."
- Buttons: "Create revision and continue" / "Cancel"

### 5. BOM locking on invoice finalization
**File:** `supabase/functions/finalize-new-invoice/index.ts`

After finalization succeeds, enrich the `bom_events` metadata:
- Query `bom_events` for the `revision_created` event linked to this invoice (via `metadata->>'internal_invoice_id'`)
- Update metadata to add `source_document_stage: "finalized"`, `stripe_invoice_id`, `stripe_invoice_number`

The BOM is already implicitly locked by the existing lock query pattern (checking for finalized invoices linked to a BOM version). We need to extend the lock check to also consider invoices.

### 6. Extend BOM lock detection to include invoices
**Files:**
- `src/pages/portal/boms/BOMBuilder.tsx` — the `isLocked` query currently only checks quotes. Add a parallel check: any invoice with `bom_id` matching and `status` in `['open', 'paid']` also locks the BOM.
- `src/components/portal/boms/BOMVersionSelector.tsx` — same lock detection extension.

### 7. Track original vs current BOM on invoice
**File:** `src/pages/portal/invoices/InvoiceDraftEditor.tsx`

- Query the `bom_group_id` from the invoice's `bom_id`
- Query latest BOM version in that group
- Display both "based on BOM #X" (original) and "Current BOM: #Y" in the header

### 8. Invoice detail view updates
**File:** `src/pages/portal/invoices/InvoiceDetail.tsx`

- Move "(från BOM #X)" from Hardware section to top metadata area, consistent with draft editor

## Technical Details

- **No database migrations needed** — `bom_events.event_type` is unconstrained text, and `invoices.bom_id` already exists.
- **SKUSelector** component is reused as-is from BOM builder. The `onSelect` callback receives `(skuId, quantity)`.
- **BOM revision creation** reuses the same pattern from `BOMBuilder.tsx` `createRevisionMutation` — copy items, insert new BOM, log event.
- **Lock detection** will use an OR condition: locked if any quote OR any finalized invoice references that `bom_id`+`bom_version`.
- **Auto-save** continues to work — adding an SKU updates `lineItems` state which triggers the existing debounced auto-save.

## File Summary
| File | Change |
|------|--------|
| `src/pages/portal/invoices/InvoiceDraftEditor.tsx` | Major: SKU picker, BOM metadata in header, revision modal, revision logic |
| `src/hooks/use-invoice-bom-revision.ts` | New: Hook encapsulating BOM revision check/create logic |
| `src/pages/portal/boms/BOMBuilder.tsx` | Minor: Extend lock detection to include invoices |
| `src/components/portal/boms/BOMVersionSelector.tsx` | Minor: Extend lock detection to include invoices |
| `supabase/functions/finalize-new-invoice/index.ts` | Minor: Enrich bom_events metadata after finalization |
| `src/pages/portal/invoices/InvoiceDetail.tsx` | Minor: Move BOM reference to header metadata |

