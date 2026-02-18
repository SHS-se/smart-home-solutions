
# Device Modeling Hierarchy Refactor: Type, Template, Instance

## Overview

Introduce a three-level device hierarchy replacing the current flat "device_kind" approach:

- **Device Type** -- defines schema, simulation model, and allowed profile kinds (staff-managed)
- **Device Template** -- catalog entry belonging to one type, with optional field defaults (staff-managed, customer-readable)
- **Device Instance** -- concrete device with actual values, assigned to a home (customer-created)

No data exists in Live for these tables, so all changes are safe.

---

## What Changes

### For Staff
- New "Device Types" management section (create/edit types with field schemas)
- Template form now selects a type first, then shows dynamic fields
- Existing template management adapts to the new structure

### For Customers
- "Add Device" flow now renders a dynamic form based on the template's type schema
- Device instances store concrete values in a `field_values` JSON column
- Read-only access to types and templates (unchanged)

---

## Technical Details

### Phase 1: Database Migrations

**1a. Create `device_types` table**

```text
Columns:
  id          uuid PK
  key         text UNIQUE NOT NULL (e.g. 'air_to_air_heat_pump')
  display_name text NOT NULL
  field_schema jsonb NOT NULL (array of field definitions)
  supported_profile_kinds jsonb NOT NULL DEFAULT '[]'
  simulation_model_key text NOT NULL
  created_at  timestamptz DEFAULT now()

RLS:
  Staff: full CRUD
  Customers: SELECT only (authenticated)
```

**1b. Seed initial device types** (6 types matching existing device_kinds):
- air_to_air_heat_pump (fields: make, model, max_power_w, scop, cop, min_temp_c; profiles: cop_curve, capacity_curve; sim: heat_pump_aa)
- direct_electric_heater (fields: make, model, max_power_w; sim: resistive)
- ev_charger (fields: make, model, max_power_w; sim: ev_charger)
- appliance (fields: make, model, max_power_w; sim: fixed_schedule)
- base_load (fields: make, model, max_power_w; sim: constant)
- hot_water_heater (fields: make, model, max_power_w; sim: hot_water)

**1c. Add `device_type_id` FK to `device_templates`**

- Add column `device_type_id uuid REFERENCES device_types(id)`
- Add column `field_defaults jsonb NOT NULL DEFAULT '{}'`
- Backfill from existing `device_kind` values
- Make `device_type_id` NOT NULL after backfill

**1d. Create `device_instances` table** (replaces `energy_devices`)

```text
Columns:
  id                  uuid PK
  home_id             uuid NOT NULL FK -> homes(id) ON DELETE CASCADE
  device_template_id  uuid NOT NULL FK -> device_templates(id)
  name                text NOT NULL
  quantity            int NOT NULL DEFAULT 1
  field_values        jsonb NOT NULL DEFAULT '{}'
  controllable        boolean NOT NULL DEFAULT false
  shiftable           boolean NOT NULL DEFAULT false
  priority            int NOT NULL DEFAULT 0
  created_at          timestamptz DEFAULT now()
  updated_at          timestamptz DEFAULT now()

RLS:
  Staff: full CRUD
  Customers: CRUD own (via home_id -> homes.customer_id)
```

**1e. Migrate data from `energy_devices` to `device_instances`**

- Copy all rows, building `field_values` from the linked template's current values (make, model, max_power_w = template's max_electrical_power_w, scop from template, plus any max_power_override_w)
- Preserve IDs so existing `model_runs.device_snapshot` references remain valid

**1f. Drop `energy_devices` table** (after code migration complete)

### Phase 2: Frontend Changes

**Files to create:**
- `src/components/portal/energy/DeviceTypesManager.tsx` -- staff-only CRUD for device types with field_schema editor
- `src/components/portal/energy/DeviceInstanceDialog.tsx` -- dynamic form that renders fields from the type's field_schema, pre-filled with template defaults

**Files to modify:**
- `src/pages/portal/EnergyModeling.tsx` -- add "Device Types" tab for staff-only view
- `src/components/portal/energy/DeviceTemplatesTab.tsx` -- refactor to select device_type first, show dynamic fields from type schema, save field_defaults
- `src/components/portal/energy/DeviceManagerTab.tsx` -- query `device_instances` instead of `energy_devices`, show type badge, display key field_values
- `src/components/portal/energy/DeviceAddEditDialog.tsx` -- replace with `DeviceInstanceDialog` that renders dynamic form from type schema
- `src/components/portal/energy/HouseSetupTab.tsx` -- update all `energy_devices` references to `device_instances`, use field_values for display
- `src/components/portal/energy/SimulatorTab.tsx` -- query `device_instances`, build device_snapshot from field_values + type key

### Phase 3: Validation

- On instance save: validate all required fields from type schema exist in `field_values` and match expected types
- On template save: validate `field_defaults` keys match type schema

### Phase 4: Simulator Integration

- Update snapshot building to include: instance id, template id, type key, resolved field_values, quantity
- Load profiles only if the template's type lists that profile_kind in `supported_profile_kinds`

---

## Migration Sequence

1. Create `device_types` table + seed data
2. Alter `device_templates` to add `device_type_id` + backfill
3. Create `device_instances` table
4. Migrate `energy_devices` data to `device_instances`
5. Update all frontend code to use new tables
6. Drop `energy_devices` (separate migration after code is stable)

---

## MVP Guardrails

- Seed 6 device types matching existing device_kinds
- Keep all 6 existing templates, linked to their types
- Field schema validation: presence + type checks only (no range validation yet)
- No customer-facing "create device type" UI
- Existing `device_template_profiles` table stays as-is, just filtered by `supported_profile_kinds`
