

# Add "Superseded" Status to Quote Chain Lifecycle

## Overview

When a new quote revision is created (from a new BOM version or pricing revision), older quotes in the same chain remain active. This makes the quotes list confusing and allows customers to potentially act on stale offers. This plan adds a `superseded` status and automatic superseding logic across all quote creation paths.

## Current State

The database already has useful fields:
- `boms.bom_group_id` -- groups BOM revisions for the same project
- `quotes.parent_quote_id` -- links quote versions (partially used)
- `quotes.supersedes_quote_id` -- exists but is never populated
- `quotes.is_latest` -- exists but not reliably updated

The bug: `createQuoteFromPreviousVersion` in `BOMBuilder.tsx` creates a new quote but never marks the old one as superseded. Same issue in `useQuoteVersioning.ts` and `CustomerViewOfferDetail.tsx`.

---

## Step 1: Database Migration

Add two new columns and create an index:

```sql
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_quote_id uuid
    REFERENCES public.quotes(id);

CREATE INDEX IF NOT EXISTS idx_quotes_superseded_by
  ON public.quotes(superseded_by_quote_id)
  WHERE superseded_by_quote_id IS NOT NULL;
```

No `quote_group_id` column needed on quotes -- `bom_group_id` on `boms` already provides the chain grouping.

---

## Step 2: Shared Superseding Helper

Create `src/lib/supersede-quotes.ts` with a reusable function:

```text
supersedeActiveQuotesInChain({
  newQuoteId,
  bomId,       -- used to find bom_group_id
}) -> Promise<string[]>   // returns superseded quote IDs
```

Logic:
1. Look up `bom_group_id` from the new quote's BOM
2. Find all BOMs sharing that `bom_group_id`
3. Find all quotes linked to those BOMs with active status (`draft`, `sent`, `viewed`, `revision_requested`)
4. Exclude the new quote itself
5. Update matching quotes: `status = 'superseded'`, `superseded_at = now()`, `superseded_by_quote_id = newQuoteId`, `is_latest = false`
6. Return list of superseded quote IDs

Protected statuses that are NEVER superseded: `accepted`, `invoiced`, `cancelled`, `expired`, `superseded`, `declined`

---

## Step 3: Wire Superseding into All Creation Paths

There are **4 code paths** that create quote revisions:

### 3a. BOMBuilder - `createQuoteFromPreviousVersion` (line ~458)
After the new quote + lines are created, call `supersedeActiveQuotesInChain`.

### 3b. BOMBuilder - `createFreshQuote` (line ~400)
Same -- after creating the fresh quote, call the helper. (Handles edge case where a BOM group already has active quotes.)

### 3c. `useQuoteVersioning` - `createNewVersionMutation` (line ~48)
Currently only sets `is_latest = false` on old quotes. Change to also set `status = 'superseded'`, `superseded_at`, `superseded_by_quote_id` on quotes with active statuses. Use the same helper.

### 3d. `CustomerViewOfferDetail` - `handleCreateRevision` (line ~241)
Currently only marks the source quote as `is_latest = false`. Add superseding of all active quotes in the chain via the helper.

---

## Step 4: Status Badge

Update `src/lib/quote-status-badge.tsx` to add:

```text
case 'superseded':
  Badge variant="outline" text="Ersatt" / "Superseded" (muted gray styling)
```

---

## Step 5: Staff Quotes List (`QuotesList.tsx`)

**Active filter**: Add `superseded` to excluded statuses alongside `cancelled`:
```text
case 'active':
  if (quote.status === 'cancelled' || quote.status === 'superseded') return false;
  if (!quote.is_latest) return false;
```

**Filter options**: Rename "Inkl. avbrutna" to "Inkl. avbrutna/ersatta" and ensure superseded quotes appear when this filter is selected.

---

## Step 6: Staff Quote Detail (`QuotePreparation.tsx`)

When a superseded quote is viewed, show a banner (similar to the existing "older version" warning):

```text
"Denna offert har ersatts av #TQ-00000007"
[Button: "Gå till senaste" / "Go to latest"]
```

Requires fetching `superseded_by_quote_id` and its `quote_number` from the database. The quote should also be non-editable when superseded -- add `superseded` to the status checks for `isEditable` and `canSend`.

---

## Step 7: Quote Version Dropdown (`QuoteVersionDropdown.tsx`)

Add `superseded` to the status badge labels:
```text
superseded: t('Ersatt', 'Superseded')
```

---

## Step 8: Quote Actions Menu (`QuoteActionsMenu.tsx`)

Prevent cancelling a quote that's already superseded:
```text
const canCancel = !['cancelled', 'superseded'].includes(status);
```

---

## Step 9: Customer Offers List (`Offers.tsx`)

Add `superseded` to the excluded statuses in the query:
```text
.neq('status', 'superseded')
```

The existing `latestPerChain` grouping provides a secondary safeguard.

Also remove the leftover `.eq('is_test', ...)` filter that references removed functionality.

---

## Step 10: Customer Offer Detail (`OfferDetail.tsx`)

- Add `superseded` to the chain versions query exclusion (already excludes `draft` and `cancelled`)
- The existing `isViewingLatest` + action guards already prevent actions on non-latest quotes, but add explicit `superseded` handling

---

## Step 11: Customer View - Staff (`CustomerViewOffers.tsx`)

Add `superseded` status to the filter dropdown:
```text
<SelectItem value="superseded">{t('Ersatt', 'Superseded')}</SelectItem>
```

---

## Step 12: Customer View Offer Detail (`CustomerViewOfferDetail.tsx`)

- Add superseded banner similar to Step 6
- Update `handleCreateRevision` to call the superseding helper (Step 3d)

---

## Step 13: Public Quote Page (`PublicQuotePage.tsx`)

When a customer opens a superseded quote link via email:
- Show a friendly message: "Denna offert har ersatts av en nyare version."
- Do not show accept/decline/revision buttons

Update the completion-state check to include `superseded`:
```text
if (quoteData.status === 'superseded') {
  // Show "This quote has been replaced" message
}
```

---

## Step 14: Edge Functions - Block Actions on Superseded Quotes

### `accept-quote/index.ts`
Add `superseded` to the status validation. Return 409 with a message like "Offerten har ersatts av en nyare version".

### `decline-quote/index.ts`
Same - reject decline action on superseded quotes.

### `customer-quote-action/index.ts`
Add `superseded` to the status checks for accept, decline, and revision_request actions.

### `fetch-public-quote/index.ts`
Do not update `last_viewed_at` or status for superseded quotes. Return the data with status so the frontend can handle it.

---

## Step 15: Backfill Existing Data

For the specific case in Test (TQ-00000006 should be superseded by TQ-00000007):

```sql
UPDATE quotes
SET status = 'superseded',
    superseded_at = now(),
    superseded_by_quote_id = 'e54351c6-ca00-472a-ab2a-0e58cbceaec4',
    is_latest = false
WHERE id = '2f24990e-deab-4e05-9779-011b5818bfc5';
```

No backfill needed for TQ-00000004/TQ-00000005 since TQ-00000004 is already cancelled and TQ-00000005 is accepted (both are terminal states).

---

## Files Changed Summary

| File | Type |
|------|------|
| Database migration | Add `superseded_at`, `superseded_by_quote_id` columns |
| `src/lib/supersede-quotes.ts` | **New** shared helper |
| `src/lib/quote-status-badge.tsx` | Add `superseded` case |
| `src/pages/portal/boms/BOMBuilder.tsx` | Call supersede helper after both creation paths |
| `src/hooks/use-quote-versioning.ts` | Call supersede helper in mutation |
| `src/pages/portal/quotes/QuotesList.tsx` | Exclude superseded from active filter |
| `src/pages/portal/quotes/QuotePreparation.tsx` | Add superseded banner, block editing |
| `src/components/portal/quotes/QuoteVersionDropdown.tsx` | Add superseded label |
| `src/components/portal/quotes/QuoteActionsMenu.tsx` | Block cancel on superseded |
| `src/pages/portal/Offers.tsx` | Exclude superseded from query, remove is_test filter |
| `src/pages/portal/OfferDetail.tsx` | Exclude superseded from chain, handle in detail |
| `src/pages/portal/customer-view/CustomerViewOffers.tsx` | Add superseded filter option |
| `src/pages/portal/customer-view/CustomerViewOfferDetail.tsx` | Add superseded banner + wire supersede helper |
| `src/pages/portal/PublicQuotePage.tsx` | Handle superseded status display |
| `supabase/functions/accept-quote/index.ts` | Block accept on superseded |
| `supabase/functions/decline-quote/index.ts` | Block decline on superseded |
| `supabase/functions/customer-quote-action/index.ts` | Block all actions on superseded |
| `supabase/functions/fetch-public-quote/index.ts` | Skip view tracking for superseded |

