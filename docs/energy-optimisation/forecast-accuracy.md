# Forecast accuracy

The server publishes one report per home at local 06:00 and 18:00. The minute
cron creates durable jobs; leases and fencing prevent a late attempt from
overwriting another attempt. Reads never calculate scores. Both planner pages
read the same report. Its plan ID and calculation time identify the forecast
evaluated at the latest scheduled boundary, even if another plan arrives later.

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

Current forecast accuracy estimates future performance from paired errors at
comparable issue-to-target leads: below six hours, six to 24 hours, and 24 hours
onward. Each target contributes at most once per lead bucket. The current
forecast's energy weights each bucket's matched share, the same ratio as above.
Missing evidence for a positive forecast component or lead leaves that estimate
unscored. No warning count or
sample-count penalty invents an accuracy percentage.

Baseline is household demand minus the same separately forecast device members
in that archived quarter. Missing members or inconsistent negative residuals
cannot produce a scored baseline. The savings-comparison scenario is a
counterfactual and has no measurable accuracy. Aggregate scores combine baseline,
device demand, solar and battery throughput; household demand is not counted
again. Battery charge and discharge errors are added separately, never netted.

Reports retain the underlying error sums, signed bias, paired/missing counts,
lead buckets, forecast weights, source plan IDs and battery SOC residuals.
Battery diagnostics also compare shifts of -30, -15, 0, 15, 30 and 60 minutes;
these do not change the reported score. `[FORECAST-ACCURACY]` logs each completed
device calculation. HA logs the shared report, including its calculations, once
when received so the app log download preserves the evidence.

Routine learning remains diagnostic information. Acquisition, command,
configuration and unavailable-comparison failures remain actionable attention.
Accuracy never participates in plan admission, permissions or device execution.
