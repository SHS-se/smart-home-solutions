

# Device-Level Calibration Workflow + Build Error Fixes

## Overview

Two concerns addressed in one implementation:

1. Fix existing build errors in `HouseModelTab.tsx` and `DeviceTypesManager.tsx` (type mismatches).
2. Build a complete calibration workflow for `electric_resistive_thermostat` in `DeviceModelsTab.tsx`.

---

## Part A: Build Error Fixes

### 1. `HouseModelTab.tsx` -- Generic type parameter mismatch

The `setEnum` helper's `setter` parameter is typed as `(v: string) => void` but receives `Dispatch<SetStateAction<WallTypeKey>>` etc. Fix: change the generic constraint so the setter accepts the narrower type.

**Line 730**: Change the `setEnum` signature to accept `setter: (v: string) => void` and cast inside, OR cast each setter call at the call site. Simplest fix: cast setters to `(v: string) => void` at each call site (lines 739-753).

### 2. `DeviceTypesManager.tsx` -- `.filter()` widens type

Line 50-56: The `.filter()` call on the array literal widens `{ key: DeviceModelKey; label: string }[]` to `{ key: string; label: string }[]`. Fix: add `as const` or type the filter result, or use a type assertion after filter.

### 3. Deno/resend error

This is a pre-existing edge function issue unrelated to our changes. No action needed.

---

## Part B: Calibration Workflow

### Design

The calibration system for `electric_resistive_thermostat` extracts two key signals from imported measured data:

1. **Effective rated power (W)** -- derived from the measured peak/plateau power during ON cycles
2. **Effective duty cycle** -- ratio of ON time to total time, which validates the thermostat deadband and setpoint behavior

These are compared against the simulator's modeled output for the same device. The user can then "apply" calibration adjustments that are stored as lightweight metadata in `device_instances.field_values` (under a `calibration_overrides` key), not as raw series data.

### What gets stored (per device instance)

```typescript
// Added to field_values JSONB
{
  ...existingFieldValues,
  calibration_overrides: {
    calibrated_at: string;          // ISO timestamp
    source_file: string;            // original filename
    device_class: string;           // from imported sample
    measured_peak_w: number;        // extracted from sample
    measured_avg_w: number;         // extracted from sample
    measured_duty_cycle: number;    // fraction 0-1
    measured_energy_kwh: number;    // from sample summary
    applied_rated_power_w: number;  // the value applied to simulation
    notes: string;                  // auto-generated summary
  }
}
```

This is ~200 bytes per device. No raw series stored.

### Files Changed

#### 1. `src/components/portal/energy/DeviceModelsTab.tsx`

**A. Extract measured series data on import (enhance `handleCalibrationImport`)**

Currently the import only reads summary metadata. Extend it to also extract calibration signals from the series data while the JSON is in memory:

- Parse `series[].power_w` values
- Compute: measuredPeakW (95th percentile to avoid spikes), measuredAvgW, duty cycle (fraction of intervals where power > 10% of peak)
- Store these in a new state `calibrationSignals` (in-memory only, not persisted)
- Discard the raw series after extraction

**B. Add "Calibration Analysis" card in the right panel (below Model Binding card)**

Shown only when `importedCalibration` is loaded and device class matches. Contains:

- **Measured vs Modeled comparison table**: Side-by-side display of measured peak power vs modeled rated power, measured duty cycle vs modeled duty cycle (computed from current preview timeseries)
- **Overlay chart**: A second `LoadCurveChart` showing both measured and modeled 24h curves overlaid. For the measured data, resample the imported series to 96 points (15-min averages). For modeled, use existing preview timeseries. This overlay uses the existing `LoadCurveChart` component with an additional `measuredOverlay` prop.
- **"Apply Calibration" button**: Updates `device_instances.field_values.calibration_overrides` in the database and optionally adjusts `rated_power_w` to match the measured peak. Shows a confirmation dialog with before/after values.
- **"Reset Calibration" button**: Removes `calibration_overrides` from field_values and restores original `rated_power_w` if it was changed.

**C. For non-electric-resistive-heater device classes**: Show a "Calibration not yet supported for this device type" message but keep the import summary visible.

**D. State additions:**

```typescript
interface CalibrationSignals {
  measuredPeakW: number;
  measuredAvgW: number;
  measuredDutyCycle: number;
  measuredEnergyKwh: number;
  measuredSeries96: Array<{ time: string; power: number }>; // resampled to 96 points, temporary
}
```

#### 2. `src/components/portal/energy/LoadCurveChart.tsx`

Add an optional `measuredOverlay` prop:

```typescript
interface LoadCurveChartProps {
  // ...existing props
  measuredOverlay?: Array<{ time: string; power: number }>;
}
```

When provided, render an additional dashed `Line` on the chart showing measured power. This reuses the existing chart without creating a new component.

#### 3. `src/lib/simulator/device-bindings.ts`

In the `electric_resistive_thermostat` binding (around line 316), check for `calibration_overrides.applied_rated_power_w` and use it instead of the standard `rated_power_w` if present. This makes calibration automatically affect future simulations.

```typescript
// After reading ratedPowerW:
const calOverrides = asRecord(fv.calibration_overrides);
if (calOverrides?.applied_rated_power_w) {
  ratedPowerW = readNumber(calOverrides, ['applied_rated_power_w'], { min: 1 }) ?? ratedPowerW;
}
```

### Calibration Flow (User Experience)

1. Select a device (e.g., "Bathroom Heater 1200W")
2. Click "Import Calibration JSON" -- load a `measured_device_sample_v1` file
3. Summary card appears (existing) + new Calibration Analysis card appears
4. Analysis card shows: measured peak = 1180W vs modeled rated = 1200W, duty cycle = 0.42 vs modeled = 0.38
5. Overlay chart shows measured power (dashed) vs modeled power (solid stacked areas)
6. User clicks "Apply Calibration" -- confirmation shows "Adjust rated_power_w from 1200W to 1180W?"
7. On confirm: saves calibration_overrides to field_values, refreshes preview
8. "Reset Calibration" button appears, allowing removal of overrides

### What is NOT stored

- Raw series JSON (discarded after signal extraction)
- No new database tables
- No new columns

---

## File Summary

| File | Action | Purpose |
|---|---|---|
| `src/components/portal/energy/HouseModelTab.tsx` | Fix | Type cast setters in `setEnum` calls |
| `src/components/portal/energy/DeviceTypesManager.tsx` | Fix | Type assertion on filtered model options |
| `src/components/portal/energy/DeviceModelsTab.tsx` | Edit | Add calibration analysis, apply/reset workflow |
| `src/components/portal/energy/LoadCurveChart.tsx` | Edit | Add optional `measuredOverlay` prop |
| `src/lib/simulator/device-bindings.ts` | Edit | Read `calibration_overrides` for electric heater |

