# Verification and delivery

## Additional required acceptance gates — 15 September 2026

Add three-owner participation and re-admission tests, no excluded metadata/telemetry, exact chart/base partition including >8 Planned devices, external Verification demand, and explicit None/Whole house/Base/Selected/Base+selected supply. Validate PV attribution, stale/missing/overlapping subgroup meters, native enforcement latency, membership changes during pending writes, and C + V action ranking with equal final-energy comparisons. The v35 cap shortcut is superseded as target; this documentation enables no hardware.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Battery release update, 14 September: use the [14 September architecture review and battery release gates](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/controller-architecture-review.md)
for current stage completion and open gates. Add long compiler-outage retention,
lost/stale transition-worker responses, retry checkpoint validity and overload-reducing transitions to the
replay matrix. Mixed-mode lifecycle and real/hypothetical isolation are required
for battery-first deployment. Thermal modelling, direct user controls and the
notification framework may remain deferred.

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Decision register](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md)

Status: current verification requirements, reconciled 2026-09-13. Historical test counts, version labels, and “next” milestones are evidence from their dates, not a current release checklist.

## What constitutes evidence

Contract validity, physical feasibility, search quality, forecast quality, and actual customer benefit are separate tests. A passing utility-curve unit test does not establish that a whole plan behaves correctly. A locally stable auction does not prove global optimality. A physically invalid schedule cannot be rescued by a good score.

Use real failing snapshots with the information available at generation time. A manually constructed alternative is a useful comparator when it is feasible under the same inputs and permissions. Compare actual cash components, service, final state, and the internal score separately.

Perfect foresight is an information benchmark. It is a true optimum bound only when the formulation and solve justify that claim. The difference from an as-issued run may contain search and modelling effects, not only forecast error. A winter scenario for a period before equipment existed is a simulation, not a backtest of that equipment.

## Verification layers

1. **Provider–consumer contracts:** generated plans through server, Python integration, and portal readers; units, versions, errors, lifecycle, expiry, UTC/DST, and idempotent retry.
2. **Physical and model invariants:** energy balance, reachable states, rated power, discrete currents, native interlocks/transition availability without SHS minimum-run settings, shared equipment, tariff state, and no unsupported control authority.
3. **Whole-plan scenarios:** changed inputs produce defensible directional behaviour without relying on one brittle exact schedule. Compare against feasible hand-built schedules and, when available, solver bounds.
4. **Historical/as-issued replay:** frozen forecast, policy, state, code, and clock; equivalent service and terminal treatment; no future information leaking into training or decisions.
5. **Local commissioning:** actual command confirmation, cloud/unexpected-load response, overrides, expiry, staged restoration, safety intervention, and reporting of unmet service.

## Scenario matrix

Each scenario records balance, purchase/export cost, objective components, import peak, self-consumption, service deviations, switching, final states, constraints, and reasons. Canonical seasonal fixtures use 288 contiguous UTC quarters; local-day and DST cases exercise their real boundaries.

| Scenario | Essential assertion |
|---|---|
| Sunny summer, EV absent | Retain desired conditional EV schedule; gate actual charging separately and allocate actual spare supply to useful eligible sinks without phantom EV delivery |
| Sunny today, cloudy tomorrow | Preserve future useful state when its value exceeds the cost and losses of storing it |
| Cloudy today, sunny tomorrow | Avoid unnecessary expensive early energy when later feasible supply can meet the same service |
| EV below urgent state | Price readiness loss through the approved curve; no implied hard everyday SOC floor or fixed priority |
| EV without explicit departure | Exercise the chosen readiness policy, including repeated replans so the target cannot silently recede forever |
| EV preference above SOC cap | Report conflict; never overfill or silently redefine household preference |
| Flat-price charging | Under enabled shaping/start costs, avoid gratuitous peaks or switching; do not impose exact spreading where constraints make it inferior |
| Negative/extreme prices | Correct signs, opportunity costs, storage bounds, finite price-shape arithmetic, and no prohibited simultaneous flows |
| Winter without PV | Charge/discharge only for justified service/economics; distinguish terminal value from unnecessary accumulation |
| Heating recovery across rooms | Compare curve-valued room outcomes with feasible device-level actuation and shared power |
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
| DST and horizon boundaries | No missing/duplicated service, reset or start; native physical state and pending effects cross boundaries without invented runtime locks |

## Intent and reactive execution acceptance

These are requirements for the target [economic policy](controller-policy.md) and [runtime](reactive-controls.md), not claims about current support. Record economic components, service/state outcomes, switching, uncertainty, evidence and timing for each case.

| Case | Required evidence |
|---|---|
| Final policy extraction | Score the final materialised whole household, with room/boiler load, resolved curves and shared equipment; auction evidence alone cannot authorise execution |
| Fixed-tail counterexample | A reduction with coupled recovery/rescheduling is correctly valued; frozen future actions must demonstrably give a different/worse answer in a fixture |
| Cost ownership | Current grid/export cost, wear and transitions plus conditional future delta reproduce full objective differences at anchors; no duplicated start, battery opportunity value or terminal benefit |
| Cell reference becomes unavailable | EV unplug or mode change cannot require subtracting an infeasible nominal plan; use a named common feasible cell reference, otherwise split/narrow/reject coverage |
| Partial current quarter | Recompute remaining-segment energy and value, carry continuing runs/departures beyond it, and distinguish segment end from execution expiry |
| Bounded compiler | Deterministic limits on solves, alternatives, conditions, wire size and HA work; report search limit/omitted coverage separately from infeasibility |
| Approximation and interpolation | Held-out joint solves measure cost/ranking error at tested states; any certified regional bound needs separate structural/mathematical evidence. No economic extrapolation or interpolation used as proof of hard physical feasibility |
| Non-divisible coupled actions | Exhaustive small cases show joint selection beats an incorrect greedy ranking and does not award shared recovery or compressor capacity twice |
| Room target/curve raised or lowered | New intent revision changes value smoothly; stable tie-breaking/deadband avoids gratuitous device switching; incompatible old tail economics are not reused |
| EV near a desired 40% knee | Illustrative 39/38% shortfall is possible and priced less severely than 30%; no hard floor is introduced by that example |
| Anchored everyday readiness | Repeated replans do not postpone the event indefinitely or award its utility in every quarter |
| House forecast 735 W, actual 1,500 W | Valid demand following may exceed forecast; measured energy changes state/economics without becoming a slot quota |
| Extra grid energy beats service loss | Buy it within real limits even after nominal allocation is exceeded or was zero; export and battery source authority remain explicit |
| Solar forecast 1 kW, actual surplus 3 kW | Useful additional battery/thermal/EV uptake competes with permitted export; forecast is not a ceiling |
| PV 8 kW to 1 kW and back | Raw grid/phase evidence governs constraints while filtered economics and affordable grid/battery bridging prevent cloud chatter; no phantom filtered supply |
| Sustained PV underproduction and overproduction | Distinct persistent deviations update allocation and trigger bounded/coalesced replanning when meaningful; not a solve per cloud |
| 8 kW unknown-load step | Likely required relief responds without appliance identification or assumed sauna duration; include cases where available grid/battery does and does not cover it |
| Unavoidable overload with only partial relief | Preserve a legally executable 4 kW reduction against an 8 kW excess; do not discard it for failing to restore full feasibility, and report the residual violation without relaxing equipment/interlock authority |
| Smaller 2 kW unknown load | Do not shed automatically if grid/battery supply is feasible and worthwhile; known coffee/iron duration is used only when actually known |
| Sunny today, cloudy tomorrow; battery full, EV full/absent | Pool preheat competes against near-zero export and avoids later purchases after losses/COP; rate and shared compressor remain binding |
| Pool warmth curve zero marginal above 32 °C | No invented hard 32 °C cap or duplicate setting; any additional future storage value is demonstrated without double counting, and worthless/harmful heating is not justified as surplus disposal |
| No SHS minimum runtimes | Target configuration/contract contains no minimum-on/off fields or SHS elapsed-time run locks; local decisions can change between quarters. Native interlocks/refusals remain respected and their actual effects accounted for; soft economics creates no hard duration |
| Conditional service reservation sacrificed | Release only through an explicit linked service-loss/release alternative; unconditional protection and unrelated reservations remain binding |
| Several services compete or become infeasible | Use curve-valued losses and extra grid options under real constraints; report physical infeasibility, unsupported coverage and economic decline distinctly |
| Accounting with unchanged power reports | Gross energy, state-bound crossings, expiry and pending-operation deadlines progress with time without a full decision per unchanged report |
| Replan mid-quarter / meter reset | Reconcile watermark and meter epochs once; no replenished entitlement, duplicated energy or erased obligation |
| EV unplug and reconnect | Preserve conditional desired schedule regardless of cable/current location, reconcile actual delivery and possible effects, then reconsider executable requests when connected |
| Battery mode supply gap | With ample actual grid headroom no invented overload; with insufficient grid/phase headroom establish required relief before removing supply |
| Unrelated group waits for physical response | New home decisions continue with pending effects reserved; one ordered SHS sequence per physical group while external writers remain possible, and no global action lock |
| Late/timed-out remote command | Cancellation/generation fencing alone cannot release possible effects; demonstrate quiescence/ordering/latest-effect evidence before reusing headroom |
| Repeated routine HA restart/reload | Persist plan, intent/mapping identity, ledger, deadlines, physical requests and issued operations; adopt unchanged valid requests with no default initialisation, lease reset or gratuitous baseline cycle |
| Restart during forced/uncertain transition | Bound continued effects throughout suspension; reconcile issued steps and remote queue before continuation; target only unsupported scope when necessary |
| Missing meter interval / changed clock | Conservative downtime accounting, absolute deadline recovery and timer rebasing; never reuse old monotonic time or invent zero consumption |
| Transient unknown/unavailable, then valid | Retain age/quality/bounds, continue only supported scopes, recover automatically without needless baseline cycling |
| Persistent source or control fault | Control status exposes cause, affected scope and recovery; notification behaviour is outside the current acceptance scope |
| Backend unavailable with valid cached plan | Supported local operation can continue to explicit valid_until; binding_until and portal report freshness do not become invented execution leases |
| Genuine expiry, disable/removal or authority loss | Confirm device-appropriate handover; persist failed restoration; report limits of any nonpersistent planning reserve |
| Unsupported replacement / stale response | Reject before actuation without widening authority; pending request neither extends expiry nor resets ledger |
| Unchanged valid intent after replacement or restart | No duplicate device command, saved override replay or unnecessary handover; operating mode, release progress and bounded retry state persist |
| High SOC, spotty-cloud PV and near-zero export | Compare no proactive drawdown with economically useful drawdown; quantify captured peaks, gross throughput, losses/wear, service and later grid use without a fixed SOC target |
| Same end-of-quarter SOC, different within-quarter bill | Expected segment cost retains buffering import/export/clipping/throughput/service differences even when future delta cancels; reconcile C with extraction L and keep realised ledger separate |
| Same daily/quarter PV energy, different subquarter paths | Smooth versus alternating peak/trough traces can produce different clipping/headroom value; preserve correlation and information timing rather than netting away cycling |
| High forecast fails / charge rate limits peak | No assumption that 60 kWh guarantees replenishment or spare kWh absorbs unlimited kW; overdrawdown losses and uncatchable peaks are visible |
| Native battery buffering | Both appropriate flow directions are enabled by supported envelopes; no EMS-mode chasing per cloud and no double headroom reward |
| Desired EV schedule while away/unplugged | Desired opportunities and conditional SOC remain visible across replans; no present-location veto or credited delivery; explicit dated intent remains separate |
| External edit between battery/thermal steps | Retain Controlling authority, reconcile actual controls and possible effects, then automatically execute a valid transition to current SHS intent; do not reopen limits blindly under a changed mode |
| External/native same-value or power change | Distinguish expected native regulation from control drift; attribution is diagnostic and unexpected values never establish an external hold |
| Definite not-sent versus ambiguous send | Unsent proof can release only that step; ambiguous delivery retains uncertainty and can trigger bounded adapter-supported reassertion of the current request, without automatic baseline cycling |
| Confirmation arrives after timeout | Reconcile and adopt valid state without duplicate write; older queued effects remain separately resolved |
| Late obsolete command while Controlling | Account for actual/possible effects and automatically converge to current SHS intent through a valid transition; no ownership hold |
| Repeated drift/failure, then new plan/slot/restart | Preserve bounded retry pacing and current mode; automatically recover under the adapter contract without an external-change hold or an uncontrolled retry burst |
| Journal pending/fails while sensor changes | Reducer continues; dispatch requires durable matching preparation plus current per-step validation; stale durability acknowledgement cannot revive work |
| Equipment returns at default-looking value | Current SHS mode determines authority; in Controlling automatically reconcile/reassert supported current intent, never blindly replay stale steps |
| Control to Monitoring/Planning/Verification during a pending command | Fence new optimisation sends, retain possible late effects and report release until approved handover completes; no optimisation reassertion after release |
| Mixed controlled and Planning/Verification devices | Hypothetical stops/discharge never release real headroom or fabricate delivered service; verify the explicitly supported shared-equipment mode boundary |
| Event burst / maximum supported home | Compile/index policy once; bounded queues preserve critical authority, meter-epoch and transition events; expose queue/pending-operation age and decision health |

Replay includes physical phase/plant constraints where supported, meter boundaries, losses, observation delay and uncertain actuator latency. Test pure decision determinism, exactly one shared owner and no double reservation. Physical commissioning must establish native routing, transition response and latest-effect bounds before relying on them.

Benchmark the declared maximum configuration/event rate on the slowest supported HA host. Initial targets to validate remain pure-decision p99 below 10 ms and observation-to-decision p95 below 250 ms; these are unmeasured engineering targets, distinct from physical-response deadlines. Record tail/max observation age, queue delay, computation, transport, physical response, confirmation and bounded storage/log growth. Measure compiler effort on captured whole-home capsules; no candidate review's estimated score count proves deployable runtime.

## Engineering backlog, not household decisions

These items require implementation or evidence, not repeated preference questions:

- Specify solver formulation, temporal utility weights, approximation bounds, scenario information structure, and status mapping. Benchmark search quality and runtime on real snapshots.
- Verify negative-price estimator behaviour and published-versus-modelled training provenance.
- Derive tariff-specific sufficient billing state from the published rule, including partial windows.
- Carry build identity and resolved inputs in exact replay; audit archive coverage rather than inferring it from retention settings.
- **Deferred significant workstream: thermal modelling.** General room/pool/tank models, shared heat-source behaviour, identification/calibration and thermal service verification are deferred beyond the initial battery compiler/controller scope. Track the [scope and completion requirements](models-and-forecasts.md#deferred-thermal-modelling-workstream); synthetic thermal scorer tests do not complete this work. Verify mixed-heater executability, distinguish effective from physical fitted coefficients and test out-of-sample trajectories before enabling the affected thermal scope.
- Implement and validate the bounded joint policy compiler and final-household scorer in [the economic design](controller-policy.md), including suffix reoptimisation, approximation coverage and current/future cost reconciliation.
- Prototype [shared-entity reconciliation](control-reconciliation.md) with explicit outcomes, mode-owned authority, automatic drift correction and bounded retries, with no global action lock; benchmark loop time before considering version-stamped offloaded calculation.
- Add conditional EV projections and correlated subquarter battery-headroom evaluation with measured economic/regret evidence. Notification design is deferred; unplugged planned charging is an illustrative future use case, not a delivery gate.
- Remove generic commissioning minimum-on/off fields, validators and SHS run locks in a separately versioned implementation; preserve native equipment observations instead.
- Build the pure decision/accounting reducer against disturbance, replan and restart fixtures before widening live envelopes. Add private asynchronous actuator-group transitions with remote-effect reconciliation, the coalescing replan gate and durable suspension/adoption. Calibrate source bounds and stability; test scoped restriction/handover and repeated routine restart.
- Specify mixed-mode planning versus live policy, shared-lever authority, entry/release transitions and verification fidelity; preserve the four existing mode meanings and prevent hypothetical physical accounting.
- Reconcile current external manual-override latches with Controlling authority; external edits must not suspend SHS control. Specify adapter repeatability, bounded pacing and automatic recovery after ambiguous delivery.
- Reconcile the current global device-execution lock, repeated full-plan validation and per-device event dependencies with the delegate runtime. Preserve scoped events and deadlines while adding shared-resource invalidation and accounting deadlines.
- Verify that current wire schemas, status readers, and provider-generated corpus agree before changing execution semantics.
- Carry the pool's authority in the plan, as a permission flag or a target-temperature trajectory, so equipment driven by a temperature band no longer depends on the executor translating watts. The [interim rule](reactive-controls.md#pool-translating-planned-watts-into-a-temperature-band) is bounded by the band the household already set.

These are requirements clarified by the split, not claims that the corresponding code has already been corrected. Settled controller decisions and remaining commissioning/unrelated product questions are separated in the decision register.

## Delivery gates

1. Resolve the decisions relevant to the first supported device scope. Reconcile installation, meter boundaries, live control facts, and declared models.
2. Collect observe-only input and baseline evidence. Report gaps and source error without representing forecasts as measurements.
3. Run candidate planning in shadow mode against historical and synthetic cases. Failures must name input, search, model, output, or service cause.
4. Commission each executor together with the reactive and expiry behaviours required to make its control safe and useful. A later phase must not supply a prerequisite for an already enabled device.
5. Enable one SHS sequence per physical group after confirmation, automatic external-drift correction, mode-exit handover and relevant service/electrical tests pass. Do not assume other HA writers have been excluded. Battery direct control is commissioned separately.
6. Monitor actual outcomes, model drift, control faults, and service alongside clearly labelled savings. Expand device and household scope only with matching evidence.

No deployment, automation edit, hardware actuation, or policy change is performed by this documentation split.
