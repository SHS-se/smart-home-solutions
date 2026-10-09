# Energy optimisation — decision register

## D10. Rule-based planner objective — 6–7 October 2026

Settled: the [planner score-card redesign](docs/energy-optimisation/planner-scorecard-redesign-2026-10.md) replaces the curve-valued objective. The planner is a measurement-driven, rule-based planner in Rust/Wasm (`planner-core/`) that maximises the planner-bench score card (`planner-core/policy.json`, `supabase/functions/_shared/planner-wasm/rule-policy.ts`), with kronor as a tie-break. Cost-value curves and their UI, marginal-value bidding, auction and settlement passes, and the “Build a plan” editor are removed. This supersedes the editable-curve service decisions in D1 and D2 and the single cost-less-service-value objective in D3, including the [planner](docs/energy-optimisation/planner.md) v24 cap cited there. Physical/equipment protections and the remaining decisions stay in force where consistent.

See the [rule-builder design](docs/energy-optimisation/rule-builder-design-2026-10.md), [rule-builder checkpoint](docs/energy-optimisation/rule-builder-checkpoint-2026-10.md), [Rust/Wasm checkpoint](docs/energy-optimisation/planner-wasm-checkpoint-2026-10.md) and [TEST live rules planner](docs/energy-optimisation/test-live-rules-planner-2026-10-08.md).
Dev/TEST runs the rules planner; production `main` keeps the earlier planner until dev is promoted.

## D9. Participation ownership and explicit battery supply — 15 September 2026

Settled: HA Devices owns Included/Excluded; the website owns Monitoring/Planned; HA Schedule shows only Planned equipment in Verification (default) or Controlling. Exclusion removes future device-specific metadata as well as readings. Grey is gross base consumption, with omitted Planned series kept in Other planned devices. Battery intent explicitly selects None, Whole house, Base, Selected Planned devices, or Base+selected, using measured eligible demand and future-cost ranking. Solar is shared proportionally across gross consumption, with the selected scope receiving its share of self-consumed PV; no automatic max-discharge rule or new fallback is authorized. This supersedes the earlier review treating beneficiary accounting as optional/outside scope.

See the [agreed participation and battery supply specification](docs/energy-optimisation/device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Updated: 2026-09-13. [Architecture](ENERGY_OPTIMISATION_ARCHITECTURE.md) and [executable policy](docs/energy-optimisation/controller-policy.md) incorporate Phil's latest decisions. D1–D6 below supersede the earlier unanswered controller questionnaire. Implementation/evidence work is not a reason to ask the same household preferences again. D7–D8 remain separate product questions, outside this controller discussion.

## D1. Comfort and service promises

**Settled:** ordinary room, pool and EV service uses editable cost/value curves, including priced shortfall. Do not demand black-and-white minimum service guarantees or shortage tiers. Room ranking follows marginal whole-home consequences, not a fixed room priority. Physical/equipment/hygiene protections remain distinct. A conditional service reservation is released only by an explicit alternative pairing the sacrifice with its released resources; otherwise it remains binding.

**Engineering:** add curve-valued room service and explicit temporal utility semantics to the final household scorer. Current painted Comfort targets/bands and summer policy are implementation facts, not the replacement definition. Direct target-edit API and schedule semantics are deferred to the forthcoming user-control discussion.

## D2. EV readiness without a trip and unreachable preferences

**Settled:** everyday readiness and dated requests belong in curves, with graded shortfall. Desired 40% with 39/38 acceptable and 30 much worse is an illustration, not a hard floor or a newly configured value. Preserve desired conditional charging, intent and delivered energy across unplug/reconnect, regardless of current cable/location. Current backend v22 already schedules unplugged EVs. Separate conditional projected SOC from achieved service. Unplugged but planned charging is an example of how notifications could work. The notification framework is out of scope and its full specification must be developed later; no trigger, routing or reminder-lifecycle requirement is selected here. Never silently change the vehicle cap or rescale an unreachable preference.

**Engineering:** preserve conditional scheduling and actual execution eligibility as described in [EV schedule and notification example](docs/energy-optimisation/controller-policy.md#ev-desired-schedule-execution-and-future-notifications); current location must not silently turn into a hard absence window. Evaluate readiness at anchored usage events, not a perpetually advancing 72-hour deadline or a reward in every quarter. A curve alone does not specify when service is used; carry existing schedule/event intent explicitly. Detailed direct requests such as full charge by 08:00 will be discussed later, without creating a second execution owner now.

## D3. Preferences, risk, and battery economics

**Settled:** compare complete economic consequences in one objective; charge current supply, wear and transitions once and future consequences once. Additional grid energy remains an option at its price under real limits. There is no per-slot grid energy entitlement. Deliberately using battery energy earlier can buy headroom for short PV peaks at near-zero export prices. Evaluate correlated subquarter response, losses/wear, useful destination and future deficit risk in the same objective; high SOC and a 60 kWh forecast are context, not hard triggers or a fixed SOC target. Ordinary reserves can be economic; unconditional protections and conditional service reservations have explicit scope. No HA-independent higher battery backup reserve is requested for an unexpected HA outage, and the inverter's read-only cutoff is not changed.

**Engineering:** separate the current parameter named `degradation`'s wear and terminal/risk-cap roles in objective evidence; it must not hide an unexplained second wear charge. The existing heuristic cap is documented as current implementation in [planner](docs/energy-optimisation/planner.md#cost-and-continuity-policy-v24), not a newly calibrated physical law. Curve calibration and uncertainty validation need evidence, not new duplicate household thresholds. The 7 September [investigation](docs/energy-optimisation/battery-valuation-investigation.md) is historical experimental evidence.

## D4. Grid headroom and peak spending

**Settled:** more grid energy is available economically whenever physical capability and authority permit it. Forecast allocations are not hard power/energy caps. Power shaping is a soft explicitly reported cost, separate from actual tariff charges; no new household shaping coefficient is selected here. An 8 kW unknown-load step is likely to need relief; smaller steps need not. Battery mode transitions matter only where the temporary loss of supply would exhaust actual grid/phase headroom.

**Commissioning remaining:** establish applicable connection, phase, inverter and response limits. Any mandatory engineering headroom must have an equipment/response basis; do not disguise a preferred lower import level as a fixed slot budget. Benchmark smoothing and stable allocation under curve changes, cloud bursts and load steps.

## D5. Degraded operation and execution lease

**Settled:** tolerate transient unknown/unavailable entities using honest age/uncertainty and dependency-scoped continuation. Restrict only scopes whose continued operation cannot be supported; missing shared evidence can affect the whole household. Persistent faults remain visible; their notification handling belongs to the deferred notification specification. Routine restarts/reloads preserve accepted plan, intent, actuals, deadlines and uncertain operations, then reconcile live state without default initialisation or gratuitous baseline cycling.

**Current fact:** accepted plans execute locally until their explicit `valid_until` (currently the final returned slot, normally up to 72 hours), subject to local guards. `binding_until` is a published-price boundary, not the execution lease. The former next-quarter-versus-longer-lease question was stale. A pending replan or restart does not extend validity. Current startup handover is implemented; durable actuator continuation is still target work. [Runtime recovery](docs/energy-optimisation/ha-runtime-recovery.md) distinguishes these facts.

**Corrected control-authority policy:** Controlling mode grants SHS complete operational authority over the supported device surface. External writes and unexpected values are overwritable drift, not a reason to suspend control or require explicit resume. Users change intent through SHS or leave Controlling for Monitoring, Planning or Control verification before operating elsewhere. Automatically reconcile/reassert the current request, including bounded adapter-supported retries after ambiguous delivery. Keep physical uncertainty and equipment protection distinct from ownership. The synchronous reducer still serialises only SHS state commits; group operations remain asynchronous with no global action lock. [Reconciliation](docs/energy-optimisation/control-reconciliation.md) replaces the earlier external-hold rule and identifies remaining retry and operating-mode specification work.

**Engineering:** settled 23 September 2026: planning is the same in every mode, and Verification and Controlling change only writer authority ([authoritative plan contract](docs/energy-optimisation/authoritative-plan-contract.md)). Still to define: authority over shared levers, mode entry/release transitions and verification fidelity. Specify bounded automatic retry/recovery per adapter. Bounded suspension, durable checkpoints, meter/clock reconciliation, remote-command quiescence and role-specific source expiry must be validated. No promise of literal continuity through expired authority or unbounded physical uncertainty is made.

## D6. Device control scope and commissioning

**Settled:** battery first; explicit operations and separate non-negative ESS ceilings are already implemented. Normal operation is Maximum Self Consumption; export is Command Discharging (PV First), never ESS First. Schema 3 separates declining to spend stored energy (`hold`, automatic mode, rated charge permission) from deliberately letting surplus reach the grid (`idle`, Standby, both ceilings closed); only the second forgoes surplus capture. The [integration contract](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-control-configuration.md) records current mapping and handover. Future policy/continuation requires a new implementation and versioned contract. Documentation approval does not authorise live commissioning writes.

The [8 September survey](docs/energy-optimisation/reactive-controls.md#surveyed-control-surfaces) established a ground-source Nibe shared compressor, distinct room/hot-water/pool levers, attribution and observable interlocks. Pool temperature-band control is implemented; desired charge power remains unmapped. Large thermal capacity and electrical input rate are separate. Sunny-today/cloudy-tomorrow pool preheat is a primary use case. The current zero marginal value above 32 °C is editable and not a new hard cap.

**Commissioning remaining:** thermal device scope/authority, transition and latest-effect timing, native routing, shared-equipment capacity and outage behaviour. Standby surplus export is answered: 20 September 2026 diagnostics show Standby exporting surplus PV with SOC unchanged, which is why only `idle` uses it. No planner or commissioning minimum-on/off settings or SHS hard runtime commitments. Retire existing generic minimum-runtime fields/locks in the target implementation; native protection and observed availability remain in equipment. Economic run length and heat-pump start cost stay soft. The event-loop reducer awaits no I/O; there is no global action lock. Current code still contains the old fields and shared execution lock until separately replaced.

## D7. Retention, audit, and savings claims

**Conflict remaining:** exact reconstruction of every action and seasonal replay require more evidence than a latest-plan row plus short-lived summaries. The document also presents several different quantities as savings.

**Decision needed:** set the retention/privacy/storage scope for as-issued forecasts, resolved plans, policies, and execution events. Choose the product claim: forecast comparison, modelled counterfactual saving, or a measured/reconciled service-equivalent result. State whether historical annual reporting and multi-home billing are part of the first supported product scope.

**Why it matters:** these choices determine which records must survive and what a customer may legitimately be told. An internal score, a published-price forecast subtotal, and an invoice saving are different numbers. Engineering can specify the archive and estimator once the claim and retention obligations are set.

See [archival data](docs/energy-optimisation/contracts-and-data.md#price-provenance-and-archival-data) and [cost reporting](docs/energy-optimisation/portal-and-reporting.md#cost-is-not-utility-and-a-forecast-is-not-a-bill). Former findings 22, 26, and 27.

## D8. Building-performance assumptions and certificate trust

**Conflict remaining:** the reporting model applies a blanket renovation improvement, and imported declaration facts have been described more authoritatively than the ingestion path alone establishes.

**Decision needed:** decide whether renovation inputs describe verified efficiency measures or general building changes, and whether imported certificates remain explicitly user-supplied evidence or require independent verification before being presented as authoritative. Decide whether current modelled priors remain suitable for the intended customer-facing claim while their validation is limited.

**Why it matters:** a generic renovation may increase area or consumption, and controlled database writes do not authenticate a document. This is separate from planner search and can be decided on its own product timeline.

See [building performance](docs/energy-optimisation/portal-and-reporting.md#building-performance-and-imported-declarations). Former finding 29.
