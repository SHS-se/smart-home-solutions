
# Device Modeling Hierarchy Refactor: Type, Template, Instance

## Status: Phase 1 & 2 Complete ✅

### Completed
- ✅ Created `device_types` table with RLS + seeded 6 types
- ✅ Added `device_type_id` FK + `field_defaults` to `device_templates`, backfilled
- ✅ Created `device_instances` table with RLS (replaces `energy_devices`)
- ✅ Migrated 8 existing `energy_devices` rows to `device_instances` with `field_values`
- ✅ Built `DeviceTypesManager.tsx` — staff-only CRUD for device types with field_schema editor
- ✅ Built `DeviceInstanceDialog.tsx` — dynamic form from type schema, pre-filled with template defaults
- ✅ Refactored `DeviceTemplatesTab.tsx` — selects device_type first, dynamic field_defaults from schema
- ✅ Updated `DeviceManagerTab.tsx` — queries `device_instances`, shows type badges
- ✅ Updated `HouseSetupTab.tsx` — uses `device_instances` + `DeviceInstanceDialog`
- ✅ Updated `SimulatorTab.tsx` — queries `device_instances`, builds snapshot with type_key + field_values
- ✅ Added "Device Types" tab to staff-only EnergyModeling view

### Remaining
- ⬜ Drop `energy_devices` table (separate migration after code is stable and published)
- ⬜ Delete dead code: `DeviceAddEditDialog.tsx` (no longer imported)
- ⬜ Phase 3: Field validation on instance/template save (presence + type checks)
- ⬜ Phase 4: Simulator integration refinements (profile filtering by supported_profile_kinds)
