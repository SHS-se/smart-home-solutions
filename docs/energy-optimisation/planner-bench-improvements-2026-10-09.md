# Planner search improvements, 9–10 October 2026

Reviewed all 24 active cases and 620 stored results across 16 retained runs. The original dev baseline was pushed and benchmarked in CI; its 24-case total exactly matched the local replay. GPT-6 Astra and Claude Opus 5.5 independently reviewed the architecture at high effort using the architect skill.

The baseline is **f87a5cf7 for every case**. The shipped change contains search improvements only. Scorer 30, policy `kronor-score-v9`, rule defaults, physics and the 760,000,000 work grant remain unchanged. The exact scorer from an archived f87a5cf7 checkout is also used to verify the final comparison. Recovery-rule experiments and alternative search refinements are deferred and are not included in this commit.

## Design and ownership

The external `solve(Problem)` interface, native problem shape and ABI 6 stay the same. Battery allocation returns a complete command proposal together with immutable continuation values:

```rust
let allocation = battery_schedule::allocate(problem, index, commands, quarters, work)?;
let joint = allocation.respond(problem, index, &appliance_edit, quarters, work)?;
let candidate = score(problem, index, joint, work)?;
// Builder adopts only exact complete score improvements.
```

`battery_schedule` owns inventory axes, continuation tables, action enumeration, exact forward household transitions and work accounting. `move_resize` supplies ordinary edits and at most two diverse equal-length moves per device for coordinated evaluation. `builder` owns immutable proposal epochs, conflict handling, the incumbent and exact adoption. Every response action uses the existing complete native physics, so an appliance edit need not first be feasible under stale battery commands. Locked commands stay fixed. There are no new fetches, validity constraints or external workers.

Responses traverse the quarters against retained values rather than rebuilding the full inventory DP for each edit. Each exact transition is metered, a complete score is temporarily reserved and the reservation is restored on every exit. Partial vectors never enter candidate selection. Approximate continuation guidance proposes actions; exact household accounting and history-sensitive rules decide adoption. A small shortlist preserves most existing span search. Immutable edits are rebased lazily, avoiding a large collection of copied command vectors.

Astra highlighted battery/appliance coordination and a cold-pool service omission. Claude proposed whole-horizon appliance profiles priced with battery recourse; its no-new-rule conclusion used the older 19-case population. The shipped synthesis reuses continuation values for bounded forward responses, without the speculative full appliance-transition cache or an additional profile DP.

## Rejected or deferred experiments

A full final battery-allocation reservation regressed unchanged-rule results by 15.0122 points by displacing useful appliance trials. Unrestricted native battery supply alone regressed by 1.4451 points. Neither standalone change is retained. Raising the work grant and a full joint pool/EV/battery DP were rejected for compute cost; price-related point deductions would charge cash twice.

The proposed recovery preference addresses C-1011: old ending pool temperature 22.53°C for a 30.5°C target, while ordinary mild/severe comfort only becomes eligible at quarters 313/289, beyond the 288-quarter horizon. The experiment reached 27.455°C but added 127.1446 kr of grid cost. Under the original scorer its combined candidate was 5.7368 points worse overall. The user chose search improvements for now, so recovery rule, scorer changes, new service guards and associated audit changes were removed from the shipped code.

## Understanding C-0627 and C-0920

C-0627 is a genuine search regression: native and measured scores agree exactly. Its new schedule reduces first-day pool heat from 35.3574 to 19.9009 kWh and increases second-day heat from 3.3628 to 18.4194 kWh. It exports more solar, then imports more electricity later. The score loss is 3.3369 kr more grid cost, a 2-point restart deduction and 0.0025 kr more wear, partially offset by 0.0780 kr more ending energy credit. Final pool temperature is effectively unchanged (30.488 to 30.487°C). The coordinated search changes the local improvement path and spends work that would otherwise fund ordinary span trials. It can reach a worse final solution despite adopting more local improvements.

C-0920 gains mainly in the real bill: grid cost falls from 72.3056 to 64.2423 kr and wear from 2.5170 to 2.4037 kr. Ending energy credit stays −7.0042 kr and neither plan has deductions. Total benefit is 8.1767 points. First-day pool heating starts 45 minutes later; second-day heating starts 30 minutes later and runs longer. The pool ends at 30.503 rather than 30.538°C, both above its 30.5°C target. Better energy timing and value produce the saving; imported kWh do not need to decrease.

A singles-first ordering nearly restores C-0627 but loses most of C-0920's gain and was rejected. A later small-frontier prototype remains in temporary research files; it was not applied after the user chose to proceed with the accepted search change. Case-specific thresholds and rules are not used to hide regressions.

## Final results and validation

The final search-only artifact improves the total by **12.5951 points under the unchanged scorer and rules**. Native/Wasm output and accounting parity, reproducible artifact build and required repository checks are recorded below.

| Case | f87a5cf7 | Search improvement | Change |
|---|---:|---:|---:|
| C-0103 | -599.07 | -598.00 | +1.07 |
| C-0217 | -643.81 | -641.04 | +2.77 |
| C-0327 | -90.27 | -91.37 | -1.10 |
| C-0401 | -117.79 | -117.72 | +0.07 |
| C-0523 | 20.33 | 20.94 | +0.61 |
| C-0616 | 70.08 | 70.40 | +0.32 |
| C-0627 | 27.04 | 21.79 | -5.25 |
| C-0717 | -20.14 | -20.16 | -0.01 |
| C-0810 | 37.70 | 37.89 | +0.20 |
| C-0816 | 57.97 | 57.36 | -0.61 |
| C-0822 | 18.23 | 19.77 | +1.54 |
| C-0827 | -49.50 | -49.51 | -0.01 |
| C-0905 | -2.15 | -2.75 | -0.59 |
| C-0912 | -4.50 | -4.50 | +0.00 |
| C-0919 | -70.69 | -70.72 | -0.02 |
| C-0920 | -81.83 | -73.65 | +8.18 |
| C-0924 | -173.79 | -173.71 | +0.08 |
| C-0927 | -100.66 | -96.72 | +3.95 |
| C-0928a | -145.62 | -145.62 | +0.00 |
| C-0928b | -137.68 | -137.49 | +0.19 |
| C-1005 | -67.28 | -66.62 | +0.66 |
| C-1011 | -132.33 | -132.33 | +0.00 |
| C-1123 | -616.12 | -615.61 | +0.51 |
| C-1219 | -183.40 | -183.35 | +0.05 |
| **Total** | **-3005.30** | **-2992.71** | **+12.60** |

Two uncontended final Wasm replays produced identical commands and scores for all 24 cases. Solve elapsed totaled 6746.6 / 6798.5 ms, averaging 281.1 / 283.3 ms per case; peaks were 311.86 / 310.88 ms. The original baseline averaged 273.64 ms and peaked at 307.16 ms. Peak Wasm linear memory is 11 MiB, versus baseline 9.875 MiB. The artifact grew from 541,420 to 560,241 bytes. Work grant remains 760,000,000. Every plan has zero physical violations and no required-rule failures.

Recipe is `rule-forecast-opportunity-v7`; policy and scorer stay `kronor-score-v9` / 30. Local solve measurements do not establish hosted whole-handler CPU or peak memory. The diagnostic hosted probe was not separately deployed.

Validation: full `deno task test` **1697 passed**, Rust **38 solver + 2 model tests passed**, strict Clippy passed, native/Wasm commands, trajectories, scores and work accounting matched exactly, and an independent checkout reproduced artifact SHA `94929fdb63b8011120ae0539ef64a2911ce33f5a484218f129131fb2bcce8985`. Generated HA contract fixtures passed. TEST frontend build passed with its existing bundle-size warning. Full `npm run lint` passed with **0 errors and 27 existing warnings**. All **63 mocked-backend Playwright tests passed** against the final rebuilt bundle. The archived f87a5cf7 scorer independently reproduced the new total −2992.7077.
