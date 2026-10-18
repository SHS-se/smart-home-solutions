# Forecast accuracy

The server publishes one report per home at local 06:00 and 18:00. The minute
cron creates durable jobs; leases and fencing prevent a late attempt from
overwriting another attempt. Reads never calculate scores. Both planner pages
read the same report (version 2). It has two scores: historical accuracy per
component, and price estimate accuracy. There is no forward-looking forecast
score.

`energy_forecast_records` retains compact, immutable forecasts after successful
publication. Failure to archive leaves a diagnostic gap and never rejects a
plan. Retention follows the end of each forecast horizon, preserving forecasts
issued before the seven-day measurement window. Older input-only archives
cannot reconstruct device or battery predictions and are not backfilled.

Historical accuracy uses the latest archived publication before each complete
quarter. Every component, and the aggregate, is scored the same way:
`100 * sum(min(predicted, actual)) / sum(max(predicted, actual))`, rounded to an
integer — the share of energy on which forecast and measurement agree. It is
bounded to 0..100 without clamping, so a badly missed stretch lowers the score
in proportion to its energy but cannot sink it below zero and hide later
agreement. Missing half the energy and delivering twice the energy score alike.
A false positive against zero measured energy scores zero; an entirely
zero-energy comparison is unscored. Missing measurements remain gaps.

Price estimate accuracy uses the same ratio on import prices (SEK/kWh, floored
at zero). Each archived slot keeps the planner's own import price where none was
published yet. For every quarter with a published price in
`energy_optimisation_price_slots`, the last archived estimate is compared with
that published price, so the score measures how close the planner's guess came
before the day-ahead prices arrived in the afternoon. Tomorrow's quarters count
as soon as their prices are published. Archives made before estimates were kept
cannot be backfilled.

## Input accuracy

Input accuracy is system health, not forecast error. Home Assistant scores its
own inputs whenever the app shows them and with every 15-minute runtime report.
The live checks are one share each, healthy over expected. The headline is the
average of the checks that have a score:

- **Prices** — the latest report's price estimate accuracy, so it changes twice
  a day and stays unscored until a published price has been compared.
- **Solar forecast** — usable configured forecast sensors. Homes without solar
  skip it; solar without a forecast scores zero.
- **Sensors** — usable configured meters and planning readings. The plant's
  continuously polled readings (battery SOC and power, grid, house and solar
  power) must also be under three minutes old. Meters that report on change are
  not stale for being quiet.
- **Measurements** — measured quarters with the full household balance among
  those read in the last 24 hours. A quarter missing from the recorder is a gap.
  Nothing read yet leaves it unscored.

Home Assistant sends the result beside its runtime as `input_accuracy`; an older
website ignores the field. The website validates it, stores it in `ha_runtime`,
and drops a malformed one without losing the runtime. TEST receives no runtime,
so its Input accuracy stays empty.

Baseline is household demand minus the same separately forecast device members
in that archived quarter. Missing members or inconsistent negative residuals
cannot produce a scored baseline. The savings-comparison scenario is a
counterfactual and has no measurable accuracy. Aggregate scores combine baseline,
device demand, solar and battery throughput; household demand is not counted
again. Battery charge and discharge errors are added separately, never netted.

Reports retain the underlying error sums, signed bias, paired/missing counts,
source plan IDs and battery SOC residuals, plus the price comparison's sums.
Battery diagnostics also compare shifts of -30, -15, 0, 15, 30 and 60 minutes;
these do not change the reported score. `[FORECAST-ACCURACY]` logs each completed
device calculation. HA logs the shared report, including its calculations, once
when received so the app log download preserves the evidence.

Routine learning remains diagnostic information. Acquisition, command,
configuration and unavailable-comparison failures remain actionable attention.
Accuracy never participates in plan admission, permissions or device execution.
