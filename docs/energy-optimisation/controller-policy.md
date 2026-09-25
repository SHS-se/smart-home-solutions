# Executable whole-home economic policy

> **Superseded controller specification — 17 September 2026.**
> [Plan execution and deviation accounting](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/controller-plan-execution.md)
> replaces the economic controller design below. The controller executes planner
> intent and accounts for deviations; it does not rank independent future
> strategies. Preserve this text as earlier rationale, not a competing
> implementation requirement. A complete rewrite is authorised; retained physical
> and authority semantics do not require retaining this policy representation.

## Explicit supply scope is required — 15 September 2026

Battery alternatives must carry the agreed house-supply selector, participation identity and explicit solar attribution. Incorporate live eligible-deficit feasibility into the existing native current response and current/future economic comparison; do not add a second fixed-ceiling BatteryService dispatcher. Scope is an accounting permission, not per-device physical routing or a fixed energy entitlement. The type sketches below predate this extension and must be revised together at implementation. Four local operating modes and universal rated house supply are superseded as target design.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Runtime](reactive-controls.md) · [Verification](verification-and-delivery.md)

Decision: 13 September 2026. This is the target design, not an implemented contract or a claim of a proven solver. It supersedes fixed slot energy entitlements, permanent device rankings, mandatory household shortage tiers, and counterfactuals that freeze all future actions. The later 13 September feedback additionally removes SHS minimum-runtime settings, preserves conditional EV scheduling independent of cable/location, values battery headroom for intermittent PV, and rejects a global action lock. The latest correction gives SHS full operational authority over supported device controls in Controlling mode; external deviations are automatically overwritten/reconciled, not held for manual resume. Existing schema-8 commands retain their current meaning until a versioned replacement ships.

## Caller usage first

The backend compiles only after it has materialised and validated the whole household trajectory. HA accepts the resulting finite policy once, then makes short decisions from reconciled actual state. It does not solve the future horizon.

```typescript
// Proposed backend call site; not implemented.
const reference = validateHouseholdTrajectory({
  finalSchedule, resolvedModels, sharedEquipment, intentRevision, obligations,
});
const result = compileHomePolicy({
  reference, actualsWatermark, forecasts, limits: compilationLimits,
});
// Publish only validated coverage; distinguish omitted/search-limited from infeasible.
```

```python
# Proposed HA call sites; not implemented.
home.post(PolicyOffered(compile_and_validate(plan.home_policy)))
home.post(ObservedFrame(observations.frame(now)))
# The synchronous reducer selects/reserves requests, then queues asynchronous effects.
home.post(TransportResult(operation_id, result))
# An SHS mode change, not an external setting edit, changes control authority.
home.post(OperatingModeChanged(device_id, mode, mode_revision))
```

## Alternatives and synthesis decision

| Representation | Strength | Limitation / decision |
|---|---|---|
| Independent marginal prices or device continuation curves | Compact; familiar curve arithmetic | Cannot generally represent shared recovery, discrete starts or mutually exclusive compressor service. Household curves remain inputs, but independent runtime device optimisers are rejected. |
| Bounded joint request alternatives with conditional future consequences | Complete household choices retain coupling; finite HA evaluation; traceable to the final objective | Selected. Coverage and approximation must be explicit, and suffix reoptimisation costs must be measured. |
| General coupled value-to-go function | Can describe many states and continuous decisions compactly when a good representation exists | High-dimensional fitting and optimisation are unproven here; a possible later replacement, not a prerequisite. |
| Complete observation-to-action table | Very simple lookup | State, time, intent, availability and pending-operation combinations grow rapidly; compilation still needs the same economic and physical proofs. Rejected as the primary representation. |

Independent Claude and Codex reviews considered these whole shapes. The Codex joint-alternative design is the base. Adopt Claude's clear separation of current costs from future value and its single-writer runtime, but reject its fixed-tail extraction, unproved separable/concave continuation curves and arbitrary production limits. A fixed-tail score can rank a recoverable interruption incorrectly. Transition cost must appear once in the objective, not again in the switching threshold.

### When to revisit a representation

Retain the alternatives during implementation and record measured coverage, empirical ranking regret, compiler work, wire size and HA latency on the same captured inputs. No switch is justified merely because another representation sounds simpler.

| Alternative to investigate | Evidence that would justify revisiting it |
|---|---|
| Independent continuation curves | Joint-minus-separable cost and ranking differences remain within the accepted economic tolerance across coupled recovery, starts, EV connection and PV-buffer scenarios; retain explicit coupling guards. |
| General joint value-to-go function | Catalogue size/compile cost repeatedly exceeds limits, or important states have persistent ranking regret/coverage gaps despite targeted refinement, and a jointly conditioned function demonstrates better measured accuracy/cost. |
| Observation-to-action table | Supported state/action dimensions become demonstrably small and enumerable; a table meets coverage and update costs, including operating-mode transitions and presence changes. |
| Another search/compiler strategy within the chosen representation | Suffix search noise, missed coupled recovery or runtime dominates the error; distinguish a solver defect from a representation defect before replacing both. |

Measured held-out error is not a certified regional bound. Record the failing capsules and explicit acceptance limits when considering a change. The runtime design provenance, authority correction and remaining mode questions are in [control reconciliation](control-reconciliation.md#design-provenance-and-implementation-evidence).

## One objective, boundary and ownership

Compare executable changes from the reconciled current request/state over the **remaining part of the current canonical 15-minute segment**. This economic segment is not the plan's execution expiry. The planner prices consequences through the remaining horizon and its explicitly modelled terminal value, including runs and obligations extending beyond the segment. Quarter resolution is not a 15-minute runtime lock: local requests can change between boundaries. Native physical response and uncertain issued effects still cross boundaries; they are not SHS-created run commitments.

Use one minimised whole-home objective in SEK: grid purchase minus permitted export revenue, wear, declared switching/power-shaping costs and service loss, less terminal value. Ordinary room warmth, pool warmth and EV readiness are editable marginal value curves. A desired 40% morning SOC may have a steep knee; 39% and 38% remain possible at a small service loss while 30% costs much more. This example adds no new saved target or hard floor. Physical limits and genuinely unconditional protections remain feasibility constraints.

Grid supply is an economic option whenever physically available and authorised. Neither forecast Wh, zero nominal allocation, nor a depleted discretionary allocation can prohibit it. There are no fixed per-slot grid energy budgets. Battery state, real equipment limits, reservations and measured gross energy still matter. Battery export requires separate permission. Source restrictions must have explicit meaning; a solar-preferred forecast is not a solar-only prohibition on buying worthwhile grid energy.

For an applicable joint alternative `a`, anchor state `z`, a feasible cell reference alternative `r`, and segment end `b`:

```text
J_a(z) = full objective of a followed by jointly repaired/reoptimised future actions
L_a(z) = expected objective contribution in [now, b), conditioned on current evidence z
F_a(z) = J_a(z) - J_r(z) - (L_a(z) - L_r(z))

C_a(z) = compiled expected remaining-segment cost model, consistent with L_a(z)
runtime_delta(a) = C_a(current_evidence) - C_r(current_evidence) + F_a(current_evidence)
```

Each applicability cell names one deterministic physically feasible reference alternative, shared by every band in that cell. The desired conditional EV schedule remains even when unplugged, but cannot serve as the current executable reference until connection and other guards permit it. Separate planned service from the actual execution branch. Validate reference feasibility throughout the declared cell; split/narrow or reject a cell if no common feasible reference exists. Never subtract an infeasible/infinite reference score. Reference identity and objective/intent versions must match when comparing deltas. The currently effective request is an ordinary candidate when still feasible; it need not be the reference.

The runtime evaluates the bounded compiled `C` model for the remaining current segment, including expected grid/export cost, gross throughput/wear, service and new transitions once. `C` uses current observations and the same conditional subquarter scenario/response convention as extraction; it must reproduce `L` at compilation anchors within its declared error evidence. This is an expectation of what has not yet happened, not fabricated future actuals. Actual metered delivery updates the separate ledger and next state; completed costs are sunk and are not awarded again. `F` contains future consequences only, including changed recovery and future wear/starts. Sunk costs cancel. An already started run does not pay another start; any later restart caused by interruption belongs to the future consequence. Do not add a separate battery opportunity price on top of the same lost future value, or add current grid cost to an unsplit full-horizon score difference. Native inverter routing needs a commissioned executable response model; a ceiling is not forced draw.

Keep monetary accounting distinct from service and internal preferences in diagnostics. Continuous room utility is a declared SEK/hour rate integrated over time; EV readiness utility is evaluated at anchored usage events, not awarded every preceding quarter or deferred by a continually moving horizon. Terminal utility must not duplicate an in-horizon service benefit. The existing linearly interpolated marginal curves integrate to piecewise-quadratic total utility; a piecewise-linear compiled approximation needs explicit error evidence, distinguishing measured test error from a certified regional bound.

## Concrete bounded extraction algorithm

The earlier instruction to “evaluate counterfactuals” was insufficient to build an algorithm. The following specifies an implementable prototype, with production adequacy gated on evidence.

1. **Freeze the reference.** Record final room/boiler materialisation as well as battery, EV and pool trajectories, resolved model/curve/intent versions, meter watermark, forecasts, equipment coupling, current requests, pending operations and outstanding physical obligations. Independently validate the final household, not the auction intermediate. Room utility and shared-equipment feasibility must first exist in the scorer.
2. **Enumerate executable joint templates.** Always consider the unchanged request when still valid. Add supported EV current steps, battery operations/envelopes, thermal run/permission/setpoint choices, shared-compressor modes and explicit linked sacrifice/release bundles. Include worthwhile grid-supported and zero-nominal choices. A linked bundle is one atomic economic choice with a feasible staged transition, not simultaneous independent commands. Bound templates, branches, anchors, solver effort, wire size and HA evaluation work by versioned engineering limits.
3. **Choose finite applicability anchors.** Cover remaining-segment time, relevant state/curve knees, presence, actual net load and correlated PV deviations, including overproduction. Name the axes and supported cells; avoid the Cartesian product of unrelated dimensions. Select and validate a common feasible reference alternative for each cell (including presence-changed cells); record its identity and solve it with the same effort convention as competitors. New observations or intents outside declared coverage require replanning, not extrapolation. Candidate selection must not silently discard every viable grid-supported choice.
4. **Force the first block.** For each template/anchor, simulate the remaining segment from reconciled state, including uncertain intermediate draw/supply, real current steps, native response and shared-equipment exclusion. Carry native observed availability, uncertain physical effects and service/accounting state across the segment end; add no commissioned minimum-on/off or hard run-duration commitment. Reject illegal commands, equipment/interlock violations and unsupported transitions independently of economics. A violated exogenous grid state is handled separately: retain explicitly commissioned partial-relief actions even when uncontrolled demand makes full household feasibility impossible. These actions do not claim a feasible economic suffix or invent relaxed equipment limits; the runtime relief contract below owns their selection.
5. **Reoptimise the suffix jointly.** Starting from that resulting household state, repair/reschedule all affected future actions using the same objective and constraints. Recovery may move between stores, devices and times. Use the reference as a warm start, with deterministic effort limits and a defined feasible-candidate status. Apply comparable search effort to the reference and alternative; solver noise is not a service valuation. Exhausted search is not proof of infeasibility. Explicit forecast scenarios, if used, share decisions until information diverges.
6. **Split and compress.** Compute `J`, `L` and `F` above; retain their component reconciliation. Compile bounded conditional bands for both expected remaining-segment cost `C` and future delta `F` over named cells, with shared scenario/model/intent/reference identity and component reconciliation. `C` must retain subquarter import/export, clipping, gross throughput, service and transition effects rather than reconstruct them from net quarter power. Keep nonseparable linked alternatives joint. Interpolation may approximate economics only inside verified coverage; it never proves hard feasibility. Publish approximation/error evidence and a coverage status, not arbitrary executable expressions.
7. **Validate held-out states.** Compare compiled rankings/costs with fresh joint counterfactual solves, including coupled recovery and discontinuities at starts, departures and presence changes. Held-out error measures tested states only; it is not a mathematical bound throughout an interpolated region. Any claimed regional bound requires separate structural/mathematical evidence. Publish empirical versus certified status explicitly and gate accepted approximation quality accordingly. Refine within the fixed compilation limit; otherwise narrow/reject unsupported coverage and report why. Report omitted alternatives separately from economically declined and infeasible alternatives.
8. **Publish or reject atomically.** The reader validates identity, limits, supported conditions, all branches, cost ownership and physical envelopes before acceptance. The policy names its absolute validity and watermark. Plan replacement reconciles actual energy/obligations since that watermark without resetting anything.

No fixed numeric catalogue size or solver runtime is claimed yet. A bounded heuristic suffix solve produces a declared approximation, not a globally exact value function. Counterexamples where an omitted/rescheduled action reverses the ranking, persistent approximation error, or unacceptable compilation/runtime cost require revisiting the representation before release.

## Runtime selection and stability

Filter discretionary economic net-surplus evidence with a time-based low-pass estimate and explicit uncertainty; initialise from valid observations, not synthetic zero. Use raw fresh grid/phase/plant observations and conservative pending-operation bounds for immediate feasibility and metering. A smoothed solar estimate is not evidence that its watts still exist. Actual grid/battery supply must cover the instantaneous balance before economic smoothing can justify bridging a cloud.

Evaluate all applicable joint alternatives, including unchanged operation and buying more grid energy. Change only when the improvement exceeds the declared numerical/uncertainty deadband; switching costs are already included once. Stable tie-breaking prefers current operation, then a stable alternative identity. Require sustained economic advantage for discretionary additions/restoration and allow rapid reductions when a real constraint requires them. Supported physical transitions and native interlocks apply. There are no SHS minimum-on/off settings, commissioned run-duration promises or elapsed-time stop prohibitions. Native equipment may decline a request; account for what it actually does. Heat-pump start cost is a soft economic term; home and EV batteries retain no start/stop penalty.

Filter constants, deadbands, restoration cadence and replan thresholds are versioned engineering calibration, not extra household priority knobs. Room temperature/curve changes alter value without allocating a new fixed energy budget. An intent revision invalidates old curve-dependent future values; only a declared and verified revaluation fast path may use them immediately. Otherwise preserve still-valid physical operation while the new intent is pending and request a matching policy. Do not combine a new room curve with an old incompatible tail valuation. Detailed user API/entity semantics are deferred.

If uncontrolled demand makes every normal joint alternative violate a grid/phase
limit, use a bounded commissioned relief set: legally executable reductions or
available supply that improve the violated balance without worsening another
protected constraint during their transition. Prefer timely effective relief;
among equivalent relief use supported service-loss economics. This is physical
limit handling, not household shortage tiers. A 4 kW EV reduction remains useful
against an 8 kW excess even when it cannot remove the whole violation. Retain
real equipment/source legality, uncertain-effect reservations and conditional
release rules, and report the remaining unavoidable violation. The relief set
must be declared and validated; absence of a feasible economic cell does not
authorise arbitrary commands or extrapolated future values.

## Battery headroom for intermittent PV

Spare battery capacity has economic value when it can capture short PV peaks that otherwise export cheaply or are curtailed. Phil's summer experience establishes this as a required scenario. A high daily forecast (for example 60 kWh+) plus high SOC is context, not a hard trigger, guaranteed remaining yield or a fixed SOC target.

Compare maintaining the present inventory with deliberately using stored energy earlier for real household demand, advancing worthwhile flexible service, or separately authorised export when the **complete** economics justify it. Creating room takes time and depends on executable routing, discharge rate and useful demand/export permission. Moving a load does not necessarily discharge the battery when PV already supplies it; simulate actual source routing. Never add a dump load merely to satisfy a headroom target. Low immediate export revenue alone neither proves nor disproves a drawdown: its later capture value may change the full result.

Use representative correlated subquarter net-load/PV paths inside bounded planning evaluation. Simulate gross charge/discharge, SOC, charge/discharge/inverter rates, native response, clipping/export and losses, then jointly repair the longer future trajectory. Compare the same information and service intent with and without proactive capacity creation. Common decisions before a forecast branch becomes known must be identical. Average quarter energy cannot distinguish a smooth day from 8 kW/1 kW fluctuations with different clipping, throughput and SOC paths.

Some buffering benefits occur entirely within the remaining quarter even when alternatives end at identical SOC. Those benefits belong in expected segment cost `C`, not the future-only delta `F`; instantaneous or net-average current costing would lose them. Keep the bounded first-segment response model in the policy and meter actual realised flows separately.

Headroom value is the difference in that same total objective: changed current use/export plus future retained energy/purchases, minus losses/wear and future deficit risk. Do not add a second headroom bonus on top of savings already represented in `J`/`F`. If a reduced statistical representation is used, its temporal correlation, issue time, coverage and measured approximation error must be explicit. No validated fluctuation model or profitable fixed drawdown amount is claimed yet.

The fast peak/trough response belongs to the inverter's native regulation. A supported buffering alternative must allow both charging and house supply as appropriate, with separate non-negative ceilings and appropriate source/export permissions. A charge-only or discharge-only envelope can defeat buffering; do not repeatedly change EMS mode for each cloud. Filtered evidence guides slower economic changes in other devices, while raw electrical/state feedback and physical limits remain authoritative. Rated capabilities are installation inputs, not universal constants.

## EV desired schedule, execution and future notifications

Keep one EV intent and distinct projections; do not create a separate wish-list optimiser:

- **Desired conditional schedule:** charging opportunities and projected service assuming the car is connected for them. Generate it regardless of current cable state or current location. Explicit dated arrival/absence/departure intent may shape opportunities; a present away reading alone must not silently impose an absence schedule.
- **Executable branch:** current cable, valid charger/state observations, authority, equipment limits and unresolved operations determine what may actually run. A known-away location is not an additional veto when a trusted home charger is connected. Disconnected/unknown cable never creates a start command or fictitious energy; any needed stop/permission adjustment follows the same mode-authorised adapter contract.
- **Achieved service:** reconciled actual energy/SOC with quality and uncertainty. Projected SOC in the desired schedule is explicitly conditional, not a report that an unplugged car has charged.

Unplugged but planned EV charging is one example of how future notifications could work: the system could prompt the user to plug in the car, potentially using known location as context. **The notification framework is out of scope here. Its full specification must be developed later**, including triggers, timing, location handling, delivery channels, configuration, deduplication, persistence and retries. This example defines no notification implementation or acceptance requirement.

Current backend v22 already schedules unplugged EVs, and HA gates actual starts on cable state. Current projected SOC assumes the planned charging occurs. Explicit conditional-service labelling remains contract work; optional location and notification behaviour belong to the later notification specification. The current materially executable reference cell must remain feasible even when the desired conditional schedule includes charging; excluding an impossible **command** must not delete the desired **schedule**.

## Types and module ownership

These are proposed shapes, not a new wire schema:

```text
PolicyIdentity = (home, plan, policy, intent_revision, models, actuals_watermark)
Policy = (identity, valid_from, valid_until, segments, commissioned_relief_set, supported_limits)
Segment = (absolute_interval, alternatives, applicability_cells, cost_convention)
ApplicabilityCell = (conditions, feasible_reference_id, supported_alternative_ids)
JointAlternative = (id, executable_group_requests, conditions,
                    expected_segment_cost_model, conditional_future_delta, error_evidence, release_bundle)
Protection = Unconditional(bound, provenance, enforcement_scope)
           | Conditional(service_id, reservation_id, authorised_release_alternative)
Observation = Fresh(value, observed_at, meter_epoch)
            | Bounded(last_valid, observed_at, lower, upper, reason)
            | Unusable(reason)
Decision = (effective_requests, reservations, reasons, next_deadline, replan_need)
Transition = (group, generation, issued_steps, possible_physical_effects,
              confirmation_requirements, deadline, quiescence_evidence)
Checkpoint = (accepted_policy, intent_revision, mapping_revision, ledger,
              reservations, transitions, operating_modes, retry_state,
              absolute_deadlines, meter_epochs)
```

| Module | Responsibility and hidden detail |
|---|---|
| Backend household scorer | One objective and physical validator over final whole-home trajectories; hides device dynamics and shared-resource simulation |
| Backend policy compiler | Bounded counterfactual solves, cost splitting, conditional representation and coverage evidence |
| HA policy compiler | Structural/semantic acceptance and indexed immutable runtime policy; no device I/O |
| HA observation store | Values, provenance, age, epochs and conservative uncertainty; no invented defaults |
| HA home runtime and pure decision function | One synchronous event-loop reducer owns SHS shared state and short commits; no global action mutex; Controlling owns supported device control authority |
| HA actuator group adapter | Private asynchronous command sequence, physical progress and quiescence evidence; cannot allocate household power or invent service value |
| HA persistence | Asynchronous durable ordered journal; command dispatch waits for its required acknowledgement without blocking the reducer |

The first supported condition vocabulary is closed: absolute interval membership;
named store-state/temperature and remaining-segment-time ranges; net uncontrolled
load, PV and current import/export-price ranges; equipment presence/availability;
source quality/age requirements; explicit operation/source/destination permissions;
and named shared-group/native-availability/reservation state. Conditions are a bounded conjunction
per applicability cell; bounded separate cells express alternatives. Entity names
cannot introduce arbitrary metrics or code. Versions must declare units, missing-data
semantics and maximum cells/axes, and reject unknown condition tags at acceptance.

A value band is a finite set of anchor vertices and a declared interpolation rule
for a named cell, with labelled empirical error evidence, any separately certified regional bound, and supported joint alternative IDs.
The complete joint expected segment cost and joint future delta retain their
respective coupling; independent device sums must not erase it. Both name the
same condition/scenario conventions, with no arbitrary runtime expressions. Conservative physical validation still runs for the actual
frame, regardless of the band's economic fit. Named pending-operation states are
usable only with bounded possible effects; otherwise the affected scope is outside
coverage. Adding a new condition or representation requires explicit version support.

One actuator group covers physically coupled levers such as the battery's mode and two ceilings, or the shared heat pump. Group tasks post immutable results; the home runtime alone reconciles SHS shared state. Other automations/users can still write HA entities, but their changes are overwritable drift while SHS is Controlling. [Reconciliation](control-reconciliation.md) defines mode-owned authority, command outcomes, automatic retries and release; unexpected values do not withdraw control. Planning/Verification proposals never contribute fictitious physical delivery or released headroom to the live decision. The mixed-mode policy contract remains to be specified. Acceptance compiles the horizon once; an ordinary event reads the active segment and changed dependencies. No mutable shared `device/options/slot/shadow` context is passed between parallel tasks.

## Tradeoffs, evidence and first implementation slice

The design prioritises predictable HA work and correct ownership over complete action-space coverage. It accepts measured approximation and declared omissions, but not frozen-tail mispricing disguised as exact value. The economic segment is a quarter for alignment with existing contracts; native physical effects and future costs cross it without creating minimum-runtime promises. More segments or a different value-function representation require evidence, not ad hoc runtime exceptions.

First build an offline final-household scorer and bounded compiler. The 14 September implementation scope defers [thermal modelling as a significant workstream](models-and-forecasts.md#deferred-thermal-modelling-workstream). Step 3 starts with battery alternatives and battery suffix reoptimisation against explicit PV and aggregate non-battery load forecasts. Demonstrate grid-supported battery recovery and a case where fixed-tail rescoring chooses the wrong battery action; retain current/future cost reconciliation, deterministic search limits and explicit coverage. A captured electrical accounting pass is not a resolved compiler input or a whole-household optimisation proof.

Curve-valued room/EV tradeoffs and sunny-today/cloudy-tomorrow pool storage remain requirements for their later supported scope. The initial battery slice does not claim joint thermal recovery. Validate the pure HA reducer and restart journal against event/transition traces before implementing a versioned provider/consumer contract or enabling hardware. Required gates remain in [verification](verification-and-delivery.md#intent-and-reactive-execution-acceptance), applied to the device scope being enabled.
