# Battery execution policy

## Required scope extension; not in v1 — 15 September 2026

The existing software contract below does not yet encode the newly agreed explicit house-supply selector. Extend compilation, conditions, native response, bounded coverage and final-dispatch identity together, including measured eligible demand and declared PV attribution. Preserve the existing finite C + V economics and single writer. A fixed forecast ceiling or rating-wide permission is not a substitute, and missing subgroup readings cannot silently widen scope.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

The executable software contract is `battery-execution-policy-v1`. It is separate
from the offline exact-anchor compiler and diagnostic interpolation coverage.
The [cross-repository architecture decision](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-execution-design.md)
records the independent Claude Opus Max/Codex comparison and the complete wire
shape. The native Home Assistant ports and hardware cutover are subsequent stages.

The producer owns future optimisation. It compiles a bounded family of bridge-to-
anchor continuations using the existing household scorer and battery optimiser.
Each cell has an explicit feasible energy/import domain, per-component quadratic
cost terms and absolute ramp terms. The first tail ramp is replaced with the
bridge-to-tail ramp, and terminal utility is retained. HA evaluates these fixed
functions; it does not run a future optimiser. A normally ranked all-idle future
family covers continuous SOC wherever idle is physically feasible, with exact
terminal utility. The first search seed supplies the minimum native action needed
for grid limits before landing at its anchor; an infeasible HOLD placeholder does
not unnecessarily exclude charging that absorbs excess PV.

HA computes the rest of the current quarter from live stored energy, PV, real
residual load and elapsed time using a declared native-response model. Saturation
splits positive-duration physical segments without rounding through timestamps.
Current and future costs share the scorer's accounting conventions, including
negative prices, efficiencies, wear, shaping, ramp and terminal accounts.

The guarantee is **exact scoring within the published finite family**. It is not
a continuous optimum or a certified regret bound. Restricted witness construction
can leave coverage holes even when a different physical plan might be feasible.
Such gaps are explicit. The producer and reader share limits of 128,000 bytes, 12 current
operations and 64 cells after all splits; aggregate compile work is limited to
40 million scored intervals.

Only the battery is controlled by this policy. Every other device is represented
by an explicit external-demand scenario whose participant IDs match the resolved
load series. Hypothetical Planning/Verification stops or service delivery cannot
be inserted into an executable projection. Live electrical admission separately
uses observed external load and unresolved possible effects.

Forced charging uses **Command Charging (PV First)**. **Command Charging (Grid
First) is excluded from normal operation**: suppressing solar to charge from the
grid is not an accepted operating objective. This initial execution profile also
rejects all PV-curtailment witnesses. Native source feasibility is stricter than
an arbitrary imposed-flow trajectory: solar-only charging follows surplus and
house supply follows net deficit. Export requires permission, eligible prices and
protection of the configured export reserve; physical cutoff and export reserve
remain distinct constraints.

Generated policy/current-response/continuation fixtures exercise the producer and Python
consumer. Continuation tests compare cell evaluations with full household scoring
at boundaries and interior points. These checks establish software consistency;
installation coverage, forecast error, compile cadence, native transition timing,
exclusive live writer cutover and abrupt-outage behaviour remain deployment gates.
Thermal modelling, direct user controls and notifications remain deferred.


Validation for this implementation: the full Deno suite passes **1,119 tests**;
repository lint has **0 errors and 26 existing warnings**; the production and dev test-mode
frontend builds and **31 mocked-backend Playwright tests** pass. The final E2E run
uses the fresh test-mode bundle required on the backend dev branch. Explicit scoped lint for
the new backend/scorer files is clean. The generated family has 17 cells and the
cross-language corpus contains 180 current responses and 96 continuation cases.
The old offline example outputs remain byte-identical after scorer extraction.

Regenerate or verify fixtures from the backend repository:

```sh
deno run --allow-write scripts/generate-battery-execution-fixtures.ts
deno run --allow-read scripts/generate-battery-execution-fixtures.ts --check
```

From the HA repository, verify the provider and consumer copies together:

```sh
python3.13 scripts/generate-execution-policy-fixtures.py ../smart-home-solutions-t-by --check
```
