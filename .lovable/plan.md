

# v1 Real Data Simulator + ROI

## Overview

Wire existing database data into the Simulator and ROI calculations. Remove all hard-coded constants. No new tables, no UI redesign, no new charts.

## Files Changed

1. **`src/components/portal/energy/SimulatorTab.tsx`** -- complete rewrite of `handleRun()` calculation logic
2. **`src/components/portal/energy/ROITab.tsx`** -- replace hard-coded costs with `model_runs` queries
3. **`src/components/portal/energy/LoadCurveChart.tsx`** -- rename stacked area keys from `ev`/`appliance` to `shiftable`/`fixedActive`

## Detailed Changes

### 1. SimulatorTab -- Fetch Real Data Before Running

Add three additional queries at the start of `handleRun()`:

- **energy_home_settings**: Fetch `ua_w_per_k`, `overrides`, `tariff_instance_id` for this `home_id`
- **tariff_instances**: Fetch `network_price_sek_per_w_month`, `energy_price_sek_per_kwh`, `fixed_monthly_fee_sek` using the `tariff_instance_id`
- **home_answers**: Fetch `annual_kwh` via `home_questions` with `semantic_key = 'annual_kwh'` joined to `home_answers` for this `home_id`

Pre-populate slider defaults on mount: fetch `energy_home_settings.overrides.indoor_temp_c` and `overrides.comfort_band_c` in a `useEffect` and set them as initial slider values (fall back to 21 and 2).

### 2. SimulatorTab -- Compute Device Aggregates

From the existing `assignments` query (already fetches `field_values`, `shiftable`, `controllable`, `quantity`):

```
For each assignment:
  power = field_values.rated_power_w ?? 0
  totalPower = power * quantity

  if shiftable:        shiftableW += totalPower
  else if !controllable: fixedActiveW += totalPower
  // controllable heating devices are handled by UA
```

### 3. SimulatorTab -- Base Load from annual_kwh

```
if (annualKwh exists):
  avgW = annualKwh * 1000 / 8760
  baseW = avgW * 0.35
else:
  baseW = 500
  console.warn('Fallback: using 500W base load')
```

### 4. SimulatorTab -- Heating from UA

```
UA = energy_home_settings.ua_w_per_k ?? 150
if (!ua_w_per_k) console.warn('Fallback: using 150 W/K')

heatingW(hour) = max(0, UA * (indoorTemp - outdoorTemp)) * (1 + 0.3 * sin(pi * (hour - 6) / 12))
```

In typical/year mode, use a moderate outdoor temp assumption (e.g., 0 C for typical) instead of arbitrary 2000+1000*sin.

### 5. SimulatorTab -- Timeseries Generation

For each of 96 intervals:
```
time = HH:MM
heating = heatingW(hour)
shiftable:
  dumb: hours 17-22 -> shiftableW, else 0
  smart: hours 01-05 -> shiftableW, else 0
fixedActive:
  hours 07-09, 18-20 -> fixedActiveW, else 0
base = baseW (constant)
total = base + heating + shiftable + fixedActive
```

Output keys change from `{ev, appliance}` to `{shiftable, fixedActive}`.

### 6. SimulatorTab -- Cost Calculation from Tariff

```
networkPrice = tariff.network_price_sek_per_w_month ?? 0.045
energyPrice = tariff.energy_price_sek_per_kwh ?? 1.5
fixedFee = tariff.fixed_monthly_fee_sek ?? 0

if (using fallbacks) console.warn(...)

annualKwhCalc = sum(total) * 365 / 4 / 1000
annualNetworkCost = peakW * networkPrice * 12
annualEnergyCost = annualKwhCalc * energyPrice
annualFixedCost = fixedFee * 12
annualCostSek = annualNetworkCost + annualEnergyCost + annualFixedCost
```

### 7. SimulatorTab -- Extended results_summary

Store per-category kWh in `results_summary`:
```
heatingKwh, baseKwh, shiftableKwh, fixedActiveKwh, totalKwh,
annualNetworkCost, annualEnergyCost, annualFixedCost
```

Also store tariff values in `tariff_snapshot` (currently always `{}`).

### 8. SimulatorTab -- Results Card

Add rows for annualNetworkCost, annualEnergyCost, annualFixedCost in the results display (same style as existing rows). Remove the old `savingsSek` row (savings now computed in ROI).

### 9. LoadCurveChart -- Rename Keys

Change stacked areas from `ev`/`appliance` to `shiftable`/`fixedActive`. Update labels/colors accordingly. Keep `base`, `heating`, `total`.

### 10. ROITab -- Fetch model_runs

Replace lines 94-107 (all hard-coded values) with:

```typescript
// On mount or when homeId changes:
const { data: runs } = await supabase
  .from('model_runs')
  .select('scenario, results_summary')
  .eq('home_id', homeId)
  .order('created_at', { ascending: false });

const dumbRun = runs?.find(r => r.scenario === 'dumb');
const smartRun = runs?.find(r => r.scenario === 'smart');

// If both exist:
annualCostDumb = dumbRun.results_summary.annualCostSek
annualCostSmart = smartRun.results_summary.annualCostSek
// Cost breakdown:
costBreakdown = [
  { name: 'Network Fee', dumb: dumbRun.results_summary.annualNetworkCost, smart: smartRun...},
  { name: 'Energy', dumb: dumbRun...annualEnergyCost, smart: smartRun...},
  { name: 'Fixed Fee', dumb: dumbRun...annualFixedCost, smart: smartRun...},
]
```

### 11. ROITab -- Missing Runs Banner

If either dumb or smart run is missing for this home, show a banner:
"Run both Dumb and Smart simulations to calculate ROI." with a disabled/greyed-out ROI section (same pattern as existing missing-fields banner).

### 12. Removed Hard-Coded Constants

| Constant | File | Replaced With |
|---|---|---|
| `base = 500` | SimulatorTab | `annualKwh * 1000 / 8760 * 0.35` |
| `deltaT * 150` | SimulatorTab | `UA * deltaT` from energy_home_settings |
| `11000` (EV) | SimulatorTab | Sum of shiftable device powers |
| `2000` (appliance) | SimulatorTab | Sum of non-shiftable device powers |
| `0.045` (network) | SimulatorTab | tariff_instances.network_price_sek_per_w_month |
| `1.5` (energy) | SimulatorTab | tariff_instances.energy_price_sek_per_kwh |
| `peakW * 0.85` | SimulatorTab | Removed (effektavgift = peakW directly) |
| `0.3` (30% savings) | SimulatorTab | Removed (savings computed by ROI from two runs) |
| `45000` | ROITab | model_runs dumb scenario annualCostSek |
| `32000` | ROITab | model_runs smart scenario annualCostSek |
| `18000/11000` | ROITab | model_runs annualNetworkCost |
| `22000/18000` | ROITab | model_runs annualEnergyCost |
| `5000` | ROITab | model_runs annualFixedCost |

### 13. No Changes To

- Database schema
- TariffPricingTab (no changes needed -- it already saves correctly)
- HouseSetupTab
- HomeDevicesTab
- Chart UI structure (only key renames)
- model_runs table structure (JSONB columns accept any shape)

