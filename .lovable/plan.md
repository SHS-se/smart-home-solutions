

# BOM / Quote Architectural Separation

## Overview

Refactor the system to enforce a strict separation: **BOM = scope** (what gets installed), **Quote = commercial document** (what the customer pays). Remove all pricing concepts from BOM. Remove the "BOM price revision" concept entirely. Make the Quote page the single home for pricing, margin, and commercial editing.

## Database Migrations

### Migration 1: Drop pricing columns from `bom_items`

Remove columns that represent pricing ownership from the BOM items table:

- `sell_price` (legacy)
- `sell_price_ex_vat_at_time`
- `sell_price_inc_vat_at_time`
- `vat_rate_at_time`
- `pricing_source`
- `cost` (legacy duplicate of `cost_ex_vat_at_time`)

**Keep**: `cost_ex_vat_at_time` (renamed conceptually to "internal cost reference" -- optional estimation field)

Before dropping, we will check Live for data in these columns (already confirmed: 12 rows with data). Since this is a deliberate architectural change and the user is aware, the columns will be dropped. A note will be provided about running a backup query on Live before publishing.

### Migration 2: Drop `bom_price_revisions` and `bom_price_revision_items` tables

These tables are no longer needed since pricing revisions are a concept being removed from BOM.

Also remove the `bom_price_revision_id` column from `quotes` table (this FK linked quotes to BOM pricing revisions, which is no longer the model).

### Migration 3: Add `source_bom_version` to `quote_lines` (optional context)

Add `source_bom_version integer` to `quote_lines` so we know which BOM version was the source when a quote was created. This is informational only.

## File Changes

### Files to Delete (4 files)

1. `src/hooks/use-bom-pricing-revisions.ts` -- entire pricing revision hook
2. `src/components/portal/boms/PricingRevisionDropdown.tsx` -- pricing revision UI component
3. `src/components/portal/quotes/QuoteOutdatedBanner.tsx` -- "BOM prices outdated" banner (no longer relevant)
4. `src/components/portal/quotes/QuoteUpdateConfirmDialog.tsx` -- "update to latest price revision" dialog
5. `src/components/portal/quotes/QuotePriceDiffModal.tsx` -- price diff comparison modal

### Files to Modify

#### 1. `src/pages/portal/boms/BOMBuilder.tsx` (major rewrite)

**Remove:**
- All pricing revision imports and usage (`PricingRevisionDropdown`, `useBomPricingRevisions`)
- "Skapa ny prisrevision" button
- Sell price columns from the table: "Salj ex", "Salj inkl", "Marginal"
- Summary sidebar: remove sell totals, margin calculations, margin status bar
- `totals` calculation that computes sell/margin -- replace with scope-only totals
- Price snapshot logic in `addItemMutation` (remove sell_price_*, vat_rate_at_time, pricing_source fields)
- Price-related fields in `createNewVersionMutation` item copying

**Keep:**
- SKU, Product Name, Quantity, Cost (optional) columns
- "Lagg till SKU", "Lagg till fran mall", "Skapa ny BOM-revision" buttons
- "Skapa offert fran BOM" button (updated logic below)
- Quantity editing with local state + save flow

**Add:**
- Info note at top: "BOM beskriver vad som ska installeras. Priser hanteras i offerten." / "BOM describes what will be installed. Prices are managed in the quote."
- Simplified summary sidebar showing only: SKU count, Total units, Total cost (ex VAT) for estimation

**Update `createQuote` function:**
- No longer calls `ensureRevisionExists`
- Copies BOM items into `quote_lines` with `section: 'hardware'`
- Fetches **current SKU pricing** at quote creation time (sell_price_ex_vat, vat_rate, cost_ex_vat_computed) and stores in quote_lines
- Sets `source_bom_id` and `source_bom_version`
- Does NOT set `bom_price_revision_id` on the quote

#### 2. `src/pages/portal/quotes/QuotePreparation.tsx` (moderate changes)

**Remove:**
- Imports: `QuotePriceDiffModal`, `QuoteOutdatedBanner`, `QuoteUpdateConfirmDialog`
- `useQuoteVersioning` hook usage (pricing status, price diff, version creation from pricing)
- The outdated pricing banner section
- The price diff modal and update confirm dialog
- State variables: `showDiffModal`, `showUpdateConfirm`, `priceDiff`

**Update hardware quantity editing:**
- Make hardware quantity fields **read-only** (disabled)
- When user focuses/clicks quantity, show a tooltip or message: "Andra antal via BOM (omfattningsandring)" / "Change quantity via BOM (scope change)"

**Add "Uppdatera fran BOM" button:**
- Shown in the hardware card header
- When clicked: fetches latest BOM items for the linked `bom_id`, compares quantities, and creates a new quote version with updated quantities (but preserves current quote prices)
- Only available when quote is editable (draft/revision_requested)

**Add margin info card:**
- In the summary sidebar, add a margin section that shows:
  - Cost vs sell comparison for hardware items (using `cost_ex_vat_at_time` from quote_lines)
  - Total margin in kr and %
  - Margin status indicator (same style as currently in BOM)

**Keep:**
- All price editing for hardware unit prices, labor, travel
- Send quote button + logic
- Create invoice button + logic
- Customer selector
- Quote version dropdown (for navigating between versions)

#### 3. `src/hooks/use-quote-versioning.ts` (simplify)

**Remove:**
- All pricing status / outdated pricing detection logic
- `computePriceDiff` function
- References to `bom_price_revision_id` and `bom_price_revisions` table

**Keep:**
- Quote family fetching (versions)
- The `createNewVersion` mutation but simplify it: instead of pulling from BOM price revisions, it copies the current quote's lines and increments version

#### 4. `src/pages/portal/quotes/QuotesList.tsx`

No significant changes needed -- this page already works with `quote_computed_totals` which is computed from `quote_lines`.

#### 5. `src/pages/portal/customer-view/CustomerViewOfferDetail.tsx`

No changes needed -- this page works with quotes/events/messages and doesn't reference BOM pricing revisions.

#### 6. `src/pages/portal/customer-view/CustomerViewDashboard.tsx`

No changes needed -- the Offerter card queries quotes, not BOM pricing.

## Business Logic Changes

### Quote Creation Flow (from BOM)

```text
User clicks "Skapa offert fran BOM"
    |
    v
Fetch all bom_items for this BOM
    |
    v
For each bom_item, fetch current SKU pricing:
  - skus.sell_price_ex_vat -> quote_lines.unit_price_ex_vat
  - skus.vat_rate -> quote_lines.vat_rate
  - skus.cost_ex_vat_computed -> quote_lines.cost_ex_vat_at_time
  - bom_items.quantity -> quote_lines.quantity
    |
    v
Insert quote with bom_id, bom_version, customer_id
Insert quote_lines (hardware) + default labor/travel rows
    |
    v
Navigate to /portal/quotes/:newId
```

### "Update from BOM" Flow (in Quote editor)

```text
User clicks "Uppdatera fran BOM" on Quote page
    |
    v
Fetch latest bom_items for quote.bom_id
    |
    v
Create new quote version (copy existing quote_lines)
Update hardware line quantities from BOM
Keep existing unit prices unchanged
    |
    v
Navigate to new quote version
```

### Quantity vs Price Change Rules

- **Quantity change** = Must be done in BOM, then "Update from BOM" in quote
- **Price change** = Done directly in Quote editor (unit prices editable)
- **Hardware quantity in quote** = Read-only, displays message directing to BOM
- **Labor/Travel quantity** = Editable in quote (these aren't scope items)

## Summary of Columns Dropped

### `bom_items` -- drop 6 columns:
- `sell_price`
- `sell_price_ex_vat_at_time`
- `sell_price_inc_vat_at_time`
- `vat_rate_at_time`
- `pricing_source`
- `cost` (legacy)

### `quotes` -- drop 1 column:
- `bom_price_revision_id`

### Tables dropped entirely:
- `bom_price_revisions`
- `bom_price_revision_items`

## Live Database Considerations

There is existing data in Live for `bom_items` pricing columns (12 rows) and `bom_price_revisions` (5 rows). Before publishing, you should run a backup query on Live to preserve this data if needed. The data will be lost on publish since these columns/tables are being dropped.

