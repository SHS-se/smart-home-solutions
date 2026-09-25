# Contracts and data

## Required participation and supply contract — 15 September 2026

Use separately owned HA inclusion, website planning and HA requested/effective authority, resolved into one acknowledged revision-bound scope. Stop excluded-device telemetry and descriptive inventory; aggregate demand remains. The next versioned battery contract carries explicit house-supply selector and solar attribution, distinct from forecast watts, physical limits and economic alternatives. Bind these identities at acceptance and before dispatch; do not reinterpret schema-2 commands or add compatibility fallbacks.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Reactive integration controls](reactive-controls.md)

Status: current contract requirements, reconciled 2026-09-13. The machine-readable contract under `contracts/ha-api` and its supported runtime versions determine the wire format. This prose does not deploy a schema change.

## Ownership and identity

The integration is a device client of the SHS backend; the portal is a separate authenticated client. Planning must work without the website open. The device token binds to one home, and the backend authorises every operation against that binding. A client-supplied identifier alone never grants access to another home.

The backend stores canonical versioned household intent, tariff assignment, inventory roles and model/policy versions. The portal is an intent client; future HA user controls must address the same intent/revision rather than create a second preference or command owner. Detailed user API/entity design is deferred. HA owns local entity bindings, live state, measurements, and execution. Reporting category does not imply controllability: a device enters control only through an explicit reviewed role and working mapping. Control routes use stable home/device/area identities, not display names or a category-to-actuator assumption.

Changing configuration uses validated integration actions or supported UI. HA storage files are not a commissioning interface. Inventory reconciliation distinguishes removal, renaming, temporary unavailability, and explicit withdrawal from service.

## Snapshot and measurement rules

- UTC ISO timestamps; half-open intervals; canonical 900-second slots. Local dates and DST affect schedules, never continuity of the UTC grid. Local-day row counts can be 92, 96, or 100.
- Watts, explicitly named Wh/kWh, Celsius, SOC fractions, and SEK/kWh. Separate non-negative import/export and charge/discharge fields avoid ambiguous signs.
- Arrays are sorted, unique, contiguous, and aligned over their stated coverage. Each source identifies observation/issue time, validity, quality, and units.
- A snapshot contains the resolved installation, policy, live state, complete required forecasts, service already delivered, overrides, and preceding execution deviations.
- Electrical limits, entity bindings, location, and installed hardware are commissioned facts. Visible versioned policy defaults and explicitly described empirical models are different from missing measurements.
- Optional capabilities are independent, but a configured unavailable store is not indistinguishable from a home that never had it. Disabled devices produce no optimisation request.
- A control excluded from optimisation remains part of uncontrollable load where appropriate; its watts must not disappear from the balance.
- Current and voltage assumptions travel with the EV model. Phase count, per-phase voltage, efficiency, and supported current increments are explicit values, not universal three-phase/230 V/92% invariants.
- Expected power and requested authority are different fields. In particular, a boiler permission can be true with zero expected draw.
- Realistic measured state beyond a target is valid input: a car above its charge limit, a pool past its stop temperature or a pack below a raised cut-off is planned as it is. A reading no device can produce leaves out only its device. HA leaves out a device whose reading is unavailable, non-numeric or impossible and names it in the snapshot's `measurement_issues`; the planner adds its own findings and publishes the complete list on the plan ([measured state](authoritative-plan-contract.md#measured-state-and-impossible-readings)).

Outdoor temperature and irradiance may use the already documented server adapters when the integration lacks coverage; provenance must identify that source. Those explicit modelling paths do not authorise arbitrary substitutions for missing installation or live control facts. A legacy compatibility reader, if still supported by a declared version, is historical transport support rather than a new canonical alias.

## Plan lifecycle and time

Keep these concepts distinct:

| Concept | Meaning |
|---|---|
| Forecast horizon | The period projected by the solver, normally 72 hours |
| Published-price boundary | End of exact published tariff/market inputs; later prices are modelled |
| Execution validity/lease | The period for which an accepted plan may issue requests locally |
| Replan cadence | When a fresh snapshot and plan are requested |

Current cadence: HA exchanges measurements and a fresh snapshot every 15 minutes, but the server solves only when that snapshot carries a new published price release or answers an outstanding manual request. Elapsed quarters shorten the accepted plan; other triggers become shared replan recommendations. Verification/Controlling changes request nothing, and a plan or battery reference captured under either mode is accepted under the other ([authoritative plan contract](authoritative-plan-contract.md)).

Current generated `valid_until` is the end of the last returned slot, normally up to the 72-hour horizon. HA may execute accepted later slots until that explicit expiry, subject to live guards. `binding_until` marks published-price coverage; it does not curtail that authority. A missing backend, pending replacement or routine restart does not reset/extend validity. The replacement policy retains explicit absolute validity and additionally bounds its applicability to actual state and observations. See [current recovery](ha-runtime-recovery.md) and [target continuation](reactive-controls.md#expiry-and-baseline-handover).

Lifecycle:

1. Integration submits snapshot/schema support with request identity.
2. Backend authenticates, validates, resolves model inputs, generates and stores a plan.
3. Integration validates the exact generated document structurally and semantically.
4. Integration acknowledges acceptance or rejection for that plan/snapshot identity.
5. Only a locally accepted, currently valid plan may drive requests; generation alone is not execution evidence.

A household may ask for a replan from the portal. The request is recorded against the home and answered on the lifecycle above: the integration is told which request is outstanding, supplies a snapshot naming it, and the backend marks the request answered by the plan that snapshot produced. The portal may not rebuild a plan from a stored snapshot instead — a snapshot is only as fresh as the last push, so that route fails the planner's freshness rule for most of every replan interval. A request is also satisfied by any plan built from measurements captured after it was made, which is what settles requests for homes whose integration predates this exchange. An integration that cannot build a snapshot reports why, so the portal states a reason rather than an unbounded wait.

The portal distinguishes no request, generation failure, awaiting acknowledgement, rejection, accepted validity, and expiry. It must not describe the latest generated plan as the currently executed plan without acceptance evidence. A rejected new plan does not retroactively change what happened under the old one.

Plan requests are idempotent for their home and snapshot identity. Inventory, telemetry watermarks, planning, and acknowledgements have independent retry/ownership semantics even if a legacy route multiplexes them. A planning failure must not discard accepted telemetry or accidentally repeat a configuration mutation.

## Versioning and validation

The normative API definition is one versioned OpenAPI/JSON Schema source. Generate structural types/readers where supported; keep semantic checks explicit for energy balance, state transitions, aligned increments, contiguous slots, expiry, and equal comparison inputs. Independent hand-written structural schemas are not substitutes for provider–consumer tests.

Version axes are separate: API envelope, snapshot schema, executable plan schema, and model/algorithm. Requests advertise accepted plan versions. Changed execution meaning requires a plan schema change even when JSON shape remains similar. Algorithm changes that can affect a result increment model identity even when prices are unchanged. Diagnostic additions must not masquerade as execution-semantic changes.

Record enough implementation identity for replay, including code/build identity where historical model labels were reused. This specification does not retroactively make those reused labels unique.

Unsupported versions produce a structured upgrade response, not an unreadable plan. Errors carry stable code, message, field path where appropriate, structured details, retryability, and correlation identity. Proxy/transport failures are distinct from model validation errors.

Validation describes different outcomes without pretending they are equivalent:

| Outcome | Meaning |
|---|---|
| Missing/stale/invalid input | A required problem input cannot be trusted |
| Infeasible problem | Stated constraints have no common solution, with supporting evidence |
| Search limit/failure | The search did not establish a sufficient answer |
| Invalid output | A returned candidate violates a required invariant |
| Feasible candidate | Valid schedule, with the known solution-quality status |

Independent safety validation may catch a constraint omitted from the optimiser; that is a model/output defect, not grounds to delete the constraint. Legacy wire statuses may be coarser until a versioned change; diagnostics must not falsely claim proof of infeasibility.

## Price provenance and archival data

A writer identifier (`snapshot`, integration, portal backfill) is not sufficient provenance. Distinguish published observations, forecasts as issued, assumed commercial terms, and later corrections. Predictive price training may consume published observations available at decision time; it must not train on its own modelled tail as if measured.

The current overwriteable price table serves priced history. An immutable as-issued forecast archive serves replay. They answer different questions. A later corrected price cannot reconstruct an earlier forecast.

Similarly, the latest snapshot/plan row is operational state, not a historical audit archive. Compact run summaries do not reconstruct every past decision. An exact replay capsule includes resolved inputs, effective policy/curves, the exact price outlook, generation clock, implementation identity, and output. Execution audit additionally needs command, confirmation, override, and deviation events.

Historical storage durations are evidence about versions, not one current retention guarantee. Longer retention does not recover previously pruned or never-collected data. Retention, privacy/deletion, replay coverage, and multi-home legacy billing scope remain the product decision in [D7](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d7-retention-audit-and-savings-claims).

## Release gate

For every supported schema, the actual provider emits success and non-success fixtures, the real Python reader consumes those exact documents, and the portal interprets the same lifecycle states. Cover active/zero EV charge, supported current steps, pool dispatch, boiler permission, room heat, battery charge/discharge, stale sources, expiry, and rejection.

Mutation cases test wrong units, bounds, enums, missing fields, and semantic violations. Hand-built consumer fixtures alone are insufficient. Reader-first rollout and a declared compatibility window follow the existing contract design; this documentation split introduces no new compatibility mechanism.

## Planned intent and envelope extension

The [economic policy](controller-policy.md) defines the replacement representation and cost convention; [reactive control](reactive-controls.md) defines runtime authority and continuation. Forecasts are separate from executable ceilings, physical state constraints and source/destination permissions. There are no fixed per-slot grid energy budgets: worthwhile extra grid energy remains an option under real limits. Accounting intervals measure actual use and never award a fresh allowance after replacement or restart.

The wire carries explicit conditional EV planning assumptions separately from executable eligibility and achieved service, plus home/plan/policy/intent/model identity, actuals watermark, absolute segment and validity times, bounded supported conditions and value bands, executable joint alternatives, named couplings, matched expected remaining-segment cost and future-delta models, cost ownership, approximation/coverage status and conditional release bundles. Distinguish unconditional protection from a conditional service reservation. Include valuable zero-nominal and grid-supported alternatives. Unsupported conditions or out-of-range values cannot be extrapolated. Auction diagnostics do not grant authority.

Accept and compile once, with supported action-space/size limits and semantic validation. Reconcile metered actuals, pending operations and outstanding obligations from the source watermark before adoption; replacement never erases consumption or a possible late command. Same effective request means no gratuitous actuation. Intent changes must match policy economics or use an explicitly validated revaluation path; otherwise the new intent is pending while still-supported execution continues.

Durable continuation preserves the accepted policy, intent/mapping revisions, ledger, meter epochs, reservations, absolute deadlines, issued operations, operating modes, pending release and bounded retry state. Unknown intervals are bounded or declared unusable, never zero-filled. Dependency-scoped source expiry and recovery are explicit. Routine restart differs from disable/removal or actual authority loss; no lease reset, retry reset or default device initialisation is permitted by the target. No minimum-on/off commissioning fields or SHS run-duration commitments belong in the replacement contract.

This is future contract work. Current schema-8 `battery_command` ceilings remain binding, including forecast-derived non-baseline ceilings. Changing these semantics requires coordinated versioning, generated provider fixtures, real reader validation and [acceptance gates](verification-and-delivery.md#intent-and-reactive-execution-acceptance). This documentation changes no output, runtime permission, deployment or compatibility behaviour.

## External writers and deferred notifications

[Control reconciliation](control-reconciliation.md) owns the target transport/physical-outcome protocol, asynchronous durable journal boundary, mode authority and automatic retry semantics. Controlling grants SHS complete operational authority over supported controls; external deviations may be overwritten without a hold or explicit resume. Persist prepared versus issued versus ambiguous operations, mode revisions, observed control revisions and possible effects; a context ID is evidence, not a distributed lock or universal idempotency key. Mode exit fences optimisation writes without erasing issued effects or approved release obligations. Verification requests are logged, never sent, and never count as measured delivery. The schedule itself is the same in every mode; shared-equipment mode semantics remain specification work.

[EV desired schedule and execution](controller-policy.md#ev-desired-schedule-execution-and-future-notifications) distinguishes conditional service from current executable charging. Desired charging is not suppressed just because it cannot currently execute. An unplugged car with planned charging is an example of a future notification use case. The notification framework is out of scope: triggers, optional location, channels, routing, configuration, identity, persistence and delivery behaviour need a full specification later and are not current wire/runtime requirements.
