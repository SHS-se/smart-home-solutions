
# Remove Device Templates; Unify to Single Devices Catalog

## Summary

This plan eliminates the `device_templates` and `device_template_profiles` tables, making `device_instances` the single "Devices" table. Physics fields and COP/capacity profiles are stored directly on devices. The UI is rebuilt as a single "Devices" tab with a 3-column layout (list, form, chart/profile panel) plus search, scope, and type filters.

---

## 1. Database Migration (single migration)

### Step A: Add `device_type_id` to `device_instances`

- Add column `device_type_id uuid` (nullable initially for migration)
- Add FK to `device_types(id)`

### Step B: Migrate template data into `device_instances`

For each `device_templates` row (where `is_deleted = false`), insert a new global device:
```sql
INSERT INTO device_instances (device_type_id, name, field_values, controllable, shiftable, priority, customer_id)
SELECT device_type_id, display_name, coalesce(field_defaults,'{}'), controllable_default, shiftable_default, 0, NULL
FROM device_templates WHERE is_deleted = false;
```

For existing customer `device_instances`, copy `device_type_id` from their linked template and merge field_defaults:
```sql
UPDATE device_instances di
SET device_type_id = dt.device_type_id,
    field_values = coalesce(dt.field_defaults,'{}') || coalesce(di.field_values,'{}')
FROM device_templates dt
WHERE di.device_template_id = dt.id AND di.device_type_id IS NULL;
```

### Step C: Create `device_profiles` table

```sql
CREATE TABLE device_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES device_instances(id) ON DELETE CASCADE,
  profile_kind text NOT NULL DEFAULT 'cop_capacity_curve',
  data jsonb NOT NULL DEFAULT '{}',
  source text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(device_id)
);
```

Enable RLS with policies matching `device_instances` (staff full access, customers read own + global).

### Step D: Migrate existing `device_template_profiles`

Map old template profile rows to the newly-created global device that came from the same template:
```sql
INSERT INTO device_profiles (device_id, profile_kind, data, source, notes)
SELECT di.id, 'cop_capacity_curve', dtp.data, dtp.source, dtp.notes
FROM device_template_profiles dtp
JOIN device_templates dt ON dtp.device_template_id = dt.id
JOIN device_instances di ON di.name = dt.display_name 
  AND di.customer_id IS NULL AND di.device_type_id = dt.device_type_id
WHERE dtp.is_active = true
ON CONFLICT (device_id) DO NOTHING;
```

### Step E: Finalize schema

- Make `device_type_id` NOT NULL on `device_instances`
- Drop `device_template_id` column from `device_instances`
- Drop `device_template_profiles` table
- Drop `device_templates` table

### Step F: Add `updated_at` trigger on `device_profiles`

---

## 2. New Edge Function: `validate-device-profile`

**File**: `supabase/functions/validate-device-profile/index.ts`

Accepts POST with `{ profile_kind, data }` and validates:

1. JSON Schema validation (points array with temp_c, cop, capacity_w constraints)
2. Business rules:
   - `temp_c` values strictly increasing
   - At least 4 points
3. Returns `{ valid: true }` or `{ valid: false, error: "..." }`

This is called from the UI before saving to `device_profiles`. Additionally, the profile save goes through the standard Supabase client insert/update.

---

## 3. UI Changes

### 3a. Replace `DeviceCatalog.tsx` tabs

- Remove the "Templates" tab and "Devices" (GlobalDeviceManagerTab) tab
- Replace with single "Devices" tab using new `DeviceCatalogTab` component
- Keep "Device Types" and "Calibration" tabs for staff

### 3b. New component: `DeviceCatalogTab.tsx`

**Layout**: 3-column grid (list | form | profile panel), same pattern as existing `DeviceTemplatesTab`

**Left column** -- Device List:
- "New Global Device" button (staff only)
- Search input (searches name, field_values.make, field_values.model)
- Scope segmented control: All / Global / Customer
- Type filter chips from `device_types`
- Scrollable list of devices, each showing name + subtitle + scope icon

**Center column** -- Edit Device Form:
- Device Type selector (required, dropdown from `device_types`)
- Display Name input
- Dynamic fields from `device_types.field_schema`, grouped into sections:
  - "Identification" (make, model)
  - "Electrical Limits" (max_power_w, min_power_w)
  - "Performance" (scop, nominal_capacity_w, min_temp_c) -- optional fields
- Controllable / Shiftable switches
- Priority input
- Save / Delete buttons

**Right column** -- COP + Capacity Curve Panel:
- Card titled "COP + Capacity curve"
- Empty state: "No curve uploaded" + "Upload curve" button
- With data: dual-axis chart (COP left axis, Capacity kW right axis, temp_c X axis)
- Metadata row: source, last updated
- Action buttons: "Replace curve", "Clear curve" (with confirm)

### 3c. New component: `CurveUploadModal.tsx`

- Dialog with:
  - JSON file upload input
  - Source dropdown (manufacturer / measured / estimated)
  - Notes textarea
- After file selection:
  - Parse and validate locally against JSON schema + business rules
  - Show preview table of points
  - Show mini preview chart
- On save: call validate edge function, then upsert into `device_profiles`

### 3d. Update `PerformanceCurveChart.tsx`

- Add support for dual-axis rendering (COP + Capacity on same chart)
- New prop for secondary data series

### 3e. Remove old components

- Delete `DeviceTemplatesTab.tsx` (replaced by DeviceCatalogTab)
- Delete `GlobalDeviceManagerTab.tsx` (merged into DeviceCatalogTab)
- Delete `DeviceInstanceDialog.tsx` (no longer needed; editing is inline)

### 3f. Update `HomeDevicesTab.tsx`

- Remove all `device_templates` references from queries
- Query `device_instances` directly with `device_types(key, display_name)` join
- Update interfaces to use `device_type_id` instead of `device_template_id`

### 3g. Update `SimulatorTab.tsx`

- Remove `device_templates` from query chain
- Join directly: `device_instances(... device_types(key, simulation_model_key))`
- Read `type_key` and `simulation_model_key` from `device_types` directly

---

## 4. Files Summary

| File | Action |
|------|--------|
| Migration SQL | **Create**: single migration with steps A-F |
| `supabase/functions/validate-device-profile/index.ts` | **Create**: JSON schema validation |
| `src/components/portal/energy/DeviceCatalogTab.tsx` | **Create**: unified devices screen |
| `src/components/portal/energy/CurveUploadModal.tsx` | **Create**: upload modal with validation + preview |
| `src/components/portal/energy/PerformanceCurveChart.tsx` | **Modify**: add dual-axis support |
| `src/pages/portal/DeviceCatalog.tsx` | **Modify**: replace tabs |
| `src/components/portal/energy/HomeDevicesTab.tsx` | **Modify**: remove template references |
| `src/components/portal/energy/SimulatorTab.tsx` | **Modify**: remove template references |
| `src/components/portal/energy/DeviceTemplatesTab.tsx` | **Delete** |
| `src/components/portal/energy/GlobalDeviceManagerTab.tsx` | **Delete** |
| `src/components/portal/energy/DeviceInstanceDialog.tsx` | **Delete** |

---

## 5. RLS Policies for `device_profiles`

- Staff: full access (ALL)
- Customers: SELECT where device_id references a device with matching customer_id or customer_id IS NULL (global)
- Customers: INSERT/UPDATE/DELETE only for devices they own

---

## 6. Edge Cases

- Existing `home_device_assignments` reference `device_instances.id` which is unchanged, so assignments are preserved
- The `validate_assignment_customer_match` trigger continues to work since it reads `device_instances.customer_id`
- The `device_types` table and `DeviceTypesManager` are completely unaffected
- Calibration tab is unaffected
