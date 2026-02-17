

# Multi-Home Scoping for Energy Modeling + ROI

## Overview

Scope all questionnaire answers, energy settings, tariffs, devices, and model runs per-home. Keep onboarding frictionless (single home, no selector). Reveal multi-home only after 2+ homes exist.

---

## Phase 1: Database Migration

### 1.1 Add `primary_home_id` to `customers`

```text
customers
  + primary_home_id uuid NULL REFERENCES homes(id)
```

Backfill for existing customers that already have a home:
- Set `primary_home_id` to their first `homes.id`.

For customers without a home (3 customers):
- Create a `homes` row named "My home".
- Set `primary_home_id`.

### 1.2 Add `home_id` to `home_answers`

```text
home_answers
  + home_id uuid NOT NULL REFERENCES homes(id) ON DELETE CASCADE
```

Steps:
1. Add column as nullable first.
2. Backfill: set `home_id = (SELECT primary_home_id FROM customers WHERE customers.id = home_answers.customer_id)`.
3. Set NOT NULL.
4. Drop existing UNIQUE(customer_id, question_id).
5. Add UNIQUE(home_id, question_id).
6. Update RLS policies: customer access checks via `home_id -> homes.customer_id`.

### 1.3 Add `home_id` to `tariff_instances`

```text
tariff_instances
  + home_id uuid NULL REFERENCES homes(id) ON DELETE CASCADE
```

Currently 0 rows, so no backfill needed. Keep nullable for now (tariffs may be created before home context is set, and existing code references customer_id).

### 1.4 Update RLS on `home_answers`

Replace customer policies to filter through `home_id`:
- SELECT: `EXISTS (SELECT 1 FROM homes WHERE homes.id = home_answers.home_id AND homes.customer_id = get_customer_id_for_user(auth.uid()))`
- INSERT: same check via WITH CHECK
- UPDATE: same

Staff policies remain unchanged.

### 1.5 Backfill summary

| Table | Existing rows | Action |
|-------|--------------|--------|
| customers | 5 | Add primary_home_id, create homes for 3 missing |
| home_answers | 63 | Set home_id from customer's primary_home_id |
| tariff_instances | 0 | Add column only |
| energy_devices | 4 | Already has home_id |
| energy_home_settings | 2 | Already has home_id |
| model_runs | 2 | Already has home_id |

---

## Phase 2: Frontend - Home Context System

### 2.1 HomeSelector visibility rules

Modify `HomeSelector` component:
- If customer has only 1 home: render nothing (completely hidden).
- If customer has 2+ homes: show the existing dropdown + "+" button.
- The parent component auto-selects `primary_home_id` as default.

### 2.2 Update `EnergyModeling.tsx` (customer view)

- Fetch `primary_home_id` from customer record on mount.
- Auto-set `selectedHomeId = primary_home_id` if no selection exists.
- Only show HomeSelector when 2+ homes exist.
- All tabs receive `homeId` (already the case for most).

### 2.3 Update `CustomerViewEnergyModeling.tsx` (staff view)

Same pattern: fetch customer's homes, auto-select primary, show selector only when 2+ homes.

---

## Phase 3: Questionnaire Per-Home Scoping

### 3.1 Update `HomeProfileForm.tsx`

- Accept optional `homeId` prop.
- All queries for `home_answers` filter by `home_id` (not just `customer_id`).
- Upserts use `onConflict: 'home_id,question_id'`.
- When `homeId` is provided and 2+ homes exist, show a subtle header: "Property: {home_name}" with small dropdown.
- When only 1 home or no `homeId`, show no selector.
- Add helper text "Answers apply only to this property." when multiple homes exist.

### 3.2 Update `HomeProfile.tsx` (customer page)

- On mount, fetch customer's primary_home_id.
- Pass `homeId={primaryHomeId}` to `HomeProfileForm`.
- Support `?home=<uuid>` query param to override (used when adding a second home).

### 3.3 Update `CustomerViewHomeProfile.tsx` (staff page)

- Same: fetch customer homes, pass homeId, show selector when 2+.

### 3.4 Update `HouseSetupTab.tsx` inline edits

- Change `handleProfileValueChange` to upsert with `home_id` instead of `customer_id` only.
- Query `home_answers` filtered by `home_id`.

---

## Phase 4: "Add Another Property" Flow

### 4.1 ROI page CTA

Add to `ROITab.tsx`:
- A secondary button/link: "Calculate ROI for another property" (Swedish: "Berakna lonsamhet for en annan fastighet").
- Positioned below the KPI summary cards.
- Opens a small dialog.

### 4.2 "Add another property" dialog

Small modal:
- Title: "Add another property" / "Lagg till en annan fastighet"
- Single field: Property name (required), placeholder examples: "Summer house", "Rental apartment"
- Primary button: "Start setup" / "Borja installning"
- Secondary: Cancel

On submit:
- Insert into `homes` table.
- Navigate to `/portal/home-profile?home=<new_home_id>` (or staff equivalent).

### 4.3 Home context label on ROI

When only 1 home: show subtle label "ROI for: My home" near the top.
When 2+ homes: the global HomeSelector handles context.

---

## Phase 5: Missing Fields Gating on ROI

### 5.1 Required fields check

Define a list of required semantic keys for ROI calculation (e.g., `heated_area_m2`, `year_built`, `dwelling_type`).

On ROI page load:
- Fetch `home_answers` for current `home_id`.
- Check which required fields are missing.
- If any missing: show a friendly checklist panel at the top of ROI.

### 5.2 Checklist panel UI

- Card with title: "A few details needed to calculate ROI" / "Nagra detaljer behovs for att berakna lonsamhet"
- List missing items in plain language (using SEMANTIC_LABELS).
- Primary button: "Continue setup" -> navigates to `/portal/home-profile?home=<homeId>`.
- ROI content below is shown but in a muted/disabled state (reduced opacity, no interaction).

---

## Phase 6: Property Context Indicator

On all Energy Modeling tabs (ROI, Home Setup, Device Manager, Simulator, Tariff), show the current home name subtly:
- When 1 home: small muted text "My home" near the tab header area.
- When 2+ homes: the HomeSelector dropdown already shows the name; no additional indicator needed.

---

## Files to Create/Modify

### Database
- 1 migration: `customers.primary_home_id`, `home_answers.home_id`, `tariff_instances.home_id`, backfill, RLS updates

### Modified files
- `src/components/portal/energy/HomeSelector.tsx` -- hide when 1 home, expose home count
- `src/components/portal/energy/ROITab.tsx` -- add home label, "add property" CTA + dialog, missing fields panel
- `src/components/portal/energy/HouseSetupTab.tsx` -- query/upsert home_answers by home_id
- `src/components/portal/home-profile/HomeProfileForm.tsx` -- accept homeId prop, scope queries by home_id, show property context when 2+ homes
- `src/pages/portal/HomeProfile.tsx` -- fetch primary_home_id, support ?home= param
- `src/pages/portal/EnergyModeling.tsx` -- auto-select primary home, conditional HomeSelector
- `src/pages/portal/customer-view/CustomerViewEnergyModeling.tsx` -- same
- `src/pages/portal/customer-view/CustomerViewHomeProfile.tsx` -- pass homeId
- `src/components/portal/energy/TariffPricingTab.tsx` -- accept homeId prop, scope queries
- `src/integrations/supabase/types.ts` -- auto-updated after migration

---

## Technical Details

### Home context resolution (frontend)

```text
1. Check URL ?home=<uuid>  ->  use that
2. Else fetch homes for customer
3. If homes.length == 1  ->  use that home's id, hide selector
4. If homes.length > 1   ->  use primary_home_id as default, show selector
5. If homes.length == 0   ->  auto-create "My home", use it
```

### Upsert conflict key change

`home_answers` upsert changes from:
```
onConflict: 'customer_id,question_id'
```
to:
```
onConflict: 'home_id,question_id'
```

### RLS pattern for home-scoped tables

All customer access policies check ownership through the `homes` table:
```sql
EXISTS (
  SELECT 1 FROM homes
  WHERE homes.id = <table>.home_id
  AND homes.customer_id = get_customer_id_for_user(auth.uid())
)
```

