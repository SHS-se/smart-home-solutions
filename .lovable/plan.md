# Redesign Home Devices Tab

## Overview

Replace the current two-panel layout (My Devices | Devices in Home) with a new layout:

- **Left panel**: Single unified list of devices assigned to this home (including standard-home devices), with quantity editing and remove button, plus an "Add Existing Device" button that opens a picker modal
- **Right panel**: A shared "New Device" editor form (reused from Device Catalog)
- Hideable right panel: appears same as "Performance data"  panel (reused from Device Catalog)

## Changes

### 1. Extract shared DeviceEditorForm component

**New file**: `src/components/portal/energy/DeviceEditorForm.tsx`

Extract lines 284-409 from `DeviceCatalogTab.tsx` (the editor card with type selector, name, field groups, toggles, save/delete) into a standalone component with props:

- `deviceTypes` -- list of available types
- `selected` -- currently selected device (or null for new)
- `customerId` -- owner for newly created devices (null = global)
- `isStaff` -- controls delete button and "include in standard home" toggle visibility
- `onSaved` -- callback after save
- `onDeleted` -- callback after delete

The component manages its own form state internally (same as current code). The "include in standard home" toggle only shows for global devices (customer_id is null), same logic as today.

### 2. Refactor DeviceCatalogTab to use DeviceEditorForm

Replace the inline editor card in `DeviceCatalogTab.tsx` with `<DeviceEditorForm>`, passing the appropriate props. The list panel and performance panel remain in DeviceCatalogTab.

### 3. Redesign HomeDevicesTab

**File**: `src/components/portal/energy/HomeDevicesTab.tsx`

New two-column layout:

**Left column -- "Devices in This Home"**:

- Header with title and an "Add Device" button
- Table with columns: Name, Type, Qty (editable input), Delete button
- On load, fetch `home_device_assignments` joined with `device_instances`
- Also auto-include global devices where `include_in_standard_home = true` that aren't already assigned (show them with qty=1, but as "virtual" rows that get inserted on first interaction)
- Clicking on a row item in the device list shows the device deails in the new device right panel. 
- Clicking "Add Device" opens an `AddDeviceModal`

**Right column -- "New Device"**:

- Uses `<DeviceEditorForm>` with `customerId` set to the current customer
- After saving, the device list refreshes so it can be assigned. 
- Saving should automatically add a quantity of 1 to the devices in this home
- Customers cannot modify global devices. If viewing a global device and they click save, the device is saved as a new customer device. 

Hideable right panel:

- Reuses "Performance data" from Device Catalog.
- Customer can upload profile types just like what is done in Device Catalog. Code must be reused, not duplicated!

### 4. New AddDeviceModal component

**New file**: `src/components/portal/energy/AddDeviceModal.tsx`

A dialog that:

- Fetches all device instances visible to this customer (customer-owned + global)
- Excludes devices already assigned to this home
- Sorts: customer-owned devices first, global second
- Shows a searchable list with name, type badge, and globe/user icon
- Clicking a device assigns it to the home (inserts into `home_device_assignments` with qty=1) and closes the modal

### Technical Details

**DeviceEditorForm props interface:**

```typescript
interface DeviceEditorFormProps {
  deviceTypes: DeviceType[];
  selected: DeviceRow | null;
  customerId: string | null; // null = global device
  isStaff: boolean;
  onSaved: () => void;
  onDeleted?: () => void;
  onNewRequested?: () => void;
}
```

**Standard home auto-inclusion logic:**
When fetching home devices, also query `device_instances` where `include_in_standard_home = true AND customer_id IS NULL` and merge them with existing assignments. If a standard device isn't yet in `home_device_assignments`, display it but only persist the assignment when the user modifies quantity or takes action.

**Files changed:**

- `src/components/portal/energy/DeviceEditorForm.tsx` (new -- extracted shared form)
- `src/components/portal/energy/AddDeviceModal.tsx` (new -- device picker modal)
- `src/components/portal/energy/DeviceCatalogTab.tsx` (refactor to use DeviceEditorForm)
- `src/components/portal/energy/HomeDevicesTab.tsx` (full redesign)

No database changes needed.