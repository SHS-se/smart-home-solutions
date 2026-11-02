# Forecast accuracy

The server recalculates a home's report when its inputs change: a published
plan, a measured household or device quarter, or a published price. Each change
queues one durable job at the end of its five-minute bucket, so a home is
recalculated at most every five minutes and not at all while nothing changes.
Queuing runs in a statement trigger that can never fail the write that caused
it. The minute cron posts each job once its bucket has closed; leases and
fencing prevent a late attempt from overwriting another attempt. Reports are
kept for two days, since readers want only the latest. Reads never calculate scores. Both planner pages
read the same report (version 3). It has two scores: historical accuracy per
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

Each energy row includes forecast and actual kWh, absolute error, signed bias,
compared quarters and gaps. Positive bias means overestimation. A percentage bias
is unavailable when actual energy is zero. Daily, planner-model and forecast-lead
summaries help distinguish changing demand from a persistent directional error.
The dialog shows the comparison period separately from calculation time. The
score and all details use the same stored report, without extra history reads.

## Input accuracy

Input accuracy is system health, not forecast error. Home Assistant scores its
own inputs whenever the app shows them. It checks them every minute and sends
a changed result with its runtime report, at most every five minutes; the
15-minute exchange sends it too. A failed send waits as long as a sent one.
The live checks are one share each, healthy over expected. The headline is the
average of the checks that have a score:

- **Prices** — the latest report's price estimate accuracy. It stays unscored
  until a published price has been compared.
- **Solar forecast** — configured forecast sensors whose `watts` attribute
  planning can read as a timestamped series; a numeric state alone is not
  enough. Homes without solar skip it; solar without a forecast scores zero.
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
source plan IDs, plus the price comparison's sums. The former battery SOC
residual is explicitly unavailable: HA supplies quarter means while the planner
supplies endpoints (`endpoint_vs_interval_mean`). It does not affect energy
accuracy and must not calibrate physics.
Battery diagnostics also compare shifts of -30, -15, 0, 15, 30 and 60 minutes;
these do not change the reported score. `[FORECAST-ACCURACY]` logs each completed
device calculation. HA logs the shared report, including its calculations, once
when received so the app log download preserves the evidence.

Routine learning remains diagnostic information. Acquisition, command,
configuration and unavailable-comparison failures remain actionable attention.
Accuracy never participates in plan admission, permissions or device execution.

## Bounded evidence read

`read_energy_accuracy_evidence` is a service-role-only, read-only RPC. It selects
compact evidence from archive records once and reads measured rows within the
same database snapshot. Whole overlapping forecast documents do not reach the
worker. Selection and scoring have separate owners: SQL selects; TypeScript
performs the existing floating energy arithmetic.

Energy, room temperatures and price estimates retain different selection rules.
A newer invalid energy prediction becomes a gap; it does not select an older
forecast. A room omitted from a newer slot retains its previous eligible
prediction under the existing room policy. Future prices remain comparable as
soon as published, including estimates from partial forecast slots. Catalog
names and latest rosters include records without winning energy quarters.

Selection preserves millisecond publication comparisons, UUID ties, duplicate
slot ordinality, first-seen order and JavaScript property ordering. Tests compare
the complete scores, sums, gaps and plan identities against a frozen, test-only
pre-change oracle. Large regression inputs are independently generated synthetic
data. Database CPU and hosted worker performance still need deployment
qualification; moving work into SQL does not make its shared-database cost free.

Report schema 3 is a coordinated roll-forward. The reader does not return old
report shapes. Deployment queues normal reporting work; it neither replans the
home nor operates a device. Existing report-job coalescing, fencing and retries
remain in force.

The previous SOC diagnostic compared a planned endpoint with a measured quarter
mean. It is explicitly unavailable with reason `endpoint_vs_interval_mean`.
Neither value is fabricated or used to calibrate battery physics. This does not
change the battery energy score. Meter AC/DC and installation-idle boundaries
must be verified before changing energy definitions or calibration.

## Offline baseline experiments

Run `python3.12 scripts/research-baseline.py --input /private/path/input.json
--out /private/path/new-report.json --app-repo /path/to/shs-ha-integration`.
Input is `{ "timezone": "Europe/Stockholm", "quarters": [{ "start": "...",
"energy_kwh": 0.25 }] }`. Establish one consistent measured residual/device
partition before preparing it. Reports must stay outside repositories.

The tool reuses the actual app estimator. Fixed candidates are the existing
profile, a coherent expected-energy centre across all three fitting stages, and
a recent-level adjustment. Each local-day origin refits on the preceding ten
elapsed days. Selection uses only earlier validation days; the final full day is
held out. Results include energy overlap, absolute error and signed bias. The
tool never publishes models, forecasts or commands. Final repaired observations
are not acquisition-time vintages, and forecast skill alone does not establish
better planner cost or battery delivery.

The dormant server `demandLevel` path is not wired into ordinary current
captures. Its historical actuals subtract only pool/hot-water/EV aggregates,
whereas the app subtracts every separately modelled device. Do not reconnect it
or stack corrections without aligning that population and choosing one model
owner. No experimental quality threshold becomes a live planning gate.
