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
# Applies only this migration to TEST, deploys its endpoint and ingest, enables
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
load and A65 week-ahead load once per hour. P1D business A60/A61 remains a daily
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
