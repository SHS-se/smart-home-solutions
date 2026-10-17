# Consecutive EV and battery charging

Planner model v12 / native ABI 9 adds a soft preference of 0.25 SEK per EV charging start and per house-battery grid-charging start. This is explicit preference accounting (`continuity_sek`), separate from the electricity bill and equipment wear. The final score subtracts it once. A worthwhile price or service benefit may still split charging.

A start is a transition from inactive to active charging. Changing EV amperage or battery charging power within consecutive active quarters is not a start. Battery solar capture is not penalised as grid charging. Exact physical projection owns activity and transition cost, including reused accepted prefixes, so the solver and published account use the same definition.

The coupled beam accumulates that cost, battery continuation values include the preceding grid-charging state, and EV move proposals account for starts at changed span boundaries. This is part of native optimisation, with no hard dwell constraint or schedule postprocessing. The existing configured grid and equipment limits still apply. Fixed-booking expansion also continues past individual infeasible beam candidates instead of aborting before another valid candidate is considered.

The regression in `tests/charging-continuity.test.ts` competes for limited house capacity across near-equal quarters. It changes repeated EV/battery starts into one EV run and one battery run, preserves both delivered energies and stays below the cap, for less than 0.01 SEK extra electricity cost. Other regressions cover variable power within a run, accepted-prefix accounting and a price gap worth interrupting charging for.

Generated Home Assistant consumer fixtures, the Wasm artifact and its source manifest are regenerated together. Rust, full Deno tests, native/Wasm parity, build reproducibility and the mocked-backend browser suites validate the change.
