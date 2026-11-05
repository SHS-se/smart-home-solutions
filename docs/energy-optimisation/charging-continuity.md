# Consecutive EV and battery charging

Planner model v12 / native ABI 9 adds a soft preference of 0.25 SEK per EV charging start and per house-battery grid-charging start. This is explicit preference accounting (`continuity_sek`), separate from the electricity bill and equipment wear. The final score subtracts it once. A worthwhile price or service benefit may still split charging.

A start is a transition from inactive to active charging. Changing EV amperage or battery charging power within consecutive active quarters is not a start. Battery solar capture is not penalised as grid charging. Exact physical projection owns activity and transition cost, including reused accepted prefixes, so the solver and published account use the same definition.

The coupled beam accumulates that cost, battery continuation values include the preceding grid-charging state, and EV move proposals account for starts at changed span boundaries. This is part of native optimisation, with no hard dwell constraint or schedule postprocessing. The existing configured grid and equipment limits still apply. Fixed-booking expansion also continues past individual infeasible beam candidates instead of aborting before another valid candidate is considered.

The regression in `tests/charging-continuity.test.ts` competes for limited house capacity across near-equal quarters. It changes repeated EV/battery starts into one EV run and one battery run, preserves both delivered energies and stays below the cap, for less than 0.01 SEK extra electricity cost. Other regressions cover variable power within a run, accepted-prefix accounting and a price gap worth interrupting charging for.

Generated Home Assistant consumer fixtures, the Wasm artifact and its source manifest are regenerated together. Rust, full Deno tests, native/Wasm parity, build reproducibility and the mocked-backend browser suites validate the change.

## Active-current block search (model v14, native ABI 10)

The follow-up replay exposed a gap in v12: the car can remain on at minimum current while alternating with maximum-current quarters. EV start accounting sees a single session, and off-destination span moves cannot exchange those already-positive currents. Raising the start preference changes the economics without repairing that missing neighbourhood.

The native solver now tries both current orderings of its most fragmented active EV session after finalist selection, before spending the remaining grant on small span edits. Each permutation preserves the existing native-current multiset on equal-duration quarters and retains commitments exactly. A partial first quarter, an unavailable quarter or a fixed command partitions the exchange window. These are energy-preserving search boundaries, not additional plan-validity constraints.

Each complete permutation receives a fresh battery allocation using its new EV demand and the unchanged exact pool trajectory. Whole-plan projection and scoring decide adoption. There is no postprocessing, minimum dwell, power-change penalty or increased search-work grant. Positive power can still change; a worthwhile price or service benefit can still split charging.

Battery continuation interpolation also no longer borrows a finite value across an endpoint with no continuation. Exact finite knots remain usable, and nonfinite candidate values are skipped. This repairs an optional-search dead end, not a new physical rejection rule. The final native projection still decides feasibility.

`tests/charging-continuity.fixture.ts` is an anonymous rounded power/price case derived from the reported pattern. Its regression covers an uninterrupted session with alternating positive currents, car service, retained battery inventory, grid limits, metered work and solve/project parity. Native tests also cover partial quarters, fixed commands, unsupported continuation cells and changed-current battery headroom.

The complete production entry point was also rerun against the supplied 72-hour capture. In its alternating evening block, EV current changes fell from six to one. Final EV energy stayed at 57.51918 kWh; final battery storage increased from approximately 17.714 to 17.852 kWh and the pool ended approximately 0.051°C warmer. Forecast electricity cost increased by 1.81 SEK across the full horizon. Peak planned import remained within the configured 15,000 W limit. These are replay forecasts, not measurements or a claim of hardware protection.

## Complete charging blocks (5 November 2026; ABI 18)

The approved policy replaces charging-start charges with **0.125 SEK per
requested EV current or battery grid-charge setting change**, including starts,
stops and positive setting changes. An isolated stop/start costs 0.25 SEK as
before. The preference is separate from electricity cost and wear; automatic
supply, export and solar-capture settings retain their existing economics. A
lower but positive request counts just like any other changed request, so a
trickle between larger requests does not save a transition. The measure is
planner intent, not the count of hardware writes. The app owns native DC
conversion, quantization and live response.

Independent accepted EV and battery references describe prior requested intent
at capture. Unknown intent is neutral at the first boundary. No prior plan is
inferred to be physically applied; current owner holds and bookings are exact.

The native solver keeps its ordinary completed search and reserves a bounded
last round for whole EV relocations, merging sessions, current grouping and
stationary charge levelling. It also tries moving part of a longer EV session
into an earlier continuous window with spare capacity under the existing
battery plan. It compares at most eight attempts, including a
fresh battery allocation on a changed EV schedule and exact projection of
bounded conditional responses. Proposal estimates rank trials; they do not
reject a whole block for its isolated price estimate. The final round keeps the
ordinary incumbent and a distinct block challenger through water completion.
Each finalist is normalized and scored with its own water permissions and rated
reservation. A challenger cannot displace the completed plan with worse required
water service. The original grant and final certification remain in force.

Continuity reduces exposure to delayed load changes. The app still owns admission
of each write and the durable capacity journal. The pinned producer/consumer
qualification exercises both directions of a delayed EV/battery handoff, plus
retained uncertain effects after restart and dispatch-receipt ordering. No timers,
minimum power, new hardware validity gates, departure deadlines or handback
behavior are introduced.
