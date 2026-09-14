# Battery policy coverage over time and state

Implemented 14 September 2026. The offline compiler now builds continuous
remaining-time/battery-energy cells, with component C/F interpolation, a common
feasible reference and fresh held-out counterfactual solves. This extends the
[exact-anchor compiler](battery-policy-compiler.md); it does not change the live
planner, HA wire contract or inverter execution.

**The new profile is diagnostic only.** Its error evidence is empirical, and its
certified regional economic error bound is null. The existing HA reader continues
to accept its exact-anchor prototype only. This work completes the bounded offline
coverage stage, not production controller commissioning.

## Use

```typescript
import {
  compileBatteryPolicyCoverage,
  evaluateBatteryPolicyCoverage,
} from "./battery-policy-coverage.ts";

const coverage = compileBatteryPolicyCoverage({
  source: existingBatteryCompileInput,
  axes: {
    at_ms: [quarterStartMs, quarterStartMs + 300_000],
    energy_kwh: [0, 0.01],
  },
  acceptance: {
    max_component_error_sek: 1e-7,
    max_ranking_regret_sek: 1e-7,
  },
});
const diagnostic = evaluateBatteryPolicyCoverage(coverage, currentResolvedProblem);
// estimated / outside_coverage / unavailable; never a device command.
```

The example's small energy range is a synthetic test domain, not a proposed
production SOC range. Callers choose axes and explicit empirical acceptance limits.
No household defaults or calibrated values are inferred from Phil's installation.

Reproduce the committed example:

```sh
deno run --allow-read scripts/compile-battery-coverage.ts docs/energy-optimisation/fixtures/battery-policy/time-state-coverage.json
deno test --allow-read supabase/functions/_shared/battery-policy-coverage.test.ts
```

The CLI exits nonzero for invalid input or when no cells are accepted. A successful
exit means at least one diagnostic cell exists; callers still inspect exclusions.
The evaluator consumes trusted in-process compiler output. It is not a hostile-wire
reader, an actuals reconciler or a freshness/authority validator.

## Ownership and supported conditions

`battery-policy-coverage.ts` owns the grid, compilation budget, coverage proof,
interpolation, validation evidence and applicability checks. It reuses the existing
battery request schema, counterfactual compiler and authoritative household scorer.
It adds no alternative physics or future optimiser. The CLI owns file I/O.

The scope is one battery with one constant imposed-response interval ending at the
next UTC quarter. Time and initial battery energy are the only variable axes.
All other fields of the parsed problem must match the source, including future
forecasts, prices, source permissions, availability, grid limits, efficiencies,
wear, initial import for ramp history, objective data and intent/model versions.
Terminal utility is supported and remains in the closing account. Thermal/EV
models, thermal stores and service events are excluded.

Each cell is a rectangle between adjacent time and energy knots. Knots must be
strictly increasing; time is integer milliseconds within the source first interval,
with at least two milliseconds between knots. The quarter boundary itself is
excluded. Energy knots must lie within physical bounds and admit a distinct
representable midpoint. Both outer grid bounds are included. Shared boundaries
use the first accepted cell in stable time/energy order. No extrapolation occurs.
A rejected neighbour does not invalidate a boundary that another accepted cell
explicitly covers.

The original source identity and actuals timestamp remain in `source.problem`.
Sample timestamps describe counterfactual remaining horizons, not new meter
observations or newly acknowledged ledger watermarks. This module never advances
or fabricates actuals.

## Feasibility and the common reference

Every corner must contain complete, unpruned finite-graph results for every named
alternative, including the same explicit reference. A missing alternative excludes
the cell; it is not silently removed from the competition.

The compiler separately scores a physical existence witness for every alternative:
its forced current response, followed by zero battery charge/discharge. Future PV
curtailment is fixed to the minimum needed for the export limit with that idle
battery. This witness is not the economic recovery trajectory and is never sent
to equipment as a fallback operation.

For this restricted model, the current endpoint is
`initial_energy + constant_rate × remaining_duration`. It is affine in the two
axes. Current power is constant, so intermediate SOC lies between its initial and
end values; idle future operation preserves the endpoint. All remaining physical
conditions are frozen. Passing corner checks therefore establishes existence
throughout the cell, under the scorer's numerical tolerances. This is a structural
feasibility argument, not an economic approximation certificate. Economically
optimised corner trajectories are never mixed into a claimed executable path.

If idle future operation violates a future import limit, coverage is excluded even
when another future battery trajectory could serve the house. The reason is
`idle_suffix_witness_failed`, not a claim of physical impossibility. This deliberate
restriction keeps the proof small and inspectable. A broader witness family needs
its own proof before it can replace this one.

## Economic bands and acceptance evidence

Each available sample retains full J, current C and future delta F for every
alternative. Inside a cell, bilinear weights interpolate each component of all
three accounts and the relative total. Linear identities remain reconciled:

```text
C_a − C_reference + F_a = J_a − J_reference
billable = import − export
total = billable + wear + starts + shaping + ramp − service − terminal
```

The reference's F stays zero. Under the constant-current, frozen-condition scope,
C is affine in remaining duration; future value can cross economic knees and is
only approximated. No additional battery opportunity cost or fixed energy allowance
is introduced.

Five withheld coordinates per potentially usable cell—the centre and four edge
midpoints—receive fresh compiler solves. They are not used to fit the cell.
Shared tests are cached; every test still refers to a solve at that exact point.
Evidence records the maximum absolute error over all C/F/J components and relative
total deltas, plus the regret of the estimated winner against the lowest fresh
finite-graph result. Ranking uses stable IDs within a 1e-7 SEK numerical tie band;
regret is still measured against the numerical minimum, not rounded to zero.

An unavailable/pruned held-out solve, component error above its declared limit, or
ranking regret above its separate limit excludes the cell. The output retains
sample coordinates, values/failure detail, cell reasons, held-out sample indices,
and individual error records. A failing capsule can be reproduced by applying its
timestamp and initial energy to the retained source problem and invoking the exact
compiler. No continuous optimum or error bound follows from passing these tests.

There is no automatic refinement in this profile. A caller can inspect failures
and request narrower cells or additional knots within the fixed limits. When no
cell remains accepted, evaluation returns `outside_coverage`; no substitute policy
is invented.

## Bounds and implementation evidence

Each axis has 2–6 knots, hence at most 25 cells. Before solving, the compiler reserves
work for every grid vertex and five tests per cell, including a conservative
allowance for duplicate shared tests. Each potential point reserves the existing
per-alternative search budget plus one full-horizon witness score per alternative.
The whole reservation must fit 40 million scorer intervals. Input and output are
each capped at 2 MB; the existing bounded battery problem/search limits still apply.

The committed negative-price example covers 08:00–08:05 UTC and 0–0.01 kWh. It
uses nine solves (four corners and five withheld points), reserves 180,036 scorer
intervals and produces about 15 KB of compact JSON. Its measured maximum component
error is 4.44e-16 SEK and ranking regret is zero. These are synthetic example results,
not accuracy or latency guarantees for production households.

Tests cover unsampled interior evaluations against fresh solves, component
reconciliation, frozen-condition changes, boundary ownership, reference/competitor
SOC failures, unsupported idle witnesses, excess PV, invalid axes and work limits,
terminal-value interpolation errors, independent ranking-regret gates, pruned
searches and malformed public inputs. Independent Codex review validated the
restricted feasibility argument and found a battery-free-input guard defect;
the guard and regression test are included. Claude review remains deferred by
agreement.

Validation passed: 1,099 backend tests, all 31 mocked browser tests against a fresh
test build, Deno type checks, formatting and the unchanged HA provider-fixture
check. Full repository lint reports zero errors and 26 existing warnings, none
in the new coverage files.

## Remaining production work

A production consumer still needs a versioned acceptance contract for the chosen
error evidence and operational policy, a hostile-wire reader, current observation
and ledger binding, and dispatch revalidation across the accepted coverage. Native
battery response/transition models and the observation, durable journal, timer and
transport ports must then pass control-verification and rollout gates. The existing
one-millisecond exact-anchor HA lease must not be lengthened to consume these bands.

Battery remains first, pool second, car third. **Thermal modelling remains a
significant deferred workstream**, including shared heat-pump allocation, calibrated
thermal state/losses and joint recovery value. Automatic control remains the initial
scope; user controls and the notification framework stay deferred.
