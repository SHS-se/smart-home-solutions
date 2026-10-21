# Monthly replay profiling and horizon experiments

Measured locally on 12 October 2026. These are deterministic synthetic August
households, not recordings from a customer's home. The benchmark includes all
2,976 execution quarters, scheduler solves and ledger creation; it excludes
history requests, the default-control projection and chart rendering. Native
diagnostic timers and production Wasm wall times are reported separately.

The later 21 October [regression audit](roi-regression-audit-2026-10.md) covers
delayed pool response and observation-aware EV replay. Current replay distinguishes
hourly SOC aliases from fresh observations and replans at a return only when a
withdrawal made the selected plan stale. This corrects the historical event model;
it does not change horizon length or search grants. The experiments below retain
their original date, event interpretation and measurements.

## Candidate refinement

The first 72-hour solve in the flat scenario produces identical native selection
JSON before and after this change, including commands, quarters, accounts, work
and termination. Its SHA256 is
`2b680b47cbc81ce7e8d1b60da9cee4d51525d6c58ff711a18cfc47fdfa7f31e6`.

| Native diagnostic scope | Before (ms) | After (ms) |
| --- | ---: | ---: |
| Complete solve | 358.9 | 169.3 |
| Candidate refinement | 309.7 | 123.0 |
| Candidate score | 269.0 | 83.3 |
| Physical projection | 250.8 | 65.2 |
| Pool transition, all physics calls | 227.4 | 44.3 |
| Complete accounting | 17.3 | 17.3 |
| Battery allocation | 22.5 | 22.0 |
| Battery response | 4.5 | 4.6 |
| Edit generation | 8.7 | 8.6 |
| Carry edits onto incumbent | 2.4 | 2.1 |
| Apply edits | 0.8 | 0.8 |
| Initial candidate construction | 14.2 | 14.5 |
| Opportunity preparation | 32.8 | 29.4 |
| Index preparation | 1.4 | 1.4 |
| Witness audit | 0.3 | 0.3 |

Scopes are inclusive and overlap: do not sum the rows. Instrumentation adds
overhead, especially around 1,066,354 pool transition calls. It is compiled only
into a temporary native source copy. Production Wasm has no timers or counters.

The expensive pool path clips heating to the thermostat stop with a 48-iteration
search. Many sibling candidates repeat exactly the same pool transition even
after their full-command prefixes diverge. Reusing a full physical suffix was
also prototyped, but found no exact full-state rejoins in this solve.

The adopted change memoizes only enabled pool-heating transitions. A projector
owns one immutable problem and one bounded table (4,096 sets, four ways). Keys
contain the slot, exact water-temperature bits, heater-state variant and exact
heater-age bits. Slot identity binds duration and outdoor temperature; the
problem owner binds all device and thermostat constants. Hits return the
unmodified model transition. Collisions and eviction recompute it.

Of 145,721 eligible heating queries, 138,393 hit the memo (95.0%). Prefix reuse
still copies 454,655 quarters and projects 850,273 quarters. All declared work
charges remain unchanged: 4,531 evaluations, 4,523 move/resize trials and
1,176,876,776 work units. The memo does not make the search try more candidates.
Accounting retains its complete fold and addition order. Execution, opportunity
construction and final independent certification still use the direct model.

The lazy table occupies 1,736,704 bytes in the native build and has bounded
capacity independent of candidate count or horizon. Tests cover full projection
parity across steady/startup heaters, linear/measured loss, heater phases,
partial quarters, EV/battery edits, locked commands and exhausted grants, plus
signed-zero keys, deliberate collisions and eviction. The three monthly
scenarios compare complete physical-output checksums and every solve's recorded
work count, budget and termination against the pre-change Wasm.

The ownership design follows the architect review's bounded pure-transition
memo, with exact pool-state invariants and direct certification from the
independent incumbent-lane proposal. It avoids a command trie or retaining
candidate ledgers merely for caching.

## Production Wasm timings

Medians of three sequential runs per artifact, using the same input and replay
protocol. Each scenario's complete physical-output checksum and every solve's
work metadata match before and after.

| August scenario | Before (s) | After (s) | Less time | Solves |
| --- | ---: | ---: | ---: | ---: |
| Flat load and prices | 16.02 | 8.36 | 47.8% | 31 |
| Solar and variable prices | 12.11 | 9.20 | 24.0% | 31 |
| Solar, variable prices and daily EV trips | 20.60 | 17.33 | 15.9% | 62 |

Wasm linear-memory high-water increases from 4.88 to 6.44 MiB without trips,
and from 7.19 to 8.75 MiB with trips: a 1.56 MiB increase in both cases. The
native table is slightly larger because native pointer-sized fields use 64 bits.
These timings describe scheduler replay, not total graph latency or a guaranteed
speedup for every household.

## Horizon semantics

Production continues to solve a rolling 72-hour forecast each local day and
after EV homecoming. A month is continuously executed from its initial state;
daily replans carry the actual simulated state and prior committed hour.

The experimental modes are confined to the benchmark:

- `month`: plan the remaining month at the start and after homecomings, using
  the normal work grant.
- `month-scaled`: the same cadence with the grant multiplied by
  `max(1, remaining quarters / 288)` so the longer horizon can score more
  candidates.
- `month-daily`: retain daily and homecoming replans, extend each horizon to the
  remaining month and retain the normal work grant.

The native ABI has no future EV energy withdrawals. The replay applies every
observed trip externally and masks car availability after its next departure.
It must replan after homecoming from the depleted state. Removing those replans
would change driving-demand handling; this experiment keeps them.

Longer horizons also change terminal value and the bounded heuristic's search.
The flat month with the normal grant scores only five candidates before grant
exhaustion. Scaling the grant is therefore a search-quality experiment as well
as a horizon change. Lower cost alone is insufficient to establish equivalence:
ending battery/EV energy and pool service also matter.

## Month-horizon results

Single sequential runs using the optimized artifact. Costs are import charges
less export revenue, excluding identical fixed fees of 789 SEK. The 72-hour
reference timings above are three-run medians.

| Scenario | 72h time (s) | Month, normal grant (s) | Month, scaled grant (s) | 72h cost (SEK) | Scaled-month cost (SEK) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Flat | 8.36 | 1.16 | 4.62 | 1,248.26 | 1,248.26 |
| Solar and variable prices | 9.20 | 1.23 | 5.21 | 97.38 | 101.81 |
| Solar, variable prices and EV trips | 17.33 | 32.48 | 79.65 | 234.99 | 233.81 |

Without trips, both month modes make one solve instead of 31. The normal grant
admits only five candidate evaluations in the first solve and exhausts its
budget; costs rise by 12.41 SEK in the flat case and 14.61 SEK in the solar case.
With the scaled grant, the first solves evaluate 5,165 and 4,138 candidates.

The scaled flat month has exactly the same pool trace and ending energy. Its
cost differs by less than 3e-12 SEK, but 17 of 2,976 commands differ and the
complete physical-output checksum differs. It is similar, not byte-identical.
The solar month costs 4.43 SEK more (+4.55% variable cost, +0.50% full bill),
changes 389 commands and differs from the 72h pool trace by up to 0.412°C.

With trips, the month modes retain 32 solves, versus 62 for 72h. The scaled month
is 4.60 times slower, changes 509 commands, and costs 1.17 SEK less (-0.50%
variable cost). Pool traces differ by up to 0.490°C and EV SOC by up to 7.77
percentage points. Ending battery energy is 0.204 kWh higher, ending EV energy
matches to floating-point precision, and ending pool temperature is 0.099°C
lower. These differences prevent treating it as the same simulation.

Scaled-month Wasm memory high-water is 96.75 MiB flat, 132.00 MiB solar and
148.63 MiB with trips. The bounded thermal table remains the same size; the
longer planner horizons account for the larger total allocation.

Keeping daily replans but extending the flat horizon to the remaining month
(`month-daily`, normal grant) takes 22.98 seconds and 84.56 MiB for 31 solves.
Its bill and pool trace match the 72h case to the precision above, but it is
2.75 times slower. Extending the horizon alone does not provide a speedup.

Production therefore retains 72h daily/homecoming replay and applies the exact
thermal memo. Whole-month planning is an alternative replay protocol, with
different bounded search, terminal value, resource use and outputs.

Raw timing samples, native scopes and aggregate horizon comparisons are in
[roi-performance-results.json](roi-performance-results.json).

## Reproduction

Freeze the earlier Wasm, then run the same scenarios with each artifact:

```sh
git show ea33f3e:supabase/functions/_shared/planner-wasm/solver.wasm > /tmp/roi-refinement-before.wasm
deno task bench:roi-horizons flat 72h /tmp/roi-refinement-before.wasm
deno task bench:roi-horizons flat 72h
deno task bench:roi-horizons solar-prices 72h
deno task bench:roi-horizons solar-prices-trips 72h
deno task bench:roi-horizons flat month-scaled
deno task bench:roi-horizons solar-prices month-scaled
deno task bench:roi-horizons solar-prices-trips month-scaled
deno task profile:roi --scenario flat --revision ea33f3e --score-function score_prefix
deno task profile:roi --scenario flat
```

Run timed cases sequentially without overlapping builds or test runs. Benchmark
stdout is one JSON report containing stage times, memory high-water, bills,
service, checksum and per-solve work. Full physical results and representative
problems are written to `/tmp/roi-horizon-*` and `/tmp/roi-problem-*`. Native
profiling copies sources into a temporary directory, adds diagnostic spans and
removes the copy when finished; it never changes the production planner.

## Validation

The final artifact passes 44 Rust tests, the full 1,789-test Deno suite,
frontend typechecking, `npm run build:test` and all 68 mocked browser tests in
`npm run test:e2e:local`. Full repository lint passes with no errors and 27
pre-existing warnings. The benchmark/profiler scripts also pass Deno checking
with the browser libraries and Vite declarations needed by their shared imports.
Regenerated HA contract fixtures change only planner model/revision identifiers,
with unchanged physical plans. The planner artifact used for all reported Wasm
measurements is the final artifact recorded in the results JSON.
