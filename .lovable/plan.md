

# Performance Data System for Energy Modeling

## Overview

This plan extends the existing `device_profiles` system from a single curve-only model to a full performance data platform supporting both 1D curves and 2D surfaces, with a rich editor modal, borrowed-data resolution, and simulator integration.

## Scope and Phasing

Due to the breadth of this feature, this is broken into **4 phases** that build on each other. Each phase delivers working functionality.

---

## Phase 1: Database Migration

### 1a. Evolve `device_profiles` table

The current table has a `UNIQUE(device_id)` constraint allowing only one profile per device. We need to support multiple profile kinds per device (e.g., heating curve + heating surface).

**Changes:**
- Drop the existing `UNIQUE(device_id)` constraint
- Add a `mode` column (`text`, default `'heating'`, not null) for heating vs cooling
- Add a `metadata` column (`jsonb`, nullable) for optional details (e.g., outdoor temp type WB/DB)
- Add a new unique constraint on `(device_id, mode, profile_kind)`
- Migrate the existing 1 row: set `mode = 'heating'`

### 1b. Create `device_profile_points` table

A normalized points table for granular data storage:

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| profile_id | uuid FK -> device_profiles.id ON DELETE CASCADE | |
| temp_c | numeric | Outdoor temp |
| indoor_temp_c | numeric, nullable | NULL for 1D curve, required for 2D surface |
| cop | numeric, nullable | Required for curve, NULL for surface |
| capacity_w | integer, nullable | Required for both |
| input_power_w | integer, nullable | Required for surface |
| created_at | timestamptz | |

**Indexes:**
- `(profile_id, temp_c)` for curve lookups
- Unique constraint logic handled at application level (temp_c unique per curve profile; (indoor_temp_c, temp_c) unique per surface profile)

**RLS:** Mirror the existing device_profiles pattern -- staff full access, customers can CRUD for own devices, customers can SELECT for global devices.

### 1c. Add `performance_data_device_id` to `device_instances`

- New nullable column `performance_data_device_id uuid` FK -> `device_instances.id`
- A validation trigger prevents self-referencing (device cannot reference itself)

---

## Phase 2: Backend Validation

### 2a. Extend `validate-device-profile` edge function

Add support for `heating_performance_surface` profile kind alongside the existing `cop_capacity_curve`.

**Curve validation rules (updated):**
- `points.length >= 2` (relaxed from current 4)
- `temp_c` unique, sorted ascending (auto-sort on save)
- `cop > 0 && cop < 15`
- `capacity_w > 0 && capacity_w < 30000`

**Surface validation rules (new):**
- Points array with `indoor_temp_c`, `temp_c`, `capacity_w`, `input_power_w`
- Unique `(indoor_temp_c, temp_c)` combinations
- `input_power_w > 0 && input_power_w < 20000`
- Derived COP sanity: `capacity_w / input_power_w` between 0.5 and 15 (warning); block save if < 0.2 or > 25

### 2b. Profile resolution helper

Create a shared utility `src/lib/performance-data.ts`:
- `resolveProfile(deviceId, mode, profileKind)` -- checks own profile first, falls back to `performance_data_device_id` device's profile
- Returns `{ profile, source: 'own' | 'borrowed', borrowedFromName? }`
- Used by both the UI (to show status) and the simulator

---

## Phase 3: Performance Data Editor Modal

Replace and extend the existing `CurveUploadModal` with a new `PerformanceDataEditor` modal.

### 3a. Modal structure

- Header: "Edit Performance Data" with profile kind indicator
- Top bar: Source dropdown (manufacturer/estimated/measured), Notes textarea
- Three tabs: **JSON**, **Table**, **Preview**
- Validation summary above Save button
- Save disabled until valid

### 3b. JSON tab
- Full JSON textarea (existing behavior, enhanced)
- Live validation (debounced) with human-readable error paths
- "Format JSON" button
- "Paste example" button that inserts a valid sample for the current schema

### 3c. Table tab

**For Curve (1D):**
- Editable table: `temp_c | cop | capacity_w`
- Add row / delete row buttons
- TSV paste support (auto-maps columns)
- "Sort by temperature" button
- Inline validation badges per row
- "Normalize units" helper (kW -> W conversion)

**For Surface (2D):**
- Flat table view: `indoor_temp_c | temp_c | capacity_w | input_power_w`
- Add/delete row, TSV paste support
- Column mapping step when paste shape is ambiguous
- Derived COP column (read-only, computed)
- "Normalize units" helper

### 3d. Preview tab

**For Curve:**
- COP vs temp line chart
- Capacity (kW display) vs temp line chart
- Side by side (existing layout)

**For Surface:**
- Indoor temp dropdown (defaults to 20 deg C)
- For selected indoor temp, three charts: Capacity vs outdoor temp, Input Power vs outdoor temp, Derived COP vs outdoor temp

### 3e. Save behavior
- Upsert `device_profiles` row by `(device_id, mode, profile_kind)`
- Replace all `device_profile_points` for that profile in a transaction
- Continue storing the JSONB `data` field as well for backwards compatibility
- Store W internally, display kW in UI

---

## Phase 4: Device Catalog UI + Simulator Integration

### 4a. Device editor: "Performance Data" section

In `DeviceCatalogTab.tsx`, replace the single "COP + Capacity Curve" card with a "Performance Data" section showing:
- Status chips per profile: "COP+Capacity Curve (heating)" and "Heating Performance Surface"
- Each shows: present / missing / borrowed + source badge
- Edit buttons open the new editor modal for the respective kind
- "Use another device's data" toggle with searchable device dropdown
- Precedence explanation text

### 4b. Simulator integration

In `SimulatorTab.tsx`:
- Indoor temperature slider/input already exists -- use it for surface interpolation
- When evaluating heating device performance:
  - Resolve profile using `resolveProfile()` helper
  - If surface exists: bilinear interpolation on (indoor_temp_c, temp_c) for capacity and input power; derive COP
  - Else fallback to curve: linear interpolation on temp_c for COP and capacity
- Show data source badge: "Manufacturer / Estimated / Measured / Borrowed from {name}"

---

## Technical Details

### Files to create
- `src/lib/performance-data.ts` -- profile resolution + interpolation helpers + validation
- `src/components/portal/energy/PerformanceDataEditor.tsx` -- new modal component
- `src/components/portal/energy/PerformanceDataStatus.tsx` -- status chips component
- `src/components/portal/energy/SurfacePreviewCharts.tsx` -- surface chart component

### Files to modify
- `supabase/functions/validate-device-profile/index.ts` -- add surface validation
- `src/components/portal/energy/DeviceCatalogTab.tsx` -- replace curve panel with performance data section
- `src/components/portal/energy/SimulatorTab.tsx` -- integrate profile resolution + interpolation
- `src/components/portal/energy/CurveUploadModal.tsx` -- deprecate / redirect to new editor

### Migration SQL (summary)
1. `ALTER TABLE device_profiles` -- add mode, metadata columns, drop old unique, add new unique
2. `CREATE TABLE device_profile_points` with RLS
3. `ALTER TABLE device_instances ADD performance_data_device_id` with FK + self-ref trigger
4. Backfill existing profile row with `mode = 'heating'`

