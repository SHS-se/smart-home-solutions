# Portal, reporting, and comparisons

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Historical product decisions](history/portal-and-reporting.md)

Status: current presentation and evidence requirements, reconciled 2026-09-06. Dated screen layouts and component names are retained in history, not treated as competing navigation requirements.

## One plan, multiple views

Power, thermal state, prices/economics, storage, and control evidence are projections of the same plan. Share selected home, scenario, time range, and quarter where relevant. Show published versus modelled prices on the plan's time axis. A curve editor is configuration, not a second source of decision evidence.

The portal must distinguish expected load, requested control, accepted plan, and measured execution. A configured but unplanned device needs an explicit reason; at-cap is different from outbid, and missing control is different from a home without that device.

Source-derived diagnostics explain the actual decisions. Browser-authored guesses must not invent comparisons the search never made. Preserve arithmetic, bounds, and reasons for accepted and declined actions, and label partial diagnostic coverage.

## Workbench modes and comparison validity

Two legitimate workbench questions have distinct inputs:

| Mode | Inputs and comparison |
|---|---|
| Exact historical replay | Frozen resolved snapshot, then-effective curves/policy, exact price outlook and code/clock identity; compare against the stored generated result |
| Current-preference experiment | Snapshot physical state/forecast with explicitly changed current preferences; re-solve the planner comparator and score the manual schedule using those same effective inputs |

The 6 September change to read current curves is the second mode, not reproduction of the previously issued plan. A source badge and exported effective inputs must make the distinction visible. The latest settings must never silently rewrite the provenance of an exact replay.

Both schedules use the same objective and constraints. A better **feasible** manual score under the same permissions proves that the search missed an improvement. A changed export permission defines a different problem. Inherited violations remain violations even when the UI separately highlights only newly introduced ones. A tie is a tie, not proof that no solver can help or the objective is necessarily wrong.

When preferences exceed reachable state, show the conflict without silently changing either the hardware cap or household intent. Ratios that mix range and SOC must be recomputed from the actual current conversion and not described as season-invariant without proof.

## Cost is not utility and a forecast is not a bill

Report separately:

- forecast grid energy purchase cost less export revenue;
- the subset using published prices;
- actual tariff demand charges, when applicable;
- modelled wear/start costs;
- artificial peak-shaping and shortfall penalties;
- service utility and remaining useful state;
- the combined optimisation score.

Published prices still multiply forecast energy in a forward plan. Even a quoted-price cost is therefore a forecast, not an invoice or measured saving. Fixed charges can be excluded from a scheduling delta where they are unchanged, but this must not make a marginal energy subtotal look like the complete bill.

Objective improvement is not automatically cash saved. A plan can buy more electricity to deliver more comfort or retain more energy. Compare physical service and terminal states alongside monetary metrics. Skipped or infeasible runs are part of availability reporting, not silently removed from the apparent quality of the product.

Overlapping 72-hour runs repeatedly price many of the same hours. Counting distinct days acknowledges dependence but does not prove an unbiased savings estimate. Short seasonal observations do not establish annual return. Label conditional extrapolations and modelled counterfactuals; the commercial savings method remains [D7](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d7-retention-audit-and-savings-claims).

## Measured history and attribution

House-level measured grid energy times the appropriate historical variable price is distinct from per-device source attribution. Quarter-hour proportional allocation of solar/grid/battery to devices is an accounting convention: the meters do not reveal which source supplied which appliance minute by minute.

Battery charging, base load, and unmatched supply/demand must remain visible so categories do not silently disappear. When energy meters disagree, report the residual rather than asserting simultaneous exact source, device, and billing identities that the observations cannot support. Per-device allocated costs must be labelled estimates, not direct measurements of electrical provenance.

Historical prices retain publication and assumption provenance. A historical commercial-terms backfill is not an exact observed tariff merely because its writer uses the same pricing code.

## Building performance and imported declarations

Retain the separation between measured building performance, grid-based estimates, and archetype priors. Seasonal coverage matters; a summer sample cannot be presented as a measured annual heating total. The statistical/prior library, declaration parser, typed events, and historical implementation experiments are recorded in the product history.

A match to one reference certificate is a useful check, not population validation. A database function controls the write path; it does not by itself authenticate submitted certificate facts. A declaration's authenticity and normative regulatory treatment require evidence beyond the permissions on an insert.

The existing blanket renovation discount is a modelling assumption, not a universal physical law. Renovation can change usage or area without improving efficiency. The product handling of these assumptions and verification is [D8](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d8-building-performance-assumptions-and-certificate-trust).
