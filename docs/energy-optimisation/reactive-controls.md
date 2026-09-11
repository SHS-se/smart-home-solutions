# Reactive controls in the Home Assistant integration

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Server planner](planner.md) · [Decisions requiring Phil](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md)

Owner: `shs_energy` in `shs-ha-integration`. Status: specification for the integration-owned reactive allocator and executors; this document does not claim that they have been implemented or commissioned. Reconciled 2026-09-06 from the former §§4.2–4.4, 6.3–6.4, and 7. Battery policy corrected 2026-09-10 from Phil's operating decisions; the earlier signed-target design is superseded.

## Purpose and boundary

The server decides when energy is valuable over the horizon. The integration responds to measured conditions now: a cloud, an unexpected appliance, EV presence, a temperature deviation, an override, or a failed actuator.

One central allocator coordinates the home. Independent devices must not each claim the same export opportunity. Per-device executors translate the allocator's effective request into commands, apply local guards, and confirm the physical result. The allocator and the planner never command an actuator in parallel.

The integration does not invent a new multi-day schedule when the plan is interrupted. It adjusts within authorised envelopes, records the deviation, and requests replanning when the original service trajectory is no longer credible.

## Inputs and ownership

Read stable numeric grid import/export, whole-home load, actual PV, battery charge/discharge/SOC, device availability, temperatures, completion, overrides, actuator state, and the accepted plan. Validate sign, units, measurement boundary, age, and alignment. Do not drive allocation from a flapping import/export binary sensor.

Distinguish a commanded transition from a confirmed transition. Until a stop is confirmed, those watts are not available for another load. Rated watts describe capacity, not proof of current draw. Expected duty-cycle watts are not an instantaneous measurement.

The backend receives quarter-hour actuals and discrete request/command/confirmation/fault events. High-frequency control stays local. The complete plan stays in integration storage rather than a large recorder-backed sensor attribute.

## Authority and safety

Precedence is the existing safety-first order, made explicit where previous prose conflicted:

1. Physical/electrical protection, equipment hard limits, and island/emergency mode.
2. Explicit manual override, within those safety limits.
3. Agreed hard service commitments, subject to physical feasibility.
4. Reactive correction within the authorised policy.
5. Planned preferences and targets.
6. Baseline local control when optimisation has no authority.

“Do not shed” suspends discretionary optimisation shedding; it cannot disable electrical protection. Hard comfort is protected from discretionary savings actions, not a promise that every load can remain energised during an impossible electrical demand. A safety intervention that prevents service must be reported as a service shortfall and trigger replanning, not silently presented as a valid schedule.

The allocator is not a replacement for physical protection. Aggregate quarter-hour limits do not establish instantaneous or per-phase guarantees. Commissioned measurements, response times, and protection determine the limits of local control; the required scope is [D4](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d4-grid-headroom-and-peak-spending).

## Residual without double subtraction

An unexplained load is a residual, not necessarily an identifiable appliance. The plan's total consumption already includes its planned controlled loads. Do not subtract those loads twice.

```text
raw_residual_w = measured_total_load_w − planned_total_load_w

confirmed_control_delta_w =
  sum(confirmed_actual_controlled_draw_w − planned_controlled_draw_w)

unexplained_residual_w = raw_residual_w − confirmed_control_delta_w
```

For a 5 kW plan containing 3 kW of controlled draw, following the plan gives zero residual. After a confirmed 1 kW reduction, 4 kW measured load and a −1 kW control delta still give zero unexplained residual. An additional 2 kW appliance then produces a +2 kW residual.

Only subtract confirmed, attributable deviations. If a device's draw cannot be measured or attributed, its uncertainty remains in the residual; a command is not evidence that it happened. Grid-flow limits are enforced from the actual grid measurement, not inferred solely from this diagnostic. Battery charging must not be silently included in a consumption measurement whose plan counterpart excludes it.

Entry and exit use magnitude thresholds, hysteresis, and stable durations, calibrated against measurement noise and normal forecast error. An unknown load's duration is not guessed. The exact commissioning values are engineering work, not additional household schedules.

## Allocation, shedding, and restoration

1. Determine actual available headroom and surplus after current confirmed commitments and the commissioned measurement/error margin. Avoid subtracting a battery commitment twice if the grid meter already reflects it.
2. Filter by presence, control permission, source validity, manual state, hard bounds, and device operating timers.
3. Apply the server's current economic policy within local constraints. A binary process requires enough power for a valid start/run; a variable device uses supported levels.
4. Reserve the proposed allocation and request the transition from its executor. Wait for confirmation before reusing the same headroom.
5. On an overshoot, remove only the necessary discretionary draw. A device must be capable of responding within the required interval; a slow compressor cannot be credited as immediate relief.
6. Among eligible responses, consider interruption cost and removable watts; for equivalent device classes, use current service headroom/thermal debt. Prefer a faster response when the required response time is binding. Do not divide interruption cost by response delay: that would reward delay under a minimum-ratio ordering.
7. After the overshoot clears stably, restore in stages using current eligibility, service urgency, and headroom. Restoration is a fresh grant decision, not blind replay of the order devices were shed. Respect minimum off times and confirm each transition.
8. Resume valid plan requests where still applicable. Carry undelivered energy and temperature deviations into the next snapshot. Trigger replanning when deadlines or recovery trajectories have materially changed.

The same allocator handles both excess sun and unexpected imports. Forecast-based promotion of a store is a server decision; whether there is actual power available for it is a local decision. No hard-coded pool-versus-EV priority is implied.

## Executor contracts

| Executor | Requests | Local duties |
|---|---|---|
| Binary process | Typed run/stop or permit/inhibit, according to mapped control type | Presence, thermostat/completion, pump coupling, minimum run/off, physical confirmation |
| Variable power | Target and permitted envelope at supported current/power steps | Live clamps, cable/SOC, delivered-energy tracking, transition rate, confirmation |
| Thermal | Bounded temperature target/offset, mode, or permission supported by the reviewed installation | Local thermostat, sensor selection, hysteresis, hard bounds, confirmation |
| Storage | Explicit operating intent plus separate non-negative charge/discharge ceilings, or handover to Maximum Self Consumption | Authority handshake, measurement sign, SOC/reserve bounds, rated power clamp, plant constraints, mode-aware confirmation |

A boiler permission is never a promise that its element is drawing its rating. A heat pump influenced through Modbus is not assumed to accept arbitrary watts. Battery policy follows the accepted design below; actuator ordering, measurement signs and confirmation still require implementation verification.

For an EV, start from the planned target and change only in declared steps within its valid envelope. Presence, start/stop, cooldown, and charge-limit enforcement remain local. Preserve delivered-energy drift across slot boundaries so a quiet cloud-driven deficit does not become a missed departure.

For rooms, coordinate thermostat requests within the heating/home budget. Rank comparable requests by measured deficit, time waiting, forecast loss, and room priority; rotate comparable requests without violating timers. A grant permits heating when the thermostat calls; it does not force a warm room on. Product comfort semantics remain [D1](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d1-comfort-and-service-promises).

### Pool: translating planned watts into a temperature band

The plan gives each slot a `pool_w`, while equipment like the surveyed Nibe is driven by a start/stop temperature band and its own permission. Mapping those registers does not by itself say which band to write for a given slot, so the executor needs a stated rule.

The gap is narrower than it looks. The pool service is built with a `fixed_power` control at the devices' summed rating, so the planner already treats the pool as running at rating or not at all, and `pool_w` is effectively a per-slot yes or no. Translating it into a band position therefore discards nothing the plan actually expressed.

The rule:

- **Capture the installed band once**, at commissioning, and treat its width as the equipment's hysteresis. That width is a property of the machine and is preserved, never narrowed to force a duty cycle.
- **A slot with power** writes the band at its heat position — the captured band.
- **A slot without power** writes the band down far enough that the machine stops calling for heat, keeping the same width.
- **Both positions are clamped** to the pool store's reviewed `minimum` and `maximum`. A clamp is not a setpoint: the bounds exist to stop a request leaving the reviewed range, and are not themselves the two positions.
- **Confirm from the water**, not from the write. A band accepted by the register is not heat delivered, and `sensor.priority_31029` with the diverter valve will show the shared compressor serving hot water instead.

This deliberately inherits the household's existing target rather than choosing one. How warm the pool should be is [D1](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d1-comfort-and-service-promises), and until that is answered the planner may defer pool heating but must not decide the pool should be warmer than the band it found.

That limit is the reason to expect this rule to be temporary. Schema 6 added measured pool state to the snapshot so the pool could be planned as a store with a temperature rather than a fixed daily energy budget, and the pool store is described as something the planner schedules water temperature against — but the plan slot still emits watts alone. The boiler shows the shape the pool is missing: it carries `boiler_expected_w` *and* `boiler_permitted`, an expectation plus an authority, which is what lets a device keep its own duty cycle under a plan. Giving the pool the same permission flag, or a `pool_target_c` trajectory, removes the translation entirely. Either is a plan-contract change and goes through [versioning and validation](contracts-and-data.md#versioning-and-validation) rather than being introduced by an executor.

## Surveyed control surfaces

Read on 8 September 2026 from the reference installation. This records which levers and confirmations exist, not that any of them has been commissioned, calibrated, or authorised to write. Entity ids are that installation's; the executor contracts above remain the product interface, and a second installation may expose the same lever under a different id.

### Storage — Sigenergy SigenStor EC 12.0 TP

The authoritative implementation specification is the [Sigenergy battery control design](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-control-configuration.md) in `shs-ha-integration`, accepted from Phil's observations and policy on 10 September 2026. It supersedes this document's former signed-target and mode-before-power prescriptions. Battery is the first device to control; documentation approval does not enable live writes.

- Normal operation, solar-only charging and house supply without battery export use `Maximum Self Consumption`. Excess PV charges the battery and remaining surplus can export. This mode may discharge to house demand; preserving SOC during solar-only charging additionally requires a discharge ceiling of zero and verification of that combination.
- Grid-assisted charging uses `Command Charging (PV First)` or `Command Charging (Grid First)` with a non-negative total ESS charge ceiling. Grid First means priority, not a ban on surplus PV; that surplus case is expected by Phil rather than measured here.
- Deliberate battery export uses **only** `Command Discharging (PV First)` with a non-negative total ESS discharge ceiling. House demand is served before export. Never select `Command Discharging (ESS First)` for routine optimisation because it may curtail PV; maintenance is outside scope.
- Hold uses `Standby`. Phil reports PV still supplies the house and the battery does not contribute. Surplus-PV export is explicitly untested; acceptance also verifies that the battery neither charges nor discharges.

Map `select.sigen_plant_remote_ems_control_mode`, `number.sigen_plant_ess_max_charging_limit` and `number.sigen_plant_ess_max_discharging_limit`. Limits are non-negative kW; planning uses W. `number.sigen_inverter_active_power_fixed_adjustment` is not a signed battery command: positive values were observed to constrain discharge, and negative values did not force charging. Do not write it for dispatch or handover. Record existing inverter constraints during commissioning.

Manufacturer authority is an adapter concern, not three manual configuration fields. A future supported adapter should discover and manage prerequisites automatically; the current controller reports rejected settings or a missing forced-operation response as a fault. The established Sigenergy prerequisites are: `switch.sigen_plant_remote_ems_controlled_by_home_assistant` claims control and `sensor.sigen_plant_ems_work_mode` reporting `Remote EMS` confirms it. Observe battery power (positive charging, negative discharging), SOC, PV, house load, grid import/export and plant health. Import/export binary sensors are observations, not permissions.

Reference ratings remain 8.8 kW charge, 9.6 kW discharge, 13.2 kW plant active power and 18.08 kWh capacity. The observed hardware discharge floor is 5%; planner reserve is separate. Grid import/export and PV limits are plant-wide constraints, not battery routing commands. Prior register contents, including the unset sentinel `4294967.295`, do not block new writes. Never replay them during handover. Phil approved Maximum Self Consumption with both ceilings derived from the configured rated-power sources, currently 8.8 kW charge and 9.6 kW discharge.

Snapshot/plan schema 8 now carries explicit intent and both ceilings in a version-1 `battery_command` on every battery slot (null without a battery). Net battery watts do not identify source/destination policy or distinguish hold from normal operation. Confirm accepted settings separately from physical delivery; a ceiling is not an exact-power promise. Passive five-second observations of natural reversals do not establish command ordering or a 15-second command timeout. The linked design defines transition safeguards, restoration and acceptance coverage without claiming those tests have run.

### Thermal — Nibe S1256 with pool accessory

One modulating ground-source compressor serves rooms, hot water, and the pool. `sensor.brine_in_bt10_30011` and `sensor.brine_out_bt11_30012` establish the source loop, so the ground-source model is an observed fact for this installation rather than the unauthorised default that models and forecasts warns against.

The three sinks have genuinely different levers, and none of them is arbitrary watts:

- **Rooms:** `climate.s1256_climate_system_s1`, with `switch.permit_heating_40182` as permission, `number.heating_offset_climate_system_1_40031` and `number.external_adjustment_climate_system_1_40052` as bounded influence, and `select.oper_mode_40238` as mode.
- **Hot water:** `water_heater.s1256_hot_water` and `select.hot_water_demand_mode_40057`, measured by `sensor.hot_water_top_bt7_30009` and `sensor.hot_water_charging_bt6_30010`.
- **Pool:** `switch.pool_1_activated_40692` plus a hysteresis window, `number.pool_1_start_temperature_40688` / `number.pool_1_stop_temperature_40690`, and `number.desired_charge_power_pool_1_main_unit_43040`, measured by `sensor.pool_bt51_30028`.

The pool is therefore a temperature window and a desired charge power, not a schedulable on/off. A run/stop schedule can only switch the accessory in and out; the machine still decides when to run within the window it has been given. Driving it means writing that window, which is a question of what the integration can record, not of what the equipment offers.

Attribution between sinks is available and does not have to be inferred from a shared meter: `binary_sensor.diverter_valve_hot_water_qn10_32197` and `sensor.priority_31029` say which sink is being served now, and the energy log reports used and produced energy per sink over the past hour (`sensor.energy_log_used_energy_for_pool_over_the_past_hour_32296`, `..._for_hot_water_..._32294`, and their `produced` counterparts). With `sensor.compressor_power_input_31049` and `sensor.compressor_frequency_current_31047`, both electrical input and delivered heat are separable per sink, which is what a per-sink COP requires.

Interlocks are observable and must gate any request: `sensor.blocked_31060`, `sensor.blocked_compressors_32175`, `sensor.compressor_time_to_start_eb100_ep14_31531`, and `binary_sensor.compressor_status_31101`. `number.max_internal_additional_heat_40103` and `number.max_internal_additional_heat_sg_ready_41053` cap the resistive addition separately from the compressor; they are a cost lever, not a heat request.

Shared capacity remains the binding constraint. Priority and the diverter valve are evidence that the sinks compete, so simultaneous independent promises to pool and hot water are not physically available whatever the levers allow. That is the substance of [D6](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d6-device-control-scope-and-commissioning).

### Integration mapping

The integration's mapped control types are `switch_schedule`, `variable_power`, `permit_inhibit`, and `setpoint`, routed by `planning_path` to room, pool, boiler, and EV. Against the surfaces above, as of `0.8.0-beta.16`:

- **Storage remains plant-level.** Updated in beta.56: explicit operations replace sign-based routing; separate non-negative charge/discharge limits replace the signed actuator. Configuration, validation, confirmation and restoration follow the [battery execution contract](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-control-configuration.md). Keep one battery store; routing it as a controllable house load would count it twice.
- **The thermal mapping carries the executor's three levers.** `setpoint` now also accepts a permission switch, a demand or operating mode, and a bounded offset. The offset's bounds are required with it rather than optional beside it: an unbounded offset is the one lever here that can drive equipment past what was reviewed. All three are optional, so existing mappings are unchanged.
- **The pool's temperature band is mapped, on the store.** The entities holding the start and stop temperatures are configured once per pool, within a reviewed range — not on each device mapping. The pool service is built from every device routed to it, so a heater and its circulation pump share one body of water and one pair of registers; a band per device asked for it once per meter, let two mappings disagree about the same window, and left two writers on one actuator. Both ends are required together, since writing one alone inverts or collapses the window the machine runs to. The pool's *desired charge power* is deliberately left unmapped for now: the lever exists on the equipment, but nothing yet asks for it.

Configuration is not authorisation. Battery control is off by default and, once switched on, an incomplete mapping raises a warning rather than being written to; a complete mapping is still not a commissioned one. What the equipment does when written to remains [D6](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d6-device-control-scope-and-commissioning), and the unmapped pool charge power belongs with the [engineering backlog](verification-and-delivery.md#engineering-backlog-not-household-decisions).

## Expiry and baseline handover

A request is unavailable when optimisation lacks authority. Inside a valid slot, zero is an explicit request value interpreted by its typed control; absence is not a stop command.

On expiry or loss of a required control source, revoke optimisation authority and return that executor to its baseline controller, respecting equipment protection and confirmation. A temporary optimisation setpoint must not become a permanent baseline merely because the network failed. Holding the last setpoint is not, by itself, safe handover.

This is the baseline handover already required by the architecture, not a new guessed scheduling fallback. Device-specific restoration and fault behaviour require commissioning tests. A sensor failure affecting the baseline thermostat is a local fault; it is not solved by retaining a planner estimate.

**Storage baseline.** Return to `Maximum Self Consumption` and set both ESS ceilings from the configured rated-power sources on expiry, disable, required-source/authority loss, startup recovery and orderly unload. Do not write zero to the inverter adjustment. Confirm mode and limits, then mode-consistent physical behaviour; normal battery power may be nonzero. Persist ownership and the configured mapping before writing; resolve its rated sources again during handover. Prior register values are not restoration data. A failed handover must remain visible rather than being declared successful from register readback alone.

`Maximum Self Consumption` is itself a Remote EMS mode, so this hands behaviour back while the integration keeps holding authority. That is the right target for every case above, all of which assume the integration is running well enough to write. It does not cover the integration not running at all: whether the inverter has its own watchdog when Remote EMS goes quiet, and what it falls back to, is unknown here and cannot be established by holding authority and observing. Releasing `switch.sigen_plant_remote_ems_controlled_by_home_assistant` and watching where `sensor.sigen_plant_ems_work_mode` lands is a commissioning test; until it is run, the behaviour of an unattended plant after a Home Assistant outage is not specified.

The execution lease for later slots and policy for missing optional capabilities still need the choices in [D5](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d5-degraded-operation-and-execution-lease).

## State and observability

Expose one merged effective request per device: value/envelope, source, reason, expiry, eligibility/guard, and last command/confirmation/fault.

Use observable states such as idle, eligible, start-pending, running, stop-pending, complete, blocked, and fault. A stop requiring actuation passes through stop-pending; a manual block must not silently mark a still-running device off. Every active state must handle expiry, override, unavailability, and safety intervention. Minimum-run obligations and completion resets must be defined per device rather than assuming every process has a daily reset.

Log request, command, confirmation, refusal, fault, and restoration with timestamps and the plan identity. An IR toggle is successful only after physical confirmation. No confirmed power may be inferred from a requested state alone.

## Human overrides and deployment

An immediate bounded “warmer now” request is local; an explicit trip, changed deadline, or dated vacation schedule changes planning inputs. Persistent target changes must reach the planner as intent, not just as the temperature they happened to produce. Temporary overrides have an expiry; permanent changes are configuration.

Node-RED can remain the prototype executor behind these contracts. The product target is integration-owned coordination with native HA executors or visible blueprints, with no Node-RED runtime dependency. The integration does not silently create customer automations. Disable the corresponding old controller before commissioning its replacement so there is one writer per actuator.

Control must not be enabled on the strength of a shadow plan alone. Verify unexpected-load response, cloud response, sensor loss, stale requests, manual override, staged restoration, unmet service, and command failure as part of [delivery](verification-and-delivery.md).
