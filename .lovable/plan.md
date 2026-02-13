# Energy Modeling -- Implementation Plan

This is a large feature spanning database schema, edge functions, and many UI components. The plan is organized into **4 phases** to keep each step reviewable and testable.

---

Phase 0:  **Questionnaire power values must be converted to W at ingestion**

Right now:

- EV charger power is entered in kW
- peak power is entered in kW

### **Required fix**

When Home Profile answers are saved:

- convert kW → W immediately
- store W in DB
- mark original unit if needed for display

If that’s not already done, add a migration to:

- convert existing stored kW answers to W
- update any dependent logic

  
Phase 1: Database Schema + Seed Data

Create all 10 new tables, RLS policies, storage bucket, and seed data in a single migration.

### Tables to create:

- **energy_home_settings** -- per-user overrides/derived values, links to home profile via customer_id
- **device_templates** -- staff-managed canonical device definitions
- **device_template_profiles** -- versioned performance curves (COP, capacity, daily profiles)
- **energy_devices** -- customer device instances referencing templates
- **tariff_rules** -- network tariff engine rules (seeded with Ellevio villa)
- **tariff_instances** -- customer-specific pricing configuration
- **model_runs** -- simulation history with snapshotted inputs/results
- **energy_raw_uploads** -- staff CSV upload metadata
- **energy_normalized_series** -- 15-min normalized power data

### RLS policies:

- Staff: full CRUD on all energy tables
- Customers: read/write own energy_home_settings, energy_devices, tariff_instances, model_runs
- Customers: read-only on device_templates, tariff_rules

### Seed data (in same migration):

- 6 device templates: Air-air heat pump 12kW (3500W electrical), Electric radiator 2kW, EV charger 11kW, Dishwasher 2kW, Washing machine 2.2kW, Constant power 500W
- Default COP/capacity curves for heat pump template profile
- Ellevio villa tariff rule with top-3 daily peaks, night factor 0.5x, 0.045 SEK/W/month

### Storage bucket:

- `energy-raw-uploads` (staff-only access)

---

## Phase 2: Routing, Page Shell, and Dashboard Card

### New files:

- `src/pages/portal/EnergyModeling.tsx` -- main page with role-based tabs
- `src/pages/portal/customer-view/CustomerViewEnergyModeling.tsx` -- staff viewing customer's energy page

### Changes to existing files:

- **App.tsx** -- add routes `/portal/energy-modeling` and `/portal/customers/:customerId/energy-modeling`
- **Dashboard.tsx** -- add Energy Modeling card to customer dashboard (with Zap icon)
- **CustomerDashboardCards.tsx** -- add Energy Modeling card with device count stats
- **CustomerViewDashboard.tsx** -- add Energy Modeling card for staff customer view

### Utility module:

- `src/lib/energy-units.ts` -- power unit helper:
  - `formatPower(watts)` returns `{ value, unit, display }` -- shows kW when >= 1000W
  - `toWatts(kw)` and `toKw(w)` converters

---

## Phase 3: Tab Components (UI)

Each tab is a separate component file under `src/components/portal/energy/`:

### Customer tabs:

1. **HouseSetupTab.tsx** -- reads home_answers via existing questionnaire system, displays as read-only with "Source: Home Profile" badges, collapsible overrides panel, Heat Demand vs delta-T chart (Recharts line chart using UA value)
2. **DeviceManagerTab.tsx** -- CRUD list of energy_devices with Add/Edit dialog, category filter pills, search, right-panel detail graphs (COP curve for heat pumps, power profile for appliances)
3. **TariffPricingTab.tsx** -- tariff rule selector, energy pricing model radio group, price inputs, monthly peak comparison bar chart
4. **SimulatorTab.tsx** -- mode/scenario toggles, sliders for delta-T/indoor temp/comfort band, target peak input, load curve + composition charts, metrics sidebar, "Run" button
5. **ROITab.tsx** -- summary cards (annual cost dumb/smart, savings, payback), cost breakdown bar chart, scenario comparison table, system cost inputs

### Staff-only tabs:

6. **DeviceTemplatesTab.tsx** -- three-column layout: template list, template form, curve editor (interactive COP/capacity charts)
7. **CalibrationTab.tsx** -- CSV upload zone, normalization preview, measured vs modeled overlay chart, calibration sliders (UA, COP scale, capacity scale)

### Shared components:

- `DeviceAddEditDialog.tsx` -- modal form for adding/editing device instances
- `PerformanceCurveChart.tsx` -- reusable Recharts component for COP/capacity curves
- `LoadCurveChart.tsx` -- 15-min interval line chart with peak markers

---

## Phase 4: Edge Functions + Simulation Engine

### Edge functions:

1. **energy-ensure-home-settings** -- POST: creates energy_home_settings row if missing, computes UA from home profile answers (area, year built, heating type), determines thermal capacity class, returns settings
2. **energy-get-effective-house-inputs** -- GET: merges home_answers + energy_home_settings overrides + derived values + energy_devices + tariff_instance into a single JSON object for simulation
3. **energy-run-model** -- POST: accepts mode (design/typical/year), scenario (dumb/smart), parameters. Generates synthetic 15-min W time series:
  - Heating demand via UA x delta-T
  - Allocates across devices by priority
  - Dumb: all loads concurrent; Smart: shifts shiftable loads off peak
  - Computes tariff peak (top-3 daily peaks method)
  - Computes energy cost
  - Saves to model_runs with input/tariff snapshots
4. **energy-upload-csv** -- POST: staff uploads CSV to storage bucket, normalizes to 15-min mean W buckets, stores in energy_normalized_series
5. **energy-profile-validate-and-save** -- POST: validates device template profile data, creates new versioned profile

### Stockholm temperature dataset:

- Hardcoded typical year hourly temperatures (8760 values) embedded in the edge function as a constant array, interpolated to 15-min for year mode simulations

---

## Technical Details

### Home Profile mapping layer

The `energy-get-effective-house-inputs` function maps question IDs to semantic fields. This requires knowing which home_questions correspond to dwelling type, heated area, etc. The mapping will be done by adding a `semantic_key` to questions. The simpler approach: store a mapping config in the edge function that maps question text patterns to field names.

Add a semantic_key column to your existing home_questions table.

Example keys:

- dwelling_type
- heated_area_m2
- year_built
- occupants
- heating_types
- hot_water_type
- has_ev
- ev_charger_power_kw
- annual_kwh
- annual_peak_kw
- contract_type
- winter_indoor_temp_c (or comfort proxy)

Edge function must read by semantic_key, not text.  
  
UA estimation formula

```
UA (W/K) = heated_area * U_factor_by_era * form_factor_by_type
```

Where U_factor_by_era is derived from year_built (pre-1960: ~1.5, 1960-1980: ~1.0, 1980-2000: ~0.6, post-2000: ~0.4 W/m2K) and form_factor accounts for dwelling type surface-to-volume ratio.

### Thermal capacity classes

- Light (wooden frame, poorly insulated): fast response
- Medium (standard Swedish construction): moderate
- Heavy (masonry, concrete): slow response

### File count estimate

- ~1 migration file
- ~12 new component files
- ~5 edge function directories
- ~2 utility/lib files
- ~3 modified existing files

### Dependencies

- Recharts (already installed) for all charts
- No new npm packages needed

---

## Implementation Order

1. **Migration** -- create all tables, RLS, seed data, storage bucket
2. **Utility + routing** -- energy-units.ts, page shell, routes, dashboard card
3. **House Setup + Device Manager tabs** -- core data display
4. **Device Templates + Calibration tabs** -- staff tools
5. **Tariff & Pricing tab** -- tariff configuration
6. **Edge functions** -- ensure-home-settings, get-effective-inputs, run-model
7. **Simulator + ROI tabs** -- connect to edge functions
8. **CSV upload edge function + Calibration integration**

Due to the size of this feature, implementation will require multiple messages. The first message will cover Phase 1 (database) and Phase 2 (routing + shell).