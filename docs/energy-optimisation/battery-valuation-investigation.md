# Battery valuation investigation — 7 September 2026

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

- Removed planner minimum-runtime inputs and enforcement from the service contract, dispatch, workbench and HA mapping/configuration. Single-quarter runs are permitted at executable power. Equipment protections remain local.
- Preserved the pool's existing curve and introduced no new EV switching coefficient. A switching penalty is a separate soft preference, not a hidden minimum run.
- Fixed settlement's physical checks: removing a discharge can overfill a later charge; removing another load can leave an unauthorised export. Both are now checked before accepting the settled schedule.

The HA update must be installed before deploying server plans without the removed service field: the old HA validator required it. No deployment or release is part of this change.

## Reproduce

```sh
deno run --allow-read scripts/audit-battery-valuation.ts /path/to/plan-2026-09-06-16-30.json
deno bench --no-check scripts/benchmark-energy-optimisation.ts
```

The audit deliberately supports only the EV-and-battery case with recoverable constant conversion coefficients. It fails if it cannot reproduce the saved objective or validate the replenished schedule. It does not import the household's export into production or change its live plan.
