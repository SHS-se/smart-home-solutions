# Energy optimisation architecture

## Rule-based planner objective — 6–7 October 2026

The [planner score-card redesign](docs/energy-optimisation/planner-scorecard-redesign-2026-10.md)
replaces the planner objective in the documents below. The planner is now a
measurement-driven, rule-based planner in Rust/Wasm (`planner-core/`). It
maximises the planner-bench score card (`planner-core/policy.json`,
`supabase/functions/_shared/planner-wasm/rule-policy.ts`) and uses kronor only
to break ties. Editable cost-value curves and their UI, marginal-value bidding,
the auction and settlement passes, and the “Build a plan” editor are removed.
This supersedes the curve-valued objective in the
[server planner](docs/energy-optimisation/planner.md) and the 13 September
adoption of editable service curves under “Authority and status” below. See the
[rule-builder design](docs/energy-optimisation/rule-builder-design-2026-10.md),
[rule-builder checkpoint](docs/energy-optimisation/rule-builder-checkpoint-2026-10.md),
[Rust/Wasm checkpoint](docs/energy-optimisation/planner-wasm-checkpoint-2026-10.md)
and [TEST live rules planner](docs/energy-optimisation/test-live-rules-planner-2026-10-08.md).
Dev/TEST runs the rules planner; production `main` keeps the earlier planner
until dev is promoted.

## Replacement controller authority — 17 September 2026

[Plan execution and deviation accounting](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/controller-plan-execution.md)
is the canonical replacement controller specification (local companion checkout:
`../shs-ha-integration/docs/controller-plan-execution.md`). It supersedes the
controller-policy and reactive-control decision model linked below, including
independent current/future economic ranking and conditional bids. The planner
owns strategy and recovery opportunities; HA executes, measures, accounts for
debt/credit and requests replanning. A complete rewrite is permitted; existing
implementation structure and wire contracts are not requirements to preserve.

Planner objectives, participation/supply permissions, real equipment limits and
reliable actuation remain required. Earlier specifications below are subordinate
where they conflict. This is a documentation decision, not a rollout claim.

## Latest agreed ownership and battery scope — 15 September 2026

The canonical participation/supply decision supersedes conflicting older terminology: HA owns Included/Excluded and Verification/Controlling; the website owns Monitoring/Planned. Explicit battery house-supply scope is an agreed requirement, evaluated against actual eligible demand and the existing future-cost policy. The companion below links the canonical specification; older prototype and deployment records remain dated evidence.

See the [agreed participation and battery supply specification](docs/energy-optimisation/device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Implementation review, 14 September 2026: the [14 September architecture review and battery release gates](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/controller-architecture-review.md)
records completed scorer/compiler/coverage and HA runtime/ledger/binding prototypes,
four reproduced recovery/constraint gaps and a proposed battery-first mixed-mode
contract. None of those offline stages connects the new controller to hardware.
Thermal modelling, direct user controls and notifications are deferred; mixed modes
and the battery deployment gates remain required work.

Updated: 2026-09-13. This is the entry point for the split architecture.

The server plans the longer horizon and delegates an executable policy to Home Assistant. One integration-owned controller applies that policy over the short operating horizon using live conditions, conditional bids and shared accounting. The portal configures the system and explains its evidence.

## Current specifications

| Document | Responsibility |
|---|---|
| [Authoritative plan and truthful interfaces](docs/energy-optimisation/authoritative-plan-contract.md) | Current: one selected plan for both UIs and execution in every mode, price-release rebids, replan recommendations, measured state and impossible readings |
| [Plan execution and deviation accounting](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/controller-plan-execution.md) | Current replacement: planner authority, measured debt/credit, authorised recovery, plan handover and acceptance evidence |
| [Earlier executable economic policy](docs/energy-optimisation/controller-policy.md) | Superseded controller decision design retained for rationale and historical evidence |
| [Planner score-card redesign](docs/energy-optimisation/planner-scorecard-redesign-2026-10.md) | Current planner objective: rule-based Rust/Wasm planner that maximises the planner-bench score card, with kronor as a tie-break |
| [Earlier server planner](docs/energy-optimisation/planner.md) | Superseded cost-less-service-value objective, curves, bidding and solver claims; physical limits and control boundary apply where consistent with the redesign |
| [Shared entities and reconciliation](docs/energy-optimisation/control-reconciliation.md) | Mode-owned control authority, external drift, transport/physical outcomes, automatic retry/reconciliation, handover and durable operation journal |
| [Earlier unified control design](docs/energy-optimisation/reactive-controls.md) | Historical economic decision model; execution/authority requirements apply only where consistent with the replacement |
| [Contracts and data](docs/energy-optimisation/contracts-and-data.md) | Ownership, snapshots, API versions, plan acceptance/expiry, provenance, and data boundaries |
| [Device models and forecasts](docs/energy-optimisation/models-and-forecasts.md) | Electrical/thermal models, battery/EV, pool/shared heat pump, commissioning, and forecast evidence |
| [Portal and reporting](docs/energy-optimisation/portal-and-reporting.md) | Plan views, exact replay versus preference experiments, monetary comparisons, and historical reporting |
| [Verification and delivery](docs/energy-optimisation/verification-and-delivery.md) | Scenarios, contract/model/replay/commissioning evidence, engineering backlog, and release gates |

The [decision register](ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md) records settled 13 September directions separately from remaining commissioning and unrelated product choices. [Reconciliation record](docs/energy-optimisation/reconciliation.md) records how the original review findings were corrected or narrowed.

## Installation references

[Phil's house](docs/energy-optimisation/reference-installations/phils-house.md)
records the owner-supplied Nibe/pool/two-stage hot-water arrangement, native
service-period settings, HA helpers and related equipment references. Build the
general model first, then map this installation into it. These house-specific
facts are not catalog defaults or general controller requirements.

## Authority and status

The topic documents above define the reconciled design. The 13 September revision adopts editable service curves, economically available grid supply without slot energy entitlements, joint counterfactual future rescheduling, and durable routine-restart continuation. It supersedes older mandatory service tiers, fixed budgets and restart-baseline target requirements. The later feedback also removes SHS/commissioning minimum runtimes, values battery headroom for intermittent PV, retains conditional EV planning regardless of cable/location, and retains unplugged planned charging as an example for future notifications. The notification framework and its full specification are out of scope until a later discussion. The runtime uses a short event-loop reducer with no global action lock. The latest authority correction gives SHS full control over the supported surface of devices in Controlling mode: external changes are overwritable drift, with automatic reconciliation/reassertion rather than external holds. Leaving Controlling withdraws optimisation authority; detailed mode transitions remain to be specified. Detailed direct-user API/entity design remains deferred. They distinguish requirements from implementation evidence; this split changes documentation only. Where a decision is open, the linked review identifies it explicitly. Do not infer a settled default from an older experiment.

The original document mixed current requirements with dated observations. Its complete contents, including the 6 September additions, are preserved in the [historical record](docs/energy-optimisation/history/README.md). History is evidence, not a competing specification. Statements such as “implemented”, “next”, shipped coefficients, and model versions describe their entry's date. The current topic documents take precedence over contradictory historical prose. Machine-readable contracts govern supported wire formats; changes to their meaning still require the contract release process.

The current backend is a custom TypeScript heuristic with known search and model limitations. A numerical solver replacement is a direction to evaluate, not work completed by this split. Integration-owned reactive coordination and device execution require their own implementation and commissioning. An accepted plan is not proof that a physical device executed it.

## Responsibility map

| Layer | Owns | Boundary |
|---|---|---|
| SHS backend | Resolved problem, forecasts/models, joint schedule, policy versions, diagnostics, replay | No direct actuator calls; no requirement for an open browser |
| `shs_energy` integration | HA bindings/state, validation/cache, local allocator, effective requests, deviations and acknowledgements | Reacts within authorised policy; does not invent a replacement horizon schedule |
| Local executors | Device-specific commands, thermostat/interlocks, mode-owned authority, physical confirmation, baseline handover | One SHS sequence per physical group; external drift is corrected while Controlling; physical protection stays authoritative |
| Portal and future HA intent surface | Versioned household intent, commissioning/evidence surfaces, comparisons | Forecast, accepted plan, and measured execution remain distinct |

The reactive allocator and target product executors belong in `shs-ha-integration`. Existing Node-RED controllers may serve as commissioned prototype executors behind the same contract, but are not a required product runtime.

## Shared terms

- **Plan:** a versioned trajectory based on resolved inputs and measured initial state, with declared conditional assumptions such as EV connection; conditional service is not achieved delivery.
- **Control authority:** Controlling mode authorises SHS to overwrite external changes on the supported device surface. Users change intent through SHS or leave Controlling to operate elsewhere; unexpected values do not create an external hold.
- **Battery headroom:** physical spare capacity whose value comes from the same forecast-dependent objective, not a fixed SOC target.
- **Published-price boundary:** end of known price inputs; it does not alone grant execution authority.
- **Execution validity:** the lease within which an accepted plan may produce local requests.
- **Hard constraint:** a physical, safety or equipment condition, or a genuinely explicit unconditional protection. Ordinary desired warmth/readiness are curve-valued preferences, not implied hard guarantees.
- **Conditional reservation:** capacity tied to a service; only an explicit paired service-loss/release alternative releases it.
- **Routine restart:** bounded suspension followed by journal/state reconciliation and continuation; it does not itself withdraw authority.
- **Soft preference:** a priced trade-off within the authorised physical/service limits.
- **Expected power:** forecast draw; distinct from run, permission, current, or setpoint authority.
- **Reactive control:** local adjustment using actual conditions, confirmations, and constraints.
- **Baseline controller:** the independent local schedule/thermostat policy that resumes when optimisation has no authority.
- **Exact replay:** reproduction from frozen resolved inputs, policy, clock, and implementation identity.
- **Preference experiment:** a new comparison using declared changed settings, not a replay of the old decision.

## Finding an old section reference

Code comments and other documents still refer to original section numbers. Use the [complete legacy section lookup](docs/energy-optimisation/history/README.md#legacy-section-lookup); numbers have not been reassigned to unrelated new text.

| Original subject | Preserved location | Current specification |
|---|---|---|
| §1–§1.2: early integration | [Early integration](docs/energy-optimisation/history/early-integration.md) | Contracts and models |
| §1.3: portal/reporting | [Product history](docs/energy-optimisation/history/portal-and-reporting.md) | Portal and reporting |
| §1.4–§1.6: forecasts/comfort | [Forecast and comfort history](docs/energy-optimisation/history/forecast-and-comfort.md) | Models and forecasts |
| §2–§7: contracts/control | [Contract and control history](docs/energy-optimisation/history/contracts-and-controls.md) | Contracts; reactive controls |
| §8–§8.12: objective | [Objective foundations](docs/energy-optimisation/history/objective-foundations.md) | Server planner |
| §8.13–§8.20: experiments/workbench | [Planner experiments](docs/energy-optimisation/history/planner-experiments.md) | Server planner; portal/reporting |
| §9–§15: models/delivery | [Model and delivery history](docs/energy-optimisation/history/models-and-delivery.md) | Models; verification and delivery |

No runtime, configuration, controller, or deployment changes are implied by this reorganisation.
