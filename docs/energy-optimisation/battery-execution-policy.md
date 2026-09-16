# Battery execution policy

## Production Sigen connection — 16 September 2026

The contract is `battery-execution-policy-v2`: explicit house-supply scope,
proportional solar attribution, wear basis and current/future permissions are
implemented. The HA production owner now connects the policy to live readings,
a durable sole-writer journal and actual Sigen mode/limit service calls.
See [participation decisions](device-participation-and-battery-supply.md) and
[deployment status](scoped-participation-implementation.md). This is implemented
software, not a claim that the user's inverter has been upgraded or tested.

Production uses the explicit `pv-first-dc-v2` response model. ESS command watts
and stored-energy changes are DC; converted household/grid flows are used for
costs. HA sends versioned gain/fixed-overhead curves and their current catalog.
The backend projects future battery actions using those same curves. Grid charging,
solar-surplus charging and discharging retain distinct models. Fits from isolated
history replace configured initial assumptions only when their evidence qualifies.
Reported PV remains a site-balance approximation: pure PV-to-battery efficiency
and separate PV-to-house conversion cannot be inferred from the four site meters.

Native catalog identity includes the local operating-mode revision; scope identity
also binds this catalog. Temporary withdrawal and readmission cannot reuse an old
execution grant. The supplied scope must match the source plan's explicit
`battery_supply_scope`; current generated plans declare `whole_house`.
The separately declared `pv-first-v1` AC model remains in offline tests; it is not
a fallback for Sigen commands. Missing DC conversion metadata is rejected.

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
installation coverage, forecast error and physical response/timing remain live
test work. Software tests cover the exclusive writer, restart and failed transport.
Thermal modelling, direct user controls and notifications remain deferred.


## Verification

DC fixtures cover both current response and future continuation, including fixed
losses, activation discontinuities, grid-flow sign changes and coincident floating
point roots. Python evaluates provider-generated vectors; continuation witnesses
are checked against the full household physics/scorer. Full-suite, frontend-build,
lint and browser results are recorded with the implementation change.

Regenerate or verify fixtures from the backend repository:

```sh
deno run --allow-write scripts/generate-battery-execution-fixtures.ts
deno run --allow-read scripts/generate-battery-execution-fixtures.ts --check
```

From the HA repository, verify the provider and consumer copies together:

```sh
python3.13 scripts/generate-execution-policy-fixtures.py ../smart-home-solutions-t-by --check
```

Final validation on 16 September: 1,155 backend tests, 697 HA tests, 61 HA panel
tests and 32 local browser tests passed. The test-mode website build and targeted
TypeScript checks passed. Lint reports zero errors and 26 existing warnings; the
build retains its bundle-size warning. The generated AC/DC provider-consumer
fixtures match. Deployment and physical inverter tests remain separate.
