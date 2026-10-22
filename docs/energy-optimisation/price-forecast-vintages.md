# TEST forecast vintages

## Usage (caller's view)

```ts
// refreshPreparedForecasts, after the actual wind and price inputs resolve.
const context = await testPriceForecastContext(db, projectUrl, zone);
const generatedAt = new Date().toISOString();
const outlook = buildPriceOutlook(slots, history, options);
if (context) EdgeRuntime.waitUntil(recordTestPriceForecastGeneration(db, projectUrl, {
  id: crypto.randomUUID(), home_id: homeId, generated_at: generatedAt,
  model_as_of: source.captured_at, timezone: source.timezone, zone,
  algorithm: RULES_MODEL_VERSION, market_context: context,
  inputs: structuredClone({ format_version: 1,
    slot_starts: slots.map(slot => slot.start),
    published_import_sek_per_kwh: slots.map(slot => slot.import_price_sek_per_kwh ?? null),
    price_history_available: !archiveResult.error,
    price_history: history, smhi_wind_outlook: wind.wind_outlook ?? null }),
  outlook: structuredClone(outlook),
}));
```

```sh
deno task deploy:market-archive
# Applies only the authorized archive migrations to TEST, deploys its endpoint, enables
# the TEST cron and requests the first collection. Never selects production.
```

## Problem

Daily price estimates and SMHI issued-on rows overwrite intraday versions. The
prepared cache is reused, so plan issue time does not identify when a price
estimate was made. Revised ENTSO-E history cannot reconstruct original inputs.

## Shape

Two append-only public service-only tables own observations and price generations.
`energy_market_forecast_observations` records every request with a local sequence,
request/response times, native query window, result, raw XML and source metadata.
`energy_price_forecast_generations` freezes every actual producer calculation,
its exact calibrated SMHI wind days, price inputs, output and explicit market IDs.
There is no collection on cache reuse and no research ID in planner contracts.

A TEST-only `energy-market-archive` endpoint collects A69 wind/solar, A65 day-ahead
load, A65 week-ahead load and medium-range weather once per hour. P1D business A60/A61 remains a daily
range, never a fabricated quarter-hour mean. Every response, including identical
payloads, no-data and errors, is a distinct local observation. Source document
creation/revision times remain provenance; they do not order local availability.

Before calculation, one SQL context read pins the latest committed observation
and latest successful data IDs for each dataset, using the local sequence. The
producer freezes those IDs; a later insert can never become evidence for this
estimate. Missing/failed collections remain explicit. The model's existing as-of
argument stays separate from the calculation timestamp and the archive timestamp.

The migration installs inert schema/procedures. An explicit TEST enable operation
creates private cron credentials and the hourly schedule. The handler, producer
hook, configuration URL and deployment script guard TEST. CI excludes the new
collector from production. There is no production deployment or activation.

## Synthesis decision

Use the Codex candidate's two-table immutable model and explicit observation IDs.
Adopt Claude's native P1D/business-type preservation and inert-by-default enablement.
Reject its read-time timestamp-only join because late commits could become
retroactive evidence. Reject digest-only price history: preserve the exact input
needed for replay. Reject early payload deduplication until storage evidence
justifies a third table. Keep remote provider calls off household planning.

The context read occurs before calculation to remove ambiguity about a concurrent
collector commit. Recording is asynchronous and failures are logged as research
gaps; they do not change the price policy or planning admission.

## Tradeoffs accepted

- We accept up to one hour between collections in exchange for independent,
  bounded provider traffic. "Known" means actually collected by TEST, not every
  version a provider might have published between collections.
- We accept repeated payload storage in exchange for preserving observations
  without a separate content-addressed storage system.
- We accept frozen price history in TEST in exchange for reproducible training
  inputs, rather than assuming historical values never receive corrections.
- We accept an explicit evidence gap if storage fails in exchange for leaving
  household planning independent of research availability.

## Alternatives considered

Synchronous collection at every price calculation would couple provider latency
and outages to planning and duplicate shared market traffic per household. A
plan-publication hook would label cached estimates with the wrong origin.

## Verification

Test native metadata/ranges, TEST/auth boundaries, repeated and failed responses,
immutable inserts, explicit pointers across a concurrent collection, and timestamp
separation. Run real SQL migration tests, full Deno, lint, TEST build and local E2E.
Operationally verify the first three stored outcomes, a second collection retaining
both observations, an active TEST cron and a genuine producer generation pinned
to earlier observation IDs. Never insert synthetic history as real forecast data.

Deployed and enabled in TEST on 22 October 2026. The first collection completed
at 16:04 UTC; by 16:08 UTC each of the three datasets retained three successful
observations. The active cron runs at minute 7 of every hour. No production
deployment or database operation was performed.

A genuine TEST estimate generated at 16:15:46 UTC pinned all three successful
dataset observations before calculation. Replaying its frozen 384 quarters,
5,878 historical price rows and exact SMHI wind inputs reproduced the stored
prices within floating-point rounding (maximum difference 8.9e-16 SEK/kWh).
The collector preserved native PT15M solar (B16), wind (B19) and day-ahead load,
and P1D week-ahead load minimum/maximum series (A60/A61).

Validation: 1,760 Deno tests passed; frontend typecheck and TEST build passed;
local E2E completed with 83 passed and one existing skip. ESLint completed with
zero errors and 27 existing warnings.

## Open questions and risks

Earlier vintages cannot be recovered. Existing source coverage can end before a
72-hour estimate horizon; retain that gap. Raw SMHI hourly provider runs are not
archived by this change, but the exact calibrated wind values actually passed to
the estimator are frozen. No new live forecast model or retention expiry is added.

## Medium-range weather extension

```ts
const request = mediumRangeWeatherRequest(); // Fixed ten SE3 sites, ECMWF IFS 0.25°.
const document = parseMediumRangeWeather(JSON.parse(rawBody), requestedAt);
// Independent collector saves dataset: 'weather_medium_range', request.record,
// raw_body, digest, native series and local D+2/D+3 coverage in the same archive.
// Existing producer pins the extra observation ID returned by the context RPC.
```

The new dataset preserves seven days of hourly 10 m/120 m wind speed (m/s),
temperature (°C) and shortwave radiation (W/m²) at the existing ten SE3 sample
sites. These are weather drivers, not forecasts of SE3 electricity generation
or consumption in MW. The existing ENTSO-E A65/A31 daily minimum/maximum load
forecasts remain the available longer-range electricity-demand forecast; no
hourly mean demand is invented from those ranges.

Use the Codex candidate's single additional dataset in the existing evidence
stream. Adopt Claude's explicit request metadata on every outcome and separate
JSON raw-body field. Reject a second table/collector, a canonical-content hash,
and an arbitrary grid-distance rejection: none adds an invariant needed here.
Requested station coordinates and returned model-grid coordinates are distinct
provenance. The provider exposes no model issue time: store null rather than
misreading its response-generation duration as an issue timestamp.

Coverage counts native non-null samples per site and variable on local D+2 and
D+3 dates. It respects Stockholm's 23/25-hour clock-change days. Radiation is the
mean of the preceding hour; the midnight label belongs to the preceding day.
Weather failures and ENTSO-E failures are recorded independently. No provider
fallback or new price policy is introduced.

A new migration expands the closed dataset set and pinned context. Older
generation rows stay immutable; an in-flight three-key write spanning rollout
may fail as an explicit research gap instead of receiving retroactive weather.
Deploy only the collector, not the shared workspace's unrelated ingest changes.

We accept equal sampling at ten existing sites in exchange for comparability
with the wind research; it is not capacity- or population-weighted aggregation.
We accept a missing model-run timestamp in exchange for honest local acquisition
times. We accept one batch failure affecting all sites in exchange for a single
bounded request and no duplicated scheduling, authentication or persistence.

Source checks on 22 October 2026:

- [Open-Meteo forecast API](https://open-meteo.com/en/docs): one explicit ECMWF
  IFS 0.25° seven-day batch returned all four variables at all ten sites, with
  168 hourly labels per site and no missing values. The free tier permits
  [evaluation/prototyping](https://open-meteo.com/en/pricing); commercial use
  requires a subscription. This deployment is TEST research only.
- [SMHI SNOW1g](https://opendata.smhi.se/metfcst/snow1gv1): verified wind and
  temperature through 2 November, but no irradiance variable. Existing estimates
  already preserve their exact calibrated SMHI wind inputs.
- [Energy-Charts API](https://api.energy-charts.info/): Swedish current wind and
  solar ended today, explicit week-ahead requests returned 404, and load ended
  tomorrow. These responses do not supply the required longer-range series.
- [ENTSO-E load specification](https://transparency.entsoe.eu/content/static_content/download?loggedUserIsPrivileged=false&path=%2FStatic+content%2Fknowledge+base%2Fentso-e-transparency-xml-schema-use-1-0.pdf):
  week-ahead A60/A61 values are daily minimum/maximum demand, already archived.
- [Montel EQ](https://app.energyquantified.com/api/docs/) offers authenticated
  forecast-instance APIs. No licensed key was provided; no account or purchase
  was created. No verified open hourly SE3 D+2/D+3 demand feed was found.

The extension was deployed only to TEST on 22 October 2026. Its first weather
observation was stored at 16:35:22 UTC: all ten sites and all four variables
covered D+2 (24 October, 24 hourly samples) and D+3 (25 October, 25 samples).
A real price calculation at 16:36:26 UTC pinned all four datasets. Its frozen
384-quarter price outlook replayed within 1.8e-15 SEK/kWh rounding difference.
The collector remains hourly at minute 7. The existing producer was not
redeployed, and no production operation was performed.

The stored SE3 week-ahead daily load lows/highs were 7,750/9,748 MW on 24 October
and 7,942/10,275 MW on 25 October. These are the day's load minimum/maximum
forecasts, not an hourly profile or a statistical confidence interval.

Extension validation: 32 typed focused tests passed, including migration-version
uniqueness; the complete working-workspace Deno suite passed 1,777 tests. Root
ESLint and the archive-only snapshot's ESLint both reported zero errors and 27
existing warnings. The TEST build passed. All four browser suites passed against
a fresh archive-only snapshot: 83 passed, one existing skip. An unrelated E2E run
occupied port 4173, so the validation used the same suites and configuration
with port 4174 and a separate result directory. Concurrent planner changes were
excluded from that snapshot and from this archive commit.
