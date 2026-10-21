# ROI regression audit, 21 October 2026

The reported failures had separate causes. The deployed commit `89d39a5`
contained them, but was not their common introduction.

## Forced battery commands in historical replay

`30586d4` tightened native certification of committed battery allocations and
updated live publication to retain the executable allocation. Historical ROI
replay still retained the command's original power ceiling. After battery state
or available power changed, the next solve could therefore reject its own
committed prefix with `native_battery_power_limit`.

`86d346e` shares allocation sizing between publication and historical replay.
The replay protocol changes so saved results cannot mask the correction. Native
regressions cover forced charging/export, remaining energy and the reported
February timestamp, including the fourth committed quarter.

## Browser workers

The affected TEST tab requested an obsolete hashed worker asset and received a
404 HTML response. The browser exposed no worker error message, so every month
displayed the generic `Default model worker failed`. Reloading loaded the current
asset and exposed a second problem: DevTools paused before a possible
out-of-memory crash while instantiating projection memory.

The original monthly baseline worker (`9e8f3f6`) used the live planner adapter,
which creates a private Wasm instance for every call. A month performs thousands
of synchronous projections, including EV load-balancing trials. Native memory
reclamation then depends on browser GC keeping pace. Short calculations and
small-equipment mocks did not reliably expose this lifetime mismatch.

The replay-specific factory retains one projection instance per monthly worker;
optimizer solves still get fresh instances. Native projection state comes
entirely from each input. Allocation/free, output parsing and coverage checks
remain shared. A thrown projection error permanently invalidates that replay
instance; there is no retry or replacement. Worker termination ends its lifetime.
Empty worker errors now give explicit reload guidance.

Regression coverage includes 10,000 real native projections with changing
battery, EV and delayed pool states; comparison with isolated reference calls;
memory plateau; separate replay ownership; fresh optimizer solves; native failed
outcomes; and trap poisoning. A real browser test runs a 31-day month with normal
equipment sizes under a finite Wasm instance budget. Another test serves a 404
worker asset and checks the reload message without automatic retries.

## Saved totals and environment data

Saved report identity previously included the Wasm digest but omitted its host
source digest. A TypeScript physics/input change could leave the binary unchanged
and reuse stale totals. Report identity now includes both digests.

The scoped environment audit found recovered history, reconstructed solar and a
pool seed in TEST, absent from production. The earlier import work explicitly
targeted TEST. This supports an environment-data difference, not a finding that
production data was deleted. CI promotes code and migrations; it does not promote
per-home imported history or modeling inputs. Before publishing a report in
another environment, verify those inputs and their coverage there. Successful
arithmetic alone does not establish that the modeled inputs are complete.

## Compute regression and prevention

Profiling the same captured horizon across historical Wasm artifacts isolated the
large runtime increase to `e31621b`, which introduced delayed pool heat response.
The earlier artifact's median was about 273 ms; that commit's median was about
784 ms. The old artifact implements different physics, so this comparison
identifies the cost of the feature rather than establishing numerical parity.
The deployed artifact remained around 794 ms on that comparison.

The expensive transition was repeatedly recomputed for equivalent physical
conditions. The previous refinement memo included slot identity and was absent
from opportunity preparation, beam construction and battery responses. The
problem-bound projector now shares the same bounded, exact-condition thermal
memo implementation in each of those callers. Each owner borrows immutable
models, includes every physical condition in its key, and cannot share entries
with another problem. Prices, grid limits, accounting and logical work are still
evaluated independently. Direct execution and independent final certification
continue to bypass the memo.

Additional improvements reuse already computed thermal endpoints, count free
proposal ranges with prefix sums, count changed run boundaries on the stack,
stream the equivalent coordinated shortlist and sort only the original consumed
proposal prefix. Full candidate enumeration, ordering charges, search grants,
evaluations and replan triggers are unchanged.

Thirty paired calculations of ten real horizons measured median times of
829 ms before and 335 ms after these changes (about 2.47 times faster). Complete
selected native output matched,
including commands, physical trajectories, accounting, witnesses, work and
termination. A complete captured November comparison also matched every baseline
and scheduler output, including services and pool states: 290 solves took 213.6 s
before and 89.5 s after (2.39 times faster). Timing is machine-dependent; compare
identical inputs and run benchmarks without competing CPU work.

Native regressions check complete memo keys, isolation, collisions, bounded
memory and direct/cached parity. An operation-count regression requires at least
90% thermal reuse for repeated opportunity intervals, avoiding a fragile
wall-clock CI threshold. Proposal tests compare the streaming shortlist with the
previous full sort and require bounded prefixes to preserve results and work.
The public ROI benchmark now includes a synthetic delayed pool with a 15-point
startup curve, so a steady-response benchmark cannot hide this class of cost.
Run `deno task profile:roi --scenario delayed-pool` for stage timings and
`deno task bench:roi-horizons delayed-pool 72h` for a complete month. Qualify future
physics changes against both direct and delayed models, compare physical output
and logical work separately from elapsed time, and investigate material runtime
increases before deployment.

## Why the first working ROI could feel much faster

The first 11 October implementation projected the default controller and compared
it with recorded consumption. `1de9075`, late that day, added repeated 72-hour
optimizer solves to generate the SHS counterfactual. This is a substantial change
in the calculation's scope, not merely another rendering of the same model.
`80d4b24` then introduced continuous pool state across months, making earlier
months prerequisites for later ones when checkpoints need regeneration.

The daily/homecoming trigger itself has not changed since `1de9075`. In the
captured November input, all 260 positive EV withdrawals occur at hour boundaries.
Recovered hourly SOC is repeated across four quarters. A decline is followed by
a quarter with no decline, which the current replay treats as a homecoming and
replans. Together with 30 daily solves this produces 290 optimizer calls. This
count describes protocol triggers; it does not establish 260 physical trips or
measured charger reconnections. Changing this interpretation requires a separate
modeling decision and evidence, rather than silently suppressing replans as a
performance optimization.

The earlier public benchmarks exercised only 31 or 62 solves per month and used
direct pool response. They did not cover the combination of delayed pool physics
and frequent hourly EV events. The synthetic `delayed-pool-hourly-ev` scenario now
combines both and reproduces the high replan count without customer data:
`deno task bench:roi-horizons delayed-pool-hourly-ev 72h`.

There is no retained timing and pinned input for the user's original successful
run. The 89.5-second result proves an exact improvement over the captured recent
model; it does not establish restoration of the original perceived latency.

## Further exact compute reduction

The delayed response's release coefficients depend only on duration and the
immutable model's time constant. Profiling one captured solve found about
1.23 million coefficient calculations but only 111,140 distinct duration bit
patterns. Startup segments and thermostat root iterations repeatedly use the
same durations; preparing only whole-quarter coefficients misses much of this
reuse.

A model-owned `PoolKernel` now keeps 4,096 exact coefficient entries. Every cell
contains the canonical result for its complete duration key. The model borrow
binds its time constant; signed zero remains distinct, and collisions recompute
the same arithmetic. `Cell` enforces single-owner access without locks. Direct
execution and independent certification use the shared canonical arithmetic
without the coefficient cache. The 96 KiB coefficient allocation and the full
transition table together remain within the existing two-MiB budget.

Startup knots stream in their original order. Thermostat partitions use stack
arrays sized from the algorithm's maximum of three partition points and six
turning points. Root iterations, duplicates, comparisons and all floating-point
expressions remain unchanged. Exact zero and full endpoints are reused.

Battery continuation evaluation also enumerated identical options twice for its
two incoming charging states. It now shares option generation, physical carry
and continuation lookup, while preserving each state's separate start charge,
arithmetic order and tie handling. Search grants and declared work are unchanged.
An independent test-only copy of the previous single-state evaluator checks both
channels during native allocation tests.

Validation includes 6,144 cached/direct transition comparisons, 5,000 complete
projections against the frozen previous Wasm, complete selected-output equality
across thirty paired solves, collision/model-isolation/byte-bound tests, the full
64-test Rust and 1,702-test Deno suites, and all 80 mocked browser tests (one
existing skip). Full lint has no errors and 27 existing warnings. Thirty paired
solves measured 337 ms before and 274 ms after this additional change.

The complete captured November comparison retained all 290 solves and matched
every physical, financial and service output: the previous optimized artifact
took 89.3 s and the additional optimization took 72.4 s. The original broken
artifact took 213.6 s on this same captured month, so the cumulative gain is about
2.95 times. This remains above a one-minute month; the earlier calculation scope
and the high hourly-EV trigger count still matter.

## Observation-aware EV replay

The replay now distinguishes fresh SOC observations from the three quarter-hour
aliases of a recovered hourly mean. Every existing withdrawal keeps its exact
amount and original quarter, including mixed-resolution inputs. A withdrawal
infers absence; only a fresh nondeclining SOC observation ends that absence.
Missing readings and hourly aliases retain the previous availability. Precise
quarter observations retain their resolution. The baseline and scheduler share
this one inferred availability timeline, so neither can charge in the artificial
gaps between consecutive declining-hour observations.

Replay retains daily solves, 72-hour horizons, search grants, native checks and
the committed hour. It additionally solves when the car becomes available after
withdrawals that its selected plan could not simulate. If a daily solve already
knows the post-withdrawal state and subsequent availability, the return does not
need another solve. The protocol changes to v4, invalidating old monthly totals
and their dependent pool checkpoints through the existing calculation identity.

This is an availability estimate, not measured charger connection or evidence of
physical trip counts. Independent captures retain the existing assumed initial
connection; seeded frames slice their monthly availability. Historical hourly
means do not establish precise sub-hour driving times. The correction does not
smooth SOC, invent trip durations, shift withdrawals or reconcile mixed-source
demand. Corrected availability and planning times can legitimately change both
models' costs and trajectories; exact old savings are not the correctness test.

Pure regressions cover aliases, fine observations, missing data, mixed sources,
partial-hour initialization and open-ended absence. Native integration checks
every EV withdrawal, charging absence, electricity/EV conservation, daily/return
coalescing and executed commitments. The public hourly-EV benchmark now includes
the provenance metadata required to exercise this policy; its three-day native
regression requires six solves for all thirty withdrawals.

A paired full captured November run, using the same Wasm and pinned models,
measured 69.4 s before and 21.1 s after this correction. Solves fell from 290 to
87. Both baseline and scheduler executed every quarter, served the unchanged
withdrawal vector and passed per-quarter electricity and EV energy conservation.
These timings include both models; they do not assume linear scaling or an
identical old schedule. The three-day public count regression protects the
semantic reduction without making machine-dependent elapsed time a CI gate.
The complete public `delayed-pool-hourly-ev 72h` month measured 14.2 s and 62
solves, down from the previous protocol's 341 solves. This public harness times
scheduler replay, whereas the captured comparison above includes both models.
All 1,719 Deno tests and 80 browser tests passed (one existing browser skip),
as did frontend type checking and the TEST build. Full lint has zero errors and
27 existing warnings. Regenerating the HA fixtures produced no changes because
the live native planner and Wasm artifact are unchanged.
