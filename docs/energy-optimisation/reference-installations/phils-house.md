# Phil's house — installation reference

Recorded: 14 September 2026, from Phil's controller-design discussion and supplied
Home Assistant configuration. This is an installation record, not a general
heat-pump model, catalog default, live inspection or commissioning certificate.

[Architecture](../../../ENERGY_OPTIMISATION_ARCHITECTURE.md) ·
[General models](../models-and-forecasts.md) ·
[Controller runtime](../reactive-controls.md) ·
[Device catalog proposal](../../../../shs-ha-integration/docs/device-catalog-design.md)

## Purpose and development direction

Phil wants to build a general equipment/service model first, then establish how
this house fits it. Keep these details available so he does not have to repeat
them. Do not turn this unusual installation into defaults for other homes, or
make additional custom HA helpers/catalog development a prerequisite for starting
the controller implementation.

The requested controller rollout order is **battery, then pool, then car**.
Automatic operation is sufficient initially; detailed direct user controls remain
deferred. Notifications remain outside the controller's current scope.

Catalog/adapter knowledge should describe supported equipment and interface
semantics. Installation data describes connected circuits, equipment relationships,
settings and bindings. Household intent remains separate from both. This record
does not settle a catalog schema or authorise hardware writes.

## Heat sources and connected services

- A **Nibe S1256 ground-source heat pump (bergvärme)** supplies pool heating and
  domestic hot-water preheating through shared compressor capacity.
- There are **currently no house-heating circuits connected for it to heat**.
  A room-heating control surface existing on the equipment does not establish
  an installed room-heating service in this home.
- Domestic water is preheated by the Nibe, then an older, separate electric
  hot-water system provides the final heating temperature. This is a two-stage
  hot-water arrangement, not two unrelated final hot-water services.
- The electric water heater has separately observed electrical phases P1–P3.
- The pool is now heated by the Nibe, not the former Shelly-metered heater.
- Phil describes the installation as unusual: the ground-source heat pump is
  used primarily for the pool, with secondary hot-water preheating. It should
  not stand in for a typical house with room heating and domestic hot water.

Phil considers the existing pool/hot-water arrangement appropriate and believes
it is energy efficient. This is his operating assessment, not a measured proof
that the configured service order minimises total electricity use. Hot-water
load can be significant, even if its heating periods are relatively short.

## Native heating-priority settings

Phil supplied these current settings:

| Entity | Setting |
|---|---|
| `number.period_time_pool_40095` | 60 minutes |
| `number.period_time_hot_water_40093` | 20 minutes |
| `number.period_time_heating_40094` | 0 minutes |

He describes this as 75% pool / 25% hot water, and reports that a default Nibe
normally prioritises hot water before other heating circuits. The latter is
owner-reported context, not verified behavior for every Nibe model/firmware.

Keep the actual minute settings as installation facts. Exact arbitration under
simultaneous demand, satisfied thermostats and interruptions needs adapter
verification. Do not interpret the ratio as guaranteed delivered heat, electrical
energy shares, compulsory 60/20-minute runs, or SHS minimum-runtime settings.

The initial controller scope proposed in the discussion preserves these native
settings while controlling pool-specific requests and coordinating circulation.
Optimising these service-period settings was not requested. Hot-water demand
still competes for the same compressor and must remain in the physical model.

## Pool controls and physical observations

These bindings are specific to this installation:

| Role | Entity / reported interpretation |
|---|---|
| Pool enabled | `switch.pool_1_activated_40692` |
| Pool temperature | `sensor.pool_bt51_30028` |
| Start temperature | `number.pool_1_start_temperature_40688` |
| Stop temperature | `number.pool_1_stop_temperature_40690` |
| Pool diverter QN19 | `sensor.pool_1_qn19_31135`; the supplied template tests state `'1'` |
| Compressor running | `binary_sensor.compressor_status_31101` |
| Current service priority | `sensor.priority_31029`; helpers distinguish `'POOL'` and `'HOT WATER'` |
| Compressor start countdown | `sensor.compressor_time_to_start_eb100_ep14_31531` |
| Alarm number | `sensor.alarm_number_31976` |
| Heat-pump electrical input used by attribution helpers | `sensor.instantaneous_used_power_32167` |

The supplied status template marks the circulation pump as required whenever
QN19 is on the pool (`'1'`). Phil's configuration explains that stopping the pump
before the diverter releases risks a no-flow trip. Pool deactivation therefore
does not establish that circulation can stop. This is a hydraulic/equipment
dependency, not an economic minimum run. The adapter must establish suitable
fresh evidence for release; a requested stop alone is insufficient.

The pool circulation-pump command entity was not supplied in this discussion.
That binding and physical transition behavior can be established during adapter
work; they are not additional household preference questions.

## Existing electrical attribution and energy helpers

The following describes Phil's supplied YAML and its comments. Helper internals
were described, not independently inspected. These are electrical consumption
series; their names do not imply measurements of delivered thermal energy.

| Helper or named sensor | Construction / meaning |
|---|---|
| `sensor.heat_pump_pool_power` | Reads `sensor.instantaneous_used_power_32167` while `sensor.priority_31029 == 'POOL'`, otherwise zero |
| “Pool heater power” (`unique_id: pool_heater_power`) | Wraps `sensor.heat_pump_pool_power` with `float(0)`; W, power, measurement |
| `sensor.heat_pump_pool_energy` | Described as a left Riemann integral of pool power, with a one-minute maximum sub-interval |
| “Pool heater energy” (`unique_id: sensor.pool_heater_energy`) | Wraps `sensor.heat_pump_pool_energy`; kWh, energy, total_increasing; requires that source to have a value |
| “Pool operating energy” (`unique_id: sensor.pool_operating_energy`) | Sum of `sensor.ftx_energy`, `sensor.pool_pump_energy`, and `sensor.heat_pump_pool_energy`; kWh, total_increasing; requires all three sources |
| `sensor.heat_pump_hot_water_energy` | Described as the integral of heat-pump input power attributed to priority `'HOT WATER'` |
| “Hot water energy” (`unique_id: sensor.hot_water_energy`) | Sum of `sensor.water_boiler_p1_energy`, `sensor.water_boiler_p2_energy`, `sensor.water_boiler_p3_energy`, and `sensor.heat_pump_hot_water_energy`; kWh, total_increasing; requires all four sources |

Display names and YAML `unique_id` values above are recorded as supplied; a unique
ID is not proof of the runtime entity ID. `sensor.ftx_energy` is included in Phil's
pool operating total; its name alone does not establish its equipment role or
make that energy controllable pool heat.

The supplied screenshot shows a “Water boiler power” view with separate Water
boiler P1/P2/P3 Power and Heat pump hot water power entries and a five-minute
aggregated history. It supports the existence of a combined reporting view; it
does not provide exact runtime entity IDs, calibrated peaks or a thermal model.

Preserve the component series for planning even when displaying category totals:
the preheater and final electric heater have different roles. Do not add a total
and its components to the household balance, or treat all “Pool operating energy”
as compressor energy. A valid electrical attribution still needs verified meter
boundaries and timing around service transitions. Missing data must remain
distinguishable from zero consumption in controller observations; the supplied
templates' `float(0)` conversions do not establish valid zero-load evidence.

## Existing pool status helper

Phil supplied “Pool heating status” (`unique_id: sensor.pool_heating_status`).
Its state logic evaluates the following conditions in this order:

| State | Condition in the supplied template |
|---|---|
| Alarm | Alarm number is neither `'0'`, `'unknown'` nor `'unavailable'` |
| Heating | QN19 on pool and compressor running |
| Starting | QN19 on pool and pool enabled, after the Heating case |
| Stopping | QN19 on pool and pool disabled, after the Heating case |
| Off | Pool disabled |
| At target | Pool temperature at or above stop temperature |
| Queued | Pool temperature below start temperature |
| Idle | Remaining cases, described as inside the hysteresis band |

The helper requires values for pool enable, QN19 and compressor status. Its
attributes expose pool/start/stop temperatures, priority, compressor countdown,
pool power, alarm number and `pump_required` (QN19 state `'1'`). Temperature and
alarm validity are not all enforced by that availability expression.

These labels are useful UI evidence, not independent physical confirmation.
For example, the template does not require a positive countdown for “Starting”
or a named competing service for “Queued”. “Heating” takes precedence even when
pool permission has been switched off. The runtime should use validated underlying
observations and reconcile pending effects, rather than treating the label alone
as proof of the equipment state. No helper rewrite is requested by this note.

## Other equipment already recorded

The existing documentation also records the following installation context;
these are prior records, not new observations from 14 September:

- **Battery:** Sigenergy SigenStor EC 12.0 TP. The current mapping, separate
  charge/discharge ceilings and approved rated-source handover are in
  [battery configuration and execution](../../../../shs-ha-integration/docs/battery-control-configuration.md).
  The [installation survey](../reactive-controls.md#storage--sigenergy-sigenstor-ec-120-tp)
  records the observed ratings and remaining commissioning questions. Resolve
  live rated sources rather than hardcoding those recorded values.
- **Car:** Tesla Model Y, with `sensor.tesla_model_y_charger_power` and
  `number.tesla_model_y_charge_current`; the catalog proposal records this
  installation's supported integer 5–16 A commands. Vehicle-side control must
  not be assumed to be wall-charger control. See the
  [catalog case](../../../../shs-ha-integration/docs/device-catalog-design.md#first-concrete-case-this-tesla-model-y-installation).

## How to use this case when building the general model

Treat this home as a test of shared heat-source capacity, service attribution,
two-stage domestic-water heating, and circulation dependencies. Other homes may
connect the same supported heat pump to rooms and domestic water without a pool
or downstream electric heater. Validate those arrangements with separate cases.

Represent observed electrical consumption even before a detailed thermal model
is validated. Do not claim measured usable hot water or quantified avoided final
electric heating solely from an electrical energy integral. The amount/timing
of that benefit needs a supported model or measurements.

Remaining work is to verify adapter semantics, command/response timing, source
quality, and thermal/electrical relationships for the scope being enabled. The
provided setup is sufficient to proceed with the controller's scope specification
and offline work; it is not evidence that commissioning or the controller itself
has been completed. More sensors should follow demonstrated implementation needs.
