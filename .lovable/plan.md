
# Energy Modeling Refactor: Multi-Home, Make/Model Templates, and Simulator Improvements

## Overview

This refactor introduces multi-home support, restructures device templates as a global make/model catalog, moves device assignment to "Home Setup", updates the Simulator to use Outdoor Temperature, and fixes schema constraints for reproducible model runs.

---

## Phase 1: Database Migration

The energy tables don't exist in the Live environment yet, so all schema changes are safe to apply in Test without data preservation concerns for Live.

### 1.1 Create `homes` table

New table linking customers to one or more homes:
- `id`, `customer_id` (FK customers), `name`, `address_text`, `created_at`
- Index on `customer_id`
- RLS: customers CRUD own homes, staff full access

### 1.2 Refactor `energy_home_settings` to per-home

- Add `home_id` (FK homes, NOT NULL, UNIQUE)
- Data migration: for each existing row, create a `homes` entry named "Home", then set `home_id`
- Drop the `UNIQUE(customer_id)` constraint (keep `customer_id` for backward compat but it's no longer the primary anchor)
- RLS updated to check via `home_id -> homes.customer_id`

### 1.3 Refactor `energy_devices` to attach to `home_id`

- Add `home_id` (FK homes, NOT NULL)
- Migrate existing rows: set `home_id` from `energy_home_settings.home_id` via join
- Drop `energy_home_settings_id` FK after migration
- RLS updated to check via `home_id -> homes.customer_id`

### 1.4 Add `make`, `model`, `display_name`, `device_kind`, `specs` to `device_templates`

- Add columns: `make` (text NOT NULL default ''), `model` (text NOT NULL default ''), `display_name` (text NOT NULL default ''), `device_kind` (text NOT NULL default ''), `specs` (jsonb NOT NULL default '{}')
- Backfill existing 6 templates with sensible make/model/display_name/device_kind values derived from their current `name` and `device_type`
- RLS stays the same (customers SELECT, staff full)

### 1.5 Fix `device_template_profiles` constraints

- Add `UNIQUE(device_template_id, profile_kind, version)` for version uniqueness
- Add partial unique index: `UNIQUE(device_template_id, profile_kind) WHERE is_active = true` for single active profile per kind

### 1.6 Fix `model_runs` for reproducibility

- Add `home_id` (FK homes, NOT NULL after migration)
- Add `device_snapshot` (jsonb, default '[]')
- Add `profile_snapshot` (jsonb, default '{}')
- Migrate existing rows (0 rows currently, so this is safe)
- Drop `energy_home_settings_id` FK after migration

---

## Phase 2: UI Changes

### 2.1 Home Selector Component

Create a reusable `HomeSelector` dropdown component:
- Fetches homes for the current customer
- Shows dropdown with home names
- "Create Home" button/modal (name + optional address)
- Empty state when no homes exist
- Used in: Home Setup, Simulator, ROI, Device Manager

### 2.2 Rename "House Setup" to "Home Setup"

- Update tab labels in `EnergyModeling.tsx` and `CustomerViewEnergyModeling.tsx`
- "Husinstellningar" becomes "Heminstellningar" (sv), "House Setup" becomes "Home Setup" (en)

### 2.3 Refactor Home Setup Tab

Current behavior: shows Home Profile data read-only + overrides.
New behavior: **also shows devices assigned to selected home** and lets users assign devices from the global catalog.

- Add home selector at top
- Keep existing Home Profile data display
- Add "Devices in this home" section with device list
- "Add device" button opens modal to pick from `device_templates` catalog
- Edit per-home instance values: name, quantity, advanced max_power_override_w

### 2.4 Refactor Device Manager Tab

**Customer view changes:**
- Default: "My Devices" -- shows only templates assigned to at least one of the customer's homes
- Toggle: "All Devices" -- read-only browse of full global catalog
- Remove the "Add" button from customer view (adding is done via Home Setup)

**Staff view stays the same** (full CRUD on templates)

### 2.5 Refactor DeviceAddEditDialog

- Change from accepting `settingsId` to accepting `homeId`
- Insert `energy_devices` with `home_id` instead of `energy_home_settings_id`

### 2.6 Refactor DeviceTemplatesTab (Staff)

- Add `make`, `model`, `display_name`, `device_kind`, `specs` fields to the template form
- Remove old `name`, `category`, `device_type` fields (or map them)
- Keep profile management (COP curve preview)

### 2.7 Simulator: Replace deltaT with Outdoor Temperature

- Remove "deltaT" slider
- Add "Outdoor Temp (°C)" slider (range: -25 to +15, default: -5)
- Keep "Indoor Temp (°C)" slider
- Compute `deltaT = indoorTemp - outdoorTemp` (clamped >= 0)
- Store in `inputs_snapshot`: `indoor_temp_c`, `outdoor_temp_c`, `delta_t_c`, `comfort_band_c`, `target_peak_w`, `home_id`
- On "Run Simulation": load devices for selected home, build snapshots, insert `model_runs` row, run simulation

### 2.8 Update EnergyModeling.tsx and CustomerViewEnergyModeling.tsx

- Pass `homeId` (from home selector state) down to child tabs
- Update tab labels

---

## Phase 3: Seed Data

Backfill the 6 existing device templates with make/model info:
- "Luft-luft varmepump 12kW" -> make: "Generic", model: "AA-12", device_kind: "air_to_air_heat_pump"
- "Elradiator 2kW" -> make: "Generic", model: "RH-2000", device_kind: "direct_electric_heater"
- "Elbilsladdare 11kW" -> make: "Generic", model: "EVC-11", device_kind: "ev_charger"
- "Diskmaskin" -> make: "Generic", model: "DW-2000", device_kind: "appliance"
- "Tvattmaskin" -> make: "Generic", model: "WM-2200", device_kind: "appliance"
- "Baslast" -> make: "Generic", model: "BL-500", device_kind: "base_load"

---

## Files to Create/Modify

### New files
- `src/components/portal/energy/HomeSelector.tsx` -- reusable home dropdown + create modal

### Modified files
- `src/pages/portal/EnergyModeling.tsx` -- home selector state, rename tabs, pass homeId
- `src/pages/portal/customer-view/CustomerViewEnergyModeling.tsx` -- same
- `src/components/portal/energy/HouseSetupTab.tsx` -- rename, add device assignment, accept homeId
- `src/components/portal/energy/DeviceManagerTab.tsx` -- customer "My Devices" vs "All" toggle, accept homeId
- `src/components/portal/energy/DeviceAddEditDialog.tsx` -- use homeId instead of settingsId
- `src/components/portal/energy/DeviceTemplatesTab.tsx` -- add make/model/kind/specs fields
- `src/components/portal/energy/SimulatorTab.tsx` -- outdoor temp slider, home selector, model_runs insert
- `src/components/portal/energy/ROITab.tsx` -- accept homeId prop (future-ready)

### Database
- One migration with: `homes` table, `energy_home_settings` refactor, `energy_devices` refactor, `device_templates` columns, `device_template_profiles` constraints, `model_runs` columns, data backfill, RLS policies
