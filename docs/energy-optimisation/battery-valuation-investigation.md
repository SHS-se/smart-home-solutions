# Battery valuation investigation — 7 September 2026

## New explicit intent requirement — 15 September 2026

Future valuation audits must compare actions within the same explicit battery house-supply scope and solar-attribution convention. Scope limits eligible demand without assigning physical electrons to devices. Measured current demand and future replenishment both matter; neither a forecast-sized cap, rating-wide cap nor an unrepaired fixed-tail minimum establishes optimality. Historical examples below retain their original policy/version assumptions.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

Historical experiment, not a competing current specification or current unresolved
questionnaire. Preserve its capsule arithmetic and limitations; subsequent decisions
and implementation are in the [planner](planner.md) and [decision register](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md).
Their curve-valued objective was superseded on 6–7 October 2026 by the
[planner score-card redesign](planner-scorecard-redesign-2026-10.md).

Source: the household's `plan-2026-09-06-16-30.json` workbench export, captured at 16:30 UTC on 6 September. It contains 288 quarters, EV and battery stores, and both planner and manual schedules. The pool is absent from this export.

## Result

The existing search left a cheaper, physically feasible schedule unexplored **even under its existing battery curve**. Changing the curve is therefore not necessary to demonstrate a real improvement on this case.

| Complete 72-hour forecast | Planner | Manual | Manual with final energy restored |
| --- | ---: | ---: | ---: |
| Variable electricity bill, SEK | 50.0008 | 46.1789 | 48.8525 |
| Modelled wear, SEK | 0.9940 | 1.0948 | 1.0948 |
| Final battery energy above the hard floor, kWh | 15.7465 | 13.7301 | 15.7465 |
| Final EV range, km | 352.9592 | 352.9592 | 352.9592 |
| Existing objective, SEK; lower is better | -7.3737 | -6.9908 | -8.4212 |

The EV's entire charging schedule is unchanged. Restore the manual battery's missing 2.0164 stored kWh with 2.1225 AC kWh, at the recovered 95% charge efficiency:

- 9 September, 13:45 Stockholm time: add 1.5048 AC kWh at 1.2588 SEK/kWh.
- 9 September, 14:00 Stockholm time: add 0.6177 AC kWh at 1.2617 SEK/kWh.

These additions cost 2.6736 SEK, remain within the battery power/state limits and 6.6 kW import-shaping threshold, and restore exactly the planner's final battery energy. The resulting bill saves **1.1483 SEK**, and the existing objective improves by **1.0475 SEK** after wear. The production scorer reports no infeasibilities.

This is a feasible counterexample, not a global optimum or a measured bill saving. The added purchases are in forecast-price quarters. The v1 export omits publication flags, so the audit does not recompute quoted-price savings or claim an exact reproduction of the live search. It does reproduce both original complete-horizon bills, wear, service utility and objective scores before constructing the alternative.

## Why the search missed it

The battery is a lossless store in usable DC kWh, with explicit conversion efficiencies. Its utility is weighted at the horizon end. The same curve nevertheless prices individual charge/discharge candidates throughout the horizon.

An individual discharge can lose to retained value even when a paired discharge and cheaper later purchase saves money while leaving terminal energy unchanged. The existing post-settlement transfer search handles this pair only when the purchase can use surplus solar. It does not consider its grid-replenishment equivalent. This export also stopped at `settle_cycle`, which provides no optimality guarantee.

The next battery search change should evaluate discharge/replenishment pairs using both available solar and grid purchases, enforcing publication restrictions, both legs' incremental grid/shaping costs, conversion losses, wear and every intervening state bound. Measure CPU cost on this export before shipping: a naive expansion of the all-pairs search can worsen ingest's worker-limit failures.

## What the curve does and does not establish

The upper band values stored energy at about 2.0353 SEK per DC kWh. The curve is constructed once from the most valuable deficit period anywhere in the horizon, then also used as a continuation value at the end. It is not a time-indexed marginal cost-to-go calculation, nor is it derived from a forecast beyond the horizon.

That makes its continuation interpretation questionable, but simply lowering the curve would conflate a valuation change with a demonstrated search defect. The equal-final-state example cancels the continuation value entirely and still wins. Keep the curve unchanged for this investigation; address paired search before tuning its levels. A later continuation-value change needs an explicit treatment of future replenishment and uncertainty beyond the horizon, without reinstating an arbitrary end-SOC target.

## Changes made alongside the investigation

Historical scope note (13 September): the removal recorded below did not establish
that generic relay minimum-on/off fields are absent from current HA code; those
fields and enforcement still exist and are now explicitly retired in the target.
No home/EV battery switching penalty is introduced by the current design.

- Removed planner minimum-runtime inputs and enforcement from the service contract, dispatch, workbench and HA mapping/configuration. Single-quarter runs are permitted at executable power. Equipment protections remain local.
- Preserved the pool's existing curve and introduced no new EV switching coefficient. A switching penalty is a separate soft preference, not a hidden minimum run.
- Fixed settlement's physical checks: removing a discharge can overfill a later charge; removing another load can leave an unauthorised export. Both are now checked before accepting the settled schedule.

The HA update must be installed before deploying server plans without the removed service field: the old HA validator required it. No deployment or release is part of this change.

## A second case: an unpaired discharge, 7 September

Source: `plan-2026-09-07-09-30.json`, captured at 09:30 UTC on 7 September. EV and battery, 288 quarters, no pool.

| Complete 72-hour forecast | Planner | Manual |
| --- | ---: | ---: |
| Existing objective, SEK; lower is better | -15.2009 | **-15.9240** |
| Variable electricity bill, SEK | 47.8493 | 44.6633 |
| Modelled wear, SEK | 0.7224 | 0.8184 |
| Battery charged / discharged, kWh | 18.2654 / 13.7250 | 18.2654 / 15.5497 |
| Final battery energy above the hard floor, kWh | 6.7558 | 4.8350 |
| Final EV range, km | 355.3333 | 355.3333 |

The two schedules differ in **nine consecutive quarters and nowhere else**: slots 77–85, 05:00 to 07:00 UTC on 8 September. Battery charging is byte-identical across the whole horizon, and the EV's schedule is untouched. The manual plan discharges 1.8247 kWh more and imports that much less.

In each of those nine quarters the planner imports at **1.6485–1.7833 SEK/kWh** while holding 3.8788 kWh it prices at **1.4063 SEK/kWh** — its own published `worth_sek_per_kwh`. The production scorer reports no infeasibilities against the manual schedule.

### Why this is not the case above

The first case needed the equal-final-state construction to win: its raw manual plan *lost* on the existing objective (-6.9908 against -7.3737) and only won once the missing energy was replenished (-8.4212). This one wins outright, by 0.7230 SEK, with no replenishment at all and no pairing to construct.

The paired defect is present here too — `audit-battery-valuation.ts` restores the 1.9208 kWh and reports a 1.0262 SEK bill saving and a 0.9302 SEK objective saving — but it is not required to demonstrate the loss. A single-leg discharge, priced below the import it would displace, was available and not taken.

That matters for sequencing. The recommended next step above is an all-pairs discharge/replenishment search, which the same section warns may worsen ingest's worker-limit failures. This case is not reachable by pairing and does not need it: if unpaired discharges priced below the prevailing import are being declined, that is both cheaper to fix and strictly prior to the paired search.

### Where to look

This export also stopped at `settle_cycle`, after 1030 iterations. A discharge that improves the whole plan while scoring negative in isolation is the shape settlement releases and the auction re-bids, and what ships is whatever the loop held when cycle detection stopped it. That is a hypothesis, not a finding: the v1 export carries schedules and prices but neither the allocation diagnostics nor the store weights, so it cannot distinguish a discharge never bid from one bid and outranked from one bid, won and released. The v2 export below carries all three; re-run this case against it before choosing a fix.

### Limits

Slots 77–85 fall outside the plan's binding window, which ends at 21:45 UTC on 7 September. This stretch is indicative and will be regenerated before it executes, and its prices come from the shaped prior rather than the market. The objective defect is real and reproducible; the 3.1860 SEK is a forecast-window figure and not money off a bill.

## Export format v2

v1 recorded what each plan did and not what it was decided against, so an audit could compare the two schedules it was handed but never check either. `shs.plan-workbench.v2` adds:

- **Per store:** `usage_weight`, `terminal_weight`, `retention_per_slot`, `wear_sek_per_kwh`, `start_cost_sek`, `cycling_cost_sek_per_unit`, and the conversion coefficients sampled on the planner's own trajectory (`units_per_kwh_by_slot`, `state_per_kwh_out_by_slot`, `drift_by_slot`) with `*_is_constant` flags. The curve was already carried.
- **Per quarter:** `published_price`, the omission that stopped this audit recomputing quoted-price savings; and `planner_allocations` and `planner_battery`, the accepted moves and the pack's charge/hold/discharge comparison.

The audit accepts both versions. On v2 it prefers the stated weights and coefficients over the ones it recovers from measured transitions, and cross-checks the two: a stated coefficient that disagrees with the schedule's own movement now fails rather than being silently overridden. Quoted-price columns are reported when the flags are present and null otherwise.

## Reproduce

```sh
deno run --allow-read scripts/audit-battery-valuation.ts /path/to/plan-2026-09-06-16-30.json
deno bench --no-check scripts/benchmark-energy-optimisation.ts
```

The audit deliberately supports only the EV-and-battery case with recoverable constant conversion coefficients. It fails if it cannot reproduce the saved objective or validate the replenished schedule. It does not import the household's export into production or change its live plan.
