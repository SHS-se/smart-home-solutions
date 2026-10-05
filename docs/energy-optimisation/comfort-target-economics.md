# Comfort target economics correction

## Usage (caller first)
`generateOptimisationPlan(snapshot, now, archive, outlook)` retains its positional API. `buildDispatchStores` resolves `targetEconomics({unit,target,units_per_kwh,reference_sek_per_kwh,scale,timing})` once from captured inputs. It supplies a target utility curve and fixed usage weights to the existing dispatcher. `scoreDispatch` integrates those weights; auction proposals use a common suffix derivative of this same account.

## Problem
Supply-clearing price is not willingness to pay for comfort. Sequential solar reservation suppresses EV values. Pool bids average a different account from exact whole-run acceptance, which mostly rewards terminal warmth. Free PV falsifies cost-derived utility even after multiplication. Preserve measured cooling stall, heat gain, native startup, hardware controls and battery continuation/arbitrage.

## Shape
One pure `target-economics.ts` owner resolves target-only utility in SEK per physical unit for a service day/event. Below target: marginal willingness = existing urgency multiplier3 * existing positive import reference / units_per_kwh * administrative scale. Utility saturates above the target. This is a versioned relative default policy, not a derived customer SEK opinion or universal hard attainment guarantee. Potential free PV does not erase willingness. Physical actual costs select procurement. Pool and EV without departure use duration_hours/24 and terminal1 (one further service day). Declared EV departure is one event, terminal0. Explicit curves retain their semantics when no target is supplied. Battery curve remains terminal replacement; in-horizon arbitrage appears in actual grid costs once. No forced curvature.

`dispatch-service-value.ts` owns exact integral and O(N) reverse marginal calculation. Reuse existing trajectory/weights and physical transition; finite sensitivities read existing drift/gain instead of changing it. An explicit trajectory revision invalidates proposal cache. Replace sustained future-average/local cap for target stores with fixed-weight suffix values; whole-run scoring remains exact, proposals approximate for discrete/nonlinear changes. Prefix slices preserve weights and units, with no renormalization. No new durable worker fields, old-planner fallback, resource or validity constraints. Existing bounded response search uses10 optional auctions; do not increase it to pass tests.

## Synthesis decision (independent Claude Opus and Codex reviews)
Base: revised Codex single fixed service account, target saturation and actual-transition marginal proposals. Adopt Claude ongoing EV readiness when departure absent and separate interpretation of battery terminal inventory from service. Reject Claude supply maximum/median rent calibration (unmeasured band requirement and additive closing curve), unchanged seeded retention derivative, terminal extra energy reward above target; reject Codex initial procurement3x willingness after free-PV falsification. No full Bellman migration: prior offline prototype has unresolved8/10-round coverage and native response gaps. Candidate caller error corrected to actual API.

## Tradeoffs accepted
- Accept an explicit existing3x relative target utility in exchange for economical target-only semantics without new settings.
- Accept a flat below-target marginal and an honest target cutoff in exchange for not inventing subjective severity thresholds.
- Accept first-order bid proposals with exact whole-run acceptance in exchange for bounded production runtime.
- Accept a one-day service continuation in exchange for preserving current24h beyond-horizon policy with explicit units.

## Alternatives and risks
Full conditional Bellman/joint rollout has richer values but much larger ownership/response/worker migration and unproven budget. Score-only time averaging failed the actual replay. Blindly multiplying all curves repeats free-PV failure and battery double counting. Soft targets may be unreachable or expensive; no new rejection gates. Cliff/discrete actions can overbid; if exact oracle, real replay or bounded native search still fails, re-ground and revise sizing/search rather than claiming success.

## Verification
The sanitized production case checks first-day recovery, free solar, unreachable
preferences against the hardware ceiling, unchanged passive cooling and pool/EV
worker continuation through JSON. A four-slot independent exhaustive oracle
integrates capped service and measured startup draw for the native pool and
supported charger currents (held readiness and declared departure). The common
account has prefix-additivity and finite-difference derivative tests.

Implementation exposed one material proposal gap: the EV integer scheduler
previously only relocated a fixed energy quantity at one readiness event. It now
chooses both quantity and timing against the same account, using the physical
charge ceiling to bound its state lattice. Partial quarters remain available to
the main auction; the lattice comparison uses its common full-quarter quantum.
Candidates still receive exact coupled acceptance. This is one extra candidate
within the shared allowance, not another outer optimization loop.

The raised battery cut-off regression also exposed a latent coordinate error:
clamping a measured below-cutoff pack to zero invented usable inventory after a
charge. Keep the measured deficit in the existing usable-energy coordinate; its
existing physical floor then forbids discharge until it has recovered. The
battery curve algorithm, efficiency and export policy are unchanged.

On the owner's October 5 replay, the old plan heated first on October 7 at
21:30 UTC, ended the EV at 318.7 km, and accumulated 100.4 pool degree-hours below
30.5 °C. The corrected ten-optional-comparison plan heats on October 5 at 10:30 UTC,
ends the EV at 360.4 km, and reduces pool shortfall to 3.1 degree-hours. The net bill over
quoted-price quarters rises from 11.9 to 52.2 SEK because the old plan skipped service.
This is a soft economic target, not a hard attainment or global optimum proof.
The shipped budget is ten optional coupled auctions shared across the generation;
mandatory physical seed/all-off comparisons still run. In the local replay this generates 22 scalar auctions (mandatory comparisons
included), about 26 seconds total; it is not ten iterations of the scalar
auction. Ten and twelve optional comparisons produced the same selected plan.
The existing worker request deadline is 120 seconds and its per-call budget is
1.2 seconds; this change does not enlarge either. Candidate ranking uses
exact physics, with first-order proposals only for the initial auction.

Pool cooling bins, heat gain, heater startup projection, water-heater scheduling
and actuator controls remain in their existing owners. The curve panel draws the
reported zero right tail explicitly, without adding smoothing or new utility.

As an efficiency comparison, hold the selected battery flow fixed and compare
pool/EV schedules through their actual physics. The selected schedule costs
147.0 SEK across the forecast horizon versus 205.3 SEK for immediate bang-bang
pool heating and immediate supported-current EV charging. Both are feasible
under that conditional comparison. The immediate schedule supplies slightly
more warmth (0.8 versus 3.1 shortfall degree-hours), but repeatedly restarts the
heater (249 versus 9 SEK startup cost). This is a simple reference control,
not an equal-comfort global optimum benchmark. Display-rounded battery power
must not be used as a raw dispatch feasibility oracle.

The actual home replay through the production 1.2-second pause threshold and
JSON continuations completes in 25 local worker calls, 27.8 seconds total. Its
assembled plan exactly matches the uninterrupted plan; the longest local step
was 1.26 seconds (the budget is a pause threshold, not preemptive execution).
This validates deterministic reconstruction on the home case without changing
worker deadlines, protocol or call ceilings.
