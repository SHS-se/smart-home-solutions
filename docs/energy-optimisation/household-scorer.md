# Offline household scorer — step 2

## Scoped feasibility, unchanged objective ownership — 15 September 2026

Extend native physical feasibility with explicit house-supply eligibility and its declared solar accounting. Keep the one whole-house import/export, losses, wear and terminal objective; selecting a scope adds no duplicate reward or separate device battery bill. Verification demand is external unless control is physically effective. Candidate comparisons share participation, source attribution and current observations, and distinguish physical measurement from source accounting.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Implementation started 14 September 2026. This is an offline resolved-model
scorer, not the shipping planner objective or an executable HA policy.

## Usage

```typescript
import { createHouseholdScorer } from "./household-score.ts";
const scorer = createHouseholdScorer(resolvedProblem); // validates once, owns a copy
const reference = scorer.score(referenceCandidate);
const alternative = scorer.score(repairedWholeHouseholdCandidate);
if (reference.status === "scored" && alternative.status === "scored") {
  const improvementSek = reference.objective.total_sek - alternative.objective.total_sek;
}
```

`deno run --allow-read scripts/score-household.ts case.json` evaluates every
named candidate in an offline case containing `problem` and `candidates`.
Run the bundled case from the repository root:

```sh
deno run --allow-read scripts/score-household.ts docs/energy-optimisation/fixtures/household-scorer/grid-recovery.json
```

The bundled case is synthetic, with explicit assumptions, not a reconstruction
of Phil's house or evidence of commissioned device response. It compares leaving
service off with grid-supported room/EV recovery, including a battery, pool/tank
states and shared heater. Results keep the bill separate from service utility;
a lower objective is not necessarily a lower electricity bill.

## Problem and shape

The shipping `scoreDispatch` evaluates the auction's battery/EV/pool stores;
`buildPlan` adds room heating and boiler materialisation afterwards. Its padding,
clamping and implicit export clipping are incompatible with the stricter oracle
needed by the future counterfactual compiler. Changing that existing function
would also change shipping search behavior.

The offline boundary accepts a complete resolved household: absolute intervals,
named residual loads excluding the modelled equipment, thermal stores, battery,
EV and heater models, equipment availability, service curves and dated events.
Candidates contain one explicit action per equipment per interval and explicit
PV curtailment. They cannot supply projected state, costs or a feasibility flag.

- `household-case.ts` owns the closed input vocabulary and structural/semantic
  validation. Unknown fields/models, missing series and ambiguous units reject.
- `household-physics.ts` projects states and validates limits independently of
  prices and service curves. It never clamps states or silently clips export.
- `household-score.ts` owns the objective and per-interval ledger. Invalid or
  physically infeasible candidates have no rankable economic total.

All evaluation state is private to one call. Input parsing copies external data;
no shared mutable context or callbacks enter the physical model.

## Synthesis decision

Independent read-only Claude Opus/High and Codex reviews both preferred a new
resolved representation over extending `DispatchStore`. Codex is the base:
separate thermal state from equipment, use explicit routes on one shared heater,
and require complete action series. Adopt Claude's strict separation of physics
from economics and separate closing/terminal accounting.

Reject Claude's fractional within-interval compressor sharing: fractions hide
ordering, starts and temperature paths. Use shorter explicit intervals instead.
Reject temperature endpoint trapezoids for service valuation: integrated marginal
curves are quadratic, so integrate along the declared linear state path, splitting
at curve knees. Reuse existing `totalUtility` and `validateCurve` arithmetic.
Do not encode Phil's 60/20-minute settings, Nibe entities or house layout here.

## Supported physics and accounting conventions

The first model is deterministic and piecewise constant in equipment power and
prices, with intervals of at most 15 minutes that do not cross UTC quarter
boundaries. A partial first interval and subquarter traces are supported.
Thermal dynamics use an explicit lumped capacity, loss to a declared environment,
background heat and thermal withdrawal. They use an Euler endpoint update with a
linear within-interval temperature path; this is a declared model approximation,
not a claim of exact physical dynamics. Unstable loss timesteps reject.

Heat delivery is electrical input times an explicitly resolved route COP.
COP is supplied per interval with model identity; no air-source, brine-temperature
or manufacturer default is inferred. One heater may supply one route per interval;
multiple independent heaters may supply the same thermal store. Route auxiliary
power is additional electrical consumption, excluded from the heater input rating.
Heater availability and supported power levels are explicit. These materialised
flows are not thermostat permissions or promises that native equipment follows
arbitrary watts. Native response/transition models remain later work.

Battery input and output stay gross and mutually exclusive within an interval.
Solar charging and battery export have explicit allocations, checked against PV,
load, grid balance and source/destination permissions. EV current steps and
connection assumptions are explicit. EV predictions are conditional model
outcomes, never achieved service. This first EV model covers charging from an
initial state; it does not yet model trip withdrawals or departure/return cycles.
State is stored in kWh or Celsius; this version requires resolved curves in those units. No curve is rescaled to meet a cap.

The objective is purchases minus export, plus gross storage wear, heat-pump
starts and separately reported shaping/ramp preferences, minus service utility
and post-horizon terminal value. Resistive heaters, EVs and batteries have no
start penalty. A running heat pump changing service route does not pay a new start.
There are no grid energy entitlements or SHS minimum-runtime fields.

Continuous curves integrate to a SEK/hour rate, integrated over each interval.
Dated events use state at their absolute boundary, once unless already completed.
Events at an interval start belong to that interval; an event exactly at the
horizon end belongs to the separate closing account. Future events remain dated
and receive no in-horizon reward. Terminal entries describe post-horizon coverage
and cannot claim an in-horizon event. Total components derive from interval plus
closing accounts. Summing intervals before a boundary therefore excludes terminal
value and events on that boundary, suitable for the later J/L/F split.

## Tradeoffs and remaining work

We accept a second scorer in exchange for preserving production behavior while
proving the new objective. We accept a closed, limited physical vocabulary in
exchange for honest unsupported-model rejection and reproducible examples.
Aggregate connection limits and an explicit no-demand-charge tariff are supported;
phase limits, general tariff statistics, nonlinear/native response, uncertain
operations, conditional reservation release and scenario probabilities are not.
Unknown fields cannot silently enable any of those unsupported capabilities.

The separate [capture accounting audit](household-capture-validation.md) now checks
current replay capsules against their own electrical forecasts and published
price ledger. It is not an adapter into this scorer.

Legacy snapshots/capsules do not contain all required resolved room utility,
shared-equipment or response evidence. There is deliberately no automatic legacy
adapter. Captured-case resolution, model calibration, joint suffix search and the
policy compiler remain subsequent work; passing these offline tests does not
complete production or physical commissioning gates.

See [controller policy](controller-policy.md) and
[verification requirements](verification-and-delivery.md).
