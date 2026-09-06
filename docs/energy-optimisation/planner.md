# Server planner

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

## Joint physical model

Every load contributes exactly once to the electrical balance. A separately planned device must be removed from the base-load estimate before its new scheduled power is added. Forecast and control authority are distinct fields.

Optimise interacting resources together: grid import/export; battery charge, discharge, and SOC; EV supported current steps and availability; eligible pool heat; boiler permissions; and room heat. All compete against the same connection limits and any explicit planning ceiling. A separate heuristic placement followed by other loads being added is not evidence of joint optimality.

Constraints include state transitions, capacity, electrical power, simultaneous-flow permissions, supported device modes, minimum run/off time, starts, service deadlines, overrides, and coupled/shared equipment. Initial state and ongoing-run obligations cross the horizon boundary. A device that may only be permitted or influenced must not be represented as fully controllable power without a justified execution model.

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
