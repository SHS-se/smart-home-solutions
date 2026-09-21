# Verification and delivery

## Additional required acceptance gates — 15 September 2026

Add three-owner participation and re-admission tests, no excluded metadata/telemetry, exact chart/base partition including >8 Planned devices, external Verification demand, and explicit None/Whole house/Base/Selected/Base+selected supply. Validate PV attribution, stale/missing/overlapping subgroup meters, native enforcement latency, membership changes during pending writes, and C + V action ranking with equal final-energy comparisons. The v35 cap shortcut is superseded as target; this documentation enables no hardware.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Decisions requiring Phil](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md)

Status: current verification requirements, reconciled 2026-09-06. Historical test counts, version labels, and “next” milestones are evidence from their dates, not a current release checklist.

## What constitutes evidence

Contract validity, physical feasibility, search quality, forecast quality, and actual customer benefit are separate tests. A passing utility-curve unit test does not establish that a whole plan behaves correctly. A locally stable auction does not prove global optimality. A physically invalid schedule cannot be rescued by a good score.

Use real failing snapshots with the information available at generation time. A manually constructed alternative is a useful comparator when it is feasible under the same inputs and permissions. Compare actual cash components, service, final state, and the internal score separately.

Perfect foresight is an information benchmark. It is a true optimum bound only when the formulation and solve justify that claim. The difference from an as-issued run may contain search and modelling effects, not only forecast error. A winter scenario for a period before equipment existed is a simulation, not a backtest of that equipment.

## Verification layers

1. **Provider–consumer contracts:** generated plans through server, Python integration, and portal readers; units, versions, errors, lifecycle, expiry, UTC/DST, and idempotent retry.
2. **Physical and model invariants:** energy balance, reachable states, rated power, discrete currents, start/minimum run/off constraints, shared equipment, tariff state, and no unsupported control authority.
3. **Whole-plan scenarios:** changed inputs produce defensible directional behaviour without relying on one brittle exact schedule. Compare against feasible hand-built schedules and, when available, solver bounds.
4. **Historical/as-issued replay:** frozen forecast, policy, state, code, and clock; equivalent service and terminal treatment; no future information leaking into training or decisions.
5. **Local commissioning:** actual command confirmation, cloud/unexpected-load response, overrides, expiry, staged restoration, safety intervention, and reporting of unmet service.

## Scenario matrix

Each scenario records balance, purchase/export cost, objective components, import peak, self-consumption, service deviations, switching, final states, constraints, and reasons. Canonical seasonal fixtures use 288 contiguous UTC quarters; local-day and DST cases exercise their real boundaries.

| Scenario | Essential assertion |
|---|---|
| Sunny summer, EV absent | Allocate useful storage only when eligible and valuable relative to export; no phantom EV work |
| Sunny today, cloudy tomorrow | Preserve future useful state when its value exceeds the cost and losses of storing it |
| Cloudy today, sunny tomorrow | Avoid unnecessary expensive early energy when later feasible supply can meet the same service |
| EV below urgent state | Honour approved readiness; economic ranking responds to state rather than a fixed priority |
| EV without explicit departure | Exercise the chosen readiness policy, including repeated replans so the target cannot silently recede forever |
| EV preference above SOC cap | Report conflict; never overfill or silently redefine household preference |
| Flat-price charging | Under enabled shaping/start costs, avoid gratuitous peaks or switching; do not impose exact spreading where constraints make it inferior |
| Negative/extreme prices | Correct signs, opportunity costs, storage bounds, finite price-shape arithmetic, and no prohibited simultaneous flows |
| Winter without PV | Charge/discharge only for justified service/economics; distinguish terminal value from unnecessary accumulation |
| Heating recovery across rooms | Satisfy the approved room promise with feasible device-level actuation and shared power |
| Cold spell or heating cutoff | Report unavailable capacity and infeasible service honestly; calendar policy cannot override safety |
| Cooling/heatwave | Do not reuse a heating-only fit as a cooling model; validate only explicitly supported cooling control |
| Air-source pool | Source-dependent efficiency/cutout and valid circulation; total heat versus loss is not a binary utility test |
| Ground-source/shared compressor | Correct electrical attribution, demand ownership, available capacity, and confirmed Modbus authority |
| Pool closed or equipment replacement | No comfort dispatch to unavailable equipment; local protection remains independent |
| Replan after completed service | No duplicate obligation; a stateful pool can still need later replacement of heat losses |
| Unplanned stove/sauna | Correct residual, measured grid response, timing-aware shedding, and no double allocation |
| Forecast misses | Reactive adaptation, confirmed delivered-energy deficit, and bounded replan trigger |
| Sensor or backend failure | Hold the last setting SHS sent and resume when the source returns; only the execution-mode select hands a device back (control continuity) |
| Actuator fails | No reuse of unconfirmed released watts; observable fault and replan |
| Manual override/vacation | Correct local versus planner ownership, expiry, and safety precedence |
| Demand tariff | Correct month/day/measurement-window state for the actual statistic; no artificial smoothing billed as tariff |
| DST and horizon boundaries | No missing/duplicated service, reset, start, or carried minimum-run obligation |

## Engineering backlog, not household decisions

These items require implementation or evidence, not repeated preference questions:

- Specify solver formulation, temporal utility weights, approximation bounds, scenario information structure, and status mapping. Benchmark search quality and runtime on real snapshots.
- Verify negative-price estimator behaviour and published-versus-modelled training provenance.
- Derive tariff-specific sufficient billing state from the published rule, including partial windows.
- Carry build identity and resolved inputs in exact replay; audit archive coverage rather than inferring it from retention settings.
- Verify mixed-heater executability and identify whether fitted coefficients are effective or physical. Test out-of-sample trajectories.
- Implement the residual and confirmation-aware allocator in the integration; calibrate thresholds/response times and test expiry/restoration per executor.
- Verify that current wire schemas, status readers, and provider-generated corpus agree before changing execution semantics.
- Carry the pool's authority in the plan, as a permission flag or a target-temperature trajectory, so equipment driven by a temperature band no longer depends on the executor translating watts. The [interim rule](reactive-controls.md#pool-translating-planned-watts-into-a-temperature-band) is bounded by the band the household already set.

These are requirements clarified by the split, not claims that the corresponding code has already been corrected. Product choices that affect their acceptance criteria are retained in the review.

## Delivery gates

1. Resolve the decisions relevant to the first supported device scope. Reconcile installation, meter boundaries, live control facts, and declared models.
2. Collect observe-only input and baseline evidence. Report gaps and source error without representing forecasts as measurements.
3. Run candidate planning in shadow mode against historical and synthetic cases. Failures must name input, search, model, output, or service cause.
4. Commission each executor together with the reactive and expiry behaviours required to make its control safe and useful. A later phase must not supply a prerequisite for an already enabled device.
5. Enable one control owner per device after confirmation, manual precedence, baseline independence, and relevant service/electrical tests pass. Battery direct control is commissioned separately.
6. Monitor actual outcomes, model drift, control faults, and service alongside clearly labelled savings. Expand device and household scope only with matching evidence.

No deployment, automation edit, hardware actuation, or policy change is performed by this documentation split.
