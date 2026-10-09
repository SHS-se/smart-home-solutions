# Whole-horizon battery allocation

The old search moved isolated battery spans against a fixed tail. It could not reliably coordinate a cheap purchase, intervening preservation, house supply and a later partial sale. This replaces that search with a conditional inventory dynamic program. The user explicitly requested removal of the guessed ±25% stress objective: the sole selection objective is the existing supplied-forecast account, including configured rule points, cash, wear and capped terminal credit.

## Usage and ownership

```rust
// After construction and when accepted pool/EV commands change their demand:
if let Some(commands) = battery_schedule::propose(
    p, index, &best.commands, &best.quarters, work,
) {
    let candidate = score(p, index, commands, work)?;
    if candidate.better(&best) { best = candidate; }
}
// A complete optional pass must fit before it starts. Locks remain identical.
assert_eq!(&proposal[..locked], &incumbent[..locked]);
// Short-horizon verification compares real native trajectories to enumeration.
assert_close(projected_account(&proposal), exhaustive_native_account());
```

`builder` alone changes the incumbent and applies full projection, account and scored witness checks. `battery_schedule` owns private action generation and continuation values for fixed pool/EV demand. `physics` owns battery/grid arithmetic shared with complete projection; `policy` owns account measurements and end credit. TypeScript transports one prepared problem and selection; it has no search controls or uncertainty policy.

The private `Context` borrows the problem, index, commands and projected appliance quarters, and owns one inventory axis per quarter. `Values { rows }` stores matching backward continuation values. `propose(...) -> Option<Vec<Command>>` returns a complete command sequence or no proposal. Scratch memory is invocation-local. No new public type is needed.

Each row has 32 uniform inventory intervals plus the initial, configured reserve, terminal-credit cap and incumbent inventory landmarks. Inventory knots approximate **value**, never physical energy. Commands are reconstructed from the exact initial inventory using native physics. Actions include follow-house, cover, hold, idle, solar capture, grid purchase and export. Partial power is derived from reachable knots, capacity/power/grid boundaries, net-zero tariff boundaries and declared flexible-load reward floors. Newly proposed fixed purchases/sales use forecast-delivered powers; accepted commands retain exact identity. Full scoring may reject a proposal because guidance omits episode and witness rules.

A checked pass bound accounts for table construction, action scans and reconstruction before allocation. Admission also leaves enough work for a full score and complete witness audit; the builder's certification reserve remains protected. The grant stays at 760 million. Battery grid-charge spans have been removed from `move_resize`: pool and EV retain that search owner.

## Synthesis

Independent Codex and Claude Opus High reviews both identified conditional whole-horizon battery allocation as the missing search. The initial synthesis used Codex's shared-command, three-inventory beam to preserve the existing stress objective. An experiment improved that objective while making measured C-0920 substantially worse. The user then removed the guessed objective, changing the design to Claude's scalar backward inventory tables, with Codex's continuous partial powers, exact native transitions, final-account adoption and upfront work admission. No scenario beam or old span implementation remains.

We accept interpolation error in exchange for bounded deterministic search. We accept alternating conditional battery and appliance improvement in exchange for avoiding an impractical joint inventory/temperature/EV state table. This is not a global optimality claim: constructor beam width, inventory resolution, omitted nonlocal guidance and the work grant can all limit search.

An exact joint dynamic program lost on state size and integration risk. Extending isolated span search lost because coordinated charge/preserve/export changes can require several individually losing edits. Retaining guessed uncertainty lost on both the user’s instruction and evidence: whole-day multipliers missed the timing of forecast errors.

## Validation and limits

Tests cover charge/preserve/supply coordination, partial earlier export followed by a stronger later sale, exhaustive short-horizon controls, conditional/full projection parity with losses and partial capture, locked command identity and work admission. Benchmark validation uses all **19** current TEST cases, identical prepared inputs and the independent measured referee. The `oracle/nominal` lane supplies future prices to every candidate, but withholds future measured load and sun. Forecast gains and measured replay gains must be reported separately.

Grounding also found an existing input-preparation omission: the main TypeScript planner applies `demandLevel` using matured home forecast/actual days, while both Rust input producers ignored them. Production `prepareRulesPlanningInput` and bench `readyProblem` now reuse that existing level correction, at the immutable capture’s local date, for base load only. Passive devices and boiler demand retain their own forecasts. Current/future observations are excluded by the existing evidence owner. No demand margin, synthetic stress scenario, new confidence bound or rejection gate is introduced. Homes without enough matured evidence keep their supplied estimate, as the existing evidence model specifies.

The prepared problem still carries one forecast. The kernel remains free of history, database and training dependencies. PV forecast timing errors remain unresolved; a schedule that improves its forecast account can still lose in measured replay.

## Fresh 19-case replay, 9 October

Same current TEST export and independent referee before/after; higher score is better. Baseline was freshly solved at `bc8c39f`. New results include the existing matured-demand level correction. No benchmark rules or replay physics were changed.

| Case | bc8c39f | New | Gain |
|---|---:|---:|---:|
| C-0103 | −603.88 | −599.07 | +4.81 |
| C-0217 | −644.01 | −643.81 | +0.20 |
| C-0327 | −91.01 | −90.27 | +0.74 |
| C-0401 | −118.82 | −117.79 | +1.04 |
| C-0523 | 19.31 | 20.33 | +1.02 |
| C-0616 | 68.44 | 70.08 | +1.64 |
| C-0627 | 22.52 | 27.04 | +4.52 |
| C-0717 | −20.80 | −20.14 | +0.66 |
| C-0827 | −51.58 | −49.50 | +2.08 |
| C-0905 | −2.15 | −2.15 | −0.002 |
| C-0919 | −79.13 | −70.69 | +8.43 |
| C-0920 | −77.56 | −81.83 | **−4.27** |
| C-0924 | −175.95 | −173.79 | +2.16 |
| C-0927 | −101.96 | −100.66 | +1.29 |
| C-0928a | −146.12 | −145.62 | +0.51 |
| C-0928b | −145.89 | −137.68 | +8.21 |
| C-1005 | −64.74 | −67.28 | **−2.55** |
| C-1123 | −616.63 | −616.12 | +0.51 |
| C-1219 | −183.51 | −183.40 | +0.11 |
| **Total** | **−3013.48** | **−2982.37** | **+31.11** |

All 19 replay trajectories have zero physical violations and no required-rule failures. Referee-proven avoidable cost falls from 69.02 to 48.97 kr. These are benchmark outcomes, not deployment or hardware measurements.

A separate frozen-prepared-input experiment isolates the search/scoring change: forecast account gains total 25.09 kr (18 cases improve; C-1005 loses 0.63), but measured replay gains only 3.46 kr. Reusing the existing demand level adds the remaining 27.65 kr. Removing the guessed objective therefore does not itself explain the headline gain. An exploratory pre-calibration 1.2 billion work-grant experiment bought only 4.24 kr more than its 760 million counterpart; the committed grant remains 760 million.

C-0920’s measured replay now covers 09/21 08:15–09:15, holds at 11:15 and 14:30–14:45, covers 09/22 07:30–09:30 with 33% at 07:30 and 23.4% at 09:30, and exports about 1.95 kWh at 19:00. It still discharges at 14:15. Its total is worse by 4.27 kr: grid cost rises from 60.43 to 72.31 kr, partly offset by a better terminal inventory credit. These timing changes are not a claim that all four concerns or C-0920’s economics are fully fixed.

An isolated local Wasm replay averages 276 ms (maximum 301 ms), compared with the baseline’s 347 ms (maximum 400 ms). Reported Wasm linear memory falls from 16.56 to 9.63 MiB. These are local solve/linear-memory diagnostics, not hosted CPU or whole-process memory limits.
