

# Home Setup UX Improvements

## Overview

Five changes: make Home Profile collapsible and editable (syncing back to questionnaire), simplify the "Add" dialog to pick from existing templates, move device creation to Device Manager, reorder tabs so ROI is first for customers, and add Device Manager tab to staff view.

---

## 1. Make Home Profile Collapsible

In `HouseSetupTab.tsx`, wrap the Home Profile card in a `Collapsible` component (same pattern as the existing Overrides section). Default state: collapsed.

## 2. Make Home Profile Fields Editable + Sync to Questionnaire

Each field row currently shows a read-only value. Change each to an inline-editable field:
- For text/number fields: show the value as text, but allow clicking or focusing to edit via an Input.
- For boolean fields (has_ev, has_solar, has_battery): show a Switch.
- For array fields (heating_types): keep read-only for now (complex multi-select).

On value change:
- Update local `profileValues` state immediately.
- Upsert `home_answers` row: find the `question_id` from the loaded questions list (already fetched), then upsert `{ customer_id, question_id, answer_value }`.
- This ensures the Home Profile questionnaire stays in sync -- no duplicate data.

The component already fetches `home_questions` with `semantic_key` and `home_answers`. We'll store the question map (semantic_key -> question_id) in state so we can write back.

Keep the "Source: Home Profile" badge and the "Computed" badge for UA/Thermal Class (those remain read-only).

## 3. Simplify "Add Device" Dialog in Home Setup

The current `DeviceAddEditDialog` is a full form with template selector, name, quantity, priority, power override, controllable, shiftable toggles. 

Change the **Add** flow (when `device` prop is null) to be a simple picker:
- Show a searchable list of `device_templates` (make, model, power).
- Clicking a template immediately inserts an `energy_devices` row with defaults (name = display_name, quantity = 1, priority = 5) and closes the dialog.
- The **Edit** flow (when `device` prop is set) keeps the full form for adjusting name, quantity, priority, overrides.

This means the "+ Add" button on Home Setup just lists existing devices from the catalog to pick from.

## 4. Add "Create New Device" to Device Manager Tab (Staff)

Currently Device Manager for customers is read-only. For **staff**, the Device Templates tab already has full CRUD. But the user wants a create button on the Device Manager tab itself.

Add a "+ New Device" button to the Device Manager tab that opens the DeviceTemplatesTab creation form in a dialog, or simply navigates/switches to the Device Templates tab. Since staff already sees Device Templates as their primary tab, the simplest approach:
- On the staff Energy Modeling page, rename "Device Templates" to "Device Manager" to consolidate naming.

## 5. Reorder Tabs

**Customer tabs** (in `EnergyModeling.tsx` and `CustomerViewEnergyModeling.tsx`):
- Change `defaultValue` from `"home-setup"` to `"roi"`
- Reorder TabsTrigger: ROI, Home Setup, Device Manager, Simulator, Tariff & Pricing

**Staff tabs** (in `EnergyModeling.tsx`):
- Add Device Manager tab back (using `DeviceManagerTab` or merging with `DeviceTemplatesTab`)
- Change `defaultValue` to `"device-manager"` (or `"device-templates"`)
- Tabs: Device Manager (templates CRUD), Calibration

---

## Technical Details

### Files Modified

1. **`src/components/portal/energy/HouseSetupTab.tsx`**
   - Wrap Home Profile card in Collapsible (default collapsed)
   - Store question_id map from fetched questions
   - Make each profile field inline-editable with upsert to `home_answers`
   - Keep UA and Thermal Class as read-only computed values

2. **`src/components/portal/energy/DeviceAddEditDialog.tsx`**
   - When `device` is null (add mode): render a simple searchable template picker list instead of the full form
   - On click, insert `energy_devices` with defaults and call `onSaved()`
   - When `device` is set (edit mode): keep existing full form

3. **`src/pages/portal/EnergyModeling.tsx`**
   - Customer: reorder tabs with ROI first, `defaultValue="roi"`
   - Staff: add Device Manager tab (using DeviceTemplatesTab), set `defaultValue="device-templates"`, rename tab label to "Device Manager"

4. **`src/pages/portal/customer-view/CustomerViewEnergyModeling.tsx`**
   - Same tab reordering: ROI first, `defaultValue="roi"`

