
# VAT-Aware Pricing Engine Implementation Plan

## Status: PHASE 1-7 COMPLETE ✅

### Recently Completed: BOM Versioning & Pricing Revisions
- Created `bom_price_revisions` table for tracking pricing snapshots
- Created `bom_price_revision_items` table for snapshot line items  
- Added `bom_version` and `bom_price_revision_id` columns to `quotes` table
- Implemented `useBomPricingRevisions` hook with create/revert logic
- Added `PricingRevisionDropdown` component with history and revert UI
- Updated BOMBuilder with dual versioning badges and actions
- Quote creation now freezes both BOM version and pricing revision

---

## Overview
This plan implements a comprehensive VAT-aware pricing system for Smart Home Solutions with automatic price calculation, history tracking, and snapshot logic for BOMs and Quotes.

---

## Phase 1: Database Schema Changes

### 1.1 Extend `skus` Table
Add new columns to support VAT-aware pricing:

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `purchase_price` | numeric | 0 | Raw purchase price (may include VAT) |
| `purchase_includes_vat` | boolean | false | Whether purchase_price includes VAT |
| `vat_rate` | numeric | 0.25 | VAT rate (default 25%) |
| `cost_ex_vat_computed` | numeric | NULL | Computed: true cost ex VAT |
| `margin_override_percent` | numeric | NULL | Optional SKU-specific margin override |
| `rounding_override_sek` | integer | NULL | Optional SKU-specific rounding override |
| `effective_margin_percent` | numeric | NULL | Resolved margin (SKU or category) |
| `effective_rounding_sek` | integer | NULL | Resolved rounding (SKU or category) |
| `sell_price_ex_vat` | numeric | NULL | Calculated sell price ex VAT |
| `sell_price_inc_vat` | numeric | NULL | Calculated sell price inc VAT |
| `pricing_updated_at` | timestamptz | NULL | Last pricing recalculation timestamp |

### 1.2 Create `sku_price_history` Table
New table to track all pricing changes:

```text
sku_price_history
- id (uuid, PK)
- sku_id (uuid, FK -> skus.id)
- changed_at (timestamptz)
- changed_by (uuid, nullable - auth.uid())
- change_reason (text)
- purchase_price (numeric)
- purchase_includes_vat (boolean)
- vat_rate (numeric)
- cost_ex_vat (numeric)
- category (text)
- margin_override_percent (numeric, nullable)
- rounding_override_sek (integer, nullable)
- rule_margin_percent (numeric)
- rule_rounding_sek (integer)
- effective_margin_percent (numeric)
- effective_rounding_sek (integer)
- sell_price_ex_vat (numeric)
- sell_price_inc_vat (numeric)
```

RLS: Staff-only access (SELECT, INSERT).

### 1.3 Extend `bom_items` Table
Add snapshot columns for pricing at time of creation:

| Column | Type | Purpose |
|--------|------|---------|
| `cost_ex_vat_at_time` | numeric | Snapshot of cost |
| `sell_price_ex_vat_at_time` | numeric | Snapshot of sell price ex VAT |
| `vat_rate_at_time` | numeric | Snapshot of VAT rate |
| `sell_price_inc_vat_at_time` | numeric | Snapshot of sell price inc VAT |
| `pricing_source` | text | 'sku' (default) or 'manual' |

Rename existing `cost` -> migrate to `cost_ex_vat_at_time`, `sell_price` -> migrate to `sell_price_ex_vat_at_time`.

### 1.4 Extend `quote_lines` Table
Add snapshot columns for detailed pricing:

| Column | Type | Purpose |
|--------|------|---------|
| `sku_id` | uuid | Reference to source SKU (nullable) |
| `unit_price_ex_vat` | numeric | Price ex VAT |
| `vat_rate` | numeric | VAT rate at time |
| `unit_price_inc_vat` | numeric | Price inc VAT |
| `cost_ex_vat_at_time` | numeric | Cost snapshot |
| `original_sku_name` | text | SKU name at time |
| `original_sku_code` | text | SKU code at time |
| `pricing_source` | text | 'sku', 'bom', or 'manual' |

### 1.5 Extend `quotes` Table
Add VAT-aware totals:

| Column | Type | Purpose |
|--------|------|---------|
| `subtotal_ex_vat` | numeric | Sum of all lines ex VAT |
| `vat_total` | numeric | Total VAT amount |
| `total_inc_vat` | numeric | Grand total inc VAT |

---

## Phase 2: Database Functions and Triggers

### 2.1 Create `sku_recalculate_pricing` Function
Create a PL/pgSQL helper function used by the SKU trigger to compute pricing values.

This function must not perform any UPDATE on the skus table and must not insert history rows.

Its sole purpose is to compute and return the derived pricing fields based on the current SKU inputs and category rules.

The function must:
	1.	Compute cost_ex_vat_computed from:
	•	purchase_price / (1 + vat_rate) if purchase_includes_vat = true
	•	otherwise purchase_price
	2.	Look up margin_rules for the SKU’s category.
	3.	Resolve:
	•	effective_margin_percent (SKU override or category rule)
	•	effective_rounding_sek (SKU override or category rule)
	4.	Enforce:
	•	effective_rounding_sek >= 1 (raise exception if not)
	•	Category must exist in margin_rules (raise exception if not)
	5.	Calculate sell prices using CEILING rounding:
```
raw_price = cost_ex_vat_computed * (1 + effective_margin_percent / 100)
sell_price_ex_vat = CEILING(raw_price / effective_rounding_sek) * effective_rounding_sek
sell_price_inc_vat = sell_price_ex_vat * (1 + vat_rate)
```
	6.	Return the computed values so the BEFORE trigger can assign them to NEW.*.

### 2.2 Create SKU Pricing Trigger
Create a BEFORE INSERT OR UPDATE trigger on skus.

This trigger must not perform any UPDATE on the skus table.
Instead, it must compute and assign all derived pricing fields directly onto NEW.* to avoid recursion.

Trigger behavior

On any INSERT or UPDATE of skus, if any of the following fields change:
	•	purchase_price
	•	purchase_includes_vat
	•	vat_rate
	•	category
	•	margin_override_percent
	•	rounding_override_sek

Then:
	1.	Compute:
	•	NEW.cost_ex_vat_computed
	•	NEW.effective_margin_percent
	•	NEW.effective_rounding_sek
	•	NEW.sell_price_ex_vat
	•	NEW.sell_price_inc_vat
	•	NEW.pricing_updated_at = now()
	2.	Enforce safety rules:
	•	effective_rounding_sek must be >= 1 (raise exception if not)
	•	NEW.category must exist in margin_rules (raise exception if not)
	3.	Return NEW without issuing any UPDATE statement.

### 2.3 History logging

A companion AFTER INSERT OR UPDATE trigger must insert a row into sku_price_history whenever any pricing-affecting input changed, regardless of whether the final calculated price changed.

This ensures a complete audit trail of how pricing inputs evolved over time.

The history insert must call a SECURITY DEFINER function so it bypasses Supabase RLS restrictions and cannot fail silently.

### 2.4 Create Margin Rules Update Trigger
Trigger `AFTER UPDATE` on `margin_rules` that:
- Finds all SKUs in the affected category
- Recalculates pricing for each
- Inserts history rows with reason "category margin change"

### 2.5 Data Migration Function
One-time function to:
1. Copy existing `cost_ex_vat` to `purchase_price`
2. Set `purchase_includes_vat = false`, `vat_rate = 0.25`
3. Run pricing calculation for all SKUs
4. Insert initial history rows with reason "initial migration"

---

## Phase 3: Frontend - SKU Form Updates

### 3.1 Update `SKUForm.tsx`
Redesign the pricing section with two groups and enforce the new pricing engine rules.

Editable Fields

These fields directly affect pricing and will trigger recalculation:
	•	Inköpspris (Purchase Price) — numeric input with “kr” suffix → maps to purchase_price
	•	“Inkl moms” toggle — Switch component → maps to purchase_includes_vat
	•	Momssats (VAT Rate) — Select: 0%, 6%, 12%, 25% → maps to vat_rate
	•	Kategori — existing Select → must match a category present in margin_rules
	•	Marginal override (optional) — numeric input with “%” suffix → maps to margin_override_percent
	•	Avrundning override (optional) — Select with values: 1, 5, 10, 50, 100 → maps to rounding_override_sek

Validation rules in UI
	•	Category cannot be saved unless it exists in margin_rules
	•	Rounding override must be >= 1
	•	Show clear validation error if these constraints fail

Read-only Calculated Fields (derived from trigger logic)

These must be clearly displayed as calculated and non-editable:
	•	Kostnad ex moms (beräknad) → cost_ex_vat_computed
	•	Effektiv marginal → effective_margin_percent
	•	Säljpris ex moms → sell_price_ex_vat
	•	Säljpris inkl moms → sell_price_inc_vat

These values update automatically after save based on trigger calculations.

Price History Tab

Add a tab “Pris-historik” that displays rows from sku_price_history for this SKU:

Columns:
	•	Datum (changed_at)
	•	Orsak (change_reason)
	•	Inköpspris
	•	Kostnad ex moms
	•	Effektiv marginal
	•	Säljpris ex moms
	•	Säljpris inkl moms

Sorted descending by date.

This history will always exist because logging is triggered by input changes, not only price changes.

---

## Phase 4: Frontend - Margin Settings Updates

### 4.1 Update `MarginSettings.tsx`
Add warning banner:
- Alert component explaining that changing margins will recalculate ALL SKUs in that category
- Each SKU will get a new price history record

Update formula display:
- Show CEILING rounding formula (not standard rounding)
- Example: "145 × 1.35 = 195.75 → CEILING to 5 = 200 kr"

---

## Phase 5: Frontend - BOM Builder Updates

### 5.1 Update `BOMBuilder.tsx`
Modify the add item mutation:
- When adding SKU, snapshot:
  - `cost_ex_vat_at_time` from `cost_ex_vat_computed`
  - `sell_price_ex_vat_at_time` from `sell_price_ex_vat`
  - `vat_rate_at_time` from `vat_rate`
  - `sell_price_inc_vat_at_time` from `sell_price_inc_vat`
- Display both ex VAT and inc VAT prices in table

### 5.2 Add "Refresh BOM Prices" Action
New button that:
1. For each BOM item, fetches current SKU pricing
2. Updates snapshot fields with current values
3. Shows confirmation dialog first: "This will update all prices to current SKU pricing"

### 5.3 Update Summary Section
Show:
- Total ex VAT
- Total VAT (25%)
- Total inc VAT

---

## Phase 6: Frontend - Quote Updates

### 6.1 Update `QuotePreparation.tsx`
When creating quote from BOM:
- Copy all snapshot fields from BOM items
- Store `sku_id`, `original_sku_name`, `original_sku_code`
- Calculate and store `subtotal_ex_vat`, `vat_total`, `total_inc_vat`

### 6.2 Update Summary Display
Show three-line total:
- Delsumma (ex moms): X kr
- Moms (25%): Y kr
- **Totalt (ink moms): Z kr**

---

## Phase 7: Component Updates

### 7.1 Update `SKUSelector.tsx`
- Show `sell_price_ex_vat` and `sell_price_inc_vat` columns
- Use the pre-calculated values from SKU record (no client-side calculation)

### 7.2 Update `SKUCatalog.tsx`
- Display `sell_price_inc_vat` as the primary "Sell Price" column
- Add secondary column or tooltip showing ex VAT price
- Remove client-side `calculateSellPrice()` function - use database values

---

## Technical Details

### Ceiling Rounding Formula (SQL)
```sql
sell_price_ex_vat := CEILING(raw_price / effective_rounding_sek) * effective_rounding_sek;
```

### Ceiling Rounding Formula (TypeScript fallback)
```typescript
const sellPriceExVat = Math.ceil(rawPrice / rounding) * rounding;
```

### Acceptance Test Validation
Given:
- purchase_price = 518
- purchase_includes_vat = true
- vat_rate = 0.25
- margin = 25%
- rounding = 5

Then:
- cost_ex_vat = 518 / 1.25 = 414.4
- raw_price = 414.4 * 1.25 = 518.0
- sell_price_ex_vat = CEIL(518.0 / 5) * 5 = 520
- sell_price_inc_vat = 520 * 1.25 = 650

---

## File Changes Summary

### New Files
- Migration SQL file (schema changes + functions + triggers)

### Modified Files
1. `src/components/portal/skus/SKUForm.tsx` - New pricing fields, read-only calculated fields, price history tab
2. `src/pages/portal/skus/SKUCatalog.tsx` - Use pre-calculated prices, show inc VAT
3. `src/pages/portal/skus/SKUImport.tsx` - Update CSV columns for new pricing fields
4. `src/pages/portal/settings/MarginSettings.tsx` - Warning banner, CEILING formula
5. `src/pages/portal/boms/BOMBuilder.tsx` - Snapshot logic, refresh action, VAT totals
6. `src/components/portal/boms/SKUSelector.tsx` - Show pre-calculated prices
7. `src/pages/portal/quotes/QuotePreparation.tsx` - Extended snapshot, VAT totals
8. `src/pages/portal/templates/TemplateDetail.tsx` - Use pre-calculated prices

---

## Implementation Order

1. **Database migration** - Schema changes, functions, triggers, data migration
2. **SKUForm updates** - New pricing fields with read-only calculated display
3. **SKUCatalog updates** - Use database-calculated prices
4. **MarginSettings updates** - Warning banner, formula fix
5. **BOMBuilder updates** - Snapshot logic and refresh action
6. **QuotePreparation updates** - Extended snapshot and VAT totals
7. **SKUSelector updates** - Pre-calculated price display
8. **TemplateDetail updates** - Use pre-calculated prices
9. **SKUImport updates** - New CSV columns
10. **Price History component** - New tab for SKU form
