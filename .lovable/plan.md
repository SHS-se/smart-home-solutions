

# Add Global Device Manager to Device Catalog

## Summary

Add a "Device Manager" tab to the Device Catalog page that shows a global list of device instances (not tied to any customer). Staff can create, edit, and delete global devices. Customers can browse global devices and add them to their homes alongside their own custom devices. Staff can also "promote" a customer-created device to a global device.

---

## 1. Database Changes

### 1.1 Make `device_instances.customer_id` nullable

Currently `customer_id` is `NOT NULL`. Global devices will have `customer_id = NULL`.

```sql
ALTER TABLE public.device_instances ALTER COLUMN customer_id DROP NOT NULL;
```

### 1.2 Update the cross-customer trigger

The `validate_assignment_customer_match` trigger currently checks `v_dc IS DISTINCT FROM v_hc`, which would block global devices (`v_dc = NULL`). Update it to allow global devices (NULL customer_id) to be assigned to any home:

```sql
-- Only block if device has a customer_id AND it doesn't match the home's customer_id
IF v_dc IS NOT NULL AND v_dc IS DISTINCT FROM v_hc THEN
  RAISE EXCEPTION '...';
END IF;
```

### 1.3 Update RLS policies on `device_instances`

- Customers can SELECT global devices (`customer_id IS NULL`) in addition to their own
- Staff retains full CRUD (no change needed)
- Customer INSERT/UPDATE/DELETE policies remain scoped to their own devices only

### 1.4 Update RLS on `home_device_assignments`

No changes needed -- the existing policies check home ownership, which is correct regardless of whether the device is global or customer-owned.

---

## 2. Device Catalog Page -- Add "Device Manager" Tab

### 2.1 New tab in `DeviceCatalog.tsx`

Add a **"Device Manager"** tab (staff-only) between Templates and Device Types:

```
Tabs: Templates | Device Manager (staff) | Device Types (staff) | Calibration (staff)
```

### 2.2 New component: `GlobalDeviceManagerTab.tsx`

A staff-only component that shows all device instances in a master-detail layout similar to the screenshot:

**Left panel (device list):**
- Search bar
- Toggle: "My Devices" (customer-owned) / "All Devices" (global + customer-owned) / "Global" (customer_id IS NULL)
- Device type filter badges (All Types, Air-Air HP, Appliance, etc.)
- Table: Make, Model, Type badge, Power
- Clicking a row selects it for detail view

**Right panel (device detail):**
- When a device is selected, show its full details (name, field_values, template info)
- Staff actions: Edit, Delete
- For customer-owned devices: "Promote to Global" button (sets `customer_id = NULL`)
- "+ Add Device" button that opens `DeviceInstanceDialog` with `customerId = null` for global devices

---

## 3. Update HomeDevicesTab (Energy Modeling)

### 3.1 Show global devices alongside customer devices

In the "My Devices" left panel, fetch both:
- `device_instances` where `customer_id = customerId` (customer's own)
- `device_instances` where `customer_id IS NULL` (global catalog)

Combine and display with a badge distinguishing "Global" vs "My Device".

### 3.2 "Add Device" creates a customer-owned instance

The existing "New Device" button continues to create customer-owned instances (with `customer_id = customerId`). Global devices are created only from the Device Catalog.

---

## 4. Update DeviceInstanceDialog

### 4.1 Support null customerId

When `customerId` is empty/null (staff creating global device from Device Catalog), insert with `customer_id: null`.

When `customerId` is set (customer or staff-per-customer context), insert with `customer_id: customerId` as before.

---

## 5. File Changes Summary

| File | Action |
|------|--------|
| Migration SQL | Make `customer_id` nullable, update trigger, update RLS |
| `src/components/portal/energy/GlobalDeviceManagerTab.tsx` | **Create**: staff-only global device list with search, type filters, detail panel |
| `src/pages/portal/DeviceCatalog.tsx` | **Modify**: add Device Manager tab |
| `src/components/portal/energy/HomeDevicesTab.tsx` | **Modify**: fetch global devices alongside customer devices |
| `src/components/portal/energy/DeviceInstanceDialog.tsx` | **Modify**: support null customerId for global devices |

---

## 6. Technical Details

- The "Promote to Global" action simply runs `UPDATE device_instances SET customer_id = NULL WHERE id = ?`. Existing home assignments remain valid because the trigger allows NULL customer_id.
- Global devices can be assigned to any customer's home without violating the cross-customer check.
- The UI distinguishes global vs customer-owned with a subtle badge or icon.
- When a customer creates a device from a template, it remains customer-owned unless staff promotes it.
