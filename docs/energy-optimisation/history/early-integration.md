# Historical record: Early Integration

Historical note: base-load confidence bounds described below were removed on
17 September 2026. The [constraint requirements](../constraint-requirements.md)
supersede those proposals; do not reintroduce them without an explicit user requirement.

[Architecture index](../../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [History index](README.md)

> **Historical evidence, not current requirements.** This is a preserved part of the pre-split document, including superseded claims, old implementation statuses, and unresolved experiments. The current topic specifications linked from the architecture index take precedence. References to deployed behaviour describe the date of the original entry, not a fresh verification.

<!-- BEGIN PRESERVED SOURCE -->
# Energy optimisation architecture

Status: **schema-v6 / marginal-value-planner-v11 state dispatch and versioned quarter-by-quarter decision evidence implemented; private API contract hardening and live commissioning are next; device executors remain**

Date: **2026-08-21**

Latest decisions: **[§1.5](forecast-and-comfort.md#legacy-section-1.5)** (Home Assistant room identity and shared preheating),
**[§5.7](contracts-and-controls.md#legacy-section-5.7)** (normative private API contract and acknowledgement) and **[§8.12.3](objective-foundations.md#legacy-section-8.12.3)**
(the plan view as a versioned, quarter-by-quarter audit surface).

Source material: `ENERGY_OPTIMISATION_NOTES.md`, the current portal implementation in
this repository, the current `shs_energy` Home Assistant integration in
`../shs-ha-integration`, and the exported Node-RED flows in
`~/Code/ha/node-red-flows`.

<a id="legacy-section-1"></a>

## 1. Decision summary

Build energy optimisation as three layers with deliberately different
responsibilities:

1. **SHS portal and backend — model and plan.** The portal owns the product
   home/device model and policy; Home Assistant owns local entity bindings. The
   portal owns customer preferences, tariffs, scenario simulation,
   calibration, plan history, actuals, and savings reporting. A separate
   server-side deterministic planner owns the first rolling optimisation
   calculation. The React browser application does not run the production
   optimiser. A Python/MILP service remains the planned replacement when the
   device/thermal constraint set outgrows the verified heuristic.
2. **`shs_energy` integration — observe and coordinate locally.** The integration
   normalises Home Assistant entities into one typed contract, sends measured
   state and forecasts to the backend, validates and caches returned plans,
   exposes the current recommendations as Home Assistant entities, runs one
   local surplus/load arbiter, and reports plan-versus-actual data.
3. **Home Assistant controllers — enforce and actuate.** Existing Node-RED flows,
   and later native HA blueprints/controllers, retain manual overrides,
   thermostats, completion detection, equipment interlocks, minimum run times,
   and command confirmation. Optimisation requests permission or a target; it
   does not bypass these controllers.

The server produces a rolling **72-hour look-ahead**, but only the portion backed
by published prices is binding. Later slots are advisory and exist primarily so
the model can value stored electricity and heat across a solar/weather change.
The canonical timestep is **15 minutes**. The server replans from measured state;
the local reactive layer corrects for what actually happens between plans.

The first shadow release simulates the battery, protects an explicit reserve,
optimises discrete pool work, inhibits empirical boiler duty cycles around high
loads, assigns a valid charger current to every planned EV quarter, and plans
room preheating against exact temperature objectives while publishing
opportunity/surplus signals. Device controllers retain their existing
closed-loop logic. EMHASS remains a useful reference and shadow comparator,
not the product runtime.

<a id="legacy-section-1.1"></a>

### 1.1 Implementation checkpoint (2026-08-10)

The initial production-shaped path now resolves the eight defects found in the
static portal prototype:

| Defect | Implemented correction |
|---|---|
| Customer telemetry was compiled into the public JavaScript bundle | Deleted the hard-coded input snapshot. The selected `home_id` now reads a row protected by RLS. Pairing codes and active device tokens are bound to one home. |
| The page was a manually copied snapshot | `shs_energy` now uploads completed 15-minute actuals and requests a fresh rolling plan hourly. The portal shows issue/expiry/source freshness and measured overlays. |
| A/B/C used unequal work and fabricated a final partial day | Services have explicit earliest times and deadlines. Only deadlines inside the horizon create work; all scenarios use the same rounded integer slot count, and end-of-solar metrics omit an unfinished final local day. |
| Pool, boiler and EV used fractional/chattering power and an invented 11 kW EV rate | Pool remains a contiguous whole-slot service. The boiler is now a probability-weighted empirical duty forecast with a separate bounded permit/inhibit control. An EV current controller supplies its reviewed minimum, maximum and step, while the integration applies the installation-wide three-phase 230 V contract; the planner chooses a supported current per 15-minute slot. Phil's 5–16 A range therefore models 3.45–11.04 kW rather than freezing the plan at the entity's instantaneous state. |
| The 80% battery claim was not verified | End-of-solar and terminal SOC are simulation invariants. The 80% target is soft by default so it cannot silently reserve solar and force pool/hot-water work onto night import; explicitly making it hard retains fail-closed infeasibility checks. |
| Export was valued with the import supplier price | SHS fetches spot prices and applies the selected supplier's effective-dated terms. Import and export are separate server-calculated series; Home Assistant price entities are not inputs. |
| One August day was repeated as baseload | Baseload is a weekday/weekend per-local-quarter median of recorder history. Only devices explicitly classified as controllable are subtracted and then added back as individual planner series; every other Energy Dashboard device remains represented by its real use inside baseload. p10/p90 and sample counts remain diagnostic data rather than graph noise. |
| Raw PV forecasts were treated as truth | HA keeps a compact forecast ledger, matches completed slots to actual solar, and publishes lead-day correction factors, sample counts, MAPE and bias. The planner and main graph use one corrected solar forecast; raw provider values remain quality diagnostics only. |

This is deliberately a **shadow/advisory release**. The integration exposes
verified planned-power requests and measured reactive surplus, but it does not
bypass existing thermostats, completion logic, manual overrides or interlocks.

<a id="legacy-section-1.1.1"></a>

### 1.1.1 Thermal checkpoint (2026-08-12)

The Thermal tab previously reported three rows as permanently blocked, and they
were hardcoded that way: no room temperature, actuator state or outdoor
temperature crossed the integration boundary, so no zone model could exist.
That pipeline now exists end to end — collection ([§5.6](contracts-and-controls.md#legacy-section-5.6)), storage, and an
empirical per-zone fit ([§9.3](models-and-delivery.md#legacy-section-9.3)).

Two decisions were settled in the process and are load-bearing for everything
that follows:

- **The portal owns the room's temperature objectives, not Home Assistant
  schedule helpers** ([§5.5](contracts-and-controls.md#legacy-section-5.5)). Reading scheduled levels out of local helpers
  would bind the contract to one home's automation conventions and could not
  be offered to other customers.
- **A painted quarter is an objective, not a thermostat band or a prescribed
  heater-on period.** The room must be at that mode's temperature when the
  quarter starts. The planner may heat in preceding setback quarters and is
  therefore free to spread recovery across rooms, prices and available power.

The room schedule editor, data model and planner constraint are now implemented
in [§1.5](forecast-and-comfort.md#legacy-section-1.5). The setpoint-trajectory executor described in [§7.5](contracts-and-controls.md#legacy-section-7.5) remains outstanding.

<a id="legacy-section-1.2"></a>

### 1.2 Configuration and customer capability decision

Planning configuration is now deliberately smaller than reporting
configuration:

- **Off** keeps energy history and tariff exchange active without a planner or
  repair warning.
- **Live / automatic** reads aggregate meters from Home Assistant's Energy
  Dashboard and discovers supported forecasts, battery and EV entities.
- **Live / manual** exposes the same options in small capability-specific steps,
  not one scrolling form.
- **Demo** creates a clearly labelled synthetic plan. The integration refuses
  to expose demo plan slots to executor automations.

Solar, battery, pool, water heating and EV are independent optional
capabilities in snapshot schema 5. A category mapped for reporting is not
assumed controllable. A website-selected device enters the advisory plan as
soon as its local mapping is complete; there is no second enable or
deferrability-confirmation switch. Installation ratings still require measured
or explicitly commissioned values. The current planner only publishes and
visualises schedules: it never calls a Home Assistant actuator.

The GUI is stored as a Home Assistant config entry in
`.storage/core.config_entries`, but that file must never be hand-edited. The
supported machine/AI surface is the read-only
`shs_energy.discover_configuration` action and validated
`shs_energy.apply_configuration` action. This makes MCP-based commissioning
possible without granting an agent arbitrary file access.

For the inspected home, automatic discovery has verified the following source
set:

| Capability | Verified source or value |
|---|---|
| Whole-home energy | Energy Dashboard grid/solar/battery balance, checked against `sensor.sigen_plant_total_load_consumption` |
| PV forecast | Eight `sensor.meteo_solar_production_forecast_estimate_*` entities, 96 timestamped quarter-hours each; home location comes from HA because the entities do not repeat coordinates |
| Price forecasts | SHS `integration-prices` fetches `elprisetjustnu.se` spot intervals and applies the home-profile supplier and bidding area; grid tariffs are then added once per direction |
| Battery | 18.08 kWh, 8.8 kW charge, 9.6 kW discharge, live Sigen SOC, 13.2 kW plant/grid envelope |
| Pool | `sensor.pool_heater_energy` plus `sensor.pool_pump_energy`; active measured power about 3.67 kW; `input_boolean.pool_heating` is the season gate |
| Hot water | `sensor.hot_water_energy`; 3.0 kW installed rating remains an explicit commissioned fact |
| EV | `sensor.car_charging_lifetime_energy`, Tesla cable/SOC/target/energy-remaining entities, and `number.tesla_model_y_charge_current`; its 5 A minimum, 16 A maximum and 1 A step are reviewed from entity attributes. A timezone-aware departure timestamp is optional; without one, the target SOC is planned against the end of the rolling 72-hour horizon |

Pool and water heating are likewise included whenever their website role and
local mapping are ready. There is no user-defined pool service window: the
planner learns the daily pool energy requirement and may place it anywhere in
that local day. Water heating retains its learned full-day duty requirement.
Old inclusion toggles, confirmation values, and pool-window values are archived
during integration upgrade and are not consulted by the runtime.


<!-- END PRESERVED SOURCE -->
