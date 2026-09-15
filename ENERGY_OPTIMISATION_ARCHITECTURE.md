# Energy optimisation architecture

## Latest agreed ownership and battery scope — 15 September 2026

The canonical participation/supply decision supersedes conflicting older terminology: HA owns Included/Excluded and Verification/Controlling; the website owns Monitoring/Planned. Explicit battery house-supply scope is an agreed requirement, evaluated against actual eligible demand and the existing future-cost policy. The companion below links the canonical specification; older prototype and deployment records remain dated evidence.

See the [agreed participation and battery supply specification](docs/energy-optimisation/device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Updated: 2026-09-06. This is the entry point for the split architecture.

The server plans the horizon; the Home Assistant integration coordinates and confirms local execution. The portal configures the system and explains its evidence.

## Current specifications

| Document | Responsibility |
|---|---|
| [Server planner](docs/energy-optimisation/planner.md) | Joint scheduling, objective, storage value, uncertainty, power costs, and solver claims |
| [Reactive controls in the integration](docs/energy-optimisation/reactive-controls.md) | Local surplus allocation, unexpected loads, shedding, restoration, overrides, executors, and baseline handover |
| [Contracts and data](docs/energy-optimisation/contracts-and-data.md) | Ownership, snapshots, API versions, plan acceptance/expiry, provenance, and data boundaries |
| [Device models and forecasts](docs/energy-optimisation/models-and-forecasts.md) | Electrical/thermal models, battery/EV, pool/shared heat pump, commissioning, and forecast evidence |
| [Portal and reporting](docs/energy-optimisation/portal-and-reporting.md) | Plan views, exact replay versus preference experiments, monetary comparisons, and historical reporting |
| [Verification and delivery](docs/energy-optimisation/verification-and-delivery.md) | Scenarios, contract/model/replay/commissioning evidence, engineering backlog, and release gates |

[Decisions requiring Phil's attention](ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md) contains only unresolved product or commissioning choices. [Reconciliation record](docs/energy-optimisation/reconciliation.md) records how the original review findings were corrected or narrowed.

## Authority and status

The topic documents above define the reconciled design. They distinguish requirements from implementation evidence; this split changes documentation only. Where a decision is open, the linked review identifies it explicitly. Do not infer a settled default from an older experiment.

The original document mixed current requirements with dated observations. Its complete contents, including the 6 September additions, are preserved in the [historical record](docs/energy-optimisation/history/README.md). History is evidence, not a competing specification. Statements such as “implemented”, “next”, shipped coefficients, and model versions describe their entry's date. The current topic documents take precedence over contradictory historical prose. Machine-readable contracts govern supported wire formats; changes to their meaning still require the contract release process.

The current backend is a custom TypeScript heuristic with known search and model limitations. A numerical solver replacement is a direction to evaluate, not work completed by this split. Integration-owned reactive coordination and device execution require their own implementation and commissioning. An accepted plan is not proof that a physical device executed it.

## Responsibility map

| Layer | Owns | Boundary |
|---|---|---|
| SHS backend | Resolved problem, forecasts/models, joint schedule, policy versions, diagnostics, replay | No direct actuator calls; no requirement for an open browser |
| `shs_energy` integration | HA bindings/state, validation/cache, local allocator, effective requests, deviations and acknowledgements | Reacts within authorised policy; does not invent a replacement horizon schedule |
| Local executors | Device-specific commands, thermostat/interlocks, manual precedence, physical confirmation, baseline handover | One command owner per actuator; physical protection remains authoritative |
| Portal | Household intent, commissioning/evidence surfaces, comparisons | Forecast, accepted plan, and measured execution remain distinct |

The reactive allocator and target product executors belong in `shs-ha-integration`. Existing Node-RED controllers may serve as commissioned prototype executors behind the same contract, but are not a required product runtime.

## Shared terms

- **Plan:** a versioned trajectory based on resolved inputs and measured initial state.
- **Published-price boundary:** end of known price inputs; it does not alone grant execution authority.
- **Execution validity:** the lease within which an accepted plan may produce local requests.
- **Hard constraint:** a physical, safety, equipment, or explicitly guaranteed service condition in the feasible problem. Incompatible constraints are reported, not hidden by a penalty.
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
