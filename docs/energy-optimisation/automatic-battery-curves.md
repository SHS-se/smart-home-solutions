# Battery curve generators

> **Removed 2026-10-01:** the *Minimize electricity cost* (`price_only`) mode,
> its curve search and its edge function no longer exist. The battery's curve
> is the planner's own *balanced* derivation every plan, unless the home keeps
> an explicit custom curve. The "Electricity cost" section below is history.

The editor offers **Minimize electricity cost** and **Balance cost and stored
energy**. Both use published prices to generate their curve. The selected
curve then applies to the full 72-hour plan. Manual point edits select **Your
curve**; saving persists both the points and generation mode atomically.

## Electricity cost

Price-only selection ranks actual planner runs by published import charges
minus published export revenue (`billable_quoted_sek`). Wear, starts, shaping
penalties, comfort utility and retained-energy credits do not enter that
ranking. The trial planner still applies its ordinary equipment and service
scheduling policy, including the economics that generate each candidate's
schedule. This selects a curve for the existing planner, not a replacement
operating policy for every appliance. No new comfort or terminal-state floor
is imposed. A trial introducing physical infeasibilities beyond the initial
incumbent's inherited conditions fails explicitly.

The search uses deterministic coordinate pattern search on nonnegative gaps
between adjacent marginal values. A gap move changes a prefix of the curve,
allowing knees and plateaus while preserving a nonincreasing shape. Normal
proposals have ten evenly spaced points across usable battery capacity.
The exact saved curve is evaluated before its resampling, so resampling cannot
hide a better incumbent. Other seeds are the current balanced heuristic and a
zero-value curve. The lowest bill wins; ties retain the earlier candidate.

The hard limit is **160 evaluations including seeds**, not 160 complete sweeps.
The initial step is one quarter of the largest seed value or absolute published
price adjusted for charge efficiency. An unsuccessful sweep divides the step
by four. The search stops after three unsuccessful scales, 24 sweeps, or the
evaluation limit. Duplicate proposals do not consume evaluations. Completion
depends on evaluation history, never elapsed wall-clock time. A zero or flat
curve is valid: without terminal credit, emptying the battery can minimize the
quoted bill. Ten points are a useful search representation, not a theorem that
the optimum must resemble a smooth declining curve. The exact incumbent may
retain a different point count if it wins.

This is the best tested curve, **not a proven global optimum**. The narrow
architect review compared independent Claude Opus 5 Max and Codex candidates.
Both favored evaluating the actual planner with a compact adaptive search.
A linear-programming battery schedule would solve a different model unless
all current household decisions and curve-to-schedule behavior were reproduced;
LP minimizes a linear objective under linear constraints ([SciPy HiGHS
reference](https://docs.scipy.org/doc/scipy/reference/optimize.linprog-highs.html)).
Dynamic programming was considered useful for an offline discretized battery
benchmark, not a direct replacement for this curve search. Population searches
were rejected for this request's evaluation budget: for example, differential
evolution scales its population and evaluation count with parameter count
([SciPy reference](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.differential_evolution.html)).
The old thirteen predetermined curves and broad-objective ranking are removed.

## Persistence and comparison

The first request atomically captures a server-owned source in
`energy_optimisation_battery_cost_curves`, before computation. Identity is home,
algorithm version and the canonical published timestamp/buy/sell vector through
the first price gap. The latest selection's frozen source is reused when all
remaining published prices match and their end is unchanged. Elapsed quarters,
midnight, JSON property ordering, SOC, weather, demand and other measurements
do not regenerate the curve. New published prices or corrections to remaining
prices start a new search. Thus generation is normally once per daily price
release, triggered by the first price-mode request with that release, with no
publication-hour timer or CET/CEST assumption. Algorithm upgrades regenerate
once. Balanced mode still responds to fresh inputs; manual curves remain fixed.

The 160-evaluation ceiling replaces up to 40 trials every quarter with a more
thorough search per price release. Early stopping remains active. There is no
random sampling and no penalty for changing curve shape. The first saved curve
is still an exact seed. Fixing the curve does not fix the whole schedule: live
load, solar and equipment state continue to affect dispatch.

The portal and ingest use the same resolver. Switching to another curve or
replacing the current plan does not erase a price-only selection. Concurrent
requests advance the same frozen job using revision compare-and-swap. Ready
results are immutable. Completed rows older than two days are pruned while
retaining the newest result and pending jobs. Existing saved curves migrate as
custom; no saved row means balanced. Ingest overrides device-supplied selection
metadata with server-owned preferences and selection.

The price button resolves before showing its selected curve. Its preview uses
the same frozen snapshot and time for both curves, over published prices only.
Other previews also use only published prices. Energy use and end states refer
to that window, making the consequences of ignoring terminal credit visible.
Full-plan generation uses current measurements and the selected curve across
72 hours; physical/fixed-plan execution authority remains in the planner.

## Balanced behavior

Balanced derives a fresh forecast-based curve from published demand, solar,
efficiency and wear, including the replacement-price cap. The normal planner
also values service and remaining energy. This mode intentionally responds to
new measurements between plans. It no longer runs the thirteen-candidate search.
The generated points shown in the editor come from the same shared resolver
used by the planner.

## Worker budget and verification

Search is a separate `cost_curve` worker chain. A continuation contains scalar
curve/bill history and only the active trial's auction checkpoint. Completed
trials never accumulate full dispatch histories. Each worker retains the
existing 1,200 ms pause budget and 300 ms additional-auction start threshold;
the 120-second orchestration deadline includes network waits, not extra CPU.
Errors, including 546 responses, propagate explicitly with no inline rerun.
Saved progress can resume on a subsequent request.

Local tests on the supplied 18:03 replay used 35 evaluations and five worker
calls: published bill 22.3105 to 12.2378 SEK. The 17:51 replay used 40 evaluations
and four calls: 31.2027 to 22.9108 SEK. The slowest observed call was about 0.38 s,
including JSON, with requests below 114 KB. A separate local orchestration
check, with JSON round-trips substituting for database transport, measured
about 5 ms outside worker execution and less than 1 ms for cache reuse. This
excludes real database SDK/network overhead. These are local measurements, not
a guarantee of hosted CPU limits or future savings. Comparisons have different
initial states and must not be interpreted as comparing the two replays with
each other.

Tests cover canonical identity, reuse across elapsed quarters and rolling slots,
price publication/correction invalidation, monotonicity, exact
incumbent preservation, deterministic interrupted execution through JSON,
forecast-tail exclusion, server authorization, persisted source ownership,
revision races, worker failures, and editor generate/preview/save/reload flows.
Planner v40, worker protocol 6, the new endpoint and migration must be deployed
together.


With the larger search budget, the supplied September 22 replays stopped after
50 and 64 evaluations, using eight local worker calls each. The longest local
call was under 0.35 seconds. These measurements do not establish hosted CPU
performance. Ordinary cache hits perform no candidate dispatches.
