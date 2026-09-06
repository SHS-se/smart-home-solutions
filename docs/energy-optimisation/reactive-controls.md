# Reactive controls in the Home Assistant integration

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Server planner](planner.md) · [Decisions requiring Phil](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md)

Owner: `shs_energy` in `shs-ha-integration`. Status: specification for the integration-owned reactive allocator and executors; this document does not claim that they have been implemented or commissioned. Reconciled 2026-09-06 from the former §§4.2–4.4, 6.3–6.4, and 7.

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

A boiler permission is never a promise that its element is drawing its rating. A heat pump influenced through Modbus is not assumed to accept arbitrary watts. Battery direct control requires separately commissioned inverter mode/sign/confirmation semantics.

For an EV, start from the planned target and change only in declared steps within its valid envelope. Presence, start/stop, cooldown, and charge-limit enforcement remain local. Preserve delivered-energy drift across slot boundaries so a quiet cloud-driven deficit does not become a missed departure.

For rooms, coordinate thermostat requests within the heating/home budget. Rank comparable requests by measured deficit, time waiting, forecast loss, and room priority; rotate comparable requests without violating timers. A grant permits heating when the thermostat calls; it does not force a warm room on. Product comfort semantics remain [D1](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d1-comfort-and-service-promises).

## Expiry and baseline handover

A request is unavailable when optimisation lacks authority. Inside a valid slot, zero is an explicit request value interpreted by its typed control; absence is not a stop command.

On expiry or loss of a required control source, revoke optimisation authority and return that executor to its baseline controller, respecting equipment protection and confirmation. A temporary optimisation setpoint must not become a permanent baseline merely because the network failed. Holding the last setpoint is not, by itself, safe handover.

This is the baseline handover already required by the architecture, not a new guessed scheduling fallback. Device-specific restoration and fault behaviour require commissioning tests. A sensor failure affecting the baseline thermostat is a local fault; it is not solved by retaining a planner estimate.

The execution lease for later slots and policy for missing optional capabilities still need the choices in [D5](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d5-degraded-operation-and-execution-lease).

## State and observability

Expose one merged effective request per device: value/envelope, source, reason, expiry, eligibility/guard, and last command/confirmation/fault.

Use observable states such as idle, eligible, start-pending, running, stop-pending, complete, blocked, and fault. A stop requiring actuation passes through stop-pending; a manual block must not silently mark a still-running device off. Every active state must handle expiry, override, unavailability, and safety intervention. Minimum-run obligations and completion resets must be defined per device rather than assuming every process has a daily reset.

Log request, command, confirmation, refusal, fault, and restoration with timestamps and the plan identity. An IR toggle is successful only after physical confirmation. No confirmed power may be inferred from a requested state alone.

## Human overrides and deployment

An immediate bounded “warmer now” request is local; an explicit trip, changed deadline, or dated vacation schedule changes planning inputs. Persistent target changes must reach the planner as intent, not just as the temperature they happened to produce. Temporary overrides have an expiry; permanent changes are configuration.

Node-RED can remain the prototype executor behind these contracts. The product target is integration-owned coordination with native HA executors or visible blueprints, with no Node-RED runtime dependency. The integration does not silently create customer automations. Disable the corresponding old controller before commissioning its replacement so there is one writer per actuator.

Control must not be enabled on the strength of a shadow plan alone. Verify unexpected-load response, cloud response, sensor loss, stale requests, manual override, staged restoration, unmet service, and command failure as part of [delivery](verification-and-delivery.md).
