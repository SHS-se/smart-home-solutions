

# Device Catalog, Customer-Owned Instances, and Home Assignments Refactor

## Overview

This refactor restructures the device architecture into three clear ownership layers: a global **Device Catalog** (templates), customer-owned **Device Instances**, and home-scoped **Device Assignments**. The Device Catalog becomes a top-level portal module, and device-to-home assignment moves to a dedicated "Home Devices" tab in Energy Modeling.

---

## 1. Database Migration

### 1.1 Alter `device_instances`: remove `home_id`, add `customer_id`

The current `device_instances` table has `home_id` as a required FK. We need to:

- Add `customer_id uuid NOT NULL` FK to `customers.id` ON DELETE CASCADE
- Backfill `customer_id` from `homes.customer_id` via the existing `home_id`
- Drop the `home_id` column (after creating the assignments table and migrating data)
- Remove `quantity` column (quantity moves to the assignment)
- Drop columns: `controllable`, `shiftable`, `priority` (these move to the assignment level or stay as instance-level defaults -- per the spec, they stay on the instance)

Actually, per the spec, `device_instances` keeps: `id`, `customer_id`, `device_template_id`, `name`, `field_values`, `created_at`, `updated_at`. The scheduling flags (`controllable`, `shiftable`, `priority`) can remain on the instance as defaults.

Migration steps:
1. Add `customer_id` column (nullable initially)
2. Backfill from `homes` join
3. Make `customer_id` NOT NULL
4. Create `home_device_assignments` table (see 1.2)
5. Migrate existing rows: for each `device_instance`, create an assignment row linking `home_id` to the instance with the existing `quantity`
6. Drop `home_id` column from `device_instances`
7. Remove `quantity` from `device_instances` (quantity lives on assignment now)

### 1.2 Create `home_device_assignments` table

```
home_device_assignments
  id            uuid PK default gen_random_uuid()
  home_id       uuid NOT NULL FK -> homes.id ON DELETE CASCADE
  device_instance_id uuid NOT NULL FK -> device_instances.id ON DELETE CASCADE
  quantity      int NOT NULL default 1
  created_at    timestamptz NOT NULL default now()
  UNIQUE(home_id, device_instance_id)
```

Validation trigger: `CHECK(quantity > 0)` -- use a trigger instead of CHECK per project conventions.

### 1.3 Cross-customer protection trigger

Create a trigger on `home_device_assignments` INSERT/UPDATE that verifies:
```sql
device_instances.customer_id = homes.customer_id
```
Raises an exception if mismatched.

### 1.4 RLS Policies

**device_instances** (updated):
- Customers: CRUD where `customer_id = get_customer_id_for_user(auth.uid())`
- Staff: full CRUD

**home_device_assignments**:
- Customers: CRUD via join `home_id -> homes.customer_id = get_customer_id_for_user(auth.uid())`
- Staff: full CRUD

### 1.5 Drop old `energy_devices` table

Since the plan.md marks this as pending, include it in this migration.

---

## 2. New Route and Page: Device Catalog

### 2.1 Route: `/portal/device-catalog`

New page `src/pages/portal/DeviceCatalog.tsx` using `PortalLayout`.

### 2.2 Tabs

- **Templates** (visible to all): Browse device templates with type filter, search by make/model. Read-only for customers.
- **Device Types** (staff-only): Reuse existing `DeviceTypesManager` component.
- **Calibration** (staff-only): Reuse existing `CalibrationTab` component.

This consolidates the staff-only tabs currently in the Energy Modeling page.

### 2.3 Staff customer-view route

Add `/portal/customers/:customerId/device-catalog` with thin wrapper, though since the catalog is global (not customer-specific), this may just link to `/portal/device-catalog`. The dashboard card will link to the global catalog route.

---

## 3. Dashboard Card

### 3.1 Update `CustomerDashboardCards.tsx`

Add a new card:
- Title: "Device Catalog" / "Enhetskatalog"
- Icon: `Cpu` or `Box` from lucide
- Path: `${basePath}/device-catalog` (for customers: `/portal/device-catalog`)
- Description: "Browse the shared device catalog and available device models."

---

## 4. Energy Modeling UI Changes

### 4.1 Remove staff-only Device Types/Templates/Calibration tabs

These move to the Device Catalog page. The staff Energy Modeling view will show the same tabs as customers when viewing a specific customer.

### 4.2 Replace "Device Manager" tab with "Home Devices"

Rename and refactor the tab:

**Customer/Staff tabs become:**
- ROI
- Home Setup
- **Home Devices** (new, replaces Device Manager)
- Simulator
- Tariff and Pricing

### 4.3 Staff global Energy Modeling page

When staff navigate to `/portal/energy-modeling` (no customer context), redirect to Device Catalog or show a prompt to select a customer. Since the catalog tabs moved, the global page can simply show a message directing staff to use per-customer views.

---

## 5. Home Devices Tab (new component)

### 5.1 `HomeDevicesTab.tsx`

Layout (two-panel):

**Left panel: "My Devices"** (`device_instances` for this customer)
- Filter by device type, search
- "New Device" button opens `DeviceInstanceDialog` (modified to use `customer_id` instead of `home_id`)
- Each row shows: name, template, type badge, key field values
- Actions: Edit, Delete, "Add to Home" button

**Right panel: "Devices in This Home"** (`home_device_assignments` for selected `home_id`)
- Table: device name, template, field values summary, quantity
- Actions: Edit quantity, Remove assignment
- If no home selected, show placeholder message

### 5.2 Assign flow

- "Add to Home" on a device instance creates a `home_device_assignments` row with quantity=1
- If already assigned (unique constraint), show toast or increment quantity
- Quantity editable inline

---

## 6. Component Changes

### 6.1 `DeviceInstanceDialog.tsx`

- Change `homeId` prop to `customerId: string`
- Insert uses `customer_id` instead of `home_id`
- Remove `quantity` field from the form (quantity is per-assignment now)
- Keep `controllable`, `shiftable`, `priority` fields

### 6.2 `HouseSetupTab.tsx`

- Remove the entire "Devices in This Home" section (lines 428-492)
- Remove device-related state and fetch logic (lines 103-106, 168-186)
- Remove `DeviceInstanceDialog` import and usage

### 6.3 `DeviceManagerTab.tsx`

- Rename/replace with `HomeDevicesTab.tsx` or refactor in-place
- Adapt to query `device_instances` by `customer_id` (left panel) and `home_device_assignments` by `home_id` (right panel)

### 6.4 `SimulatorTab.tsx`

- Change device loading: query `home_device_assignments` for the home, join to `device_instances` for field_values, join to templates/types
- `device_snapshot` now includes assignment `quantity` from the join table instead of from the instance

### 6.5 `EnergyModeling.tsx`

- Remove staff-only tabs (Device Types, Device Templates, Device Manager, Calibration) -- these move to Device Catalog
- Staff global view: show message or redirect
- Customer/staff-per-customer view: show ROI, Home Setup, Home Devices, Simulator, Tariff

### 6.6 `DeviceTemplatesTab.tsx`

- Move to Device Catalog page (already a standalone component, just re-mount it there)

---

## 7. Routing Changes (`App.tsx`)

Add:
- `/portal/device-catalog` -> `DeviceCatalog`
- (Optional) `/portal/customers/:customerId/device-catalog` -> redirect or wrapper

---

## 8. File Summary

| File | Action |
|------|--------|
| Migration SQL | Create: add customer_id to device_instances, create home_device_assignments, triggers, RLS, drop home_id, drop energy_devices |
| `src/pages/portal/DeviceCatalog.tsx` | **Create**: new page with Templates/Types/Calibration tabs |
| `src/components/portal/energy/HomeDevicesTab.tsx` | **Create**: two-panel My Devices + Home Assignments |
| `src/components/portal/energy/DeviceInstanceDialog.tsx` | **Modify**: use customer_id, remove quantity |
| `src/components/portal/energy/HouseSetupTab.tsx` | **Modify**: remove device section |
| `src/components/portal/energy/SimulatorTab.tsx` | **Modify**: load via assignments join |
| `src/pages/portal/EnergyModeling.tsx` | **Modify**: replace tabs, remove staff-only catalog tabs |
| `src/components/portal/CustomerDashboardCards.tsx` | **Modify**: add Device Catalog card |
| `src/App.tsx` | **Modify**: add device-catalog route |
| `.lovable/plan.md` | **Update**: mark completed items |
| `src/components/portal/energy/DeviceAddEditDialog.tsx` | **Delete**: dead code |

---

## Technical Notes

- The cross-customer trigger is critical: it prevents staff or application bugs from assigning Customer A's device to Customer B's home.
- The `UNIQUE(home_id, device_instance_id)` constraint means one assignment row per device per home; multiplicity is expressed via the `quantity` column.
- Existing `device_instances` data (8 rows) will be migrated: `customer_id` backfilled from `homes`, then assignment rows created preserving the original `home_id` + `quantity`.
- The `controllable`, `shiftable`, `priority` fields stay on `device_instances` as instance-level properties (not per-assignment).

