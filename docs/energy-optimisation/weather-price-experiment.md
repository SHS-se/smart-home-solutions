# Weather price forecasting and the TEST experiment

## Household prices

For unpublished SE3 quarters on Stockholm D+2 and D+3, household forecast
preparation fits the weather-price regression separately with ECMWF IFS Open
Data and NOAA GFS, then averages their prices equally. A quarter with one
weather estimate uses that estimate. Quarters with neither use the existing
price estimator. Published prices remain authoritative.

The regional collection workflow publishes independent rows to
`energy_price_weather_feeds`. It decodes ECMWF IFS GRIB fields from ECMWF's
public Google Cloud mirror and reads GFS point series from dynamical.org.
Each source supplies 100 m wind, 2 m temperature and surface solar radiation.
IFS values are resampled from three-hourly output. The collector shares the
weather feature calculation with the forecast model and retains 30 days of
regional hours. Planning reads the database cache without calling the providers.

Sources are ECMWF IFS Open Data and NOAA NWS NCEP GFS data processed by
dynamical.org, used under CC BY 4.0. Forecast preparation records the source per
quarter. The original TEST experiment below keeps the SMHI-based estimator as
its baseline.

## Retired TEST study

The Open-Meteo collector and new TEST comparisons stopped on 13 November 2026.
The saved comparisons remain visible on the TEST bench. The regional price
blend described above uses its independent ECMWF and GFS feeds. Household
irradiance uses NOAA GFS data processed by dynamical.org (CC BY 4.0).

## Historical usage

```ts
const context = await store.context(tick);            // frozen at the deployed forecast's generation time
if (context.status === 'ready') await store.record(context.baselineId, buildWeatherPrice(context));
```

```sh
deno task deploy:market-archive   # applies the schema and deploys the active market collectors
```

The TEST staff bench shows the study at `/portal/planner-bench?tab=generation-mix`
under **Price experiments**. It is the default study there. The retired mix and
correction studies remain selectable.

## Question

Can a forecast of the published all-in household import price for SE3, at
15-minute resolution for Stockholm D+2 and D+3, consistently beat the deployed
wind-based estimator? Only quarters whose prices were unknown at forecast time
are scored, and both forecasts are scored on identical origins and quarters.

## Candidate: `se3-weather-price-v1`

`_shared/price-weather.ts` is a pure function. It fits a ridge regression
(fixed lambda 1, training-only standardisation, the shared `ridge.ts`) on the
logarithm of the price over the trailing 28 days of prices known at the origin.

- Weather: ten-site means of a cubic 120 m wind power proxy (the hour and the
  local day's mean), 2 m temperature and shortwave radiation.
- Calendar: local-time harmonics (three per day), weekend, weekend x harmonics.
- Level anchor: the mean log error over the last 24 known hours, decayed by 0.7
  per day of lead from the last known quarter.

One ECMWF document supplies both the training weather (its 28 past days) and the
target weather (its forecast days). Training on a model's past values and
predicting from its forecast values is an accepted mismatch: the document is the
only weather version demonstrably held at the origin.

Missing stays missing. An hour with any missing site value has no features, so
its quarters get no candidate and count against coverage. No document, or under a
week of usable history, saves an explicit unavailable run. Nothing is filled with
zero, a neighbouring hour or another source.

## Leakage rules

The origin is the deployed forecast's own `generated_at`. Everything the model
sees is selected by TEST's local acquisition time (`recorded_at <= origin`):
prices by ledger sequence, weather by observation. Provider issue or publication
times never establish availability. The SQL context and the SQL record both derive
the scored cohort from the archived deployed forecast (`private.test_weather_price_targets`),
so the worker cannot widen it or supply its own baseline.

A run is `prospective` when the database finds no price for any of its targets at
save time, otherwise `replay`. The worker does not choose the label.

## Validation

The walk-forward test used the latest deployed forecast in the 30 minutes before
each six-hourly tick (hh:50 UTC). Delivery days 25 October to 2 November 2026 were
used to choose the candidate. Delivery days 3 to 10 November were held out. The
success criterion was written down before any holdout day was scored:

1. Pooled MAE at least 5% lower than deployed at D+2 and, separately, at D+3.
2. Lower MAE than deployed on at least 6 of the 8 distinct delivery days at each lead.
3. A delivery-day block bootstrap 90% interval of the combined MAE difference below zero.
4. Candidate coverage of at least 98% of the scored deployed quarters.

The candidate met all four on the single holdout evaluation. The page recomputes
the same rules from the replayed runs stored in TEST, so the numbers shown there
are the evidence; none are stored in this repository.

Eight delivery days are few. Prices rose through the window and the deployed
forecast ran low, so part of the gain is a level effect that may not persist. The
prospective cohort is the test that matters from here.

## What each source added

Measured as additions to the candidate on the development days unless noted.

- **Wind** carries the forecast. Without it the model is no better than the calendar.
- **Temperature and radiation** add about one percent together.
- **Deployed SMHI wind input** adds nothing beside the ECMWF wind.
- **Nuclear outages**: no effect. Announced availability did not change inside any
  training window, so there was nothing to learn from.
- **Week-ahead demand**: worse. Only vintages since 22 October exist, too few days to fit.
- **Measured generation and hydrology** (lagged state): inconsistent between windows.
- **Day-ahead demand, wind/solar, the five neighbours and JAO**: never cover D+2 or
  D+3 at acquisition time, so they cannot be target-time inputs at these leads.
- **NUCS week-ahead capacities**: cover D+2/D+3, but exist only from 1 November and
  change in a few steps. A fitted coefficient extrapolated wildly on an unseen level.

Sources that start on 1-2 November could only be examined on holdout days, after
the candidate was frozen. Those looks are exploratory and did not change it.

## Shape

`energy_test_weather_price_runs` and `energy_test_weather_price_targets` are
immutable, service-role read only, and separate from the earlier studies' tables.
They share the TEST price ledger. `get_test_weather_price_comparison` is the
staff-only projection: scores per lead, per delivery day, day wins, coverage and
one selected forecast with the deployed forecast and published prices. Replay
scores are restricted to the holdout delivery days.

The worker `energy-price-weather-experiment` accepts only the exact TEST project
and the private archive token. Cron `test-energy-price-weather` requests a run at
minute 50 every six hours, after the weather, context and regional collections.
CI deploys it only through `deploy:market-archive`, never to production. The
household estimator, its preparation and the planner read none of these tables.

## Tradeoffs accepted

- We accept origins tied to a deployed forecast in exchange for strictly identical
  origins. With no deployed forecast in the 30 minutes before a tick, no run is saved.
- We accept one weather document per run in exchange for provable availability.
- We accept a model without demand, transmission or neighbour inputs until those
  archives are long enough, or reach far enough ahead, to be tested.
