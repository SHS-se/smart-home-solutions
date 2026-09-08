# Energy optimisation — decisions requiring attention

Updated: 2026-09-08. Split from the [architecture](ENERGY_OPTIMISATION_ARCHITECTURE.md) on 6 September; D3 and D6 narrowed on 8 September against the [battery valuation investigation](docs/energy-optimisation/battery-valuation-investigation.md) and a survey of the reference installation's [control surfaces](docs/energy-optimisation/reactive-controls.md#surveyed-control-surfaces).

This file now contains only unresolved product or commissioning choices. Clear mathematical errors, arithmetic mistakes, stale statuses, and conflicting definitions have been corrected in the current specifications. Their disposition is in the [reconciliation record](docs/energy-optimisation/reconciliation.md); technical implementation and validation work is in the [engineering backlog](docs/energy-optimisation/verification-and-delivery.md#engineering-backlog-not-household-decisions).

These decisions have not been made implicitly during the split. They can be answered individually; none requires approving the old document as a whole.

## D1. Comfort and service promises

**Conflict remaining:** the original architecture asks for exact room temperatures at quarter boundaries, flexible bands, and priced comfort shortfalls. It also says both that pool service may be reduced and that savings never come from delivering less service.

**Decision needed:** define the customer promise for rooms and pool: which state is a guaranteed minimum, what additional warmth is discretionary, and whether modest shortfalls may be traded for savings. For room schedules, decide whether a painted Comfort cell means reaching at least the chosen temperature at its start or remaining within a stated band. State whether summer heating is ordinarily disabled while safety protection remains active.

**Why it matters:** these choices change which plans are feasible and whether a lower bill counts as improved scheduling or reduced service. An exact equality is not assumed for an already warmer heating-only room, and a finite penalty is not treated as a guarantee.

See [planner commitments](docs/energy-optimisation/planner.md#objective-units-and-commitments) and [thermal models](docs/energy-optimisation/models-and-forecasts.md#thermal-state-and-identification). Former findings 2, 3, and 21.

## D2. EV readiness without a trip and unreachable preferences

**Conflict remaining:** an absent departure means a continually advancing 72-hour deadline in one design and a learned departure distribution in another. The workbench notes also identify a desired range inconsistent with the vehicle's charge cap.

**Decision needed:** state the minimum everyday readiness you expect while connected, without entering a trip each day. An explicit trip can still supply a higher target and deadline. When your range preference exceeds the range available under the SOC limit, decide which should change: the preference or the vehicle's charge limit. The system must not change either silently.

**Why it matters:** a moving deadline can postpone charging indefinitely; an unreachable comfort threshold can keep the car economically unsatisfied at its allowed cap. Neither can be resolved by selecting a better current schedule alone.

See [battery and EV](docs/energy-optimisation/models-and-forecasts.md#battery-and-ev) and [workbench comparisons](docs/energy-optimisation/portal-and-reporting.md#workbench-modes-and-comparison-validity). Former finding 14 and the [§8.20.3 evidence](docs/energy-optimisation/history/planner-experiments.md#legacy-section-8.20.3).

## D3. Preferences, risk, and battery economics

**Conflict remaining:** household thresholds, price-derived bids, outage reserve, and a parameter called degradation currently express overlapping and sometimes different policies. Hardware physics alone cannot decide willingness to pay for comfort or insurance. This item owns the battery's economics; its control path is in [D6](#d6-device-control-scope-and-commissioning).

**Already settled, so not part of this decision:** the inviolable floor is not a product choice. `discharge_cut_off_soc` is enforced inside the inverter and is read-only, so any planner reserve is necessarily a second, higher figure the planner may spend, and the planner already treats the physical floor as beyond a soft reserve's reach.

**Sharper than when this was written:** the ambiguity now has an exact location. Wear is scored as its own quantity per schedule, while the parameter named `degradation` separately reduces the continuation-curve cap reported as `terminal_replacement_sek_per_kwh`. One name is therefore doing two jobs in two places at once, rather than one parameter being merely under-defined.

**Decision needed:** establish which optional service and protection trade-offs the product should make. State whether backup protection is part of the first control scope. Decide what the margin above the hard floor represents — wear, protection against uncertain arbitrage, an outage reserve, or separately identified contributions — and, given the above, whether the continuation cap should keep being reduced by the same parameter that scores wear. Numerical calibration can then be engineering work rather than another household tuning exercise.

**Why it matters:** these valuations directly affect grid purchases, solar storage, and battery discharge. A maximum forecast price is not an outage valuation, and nominal cycle life does not establish that actual wear is zero. The split did not select a new coefficient.

**Sequencing:** the [7 September investigation](docs/energy-optimisation/battery-valuation-investigation.md) found a cheaper feasible schedule under the existing curve, and recommends fixing the paired discharge/replenishment search before tuning any level. This decision is therefore not on the controller's critical path, and answering it early would risk attributing a search defect to a valuation.

See [storage value and uncertainty](docs/energy-optimisation/planner.md#storage-value-and-uncertainty) and the [battery valuation investigation](docs/energy-optimisation/battery-valuation-investigation.md). Former findings 3, 5, 6, 9, and 13.

## D4. Grid headroom and peak spending

**Conflict remaining:** the desired planning ceiling below the fuse was conflated with a soft peak penalty; the penalty's acceptable cost was never settled. Aggregate quarter-hour planning also cannot establish instantaneous or per-phase protection.

**Decision needed:** confirm the commissioned connection/inverter constraints and the intended planning headroom. State whether lower peaks are worth extra electricity cost when no demand charge applies, and what practical cost limit or priority should govern that trade-off. Confirm whether per-phase monitoring/control is required for the first enabled scope; actual protection must remain independent either way.

**Why it matters:** the same preference can encourage gentler EV charging, or become expensive grid reshuffling if weighted too heavily. A soft cost does not enforce a ceiling. Local residual thresholds and response-time measurements are commissioning work once this scope is clear.

See [power costs](docs/energy-optimisation/planner.md#power-costs-and-demand-charges) and [reactive authority](docs/energy-optimisation/reactive-controls.md#authority-and-safety). Former findings 11 and 17.

## D5. Degraded operation and execution lease

**Conflict remaining:** one invalid optional room can either stop the whole plan or be left to baseline control while other devices continue. Separately, published-price validity and the right to execute later slots were not distinguished.

**Decision needed:** choose the product behaviour when an optional capability cannot be planned: stop optimisation for the whole home, or continue unaffected capabilities while visibly withdrawing the affected one and retaining its load in the balance. Also decide whether a missed replan allows later slots of an accepted plan to continue for a bounded lease or hands control back immediately at the next quarter.

**Why it matters:** the choice trades continuity against reliance on stale state. Under either choice, hard guards, actual source validity, and expiry remain authoritative; no guessed live measurement is introduced.

See [plan time and lifecycle](docs/energy-optimisation/contracts-and-data.md#plan-lifecycle-and-time) and [baseline handover](docs/energy-optimisation/reactive-controls.md#expiry-and-baseline-handover). Former finding 19.

## D6. Device control scope and commissioning

**Conflict remaining:** the Nibe pool/hot-water unit is sometimes treated as schedulable watts and sometimes as an internally controlled device the planner can only permit or influence. Mixed room heaters create a related gap between requested watts and achievable heat. This item owns the control path for both the heat pump and the battery; the battery's economics stay in [D3](#d3-preferences-risk-and-battery-economics).

**Now surveyed, so no longer part of this decision:** the [control surfaces](docs/energy-optimisation/reactive-controls.md#surveyed-control-surfaces) were read from the reference installation on 8 September 2026. The machine is ground source, the three sinks have distinct levers, per-sink attribution and interlocks are directly observable, the pool is a temperature window plus a desired charge power rather than a schedulable on/off, and the inverter exposes a mode, a signed kW target, envelopes, and an authority handshake. What remains unknown is behaviour under write, not inventory.

**Decision needed:** confirm the first device scope — which of rooms, hot water, pool, and battery may be written to at all — and authorise the commissioning writes needed to establish response, confirmation, sign, and blocking behaviour for that scope. Decide whether pool optimisation waits for this or the pool stays outside the first enabled scope. Decide the same for battery direct control, which is a separate authorisation from the heat pump's.

**Why it matters:** no algorithm can schedule unavailable independent capacity, and a shared compressor cannot promise pool and hot water simultaneously however many levers exist. Reading a register is not permission to write it, and the surveyed inventory does not establish how the equipment responds. Guessed register behaviour is not a household preference.

**Blocks the controller:** the integration has no storage control type and no battery actuator mapping at all, and its thermal mapping cannot express an offset, a demand mode, a permission switch, or a temperature window. That gap is engineering work in the [backlog](docs/energy-optimisation/verification-and-delivery.md#engineering-backlog-not-household-decisions), but its scope follows this decision.

See [shared heat pumps](docs/energy-optimisation/models-and-forecasts.md#pool-hot-water-and-shared-heat-pumps), [executor contracts](docs/energy-optimisation/reactive-controls.md#executor-contracts), and the [integration gap](docs/energy-optimisation/reactive-controls.md#integration-gap). Former findings 20 and 21.

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
