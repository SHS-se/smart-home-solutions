# Server planner

## Explicit scope alongside forecast and economics — 15 September 2026

Emit explicit battery house-supply scope for each supported policy alternative: None, Whole house, Base, Selected Planned devices, or Base+selected. Predict current/future device consumption separately from that permission. Scope membership comes from the agreed participation contract; Verification demand stays external in executable forecasts. Current eligible demand is measured in HA and ranked using the existing remaining-interval C + V policy. Scope bounds feasibility; it does not prove every eligible kWh is worth supplying or justify a rating-wide ceiling.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Decisions requiring Phil](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md)

Status: current design requirements, reconciled 2026-09-06. This document does not certify that the shipping heuristic meets them. Historical algorithm versions and capsule results are in [planner experiments](history/planner-experiments.md).

## Responsibility and control boundary

The server constructs and solves a joint whole-home scheduling problem from a resolved, versioned snapshot. It owns the forecast horizon, service economics, shared resource constraints, and decision evidence. The browser may run a labelled preview or comparison, but production planning must not require an open browser.

The normal horizon is 72 hours at 15-minute resolution, starting from measured state. The first quarter is the normal receding-horizon action; later quarters describe the planned trajectory. Price publication, execution validity, and replan cadence are separate concepts in the [contract](contracts-and-data.md#plan-lifecycle-and-time).

The server never bypasses local equipment limits, confirmations, or overrides. [Reactive controls](reactive-controls.md) in `shs_energy` adjust execution to the conditions that actually occur between solves.

## Objective, units, and commitments

Cost minimisation with meaningful service constraints is a valid formulation. Turning everything off is feasible only when those constraints allow it. Optional comfort and readiness can additionally be valued through utility; utility is not a substitute for a guaranteed commitment.

Use the following decomposition when defining a solver objective:

```text
minimise:
  grid energy purchase cost − export revenue
  + actual incremental demand charges
  + explicitly modelled wear and start costs
  + separately identified power-shaping and shortfall penalties
  − optional service utility − continuation value
```

Grid energy is in kWh per slot: `energy_kwh = power_w / 1000 × 0.25`. Energy prices are SEK/kWh; all objective contributions are SEK. If service utility is a rate, integrate it over time. A visit/departure utility is counted at its usage event, not once for every preceding quarter.

`U(x)` is total utility in SEK. A curve point expressed in SEK per state unit describes **marginal utility**, not total utility. Integrating those marginal values gives total utility. A zero marginal value means another unit has no benefit, not that all previously stored energy is worthless. Negative marginal utility would represent disutility; the existing non-negative curve type does not express that. Overtemperature limits must not be inferred from such a curve.

The time weights for continuous warmth, discrete usage, and terminal state must be explicit, with no accidental double-counting of the same benefit. The intended service promises and remaining utility-policy choices are [D1](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d1-comfort-and-service-promises) and [D3](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d3-preferences-risk-and-battery-economics).

Hard constraints restrict feasible schedules. Finite penalties express trade-offs and cannot guarantee compliance. `min_soc` is a physical/commissioned floor. A soft reserve valuation is distinct from it. There is no automatic instruction to reinstate a hard 80% end-of-solar target.

There is no planner minimum-runtime setting. An executable quarter may stand alone; local equipment protection remains the device's responsibility. Optional start/switch costs are soft economic preferences and must be priced consistently by search and scoring, independently of run length. Start costs and the start preference apply only to heat pumps, currently the pool store with its explicit equipment start cost. Home batteries and EV batteries pay neither start nor stop penalties; energy-throughput degradation remains a separate cost. These preferences do not guarantee a minimum on/off time or carry compressor protection timers across replans.

## Cost and continuity policy (v24)

Battery charging and later discharge can now be considered as one transaction. Its benefit is avoided grid purchase, less charging cost, conversion losses and configured cycling wear; terminal utility cancels because closing storage is unchanged. A committed grid purchase requires a published price for the later use. Transactions worth at most 0.001 SEK are ignored to avoid numerical micro-adjustments. Solar is still priced at foregone export revenue.

The generated battery continuation curve is capped at the median import price in the final 24 hours of the horizon, multiplied by discharge efficiency and reduced by configured degradation. The cap is reported as `terminal_replacement_sek_per_kwh`. This remains an estimate, but an expensive hour already inside the plan no longer sets a second premium on leftover charge. The physical SOC floor remains enforced; a soft reserve cannot override the replacement-cost cap.

After the auction and joint transactions, up to eight local refinement sweeps exchange charging between quarters within one hour. The refinement minimises energy cost plus wear, starts and explicitly reported shaping preferences. Every accepted move must preserve each store's service value and pass the independent physical scorer, including state limits and executable current steps. It cannot buy a utility improvement at the expense of that cost objective. Availability is checked before moving energy. The search is local and does not guarantee the globally cheapest or smoothest schedule.

The default soft preferences are:

- Grid shaping: `0.1 SEK/kWh/kW`, applied from zero import, integrated as `0.5 × rate × import_kW² × 0.25 h` per quarter.
- Import changes: `0.05 SEK/kW` of absolute change between adjacent quarters, without inventing an initial or final zero-load boundary.
- Heat-pump starts: `0.25 SEK` per run in refinement, in addition to the pool’s `0.50 SEK` equipment start cost. Batteries, including EV batteries, are excluded.

These are scheduling preferences, not billed charges or measured equipment wear. They are published in `peak_shaping`; the scorer reports continuity separately in `continuity_sek`, and neither preference enters `billable_sek`. No Ellevio demand charge is assumed while the household has none. A future tariff requires its actual measurement windows and carried billing state.

Hot-water thermostat permission is inhibited only when the other planned net load plus the heater's rated draw would exceed the connection limit. Merely charging another device no longer interrupts hot water. Existing maximum inhibition and recovery rules remain enforced. Local equipment controls retain responsibility for compressor safety and actual duty cycle.

Replay comparison: `deno run --allow-read scripts/compare-planner-replay.ts capsule.json [from-ISO to-ISO]`. This runs the current implementation against captured input data and compares it with the recorded plan; it never executes instructions from the capsule. Compare closing inventory as well as spending.

## Heat-pump run settlement (v26)

Settlement rebuilds continuous heat-pump runs from the actual power schedule and accounts for one equipment start per run. Confirmed operation at the first quarter waives that continuation’s start. Settlement considers trimming or removing any contiguous portion of a run, including the cost of any restart the cut creates. A slightly losing quarter therefore cannot be removed in isolation and leave its neighbour incorrectly priced as a free continuation. Diagnostics describe these actual runs and their combined net value, including after cost refinement.

Decision, 2026-09-10: fix this accounting defect first, without adding a minimum runtime or changing the existing start cost. If isolated short heating runs recur, prefer adding a separate stopping cost (discussed at 0.50 SEK), rather than increasing the start cost. A new run would need to justify its start and eventual stop across the whole run. This is a future option, not an implemented penalty; any such start/stop costs apply only to heat pumps, never home or EV batteries.

## Joint physical model

Every load contributes exactly once to the electrical balance. A separately planned device must be removed from the base-load estimate before its new scheduled power is added. Forecast and control authority are distinct fields.

Optimise interacting resources together: grid import/export; battery charge, discharge, and SOC; EV supported current steps and availability; eligible pool heat; boiler permissions; and room heat. All compete against the same connection limits and any explicit planning ceiling. A separate heuristic placement followed by other loads being added is not evidence of joint optimality.

Constraints include state transitions, capacity, electrical power, simultaneous-flow permissions, supported device modes, starts, service deadlines, overrides, and coupled/shared equipment. Initial state and ongoing-run obligations cross the horizon boundary. A device that may only be permitted or influenced must not be represented as fully controllable power without a justified execution model.

Room and tank thermal mass are stores physically, even when their current contracts only expose comfort constraints or duty-cycle inhibition. Those implementation boundaries do not remove their time-shifting economics. [Models and forecasts](models-and-forecasts.md) defines the evidence and capability limits.

## Storage value and uncertainty

Static household preferences can produce time-dependent schedules when combined with forecasts, losses, and shared constraints. It is not necessary to derive every preference curve from energy prices. The cost of producing warmth is not the household's willingness to pay for it.

A stored battery kWh is valued on the energy it can deliver, with charge and discharge efficiency applied at their respective physical flows. Solar consumption carries foregone export revenue when that export is feasible; it is not universally free. Wear must have an explicit throughput basis so it is not counted twice.

Continuation value accounts for useful state beyond the horizon. A fitted or heuristic continuation value is an approximation; a chosen covering window is not an exact Bellman solution. The relevant state may include all stores, service obligations, equipment timers, and billing history. Seventy-two hours is a product horizon, not an optimality theorem based on a thermal time constant.

Forecast uncertainty can justify reserve, but a deterministic model can also retain energy for known demand or a terminal value. A maximum price inside a forecast is not the probability or magnitude of an unforeseen spike. Existing reserve-price and battery-margin experiments are empirical policies, not proven insurance valuations.

A stochastic formulation must state scenario weights, correlated trajectories, what becomes known when, and non-anticipativity: actions cannot differ between scenarios before their information differs. A robust-quantile approach must state which limits it protects and what risk remains. Neither approach guarantees actual service merely by passing a point-forecast simulation. Product choices are in D3; technical formulation and validation belong to the engineering backlog.

## Power costs and demand charges

Three quantities remain separate:

| Quantity | Meaning |
|---|---|
| Physical connection limits | Commissioned feasibility limits, including relevant phase/inverter constraints |
| Planning ceiling | An explicit constraint below the connection limit, when configured |
| Power shaping | A priced preference for reducing peaks; it is neither a hard ceiling nor a billed charge |

A finite quadratic shaping cost can be exceeded by a sufficiently valuable action. It must not be reported as enforcing a hard ceiling. Its coefficient can trade real energy cost for smoothing; it is not necessarily a negligible tie-breaker. No numeric coefficient is prescribed by this document; the [cost/headroom decision](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d4-grid-headroom-and-peak-spending) remains open.

Actual demand charges use the effective-dated tariff function. Their state depends on that function:

| Tariff statistic | Required carried state |
|---|---|
| Monthly maximum | Running eligible maximum and any unfinished measurement window |
| Highest k peaks on distinct days | Eligible day maxima/top-k state, current day's maximum, and unfinished measurement window |
| Mean of daily maxima | Completed eligible day maxima or sufficient aggregate/count, current day, and unfinished measurement window |

Calendar, applicability windows, and 15/60-minute aggregation also belong to the tariff. Substituting a tariff rate into a per-quarter quadratic penalty does not implement this billing function. Tariff versions, not statements about a country as a whole, determine whether a home has a demand charge.

Peak reduction does not generally mean proportional discharge. Uniform loads at comparable prices can favour even discharge; varying loads, prices, limits, and later needs change the answer. Likewise there is no universal room → pool → EV → battery ordering. The household's current marginal costs and constraints determine allocation.

## Solver claims and status

Concavity does not imply an exact finite piecewise-linear representation or free computational complexity. The current interpolated marginal curves integrate to piecewise-quadratic utility, and power shaping is quadratic above its threshold. A replacement formulation must state approximations and their error, integer decisions, and treatment of state-dependent physics. Runtime must be measured.

The existing TypeScript auction and settlement passes are a heuristic. Convergence or absence of one profitable local move does not prove global optimality. Paired transfers and joint changes can improve a locally stable schedule.

The previously proposed Python/solver service remains an implementation direction, not a completed migration. The function boundary and typed snapshot can be preserved without preserving incorrect search assumptions. Benchmarks must distinguish feasible candidate, search limit, optimality bound, invalid output, and infeasible problem; see [verification](verification-and-delivery.md).

## Decision evidence

Publish the resolved inputs, effective curves, physical constraints, objective components, final state trajectories, and tested alternatives needed to explain a decision. A hold reason must distinguish at-cap, unavailable, unmodelled, not considered, and economically declined. Search ordering and later-added loads must not be presented as economic comparisons that never occurred.

A request that raises a target or changes a deadline enters the next snapshot. Device state and deviation from the preceding plan are also inputs; unconfirmed actuator changes are not treated as delivered energy.

## Fixed plans from the workbench

The household can activate an edited schedule starting at the next 15-minute
boundary. The fixed interval ends after the last modified editor period (a whole
hour in hourly editing). Every allocation in that interval is retained, including
unchanged devices and off slots. Reverting the last edit shortens the interval.
The day filter only changes what is visible. Explicit workbench export permission
is retained for its selected slots; it does not change automatic export policy.

`energy-optimisation-fixed-plan` authorises the household through the current
plan's RLS policy, validates the complete allocation shape, and materialises
executable targets through the ordinary planner simulator. Submission requires
the snapshot and fixed-plan revision the household reviewed. Passing a start
boundary or receiving a newer snapshot requires resubmission. Preflight does not
publish a historical snapshot to HA: persistence atomically requests fresh
measurements through the existing replan exchange.

One fixed schedule is stored per home in `energy_optimisation_current`. A new
activation replaces it; the previous current quarter is retained until the new
start boundary. Ingest reads its revision before solving, and a database trigger
rejects a generated write if replacement or rescission happened during the solve.
The fixed interval uses absolute timestamps, so rolling horizons and DST never
shift allocations between quarters. Storage is projected through the fixed
prefix before the automatic suffix is solved. Thermal searches also retain the
fixed device decisions. Prices, forecasts and measured state remain fresh.
Changed equipment or an infeasible fixed trajectory is reported, never silently
rewritten. HA still enforces its equipment protections and confirms execution.

The portal distinguishes queued generation, HA acceptance/rejection, scheduled
activation, active fixed control, and an expired execution lease. Returning to
automatic planning clears the stored fixed schedule and requests a fresh plan;
the UI reports the switch only after the matching generation is accepted by HA.
Expiry of the fixed interval removes its constraints from subsequent automatic
plans, without extending HA's ordinary execution lease.

Rollout requires migration `20260909120100_fixed_energy_plans.sql`, deployment of
`energy-optimisation-fixed-plan` and the updated `energy-optimisation-ingest`,
then the portal build. Executable plan schemas remain unchanged; `fixed_plan`
is descriptive metadata. The fixed controls are available before loading the
editor so a stored schedule can be rescinded after reloading the page.

## Battery charge-now versus wait requirement

The [15 September charge-timing design](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-opportunity-cost.md)
clarifies the actual-state opportunity-cost requirement. Compare each useful
current charge amount with waiting using current cost plus its conditional future;
later purchases and discharges can change in both branches. The previous projected
SOC is not an obligation. Expensive later quarters alone do not establish a need
for more stored energy when demand is already covered or later PV/refill is better.

The live schema-9 planner already includes tariffs and its battery-value
approximation. The finite continuation compiler/evaluator exists but awaits the
production host/adapter cutover. Its exact-family scoring must be checked against
fresh bounded future searches; neither is a global-optimum claim. The first next
implementation unit is an offline charge-timing audit, not a separate local
optimiser or an SOC-recovery overlay. Report cost decomposition, coverage,
projected margin before refill and sensitivity to external-demand assumptions.
Scenarios need evidence and an explicit information/risk model before they can
change control; unweighted stress cases remain diagnostics.
