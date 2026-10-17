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
