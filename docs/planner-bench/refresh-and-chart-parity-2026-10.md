# Bounded refresh and shared chart data — 8 October 2026

## Problem

The routine workflow expanded nine saved versions before the current candidate,
with six solves per measured case. Historical solvers took 17–20 seconds per
solve; the current Wasm fixture took 123 ms. Branch marks were updated only after
all workers. Both charts rendered `PlanPanels`, but differed in meter grouping,
palette, remainder validation, and selected-window cumulative cost.

## Usage (caller's view)

```sh
# Automatic refresh: dev first, main second, one normal solve per case.
deno run -A bench/run.ts --shas heads --scope base --current MAIN --test DEV
# Explicit diagnostic/history expansion; never selected by a normal refresh.
deno run -A bench/run.ts --shas SHA --scope diagnostics
deno run -A bench/run.ts --shas all --scope diagnostics
# Recompute stored measurements without changing source decisions.
deno run -A bench/run.ts --shas none
```

```ts
const { rows, prices } = benchChartData(series, lane);
const chart = projectPlanChart({ rows, prices, range, timeZone, devices: series.devices });
// Live PowerSection calls the same projection with prices: {kind: 'live'}.
// Neither caller projects device physics or substitutes command watts.
```

## Shape

`bench/scope.ts` owns required lanes and target selection. Explicit SHAs do not
implicitly expand to the environment heads. The runner resolves exact identities,
enforces head/base scope for automatic `workflow_run` events (whose workflow
definition GitHub takes from main even when the harness is checked out from dev),
registers environment metadata before solving, prepares cases once, and preserves
the serial store pacing. Scoped verification requires every requested base result
and all its independent audit evidence; unrequested history and diagnostics cannot
block completion. Logs distinguish input preparation, solve, independent evaluation,
and storage. History remains stored and visibly stale until explicitly refreshed.

The device model returns compressor and auxiliary electricity alongside total
electricity and thermal output. The referee captures each physical meter using the
same identities given to historical planners. Referee v13 invalidates older chart
series. `plan-chart-data.ts` owns price provenance, display units, selected-window
cost and `splitConsumption`; both charts consume it. Missing device projections
require recomputation, and inconsistent consumption leaves an explicit unknown
remainder. Pool temperature is a producer output, never inferred by a chart.

The record stores both the full supplied-criteria fingerprint and the actual
effective solver-rule fingerprint. Historical code owns its defaults, which may
legitimately differ from today's harness. Freshness compares supplied criteria;
effective rules remain policy provenance. This includes removed overrides that
historical code may still consume. The summary view exposes both separately from
the score fingerprint. Rescoring cannot make old rule-driven decisions appear
newly optimized; saving rules refreshes the current head candidates. No new
production planner is activated by these changes.

## Synthesis decision

Use Astra's bounded work scope and scoped verification as the base. Adopt Opus's
explicit historical-selection labels, timing breakdown and shared pure projection.
Prefer Astra's producer-owned per-meter output to an aggregate pool category.
Reject Opus's new present-input publication table for this increment: it expands
storage ownership without being necessary to remove the demonstrated latency.
Track the concrete rule-input freshness gap in existing records instead.

## Tradeoffs accepted

- We accept stale historical comparisons until requested in exchange for a
  predictable current-candidate refresh.
- We accept independent scoring time in exchange for keeping all rule evidence.
- We accept a referee-series update in exchange for truthful electrical meter
  profiles and one shared chart interpretation.
- We accept that main's existing solver remains slower in exchange for keeping
  production activation separate from benchmark qualification.

## Alternatives considered

Reordering all historical work still exceeds the workflow budget. Parallelizing it
violates existing service pacing without removing unnecessary solves. Fabricating
a production plan contract for bench charts leaks unrelated fields and physics
into display code. Weakening scoring changes what the benchmark proves.

## Open questions and risks

Recorded-condition bench trajectories can differ from live forecast trajectories;
the same physical trajectory must have the same display interpretation. Detailed
timings will show whether audit optimization needs separate work. Complete source
identity remains conservatively hashed by the existing adapter; the new provenance
field addresses rule-input freshness without claiming a universal input manifest.

## Next implementation step

Verify base-only call counts and retry skips, scoped complete coverage, truthful
rule-input freshness, heater startup meter decomposition, and equal chart outputs.
Run full Deno, lint, frontend build and browser tests before publishing dev, then
verify current-head results in TEST.
