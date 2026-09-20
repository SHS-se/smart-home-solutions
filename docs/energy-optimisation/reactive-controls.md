# Unified household control in Home Assistant

> **Replacement decision model — 17 September 2026.**
> [Plan execution and deviation accounting](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/controller-plan-execution.md)
> is the current controller specification. It replaces conditional bids, independent
> economic selection and local strategy changes below with plan execution,
> measured debt/credit and planner-authorised recovery. Reliable actuation and
> mode-owned authority remain requirements where consistent with that specification.
> The older design below is not a requirement to preserve existing implementation.

## Scope-aware live execution — 15 September 2026

Only Planned equipment has a command interface, with HA Verification/Controlling authority; the observation interface still covers the whole household. Supply scope selects eligible demand, while the existing policy ranks battery actions from measured state and future consequences. Feed gross residual consumption and PV separately, apply the explicit attribution once, and enforce the scoped house-supply response within declared native capabilities. Reject missing coverage through the existing release protocol; no forecast, whole-house or rated-power fallback is added.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Implementation update, 14 September: the pure runtime, gross ledger, exact policy
binding and backend diagnostic coverage are now implemented offline. The
[14 September architecture review and battery release gates](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/controller-architecture-review.md) distinguishes those stages
from the shipping controller, records open recovery/relief gaps and proposes the
battery-first mixed-mode lifecycle. The target below remains unimplemented in
the live HA execution path.

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Executable economic policy](controller-policy.md) · [Contracts](contracts-and-data.md) · [Shared-entity reconciliation](control-reconciliation.md)

Status: target design reconciled with Phil's 13 September 2026 decisions. Schema-8 battery commands and the existing scheduled controller are implemented; the joint policy, durable continuation runtime and wider reactive authority described here are not. Historical requirements for fixed slot energy budgets, mandatory service tiers, commissioned minimum runtimes and routine-restart baseline cycling are superseded. The later 13 September feedback adds proactive battery headroom and persistent conditional EV planning. The latest authority correction supersedes external-change holds: SHS fully controls its supported device surface while Controlling and may overwrite external changes. Unplugged planned charging is an example for a later notification specification, not a notification-framework requirement.

## Purpose and boundary

The backend plans the future household. One integration-owned runtime selects a jointly feasible present request using the planner's compiled economic policy and measured conditions. Device adapters execute it. There is no scheduled controller plus an independent reactive override controller, no permanent device ranking, and no device-specific horizon optimiser in HA.

## Plan intent, forecasts, and execution envelopes

A forecast predicts draw and state; it grants no permission and imposes no energy quota. The replacement contract separates expected power from executable modes, physical ceilings, state bounds, source/destination authority, conditional alternatives and their value. Extra grid energy is always considered when physically available and authorised, at its applicable price. Zero nominal allocation must not exclude a useful device or a grid-supported alternative. There is no fixed per-slot grid energy budget.

Actual energy, battery inventory and outstanding obligations remain accounted for. A real physical floor or equipment power limit is binding; an economic reserve is priced and spendable. Any restriction must name its provenance and enforcement scope. Export permission is separate from grid availability. Current schema-8 non-baseline battery ceilings are still derived from planned power and validated as such; these future semantics cannot be inferred from its forecasts.

## One controller, one effective decision

One event-loop reducer owns SHS accepted policy, shared accounting, reservations and one effective request per actuator group. Controlling mode gives SHS full operational authority over the supported device surface. Other writers remain technically possible; their changes are overwritable drift rather than a reason to yield control. It combines observed load, available supply and pending physical effects before choosing the next action. An unchanged effective request whose controls/outcome remain supported requires no repeat actuation, even after plan replacement or routine restart. Observed control drift can require reassertion of that same request.

## Controller structure and parameter ownership

[Caller usage, types and module boundaries](controller-policy.md#types-and-module-ownership) define the target. Customer preferences are editable value curves and dated intent. Installation limits and supported physical modes are equipment facts. Native protections/availability are observed; they do not create SHS commissioning minimum-runtime fields. Forecasts and fitted dynamics are model inputs; filtering, deadbands and queue limits are versioned engineering calibration. Do not introduce a second household priority list, fixed energy allocations, or duplicate pool maximum to tune the same preference.

The target has no planner or commissioning minimum-on/off settings and no SHS hard run-duration commitments. Retire the existing generic `minimum_on_seconds`/`minimum_off_seconds` fields and elapsed-time locks in a later implementation change; do not rename them commissioned obligations. Native protection remains inside equipment. Adapters observe interlocks, accepted/refused transitions and actual noninterruptibility, retaining possible consumption while a device cannot respond. An observed native countdown can inform the next observation, not a household run promise. Economically choosing a long run and soft heat-pump start costs remain distinct; home and EV batteries retain no start/stop penalty.

## One decision cycle

1. Build an observation frame with ages, uncertainty, meter epochs and pending transitions; reconcile gross actual energy once.
2. Apply authority, equipment/interlock, physical state and transition-path guards to applicable joint alternatives.
3. Compare their current costs plus planner-derived future consequences, including unchanged operation and worthwhile grid supply.
4. Commit the winning effective requests and reservations atomically in the short synchronous reducer; queue required journal writes, then dispatch only after durable acknowledgement and fresh per-step validation. Await neither device nor persistence I/O in the reducer.
5. Process physical progress, meter updates and absolute deadlines through the same owner. Replan when economics/coverage or persistent state drift requires it.

## Deriving flexibility in the planner

The canonical [bounded extraction algorithm](controller-policy.md#concrete-bounded-extraction-algorithm) starts with the final validated household trajectory, including room/boiler materialisation, and jointly repairs/reoptimises future actions for each bounded counterfactual. Fixed-tail rescoring is insufficient. The existing auction acceptance trace remains evidence about that auction, not an executable priority or policy.

## Conditional bids delegated from the final plan

“Bid” means a conditional complete household alternative with a declared cost split, applicability range, executable device levels and explicit linked releases. It is not an independently ranked watt belonging to one device. The finite condition language and bounded value bands cannot contain arbitrary expressions, unbounded optimisation, or extrapolation. The [economic policy](controller-policy.md#one-objective-boundary-and-ownership) owns current-supply, wear, transition and future-consequence accounting exactly once.

## Scarcity, abundance and infeasible service

Ordinary warmth and readiness shortfalls are valued by the same editable curves as normal operation. There are no compulsory household shortage tiers and no implied hard 40% EV promise. An unconditional physical/protection reservation remains binding. A conditional service reservation can be released only by an explicit alternative that pairs the service loss with the released energy or recovery capacity. Without that alternative it remains reserved, even if another service is left unmet.

When several services compete, compare their complete economic consequences and additional grid supply within real limits. Report service loss and binding constraints separately from physical infeasibility or search/coverage failure. An economically declined action is not a controller fault and does not automatically trigger baseline handover. A replacement plan pending in the backend grants no extra authority.

## Pool as a residual surplus sink

Sunny today and cloudy tomorrow is a primary storage case: with house battery full, EV full or absent and permitted export worth near zero, preheating the pool can avoid paid heating tomorrow. Price retained heat, losses, COP, shared-compressor opportunity cost and future recovery once in the full objective. Prefer the pool when its additional total value exceeds export or other feasible uses.

Phil's editable curve currently has zero marginal warmth value above 32 °C. That is not a hard equipment cap or a request for another maximum-temperature preference. Immediate extra warmth can have zero value while retained heat still avoids a later purchase; the full trajectory must establish that benefit without awarding it twice. A genuinely unwanted/harmful temperature needs an explicit disutility or physical bound; it cannot be inferred from a non-negative zero-marginal curve.

Thermal capacity is how much heat can be stored; electrical absorption power is how fast the installed compressor can take electricity. Large water volume gives substantial storage, but cannot make the compressor absorb an arbitrary instantaneous PV peak. At the surveyed ground-source installation, electricity drives the heat pump and heat also enters from the ground loop. The pool being warmer than its surroundings does not prevent this transfer. Use the actual equipment rate and shared-service availability when deciding how much surplus can be absorbed.

## Worked policy: battery plus one flexible load

Suppose house demand was forecast at 735 W but is now 1,500 W. Authorised demand-following battery supply may follow the actual load within physical power/state limits; it is not capped merely by the forecast. The extra battery energy changes future state/value. The same decision can instead buy grid energy if preserving battery energy or avoiding a mode change is more valuable.

With a 1 kW charging forecast and 3 kW actual PV surplus, consider additional battery uptake, useful thermal/EV service, and permitted export using their joint future consequences. A full battery cannot absorb more energy; a zero-forecast pool can still be eligible. A switch to grid-supported charging must have explicit source authority. No nominal allocation is transferable as an energy entitlement between devices.

## Disturbances outside the nominal schedule

- **EV unplug/reconnect:** retain the desired conditional charging schedule regardless of current cable/location; only the actual execution branch loses eligibility. Preserve intent and delivered energy, reconcile uncertain effects and reconsider execution on reconnect. Unplugged planned charging is an example of a possible future notification; the full notification specification is deferred. See [EV schedule and notification example](controller-policy.md#ev-desired-schedule-execution-and-future-notifications).
- **PV from 8 kW to 1 kW and back:** leave fast peak/trough regulation to the battery with an appropriate bidirectional envelope. A full battery loses capture opportunities, so the planner may deliberately use energy earlier to create economically worthwhile headroom. Price correlated subquarter paths and later consequences, rather than add a fixed SOC target or threshold at a 60 kWh daily forecast. Filter slower discretionary load decisions; use raw measurements for limits and metering. See [battery headroom](controller-policy.md#battery-headroom-for-intermittent-pv).
- **Large unmetered load:** an 8 kW step is likely to require shedding depending on current grid/phase headroom and battery capability. Respond to the measured residual without identifying a sauna or guessing its duration. A smaller 2 kW load need not cause shedding if grid/battery supply makes sense. A known coffee machine's short duration or iron's longer use can inform forecasting only when that identity/duration is actually available; otherwise use observed persistence and uncertainty.
- **Persistent forecast miss:** accumulate actual state/energy drift and replan when coverage, recoverability or economic significance warrants it. A single cloud need not trigger a solve.
- **Unchanged readings:** time still consumes energy and advances state/protection, expiry and operation deadlines. Schedule those crossings without depending on changed sensor values.

## Confirmation and reporting semantics

Transport completion, register readback and physical response are different evidence. Confirm against the effective operation and envelope, not exact forecast watts. Demand following above forecast may be correct execution with energy drift; a permit or thermostat band is not delivered heat. A timeout means unresolved physical effect until the adapter establishes what can still happen.

## Quantities with different meanings

Keep forecast, effective request, accepted settings, measured power, gross delivered energy, projected state, reservation, service value and billed cost separate. Do not net charge and discharge into a quantity that loses wear/efficiency information. Do not treat an electrical ceiling as a power setpoint or a change in SOC as an independently metered flow without accounting for its uncertainty.

## Battery examples and mode semantics

Operations and the approved Sigenergy mappings are in the [integration battery contract](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-control-configuration.md). Normal operation uses Maximum Self Consumption; planned export uses PV First, never ESS First. Each operation has distinct routing and ceiling semantics. The future policy widens only explicitly validated authority, not the meaning of an old command.

A quarter answers two separate questions: whether to spend stored energy, and whether to absorb the surplus the plant produces anyway. Schema-2 commands answered both with one `hold` and one inert native mode, so a decision about discharging silently forbade charging. Schema 3 splits them:

- `hold` declines to spend stored energy. It stays in the automatic mode with the rated charge ceiling and a zero discharge ceiling, so real surplus is still absorbed. Use it whenever the dispatcher declined to discharge, could not discharge, or had nothing to do.
- `idle` keeps the stored energy *and* deliberately lets the surplus reach the grid. It alone uses the inert mode, with both ceilings closed, so the pack neither gives nor takes. The dispatcher emits it only for `charge_value_below_export`: a completed comparison in which the export price beat the marginal value of storing that energy. A full pack is not that comparison, and neither is an unaffordable discharge.

A charge ceiling is a permission under every automatic operation, including `supply_house`. Capping what may leave the pack says nothing about what a sunny minute inside the quarter may put back into it, and the measured surplus-charge path carries no activation overhead, so capture is worth taking at any power. Only `grid_charge` sizes its charge ceiling, because that ceiling bounds a purchase.

## Energy accounting and future service

A durable ledger records stable device/meter identity and epochs, gross flows, time boundaries, measured state and uncertainty. Reconcile an accepted plan's watermark with subsequent actuals once. Replans, overlapping quarters, meter resets and restarts never create fresh energy or erase delivered service. Ledger intervals measure use; they do not allocate fixed slot grid budgets.

For missing meter intervals, use available cumulative readings and reconciled state with honest bounds; otherwise carry uncertain consumption. Do not manufacture zero load or start from default SOC/temperature. Real state/protection bounds include possible use during command latency and suspension. Reserve only what is genuinely unavailable and retain conditional service reservations until their authorised release is selected.

## Solar forecast errors: one allocation decision

The controller chooses supply and demand together. PV overproduction may justify extra heat today for tomorrow; underproduction may justify extra grid energy, battery supply or reduced service. A generic “shed reverse auction order” is incorrect when interruption, restart or coupled recovery changes value. [Stability rules](controller-policy.md#runtime-selection-and-stability) define the raw/filtered separation and single-counted switching economics.

## Contract and delivery boundary

The target policy is a new versioned provider/consumer contract with explicit coverage and bounded execution complexity. No generic legacy fallback or inferred forecast permission is introduced. Generate provider fixtures and validate them through actual HA/portal readers before deployment. This documentation update changes neither schemas nor installed control permissions.

## Home Assistant runtime and performance

The current controller serialises device execution under a shared home lock and awaits service/readback/confirmation stages. Service and confirmation waits are individually bounded (currently 15 seconds), but several sequential stages can delay other SHS decisions substantially. This is evidence of possible decision stalls, not proof of a permanent deadlock or a blocked HA event loop. Current scoped events and one-shot deadlines already avoid a mandatory five-second whole-plan poll.

The target uses a synchronous event-loop reducer, with no global action mutex. It serialises only SHS shared bookkeeping and joint decisions to avoid duplicate reservations or conflicting SHS sequences. It never waits for entity state, services, disk or notifications. Private actuator-group tasks progress asynchronously; their pending effects remain in the shared frame. Coupled battery controls or heat-pump levers stay in one group. The reducer cannot lock HA entities against external writers. The [reconciliation specification](control-reconciliation.md) defines per-step validation, uncertain transport outcomes, mode-owned full control, automatic drift correction, bounded adapter-supported retries and release on leaving Controlling. Moving today's shared mutable per-device context into concurrent tasks without redesign would be unsafe.

Every transition has an absolute deadline, progress state and health reporting. A timeout enters the [automatic retry/reconciliation protocol](control-reconciliation.md#ambiguous-commands-and-retries): retry the current request where the adapter supports its possible effects, with bounded pacing and current mode validation. Record queue age, oldest pending operation, decision latency, last success and fault reason so a stalled group is visible. Bound/coalesce ordinary observations while preserving meter epochs, authority changes and operation results. Decision latency and response guarantees require benchmarks and commissioning; current tests do not establish them.

## Replanning and degraded scope

Keep one correlated replan request with reason, urgency, intent revision and observation watermark; coalesce ordinary drift and reject stale responses. A pending solve neither extends `valid_until` nor clears reservations, mode transitions or retry state. Continue unaffected scopes only when their dependency closure still has valid authority and bounded observations/resources. Missing shared grid or plant evidence may affect the whole home; EV absence affects the actual execution branch, not the desired conditional charging schedule or its intent. Unsupported economic coverage cannot be patched by extrapolated values.

Transient `unknown`/`unavailable` readings retain the last valid value with its actual age and uncertainty. Continue only while conservative bounds support the current request, with role-specific expiry; never relabel an aged value fresh. Recover automatically when valid data returns and reconcile before resuming, under the current operating mode and adapter retry/recovery rules. External changes do not create a hold or require renewed authority; persistent equipment/transport defects remain distinct. Persistent control/data faults remain visible with affected capability, reason and recovery status. They are another potential notification use case; the notification framework and its full delivery specification are deferred.

## Inputs and ownership

HA owns current observations, entity bindings, meter epochs and execution. The backend owns forecast/model provenance and compiled future consequences. Both refer to one versioned household intent rather than a portal-only or local-only shadow preference. Direct room +/- and charge-by-time requests will enter that intent boundary; their API, entities, widgets and detailed semantics remain a later discussion.

## Authority and safety

Independent electrical/equipment protections remain authoritative. Commission aggregate, phase and inverter limits that are relevant to the installation; a grid price or shaping preference cannot replace them. Extra grid purchase is permitted economically up to those real limits, not a forecast-derived energy ceiling.

Validate intermediate paths. The current battery mode sequence closes both ceilings before changing mode, temporarily withdrawing supply. That matters only if actual available grid/phase headroom cannot cover the gap; it is not a blanket assertion that a mode change overloads the grid. Account for other loads and pending operations, establish relief if required, then make the change. Model uncertain consumption as well as lost supply throughout the transition.

## Residual without double subtraction

Start from explicitly reconciled aggregate meter boundaries. Remove only loads already measured/modelled separately, and add candidate controllable flows once. Pending starts retain possible draw; requested stops release no watts until physical/quiescence evidence supports release. Unmetered appliances remain in the residual, with no identification prerequisite.

## Allocation, shedding, and restoration

Choose the complete alternative with the best supported economic result under real limits and reservations. Mandatory electrical relief may precede discretionary optimisation. Restore in stable stages as raw capability and filtered economic advantage support it. If uncontrolled demand prevents full grid/phase feasibility, retain the explicitly commissioned partial-relief actions: a legal 4 kW EV reduction is useful even if an 8 kW excess remains too large to eliminate. Select timely non-worsening relief within immutable equipment/interlock/source authority and conditional reservation rules; do not reject every reduction merely because none alone solves the whole violation. Account for transition paths and report the remaining unavoidable limitation. Software cannot promise to replace a fuse or make absent capacity appear.

## Executor contracts

An adapter declares executable levels, group coupling, transition paths, possible draw/supply envelopes, native response, native availability/interlock evidence, confirmation evidence, timeout and latest possible effect. Persist issued steps and uncertain outcomes before relinquishing them. Cancellation or a generation fence prevents obsolete software results from becoming current authority, but cannot retract a command already queued remotely.

An uncertain operation is finished only when its outcome is reconciled and no obsolete command can still take effect, using device-supported cancellation, a verified ordering barrier or commissioned latest-effect bound and fresh observation. A fresh zero reading alone is insufficient if a delayed start can still arrive. Until then retain possible effects and reservations. Plan replacement or restart adopts this state rather than replaying the old command or starting a conflicting sequence.

## Pool: translating planned watts into a temperature band

Current implementation is an interim adapter: capture the installed start/stop band; use it on heat slots and lower it for deferral within reviewed bounds; restore captured settings when handing back authority. This cannot express all future preheating choices. The replacement policy must explicitly authorise executable band/permission choices from the pool trajectory and curve, rather than treating forecast watts or a captured band as the permanent household warmth preference. The desired-charge-power lever remains unmapped pending a validated model and control scope.

## Surveyed control surfaces

Read on 8 September 2026 from the reference installation. This records which levers and confirmations exist, not that any of them has been commissioned, calibrated, or authorised to write. Entity ids are that installation's; the executor contracts above remain the product interface, and a second installation may expose the same lever under a different id.

### Storage — Sigenergy SigenStor EC 12.0 TP

The authoritative implementation specification is the [Sigenergy battery control design](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-control-configuration.md) in `shs-ha-integration`, accepted from Phil's observations and policy on 10 September 2026. It supersedes this document's former signed-target and mode-before-power prescriptions. Battery is the first device to control; documentation approval does not enable live writes.

- Normal operation, solar-only charging, holding stored energy and house supply without battery export all use `Maximum Self Consumption`. Excess PV charges the battery and remaining surplus can export. This mode may discharge to house demand; preserving SOC additionally requires a discharge ceiling of zero, and Phil confirms that combination holds SOC while the mode continues to absorb surplus PV. That is why holding stored energy no longer needs an inert mode.
- Forced/grid-assisted charging uses **only** `Command Charging (PV First)` with a non-negative total ESS charge ceiling. Phil's 15 September history shows Grid First curtailing PV to zero while grid import rises, and PV recovering after switching back to PV First. `Command Charging (Grid First)` is excluded from every normal operating scenario. The earlier claim that Grid First merely changes priority without suppressing PV is withdrawn. The total ESS ceiling does not promise minimum grid charging plus unlimited additional solar capture.
- Deliberate battery export uses **only** `Command Discharging (PV First)` with a non-negative total ESS discharge ceiling. House demand is served before export. Never select `Command Discharging (ESS First)` for routine optimisation because it may curtail PV; maintenance is outside scope.
- Only `idle` uses `Standby`, and Standby's surplus behaviour is no longer untested. Controller diagnostics from 20 September 2026 06:24–07:05Z record the native target `Standby / charge 0 / discharge 0` while PV rose 0.4 kW to 1.26 kW against a 0.5–0.95 kW house load: battery power stayed at about −0.003 kW, SOC was pinned at 37.5%, and grid export climbed from 0.06 kW to 0.71 kW. **Standby exports surplus PV and does not charge.** It is therefore the right mode for a deliberate `idle` and the wrong one for holding stored energy. PV still supplies the house, and the battery neither charges nor discharges.

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

The integration maps switch_schedule, variable_power, permit_inhibit and setpoint, routed by planning_path to room, pool, boiler and EV. The following records the earlier mapping milestones and their current design role; dated beta versions are evidence of those additions, not a statement that the target delegate is implemented:

- **Storage remains plant-level.** Updated in beta.56: explicit operations replace sign-based routing; separate non-negative charge/discharge limits replace the signed actuator. Configuration, validation, confirmation and restoration follow the [battery execution contract](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-control-configuration.md). Keep one battery store; routing it as a controllable house load would count it twice.
- **The thermal mapping carries the executor's three levers.** `setpoint` now also accepts a permission switch, a demand or operating mode, and a bounded offset. The offset's bounds are required with it rather than optional beside it: an unbounded offset is the one lever here that can drive equipment past what was reviewed. All three are optional, so existing mappings are unchanged.
- **The pool's temperature band is mapped, on the store.** The entities holding the start and stop temperatures are configured once per pool, within a reviewed range — not on each device mapping. The pool service is built from every device routed to it, so a heater and its circulation pump share one body of water and one pair of registers; a band per device asked for it once per meter, let two mappings disagree about the same window, and left two writers on one actuator. Both ends are required together, since writing one alone inverts or collapses the window the machine runs to. The pool's *desired charge power* is deliberately left unmapped for now: the lever exists on the equipment, but nothing yet asks for it.

Configuration is not authorisation. Battery control is off by default and, once switched on, an incomplete mapping raises a warning rather than being written to; a complete mapping is still not a commissioned one. What the equipment does when written to remains [D6](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d6-device-control-scope-and-commissioning), and the unmapped pool charge power belongs with the [engineering backlog](verification-and-delivery.md#engineering-backlog-not-household-decisions).

## Expiry and baseline handover

Routine HA restart, upgrade or integration reload is **suspension and continuation**, not withdrawal of optimisation authority. Persist operating modes, release progress and retry state too; restart neither changes authority nor resets retry pacing. Persist accepted plan/policy and intent revision, mapping identity, meter ledger/epochs, reservations, current physical requests, pending issued operations and absolute deadlines. Checkpoint during operation as well as orderly shutdown. On resume validate the same authority/expiry, reconcile live states and possible downtime consumption, and adopt unchanged requests without default settings or gratuitous writes. Rebase timers from absolute deadlines and clock evidence; never reuse a prior process's monotonic timestamp or reset a lease.

A running request must be safe for the supported suspension interval, including possible meter loss, native behaviour and lease/state crossings. Forced operations that cannot be bounded across that interval require an equipment-enforced stop or a targeted pre-suspension change. A planned restart does not automatically require all devices to baseline. An abrupt outage cannot rely on HA performing that preparation. If an interval, physical state or late remote effect is unbounded, or authority/lease has expired, resume only supported groups and explicitly restrict/handover the affected scope. Literal uninterrupted execution cannot be promised beyond available evidence.

Explicit disable/removal, relinquished authority, genuine expiry and unrecoverable faults use device-appropriate handover only where SHS still has supported authority over those controls. External drift during Controlling does not veto authorised handover. Leaving Controlling fences optimisation sends immediately while already-issued effects and approved release remain reconciled; follow [control reconciliation](control-reconciliation.md). Battery handover is the approved Maximum Self Consumption with fresh configured rated charge/discharge limits, never stale register contents or guessed values. EV/pool restore their captured legitimate settings. Pending restoration remains durable and visible until confirmed. Intentional permanent shutdown is distinct from a routine restart/reload even when HA's event alone is ambiguous; lifecycle integration must establish that distinction or bound the suspension explicitly.

Current schema-8 startup/unload restores owned devices before proceeding. Cached-plan restoration is already implemented but is not actuator continuity. The new suspension/journal/adoption mechanism replaces that behaviour only after implementation and restart validation. See [current runtime recovery](ha-runtime-recovery.md) and the [integration battery record](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-control-configuration.md).

No HA-independent higher backup reserve is requested for an unexpected outage. The physical inverter cutoff remains read-only and independent. Rated-limit baseline operation can spend a higher economic planning reserve. Do not claim any optional protection survives an HA outage without equipment evidence; do not add a new household backup promise or silently raise that cutoff. A known stopped HA process cannot issue handover commands.

## State and observability

Expose effective request and reason, plan/intent identity, validity, eligibility, measured outcome, energy drift, last command/confirmation, pending-operation age, degraded source quality and faults. Distinguish idle, eligible, starting, running, stopping, completed, blocked and uncertain/faulted states. “Stopped” cannot be inferred merely from a requested stop. Carry native physical state, pending effects and completion events across plan changes and restarts; no SHS minimum-runtime commitment is created.

Record request, command, confirmation, refusal, restriction, handover and recovery with timestamps and evidence. An IR toggle needs physical confirmation. A retained last value must visibly retain its age. Control faults and recovery remain visible in status. How notifications present them is outside this design scope and requires a later specification.

## Human overrides and deployment

Intent addressed to SHS is versioned input to its decision owner. Direct external entity edits are overwritable drift while Controlling; they are not translated into SHS preferences and never establish a manual-precedence hold. Users request through SHS or leave Controlling before controlling the device elsewhere. The [mode boundary](control-reconciliation.md#operating-modes-handover-and-restart) distinguishes Monitoring, Planning, Control verification and Controlling, with mixed-mode and transition details still to specify. Changing a room target or EV deadline invalidates incompatible policy economics; reconciliation and supported revaluation/replanning rules apply. Direct-control API/entities and immediate-versus-dated request semantics are explicitly deferred; this document does not claim that warmer-now commands can bypass policy validation.

Existing Node-RED may serve as a commissioned prototype executor, but the product target has no Node-RED runtime dependency. Prevent duplicate SHS sequences for one physical group, but do not assume other HA writers can be excluded. Commission automatic correction of external user/automation changes and mid-sequence drift as normal operating cases, including bounded retries and mode exit during uncertain delivery. This documentation update enables no controller, creates no automation and performs no hardware writes. [Verification and delivery](verification-and-delivery.md) governs implementation and physical enablement.
