

# Add Energy vs Temperature Chart + Extract simulate_day()

## Overview

Extract the core simulation logic into a reusable `simulate_day()` function. Add a temperature sweep that runs it across -20°C to +20°C and renders a second chart: daily kWh vs outdoor temperature. The existing load curve chart stays as-is.

## Changes

### 1. New file: `src/lib/simulate-day.ts`

Extract the pure computation from `SimulatorTab.handleRun()` into a standalone function:

```typescript
interface SimulateDayInputs {
  indoorTempC: number;
  outdoorTempC: number;
  UA: number;
  baseW: number;
  shiftableW: number;
  fixedActiveW: number;
  scenario: 'dumb' | 'smart';
}

interface SimulateDayResult {
  timeseries: Array<{ time: string; total: number; heating: number; shiftable: number; fixedActive: number; base: number }>;
  dailyKwh: number;
  dailyKwhByCategory: { heating: number; base: number; shiftable: number; fixedActive: number };
  peakW: number;
  avgW: number;
}

function simulateDay(inputs: SimulateDayInputs): SimulateDayResult
```

This contains the existing 96-point generation logic (lines 173-189 of current SimulatorTab) with no DB calls. Pure math.

### 2. Update `SimulatorTab.tsx`

- Import and call `simulateDay()` instead of inline generation
- After the single-day run, also run a **temperature sweep**: loop from -20 to +20 (step 1°C), call `simulateDay()` for each, collect `{ tempC, dailyKwh }` array
- Store the sweep data in results state alongside the existing timeseries
- Render both charts in the right panel: load curve on top, energy-vs-temp below
- The sweep uses the same `baseW`, `shiftableW`, `fixedActiveW`, `scenario` — only `outdoorTempC` changes per iteration
- The model_runs insert stays the same (single-day data); the sweep is display-only, not persisted

### 3. New file: `src/components/portal/energy/EnergyVsTempChart.tsx`

A simple Recharts `LineChart` (or `ScatterChart`) component:

```typescript
interface EnergyVsTempChartProps {
  title: string;
  data: Array<{ tempC: number; dailyKwh: number }>;
  currentTemp?: number; // highlight the selected outdoor temp
  height?: number;
}
```

- X axis: outdoor temp (°C), -20 to +20
- Y axis: daily kWh
- Single line connecting the points
- A vertical ReferenceLine at `currentTemp` to show where the user's slider is
- Clean, matches existing card style

### 4. Results state update

Extend the results type to include the sweep:

```typescript
sweepData: Array<{ tempC: number; dailyKwh: number }>;
```

### 5. No other changes

- LoadCurveChart unchanged
- ROITab unchanged
- No DB schema changes
- No new DB queries (sweep is pure computation from already-fetched data)

## File Summary

| File | Action |
|---|---|
| `src/lib/simulate-day.ts` | New — pure simulation function |
| `src/components/portal/energy/EnergyVsTempChart.tsx` | New — line chart component |
| `src/components/portal/energy/SimulatorTab.tsx` | Edit — use `simulateDay()`, add sweep, render second chart |

