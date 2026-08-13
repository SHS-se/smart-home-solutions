# Energy optimisation — working notes

Status: **working document, not committed.** Written 2026-08-09 while wiring EMHASS up
against Phil's house. Captures what exists, what was learned the hard way, and where this
is going. Everything here was verified against the live Home Assistant instance rather
than inferred from documentation.

---

## 1. Why this exists

The customer-facing value story is **money saved**, not kWh moved. The portal already
ships a savings card (`src/lib/energy-savings.ts` in `smart-home-solutions-t-by`) that
prices self-consumption at the *variable* cost of an imported kWh and adds export income.

The next step is optimisation: deciding *when* to charge, discharge, import, export and
run large loads, then being able to show what that decision was worth. That requires a
forecast-driven optimiser. EMHASS is the reference implementation and is what we are
using now; §8 covers replacing it.

---

## 2. The physical system

| Thing | Value | Source |
|---|---|---|
| Inverter/battery | Sigenergy, hybrid | `sigen` integration (HACS), Modbus TCP |
| Battery capacity | 18.08 kWh rated | `sensor.sigen_plant_rated_energy_capacity` |
| Max charge power | 8.8 kW | `sensor.sigen_plant_ess_rated_charging_power` |
| Max discharge power | 9.6 kW | `sensor.sigen_plant_ess_rated_discharging_power` |
| Plant max active power | 13.2 kW | `sensor.sigen_plant_max_active_power` |
| PV | 3 strings (PV1/PV2 active, PV3 idle) | `sensor.sigen_inverter_pv{1,2,3}_power` |
| Grid operator | Ellevio, low-voltage tariff | `sensor.smart_home_solutions_grid_operator` |
| Supplier | Tibber | SHS home profile |
| Bidding zone | SE3 | SHS home profile |

Key live sensors (all **kW**, note the unit — see §6.1):

```
sensor.sigen_plant_pv_power              PV production
sensor.sigen_plant_total_load_power      whole-house load
sensor.sigen_plant_grid_import_power     grid in
sensor.sigen_plant_grid_export_power     grid out
sensor.sigen_plant_battery_power         battery (+ = charging)
sensor.sigen_plant_battery_state_of_charge   %
```

### 2.1 Control surface

The `sigen` integration **ships read-only** and drops writes silently:

```python
# custom_components/sigen/modbus.py:1213
if self.read_only:
    _LOGGER.error("Cannot write parameter while in read-only mode")
    return
```

No exception is raised, so Home Assistant accepts the click, nothing reaches the
inverter, and the entity snaps back on the next 5-second poll. It looks exactly like a
read-only UI control. `DEFAULT_READ_ONLY = True` in `const.py`.

Turning control on requires, in order:

1. Settings → Devices & Services → **Sigen Plant** → Configure → pick the plant device →
   untick read-only. (Stored at `entry.data.plant_connection.read_only`; changing it
   reloads the entry.) **This is a Home Assistant setting, not a Sigen app setting.**
2. `switch.sigen_plant_remote_ems_controlled_by_home_assistant` → on. Until this is on,
   `select.sigen_plant_remote_ems_control_mode` reports `unavailable`, because its
   `available_fn` requires `plant_remote_ems_enable == 1`.
3. Manually enable four control entities that are `disabled_by: "integration"`:
   `number.sigen_plant_ess_max_charging_limit`,
   `number.sigen_plant_ess_max_discharging_limit`,
   `number.sigen_plant_grid_export_limitation`,
   `number.sigen_plant_pv_max_power_limit`.

`select.sigen_plant_remote_ems_control_mode` offers **nine** options in this build (the
public Sigenergy/EMHASS guides assume four):

```
PCS Remote Control · Standby · Maximum Self Consumption
Command Charging (Grid First) · Command Charging (PV First)
Command Discharging (PV First) · Command Discharging (ESS First)
V2G · Unknown
```

Grid First vs PV First matters in a Swedish winter in a way it does not in the
Australian guides this is all derived from.

### 2.2 Known cosmetic defect

`binary_sensor.sigen_plant_importing_from_grid` flaps constantly — 562 transitions in 36
hours, always on for exactly one 5-second poll. Cause:

```python
value_fn=lambda data: safe_decimal(data.get("plant_grid_sensor_active_power")) > Decimal("0.01")
```

A 10 W threshold with no hysteresis, on a plant that regulates grid flow to zero. It
predates any of our changes. Harmless, but **never trigger an automation from it** —
build a threshold + `for:` sensor from `sensor.sigen_plant_grid_import_power` instead.

---

## 3. Price data

### 3.1 Grid tariff — our own integration

`shs_energy` publishes `sensor.smart_home_solutions_grid_import_price` and
`…_grid_export_price`, each carrying a **`forecast` attribute**: hourly slots from the
current hour to the end of tomorrow, `{start: <UTC ISO>, price_sek_per_kwh: <float>}`.
This is *exact*, not predicted — Ellevio publishes tariffs ahead, and `grid_price_forecast()`
in `tariff.py` resolves revision boundaries and high/low-load flips slot by slot.

Attributes on the import sensor also carry `capacity_cost_per_kw`, `demand_charge` and
`billing_period_peak_kw` for peak shaving.

**Open defect:** all three of those resolve to `None` on the current Ellevio revision,
and `sensor.smart_home_solutions_peak_demand_fee` reads 0. The effektavgift data an
optimiser needs is not coming through. Needs investigation in `tariff.py`.

**Seasonal note:** in August every forecast slot is identical (0.71 import / 0.033 export,
`load_period: low`). The grid series is a constant offset right now; all optimisation
signal comes from spot. It will vary in high season.

`OPT_FORECAST_RESOLUTION_MINUTES` supports quarter-hours but is **not exposed in the
options flow**, so it is effectively pinned at 60.

### 3.2 Spot and supplier prices

Smart Home Solutions owns the price source. `integration-prices` fetches native
15-minute Swedish spot intervals from `elprisetjustnu.se`, selects the home's
effective-dated supplier terms, and returns distinct supplier import and export
prices. The home profile supplies only the electricity supplier and bidding area.
No Tibber or Nord Pool Home Assistant integration is required.

### 3.3 The all-in price

```
import = grid_import_price.forecast[slot] + supplier_import[slot]
export = grid_export_price.forecast[slot] + supplier_export[slot]
```

The integration combines the server-owned supplier direction with the matching
grid-tariff direction. Before tomorrow's market prices are published, the exact
series ends instead of repeating today's price.

---

## 4. Forecast inputs

| Forecast | Source | Shape |
|---|---|---|
| PV production | `sensor.meteo_solar_production_forecast_estimate_today` / `_tomorrow` | `watts` attribute, 96-entry local-ISO→W dict (15 min) |
| Spot price | `tibber.get_prices` | service response, 15 min |
| Grid tariff | `shs_energy` sensor attribute | hourly, exact |
| Load | EMHASS internal (`typical`) | — |

`open_meteo_solar_forecast` and `forecast_solar` are both installed. EMHASS does **not
need either** — its default `weather_forecast_method: open-meteo` calls Open-Meteo itself
and runs PVLib over the result. We supply `pv_power_forecast` explicitly anyway because
the HA integration is already calibrated to the actual array.

There is a stale duplicate `forecast_solar` config entry in `not_loaded` state, worth
removing.

---

## 5. The load inventory

### 5.1 Scale

Lifetime energy, against 117,174 kWh lifetime grid import:

| Category | kWh | Share | Control |
|---|---|---|---|
| Air conditioning (3) | 11,443 | 9.8% | 2× Daikin wifi, 1× Zigbee IR + Shelly meter |
| Electric wall/floor heaters | 10,261 | 8.8% | Zigbee relays |
| Pool heater | 7,703 | 6.6% | Relay, 3-phase |
| Hot water boiler | 5,802 | 5.0% | Relay, 3-phase |
| **Total schedulable** | **35,208** | **~30%** | |

Plus the Easee car charger and pool pump, not counted above. Comparison is indicative —
the device meters and the grid meter do not cover identical periods.

### 5.2 Metering

The house is almost fully sub-metered: **45 devices** on the Energy dashboard after this
session (34 before). Added: server cabinet lights (520 kWh), pool room floor heater (399),
spare outlet (121), KEF speakers (28), Phil's office heater (24), plus six Shelly mini PM
power points reading ~0.

**Critical structure:** room heaters, the water boiler, pool heater, stove and extractor
fan each have per-phase or per-unit child sensors **whose aggregate is already the
dashboard entry**. Adding the children double-counts. Verified:
`sensor.hot_water_energy` = 5801.501 == `water_boiler_p1+p2+p3` = 5801.5, and
`sensor.electrical_heaters_energy` = 10260.71 == the sum of its nine parts.

Unidentified: `sensor.shellypro2pm_ec6260923c54_switch_1_energy`, 0.0 kWh — a Shelly Pro
2PM second channel nobody has named.

`sensor.unmetered_energy_consumption` (v1) reads **negative** (−18.4), which implies
double counting somewhere in that helper. v2 reads 63,482 kWh.

### 5.3 Deferrable loads — conventional

Relay-gated, fixed-power, genuinely shiftable:

| Load | Power | Switch | Meter |
|---|---|---|---|
| Water boiler | ~3 kW | `switch.water_boiler` (+p1/p2/p3) | `sensor.water_boiler_power` |
| Pool heater | ~3.3 kW | `switch.pool_heater` (+p1/p2/p3) | `sensor.pool_heater_power` |
| Pool pump | ~0.4 kW | `switch.esphome_pool_pump_switch` | `sensor.esphome_pool_pump_power` |
| Car charger | up to 11 kW | Easee | `sensor.car_charging_power` |

These are live in August, so they are the ones that can be validated now.

`binary_sensor.pool_heater_cycle` and `binary_sensor.node_red_pool_heating_complete`
already implement cycle detection from draw for the pool loop — the pattern to reuse.

### 5.4 Deferrable loads — thermal

**The zone abstraction already exists in Node-RED.** Four flows, exported to
`~/Code/ha/node-red-flows` (June 16 snapshot):

- `room heating controls.json`
- `room heating with occupancy.json`
- `room heating state logic (outdoor aware).json`
- `room heating manual overrides.json`

Reusable subflows: `Room heating state logic`, `Room heating state logic (outdoor aware)`,
`Zigbee floor thermostat`, `Heating override`, `Set override`, `Next scheduled change`,
`Timer`, `Filter messages`.

13 zones, each controlled at group level:

```
switch.kitchen_heaters            switch.master_bedroom_heaters
switch.sophia_s_bedroom_heaters   switch.phil_s_office_heaters
switch.marks_bedroom_heater       switch.guest_bedroom_heater
switch.heated_towel_rack_switch   switch.ground_floor_bathroom_wall_heater_switch_0
climate.laundry_floor_thermostat  climate.master_bathroom_floor_thermostat
climate.pool_bathroom_floor_thermostat
climate.living_room_aircon        climate.tv_room_aircon        climate.entrance_aircon
```

Each zone already has a **setpoint model**: `input_number.<zone>_high_temp`, `_low_temp`,
`_sleeping_temp`, `_temporary_adjustment`, plus a global `input_number.heater_off`. Plus
room temperature sensors, `sensor.weather_station_temperature` for outdoor compensation,
occupancy-aware variants and a manual override subflow.

**This maps onto a thermal optimiser's `desired_temperatures` almost directly.** No
redesign needed — it is a rename.

Per-zone lifetime energy (biggest first): guest bedroom 3,361 · master bathroom floor
2,387 · Mark's bedroom 1,582 · Sophia's 1,177 · kitchen 715 · towel rack 546 · pool room
floor 399 · master bedroom 70 · Phil's office 24.

Aircon lifetime: living room 4,773 · TV room 3,340 · entrance 3,330.

### 5.5 The infra-red aircon

Controlled by MQTT to a Zigbee IR blaster:

```
topic:   zigbee2mqtt/Entrance aircon controller/set
payload: {"ir_code_to_send": "<base64 blob>"}
```

with `input_boolean.entrance_aircon` as the state mirror.

This is **not** open-loop. Two Node-RED groups close the loop using measured power, and
power — not the boolean — is the source of truth. Same pattern covers the TV and the KEF
speakers.

**"Infra-red switches"** (command side). Triggered by the `input_boolean` changing.
Before transmitting, it reads the device's power sensor and only fires if the device is
actually in the opposite state:

| Device | On-guard | Off-guard | Topic |
|---|---|---|---|
| TV | `sensor.tv_outlet_power` < 100 W | > 100 W | `zigbee2mqtt/TV controller/set` |
| KEF speakers | `sensor.kef_speakers_power` < 5 W | > 5 W | `zigbee2mqtt/TV controller/set` |
| Entrance aircon | `sensor.entrance_aircon_power` < 100 W | > 5 W | `zigbee2mqtt/Entrance aircon controller/set` |

This guard is essential, not decorative: the TV and KEF codes are **toggles** — the same
IR blob for on and off — so firing blind would invert the state whenever the mirror had
drifted.

**"Infra-red switch status checks"** (feedback side). Watches the power sensors and
reconciles the `input_boolean` to match reality:

| Device | Threshold | Debounce |
|---|---|---|
| TV | > 100 W | 5 s |
| KEF speakers | > 9 W | 5 s |
| Entrance aircon | > 50 W | 60 s |

The 60 s aircon debounce reflects compressor start/stop time.

Two defects worth fixing:

1. **Three different thresholds for the aircon** — 100 W (command on-guard), 5 W (command
   off-guard), 50 W (status check). The 5 W off-guard is low enough that standby draw
   reads as "on".
2. **The power lookups cannot fail safe.** Every function node does
   `global.get("homeassistant.homeAssistant.states['sensor.x'].state" || 0)` — the `|| 0`
   is inside the string argument, so it is a no-op and the default never applies. If the
   power sensor is unavailable, the value is `undefined`, both `< threshold` and
   `> threshold` are false, and **the IR command is silently dropped**. Should be
   `global.get(path) || 0`.

For the optimiser this is good news: an IR-controlled load is commandable *and*
verifiable, so it can be treated like any other deferrable load, with the caveat that
confirmation takes up to 60 s.

The IR unit draws roughly **twice** the power of the Daikins for equivalent duty.

### 5.6 Why fixed-power deferrable loads are wrong for HVAC

All three aircons show the same profile: high initial draw, decaying toward a lower
steady state. EMHASS's deferrable load is a fixed wattage for N hours; its thermal model
adds heating/cooling rates but still assumes constant electrical draw. Neither expresses
a decaying curve, and neither expresses an inverter modulating to hold a setpoint.

For now: use per-zone **steady-state** power from history and let duration carry the
energy, deliberately understating the first 15 minutes rather than pretending to model
them. Doing it properly is a reason to own the engine (§8).

Note also that the bedrooms are resistive (COP 1) while living room, TV room and entrance
are heat-pumped (COP ~3). Mostly different rooms, so not a straight either/or, but where
they overlap, source selection is worth more than time-shifting either.

---

## 6. What is wired up today

### 6.1 Template sensors

EMHASS assumes **watts**; the Sigen sensors are **kW**. Feed them raw and every result is
1000× wrong.

| Entity | Definition |
|---|---|
| `sensor.emhass_pv_power` | `sigen_plant_pv_power × 1000` |
| `sensor.emhass_load_power` | `sigen_plant_total_load_power × 1000` |
| `sensor.emhass_load_power_no_var_loads` | total load − boiler − pool heater − pool pump − car charger |

The third is what EMHASS's load forecast should be trained on, because deferrable loads
are scheduled separately and must not be double-counted. It reads ~417 W against a 4,102 W
whole-house draw when the pool is heating — i.e. **90% of current load is schedulable.**

### 6.2 Calling EMHASS

`shell_command` in `configuration.yaml` (three commands: dayahead-optim, naive-mpc-optim,
publish-data), driven by `script.emhass_dayahead_optim`, surfaced on the `emhass-energy`
dashboard.

**Three hard-won gotchas:**

1. `rest_command` is not in the `ha_config_set_yaml` key allowlist; `shell_command` is.
2. **`shell_command` stringifies dict service data with Python `repr`** — single quotes,
   `True`/`False` — which EMHASS rejects with
   `Check your payload for syntax errors (e.g., use 'false' instead of 'False')`.
   Pass the payload as a **JSON string**.
3. …but Home Assistant `literal_eval`s a dict-shaped string straight back into a dict,
   reintroducing the bug. **Keeping at least one JSON boolean in the payload defeats
   this** (`true` is not a Python literal). The `set_use_pv` / `set_use_battery` /
   `inverter_is_hybrid` flags are load-bearing for this reason, not just semantics.

`shell_command` requires a **full HA restart**; `homeassistant.reload_all` does not load it.

### 6.3 Working payload

```json
{
  "optimization_time_step": 60,
  "delta_forecast_daily": 1,
  "prediction_horizon": 34,
  "costfun": "profit",
  "set_use_pv": true, "set_use_battery": true, "inverter_is_hybrid": true,
  "number_of_deferrable_loads": 0,
  "nominal_power_of_deferrable_loads": [],
  "operating_hours_of_each_deferrable_load": [],
  "battery_nominal_energy_capacity": 18080,
  "battery_charge_power_max": 8800,
  "battery_discharge_power_max": 9600,
  "battery_minimum_state_of_charge": 0.15,
  "battery_maximum_state_of_charge": 0.95,
  "battery_target_state_of_charge": 0.5,
  "maximum_power_from_grid": 13200,
  "maximum_power_to_grid": 13200,
  "pv_power_forecast":   [...],
  "load_cost_forecast":  [...],
  "prod_price_forecast": [...]
}
```

Passing `pv_power_forecast` / `load_cost_forecast` / `prod_price_forecast` makes EMHASS
switch each method to `list` automatically. Load forecast is left on `typical`.

**`number_of_deferrable_loads: 0` matters.** EMHASS's stored config invents two deferrable
loads (11 kW + 4.2 kW) that do not exist; leaving them in makes the cost function
meaningless — it reported −13.10 with them and +4.86 without.

### 6.3.1 The deferrable-load count is NOT a runtime parameter

Established empirically on 2026-08-09. Passing
`number_of_deferrable_loads: 4` with four-element lists produced **two** deferrable
columns, using the **first two** entries of the supplied lists:

```
sent:      number_of_deferrable_loads: 4
           nominal_power_of_deferrable_loads: [3000, 3300, 400, 11000]
published: sensor.p_deferrable0 = 3000    sensor.p_deferrable1 = 3300
           sensor.p_deferrable2 = unknown sensor.p_deferrable3 = unknown
```

So the *lists* are honoured at runtime but the *count* is pinned to whatever
`config.json` says (2). Corroborating evidence: sending empty lists produced
`ERROR in command_line: P_deferrable0 was not found in results DataFrame` — publish still
expected two columns even though the optimiser had produced none, i.e. the count never
moved.

**Fix:** set the count in EMHASS's own config — web UI cog icon, or
`/addon_configs/5b918bf2_emhass/config.json`. Not from the payload.

There is also an unhandled exception in `command_line.py:3336 _publish_deferrable_loads`
when the expected columns are missing, which is what surfaces as a 500 on publish-data.

### 6.3.1a Result with four deferrable loads

After raising the count to 4 in `config.json` (2026-08-09, 15:42):

```
optim_status  Optimal        total_cost_fun_value  -28.42
d0 boiler 3000 · d1 pool heater 3300 · d2 pool pump 400 · d3 car 11000
pv 6884 · load 970 · batt -1414 (charging) · grid +13200 (importing at the cap)
```

Energy balance checks exactly: in 6884 + 13200 = 20084; out 970 + 17700 + 1414 = 20084.
The model is internally consistent.

**And the schedule is nonsense.** Every deferrable load is switched on simultaneously in
the first hour, importing at the full 13.2 kW service limit, because:

- all four have fabricated must-run hours that have to be satisfied somewhere,
- the first hours are the cheapest in the horizon (0.826 rising to 1.05 SEK/kWh),
- nothing tells the optimiser the pool has already completed today's cycle or that the
  car is not plugged in.

This is the clearest available evidence for §10: a MILP given fixed-duration blocks will
happily schedule 17.7 kW of demand into one hour against a 13.2 kW service. The failure
is not in EMHASS's solver — it is in asking a fixed-duration model to represent
closed-loop, comfort-constrained loads.

### 6.3.1b EMHASS publishes the full 24-hour series — under inconsistent attribute names

Every published sensor carries the whole horizon, but the attribute holding it is named
differently per sensor. This is why the series look missing at first.

| Sensor | Attribute | Value key |
|---|---|---|
| `sensor.p_pv_forecast` | `forecasts` | `p_pv_forecast` |
| `sensor.p_load_forecast` | `forecasts` | `p_load_forecast` |
| `sensor.p_grid_forecast` | `forecasts` | `p_grid_forecast` |
| `sensor.p_batt_forecast` | `battery_scheduled_power` | `p_batt_forecast` |
| `sensor.soc_batt_forecast` | `battery_scheduled_soc` | `soc_batt_forecast` |
| `sensor.unit_load_cost` | `unit_load_cost_forecasts` | `unit_load_cost` |
| `sensor.unit_prod_price` | `unit_prod_price_forecasts` | `unit_prod_price` |
| `sensor.p_deferrable0..3` | `deferrables_schedule` | `p_deferrableN` |

All are 24 entries of `{date: <local ISO>, <key>: "<string>"}` — note the values are
**strings**, so `parseFloat` them.

ApexCharts data generator:

```js
return (entity.attributes.<attribute> || [])
  .map(e => [new Date(e.date).getTime(), parseFloat(e.<key>)]);
```

`unit_load_cost_forecasts` is the all-in import price series (grid tariff + spot) and is
the one worth charting — the grid-tariff-only forecast is flat in low season and carries
no signal.

### 6.3.1c Why everything piles into one hour — and the experiment that proves it

Observed: all four deferrables scheduled simultaneously at full power in the current hour,
17.7 kW against a 13.2 kW service. Three causes, none of them a solver bug:

1. **The current hour is the cheapest in the horizon** (0.826 SEK/kWh, rising to 1.015 by
   10:00 next day). Any load that *must* run is cheapest run now.
2. **Nothing penalises concurrency.** The objective is pure cost. No smoothness term, no
   diversity requirement, no peak charge. Cost is minimised by piling demand into the
   cheapest hours; it stops only when it hits `maximum_power_from_grid`.
3. **Peak power is free in the model.** `capacity_cost_per_kw` is None and we send no
   demand charge, so a 13.2 kW spike costs the optimiser nothing.

Note this is *partly correct behaviour*: import 0.826 vs export 0.149 is a **5.5× spread**,
so every kWh self-consumed instead of exported is worth ~0.68 kr. Concentrating loads into
solar hours is right. The error is that it continued well past the available 6.9 kW of PV
and into 13.2 kW of full-price import.

**Experiment (2026-08-09 16:12):** lower `maximum_power_from_grid` from 13200 to 5000,
change nothing else.

```
before (13.2 kW cap):  everything in hour 0, cost fun −28.42
after  (5 kW cap):     boiler hours 0-2 · pool heater 0,1,11,21-23
                       pool pump scattered · car modulated across 14 slots
                       grid pinned at 5000 only in hours 0,1,10,11
                       cost fun −20.01
```

So spreading costs **8.41 kr over the horizon**. Concentration really was cheaper — in a
world where peak power is free. That number is the price of the missing constraint.

**The principled fix is the effektavgift, not an arbitrary cap.** Currently
`sensor.smart_home_solutions_peak_demand_fee` reports `active: false` with empty
`details` and `how_this_is_calculated` on revision `ellevio-2026-06-01`. Either Ellevio
genuinely has no demand charge on this tariff/season, or our tariff definition omits it.
**This needs checking against the real Ellevio tariff** — it materially changes every
optimisation, and it is the natural force that spreads load without inventing limits.

`maximum_power_from_grid` is currently left at **5000** in the payload as a stand-in.

### 6.3.1d Runtime parameters silently override the config page

Changing `costfun` from `profit` to `self-consumption` in the EMHASS UI had **no effect**,
because the payload was sending `'costfun': 'profit'` on every call. Runtime parameters win.

The payload sets ~20 parameters, so the config page is effectively decorative for all of
them — except `number_of_deferrable_loads`, which is the one parameter the payload cannot
set and the one not exposed as a UI field (§6.3.1a). Worth remembering when a UI change
"does nothing".

`costfun` is now deliberately **omitted** from the payload so the UI governs it.

**Comparison at 2026-08-09 16:22, all else equal:**

| | `profit` | `self-consumption` |
|---|---|---|
| `total_cost_fun_value` | −20.01 | **0.00** |
| Battery SOC at horizon end | 50% | **15%** (floor) |
| Boiler | hours 0-2 | hours 21-23 |

Two things matter here:

1. **`self-consumption` produces no money figure.** The cost-function value goes to 0.00
   because the objective is a PV fraction, not currency. The number used to compare
   scenarios disappears — fatal given the goal is measuring money saved (§1).
2. **It drains the battery to the 15% floor.** Self-consumption places no value on stored
   energy, so it empties the battery rather than holding charge for expensive hours.

For this project `profit` is the correct objective: it prices import and export
separately, so it captures the 5.5× spread that makes self-consumption valuable *and* the
price arbitrage that self-consumption ignores. `self-consumption` has nothing to optimise
on a dark winter day, which is exactly when the Swedish load is largest.

### 6.3.1e `self-consumption` does not mean "minimise grid import"

Under `costfun: self-consumption`, hour 0 of 2026-08-09 16:00 came out as:

```
in :  PV 4882 + grid 5000            = 9882 W
out:  base 368 + pool 3300 + car 6214 = 9882 W    (battery 0)
```

It imports 5 kW — at the self-imposed cap — while claiming to optimise self-consumption.
Not a bug. EMHASS's `self-consumption` objective maximises the **share of PV consumed on
site**, i.e. it penalises *exporting* PV. There is **no cost term on import at all**, so
buying 5 kW from the grid is free as far as that objective is concerned.

Only `profit` (and partly `cost`) price grid import. This is a second, independent reason
`profit` is the right objective for this project (see §6.3.1d).

### 6.3.1f Deferrable loads are independent — no coupling, exclusion or sequencing

The pool heater and pool pump were modelled as two separate deferrable loads. The
optimiser promptly scheduled **the heater without the pump**, which is physically
impossible — you cannot heat a pool without circulating water.

EMHASS's deferrable loads are independent by construction. It cannot express:

- **Coupling** — "B must run whenever A runs" (pump + heater)
- **Exclusion** — "never both at once" (phase or fuse limits)
- **Sequencing** — "B only after A has finished"

Workaround applied 2026-08-09: model pool heating as **one** deferrable load at 3700 W
(3300 heater + 400 pump). Slots are now:

| Slot | Load | Power | Hours |
|---|---|---|---|
| 0 | Water boiler | 3000 W | 3 |
| 1 | Pool heating (heater + pump) | 3700 W | 6 |
| 2 | Car charger | 11000 W | 2 |
| 3 | spare (unused) | 1 W | 0 |

Merging works where loads are one physical process. It does **not** solve exclusion or
sequencing, and it cannot represent the pump running *without* the heater (filtration
cycles). Another entry for the rebuild list (§8).

### 6.3.2 `operating_hours_of_each_deferrable_load` is a REQUIREMENT, not a cap

This is the parameter most likely to produce nonsense. It is an equality constraint on
total energy — `nominal_power × operating_hours` **must** be scheduled inside the horizon.
It does not mean "may run up to N hours".

Consequences for this house:

- The pool heater will be scheduled for its full quota **even after it has already
  finished today's cycle**.
- The car charger will be scheduled **even when the car is away**.

**Implemented 2026-08-09.** EMHASS supports dynamic hours only in the sense that
`operating_hours_of_each_deferrable_load` is a runtime parameter, so the requirement can
be recomputed per run. It has **no state-dependent termination** — it cannot express "run
until the tank reaches 60 °C" or "stop at 80% SOC". Within a horizon the requirement is
fixed; between runs it can move. That is closed-loop at the run interval, open-loop
inside it.

Requirements are now computed in the script from today's daily utility meters (which reset
at local midnight) and live device state:

```jinja
boiler_h = ceil(max(0, target_kwh - hot_water_utility_meter) / 3.0)
pool_h   = 0 if node_red_pool_heating_complete else
           ceil(max(0, target_kwh - (pool_heater_um + pool_pump_um)) / 3.7)
car_h    = 0 if not tesla_charge_cable else
           max(0, (target_soc - battery_level)/100 * capacity_kwh) / 11.0
```

Targets are `input_number` helpers so they are tunable rather than hard-coded:
`emhass_boiler_daily_target` (9 kWh), `emhass_pool_daily_target` (22 kWh),
`emhass_car_target_soc` (80%), `emhass_car_battery_capacity` (75 kWh).

Note semi-continuous loads (boiler, pool) are on-at-nominal or off, so their hours are
rounded **up** to whole hours. The car modulates, so a fractional requirement is fine.

**Before / after, same instant (2026-08-09 16:45):**

| | invented hours | dynamic hours |
|---|---|---|
| Boiler | 3 h | 3 h (9 kWh target − 2.23 kWh done) |
| Pool | 6 h | **0 h** — cycle already complete today |
| Car | 2 h @ 11 kW | 1.57 h = 17.25 kWh from a real 57%→80% SOC gap |
| Grid plan | 5000 W import at the cap for 3 hours | **never imports** — all zero or exporting |
| Battery SOC | drained to 15% | holds 50-58% |

Removing the phantom pool demand alone was enough for PV plus battery to cover the whole
horizon. The car schedule now sums to 17.27 kWh against a 17.25 kWh requirement.

This does not make EMHASS understand thermostats — it stops it scheduling work that is
already done or unnecessary, which was the largest single source of nonsense.

EMHASS also offers `start_timesteps_of_each_deferrable_load` and
`end_timesteps_of_each_deferrable_load` for allowed windows — useful for "pool pump only
in daylight" or "no boiler between 23:00 and 06:00". Not yet used.

EMHASS also offers `start_timesteps_of_each_deferrable_load` and
`end_timesteps_of_each_deferrable_load` for allowed windows — useful for "pool pump only
in daylight" or "no boiler between 23:00 and 06:00".

Verified result (2026-08-09 14:15):

```
optim_status      Optimal
p_pv_forecast     7344 W      p_load_forecast    538 W
p_batt_forecast  -4897 W      p_grid_forecast   -1909 W
soc_batt_forecast  75.7 %
unit_load_cost    0.826 SEK/kWh   unit_prod_price  0.149 SEK/kWh
```

7344 − 538 = 6806 = 4897 + 1909. Internally consistent, and the unit prices are our
merged Ellevio+Tibber figures round-tripping intact.

### 6.4 Constraint on machine learning

`recorder: purge_keep_days: 30` caps EMHASS's `mlforecaster` training window at 30 days,
not the 365 it wants. InfluxDB is running and the EMHASS add-on exposes
`influxdb_username`/`influxdb_password` — likely the route to a longer history.

---

## 7. EMHASS assessment

Good: the architecture is right — forecasts in, MILP out, publish to HA. Solver is fast
(0.6 s for 34 hourly slots). Runtime parameters make it scriptable. MIT licensed.

Bad, for this house specifically:

- No inverter/heat-pump power curve. Fixed-wattage loads only.
- Thermal model assumes constant electrical draw.
- No COP model, so it cannot choose between resistive and heat-pump heating.
- No concept of a monthly demand charge (effektavgift) as an optimisation objective.
- Deferrable loads are homogeneous — no notion of "this one is thermostatic and
  interruptible, that one is a fixed cycle that must not be interrupted".
- Setup is genuinely awkward: config split between an add-on options screen, a
  `config.json`, and runtime parameters, with silent fallbacks when any of them disagree.
- Requires installing and maintaining a separate add-on per customer.

---

## 8. Direction: bring the engine into `shs_energy`

**Is it possible? Yes — but not by running the solver inside Home Assistant.**

### 8.1 The dependency problem

EMHASS needs numpy, pandas, cvxpy (or PuLP), HiGHS/CBC, scikit-learn and pvlib. A custom
integration declares `requirements` in `manifest.json` and Home Assistant pip-installs
them into HA Core's venv. HA Core is **Alpine/musl**; most scientific wheels are
manylinux/glibc. cvxpy and the solver binaries would need compiling on the customer's
box, on arm64 and amd64. That is not a supportable install story for a product — it is
the single biggest obstacle, and it is why EMHASS ships as an add-on with its own image.

### 8.2 Recommended architecture: optimise server-side

Do not run the MILP on the customer's HA at all.

```
shs_energy (HA)                     SHS backend
─────────────────────────────────   ────────────────────────────────
collect: PV forecast, load history,
  prices, device model, SOC      ──▶  POST /optimise
                                        build MILP
                                        solve
schedule sensors + attributes    ◀──   return schedule
automations act on the schedule
```

This fits what already exists. `shs_energy` already pairs with the backend, pulls the
tariff catalogue from `integration-tariff`, and pushes daily readings to
`ha-energy-ingest`. An `/optimise` endpoint is the same shape as `integration-tariff`.

Advantages:

- No dependency hell; solver runs where we control the image.
- One place to improve the model. Every customer gets it at once, no HACS update.
- Works on HA OS, Container, Core, Supervised alike.
- The model becomes a product differentiator rather than a config file the customer owns.
- Server-side we can do the things EMHASS cannot: per-device power curves fitted from
  that customer's own history, COP models, demand-charge objectives.

Costs and risks:

- Needs connectivity. Must degrade gracefully — cache the last schedule, and fall back
  to a simple rule (e.g. self-consumption) when offline.
- Latency and compute cost per customer per day. Small: one solve per customer per hour
  at most; the SE3 day-ahead problem solves in well under a second.
- Privacy: load profiles leave the house. Already true for the daily readings push, but
  the resolution would be higher. Worth being explicit about in the subscription terms.
- Supabase edge functions are Deno — no good for a MILP. This needs a Python service
  (Cloud Run / Fly / a container), which is new infrastructure for SHS.

### 8.3 Alternative: pure-Python solver in the integration

If the schedule must be computed locally, a small purpose-built solver is more realistic
than porting EMHASS. The day-ahead battery + deferrable problem over 24–48 hourly slots
is small; a greedy/dynamic-programming approach over price-sorted slots gets most of the
value without a MILP. Loses global optimality; gains zero dependencies.

Worth prototyping as the **offline fallback** for §8.2 regardless.

### 8.4 What to reuse from EMHASS

MIT licensed, so the formulation can be lifted with attribution. Specifically worth
reading: the cost-function construction, the battery SOC constraints, and the deferrable
load constraints. The data-plumbing half is not worth reusing — we have better inputs.

---

## 9a. "MPC" is a misleading name — it is planning from a measured initial condition

`dayahead-optim` and `naive-mpc-optim` are **the same MILP**. The difference is the
battery's boundary condition:

| | `dayahead-optim` | `naive-mpc-optim` |
|---|---|---|
| Battery start | assumed (`battery_target_state_of_charge`) | **measured** (`soc_init`) |
| Battery end | assumed | `soc_final` |
| Horizon | `delta_forecast_daily` | caller's `prediction_horizon` |

Nothing about `naive-mpc-optim` requires running it frequently. Run it once a day and it
is simply a *better-initialised day-ahead plan*. Run it every 30 minutes and it becomes
model-predictive control. **The cadence is a separate choice from the endpoint.**

This matters because `dayahead-optim` cannot be told the real SOC at all — `soc_init` is
not accepted there. Demonstrated 2026-08-09 17:06 with the battery at **96.7%**:

```
dayahead-optim (assumed):  SOC 50 → 50 → 52 → 58 → ... → 50
naive-mpc-optim (measured): SOC 95 → 95 → 92 → 90 → ... → 50
```

The plans diverge completely. With a nearly full battery the measured plan exports hard
through the solar peak (−5.2, −6.2, −5.8 kW) instead of charging into a battery that has
no room. **Every battery figure in the earlier day-ahead runs was built on a starting
point ~45 points from reality.**

Practical conclusion: use `naive-mpc-optim` for anything involving the battery, at
whatever cadence suits. `script.emhass_mpc_optim` does this; the dashboard has both
buttons so the two can be compared.

## 10. The integration pattern: a price signal, not a command

The instinct to have EMHASS *command* the loads is wrong for this house, and §6.3.1a is
the proof. The existing Node-RED control logic already encodes constraints the optimiser
cannot see:

| Existing control logic | EMHASS deferrable load |
|---|---|
| Multiple heating windows per day | One window, or none |
| Target temperature, switches off on reach | Fixed duration, must complete |
| Setpoint varies by occupancy, schedule, outdoor temp | No concept |
| Car: SOC-aware, forceable, skipped when at limit | Fixed kWh, must run |
| Pool: cycle-complete flag from measured draw | No concept |

The control logic is closed-loop against a physical target. The optimiser is open-loop
against a clock. Handing control to the weaker model to gain price awareness is a bad
trade.

**Invert it.** The optimiser should publish *when energy is cheap*, and the existing logic
decides whether to act, keeping every comfort and safety constraint it already enforces.

The useful output is not `p_deferrable0 = 3000 W at 15:00`. It is a per-slot ranking:

```
cheap_hours_rank[slot]      1..N, cheapest first
marginal_value[slot]        SEK/kWh all-in, import and export
solar_surplus[slot]         forecast PV minus forecast base load
battery_plan[slot]          what the battery intends to do
```

Then: heating keeps its windows and setpoints and simply prefers cheap hours inside them;
the car charger keeps its SOC logic and picks its cheapest window; the pool keeps its
cycle-complete flag and starts when the price is low enough.

Benefits:

- No load surrenders a safety constraint to a model that does not know it exists.
- Failure mode is degraded savings, not a cold house or an uncharged car.
- The signal is engine-agnostic — it survives replacing EMHASS (§8).
- Incremental: one load can adopt it without the others changing.

The battery is the exception and should stay a genuine optimisation. It is block-shaped,
has no comfort constraint, and EMHASS models it well — `p_batt_forecast` and
`soc_batt_forecast` are already sensible.

**Consequence for phase 2:** do not force thermostatic heating into EMHASS's deferrable
model. Use EMHASS for the battery and genuinely block-shaped loads, and derive the
cheap-hours signal for everything else.

## 11. Conclusions (Phil, 2026-08-09)

1. The architecture is basically correct and is what we need to implement. **3 days ahead**
   is the target horizon, even though prices are only available 24 h out.
2. The plan is fundamentally about **how best to consume available solar**. Solar forecasts
   run several days ahead, and cloud conditions change what should be prioritised.
3. **More device models are needed than EMHASS's single fixed-power type:**
   1. 100% fixed-power loads (electric heaters)
   2. 100% variable-power loads (EVs, house battery)
   3. Inverter loads (aircons, heat pumps)
   4. Duty-cycle loads (stove tops, ovens, water boiler — mainly about controlling when
      the device is *off*)
4. Devices or rooms may be switched on conditions other than power/energy — **SOC,
   temperature**, occupancy.
5. **No need for selectable objectives** (profit / self-consumption / cost). Every customer
   is in the same Swedish market. One fixed hierarchy: **self-consumption first, balanced
   load second** (effektavgift is expected to return next year), **cost/profit third**.
6. Still need a way to respond to **instantaneous conditions not in the plan** — largely
   what Node-RED already does, but today it is tuned for summer solar only.

## 12. Additional lessons worth carrying into the rebuild

Things learned during this session that are not in §11 and that shaped it.

**a. Seed every stateful device from measurement, not assumption.** The single largest
error today was planning the battery from an assumed 50% while it sat at 96.7% (§9a). That
is not battery-specific. The device taxonomy in §11.3 classifies devices by *power shape*;
there is a second, orthogonal axis — **what state the device carries**. A boiler with a
tank temperature, a car with an SOC, a pool with a completed cycle, a room with a
temperature. Any device carrying state must have its plan seeded from a live reading, or
the plan is fiction from the first timestep.

**b. Requirements are derived, never configured.** "How many hours must this run" is not a
setting — it is *what remains to be done today*, computed from meters and state at plan
time (§6.3.2). Every hard-coded requirement we used produced a nonsense schedule, and
every derived one produced a sane schedule. In the rebuilt engine this should be a
first-class computed quantity with its own inputs and its own tests.

**c. Model constraints *between* devices.** §11.3 lists device types; real installations
also need relationships:
- **Coupling** — pool pump must run whenever the pool heater runs (§6.3.1f)
- **Exclusion** — never both at once
- **Sequencing** — B only after A completes

**Phase balance is explicitly out of scope.** The house is three-phase, but distributing
load across phases is an electrician's problem at installation time, not something the
automation models.

**d. Effektavgift: not modelled.** Its future form is unknown — it may return as before or
in some other shape. It is not modelled now. It survives only as the "balanced load" term
in the §11.5 hierarchy, as a general preference against unnecessary spikes.

One structural note for whenever it does return: a *monthly* peak charge couples every hour
of the month, so it cannot be optimised inside a 24–72 h window alone. It would need
month-to-date peak carried in as an input, with the rest of the month treated as remaining
headroom. `billing_period_peak_kw` already exists in the integration for this (currently
`None`, §3.1). Nothing to build until the charge is real and its shape is known.

**e. Surplus allocation across a solar cliff — the case that matters most.**

The scenario, from Phil: today is sunny (>60 kWh), tomorrow is cloudy and rainy all day
(<10 kWh). The plan charges the house battery, heats the pool, and still has surplus.

*Case 1 — the car is away.* Exported energy is worth close to nothing (0.149 vs 0.826
SEK/kWh — see §6.3.1c), so exporting the surplus is nearly the worst available option. The
better decision is to **push the pool past its setpoint**, storing the energy as heat,
because tomorrow there will not be enough sun to heat it.

*Case 2 — the car is home below 20% SOC.* Now the pool should be **stopped early, before
reaching its setpoint**, and the remaining solar sent to the car instead.

What both cases share, and what a fixed-duration deferrable model cannot express:

- **Setpoints are soft in both directions.** Overshoot when there is nowhere better for the
  energy; undershoot when something else needs it more. Each sink needs a comfort target,
  a hard limit, and a willingness to deviate.
- **Thermal mass is storage.** The pool is a large thermal battery. Heating past setpoint
  on a sunny day before a dark one is a rational store, not waste.
- **Priority between sinks is conditional**, not fixed. A car at 20% before a cloudy day
  outranks pool comfort; the same car at 80%, or absent, does not.
- **Export is the sink of last resort**, not a neutral outcome.

**Phil's scoping decision: this belongs in the reactive controls, not the planner.** That
is right, because the deciding facts are live — is the car actually home, is there actually
surplus right now, did the forecast hold. A planner working on day-ahead data cannot know
them.

Which suggests what the planner should actually emit. Not a power schedule, but a
**surplus allocation policy**: an ordered list of sinks, each with a target, a limit, and
the conditions that promote or demote it, derived from the multi-day solar forecast. The
reactive layer then spends whatever surplus actually materialises against that ranking.

That bridges §11.1 and §11.6 cleanly, and it is a different output shape from anything
EMHASS produces — closer in spirit to the price signal of §10 than to `p_deferrableN`.
Worth treating as a primary design target for the rebuilt engine rather than an
afterthought.

**f. Record plan-versus-actual from day one.** Everything today was judged by eye. A
product needs the schedule stored alongside what actually happened, so savings can be
shown to the customer, so regressions are visible, and so device models can be fitted from
their own error. This is also the honest input to the savings card (§1) — and it must be
captured **before** any control is handed over, or there is no baseline to compare against.

**g. Most of what went wrong was interface, not algorithm.** The solver was never the
problem. The problems were: parameters silently overridden (§6.3.1d), the same series
published under six different attribute names (§6.3.1b), a parameter settable in one place
but not another (§6.3.1a), dict-versus-string marshalling corrupting payloads (§6.2), and
silent fallbacks when inputs disagreed. For the rebuild: **one typed contract, loud
validation, and no silent defaults.** If an input is missing, say so; do not substitute a
plausible number.

## 13. Next steps

**Phase 1 — done 2026-08-09, modelling only.** Boiler, pool heater, pool pump and car
charger sent as deferrable loads; `sensor_power_load_no_var_loads` pointed at the new
sensor. Result `Optimal`, cost function −25.48 (vs +4.86 with no deferrables). Boiler and
pool heater scheduled.

Outstanding before the schedule means anything:

1. Raise the deferrable count to 4 in EMHASS's config file (§6.3.1) — only 2 of 4 are
   being optimised.
2. Make operating hours dynamic (§6.3.2) — the current 3/6/8/2 are invented, and as
   *requirements* they will schedule loads that have already run or are not present.

**Phase 2 (before heating season):** thermal zones from the Node-RED setpoint model.
Requires deriving per-zone steady-state power from history.

**Phase 3:** control. Requires the four `number.sigen_plant_*` entities enabled and a
decision about what happens when the optimiser and the Node-RED comfort logic disagree.
That conflict needs designing, not discovering.

**Parallel workstreams:**

- Fix `capacity_cost_per_kw` / `demand_charge` / `billing_period_peak_kw` returning `None`
  (§3.1) — needed for peak shaving either way.
- Add a combined `forecast` attribute to the Total import/export price sensors in
  `shs_energy` (§3.3).
- Expose `OPT_FORECAST_RESOLUTION_MINUTES` in the options flow.
- Re-export the Node-RED flows including the infra-red groups (§5.5).
- Identify `sensor.shellypro2pm_ec6260923c54_switch_1_energy` (§5.2).
- Decide on InfluxDB vs `purge_keep_days` for ML history (§6.4).
- Baseline capture: take a clean "before" period **before** handing control to any
  optimiser, or the savings card has nothing to compare against.
