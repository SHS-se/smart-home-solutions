# Prospective correction of the household price forecast (TEST)

## Usage (caller's view)

```ts
const reservation = await store.begin();
if (reservation?.status === 'pending') {
  await store.complete(reservation.id, buildPriceCorrection(reservation.context));
}
```

```sh
deno task deploy:market-archive
deno task research:prices:correction-report --out NEW_PRIVATE_DIRECTORY
```

The TEST staff bench exposes the study at
`/portal/planner-bench?tab=generation-mix&study=correction` under **Price experiments**.
The same comparison component also renders the original generation-mix study.
Selecting a study clears the other study's selected pair.

## Problem

The earlier paired ridge experiment asks whether generation features improve its
own price model. Its baseline is not the household estimator. The requested
experiment instead corrects the exact forecast the household already received.
The household estimator, its preparation, planner contracts and published prices
remain unchanged. No corrected output can select a live planning policy.

## Shape

`price-correction.ts` owns the pure residual model:

```ts
function buildPriceCorrection(input: PriceCorrectionInput): PriceCorrectionForecast;
// target: frozen_baseline + ridge(forecast_features)
// label: published_actual - original_frozen_baseline
```

The fixed feature vocabulary is baseline import price, local hour harmonics,
weekend, lead hours, the existing six selected prospective production candidates,
and native week-ahead demand minimum and maximum. P1D A60/A61 remain two range
features; neither becomes an invented hourly load mean. Hydro state and announced
nuclear availability enter through the selected generation candidates. Training
and inference both use prospective forecast MW, never future actual generation.
The shared ridge implementation fixes lambda=1 and scales from training only.

`begin_test_price_correction` freezes a genuine household generation, the latest
committed generation run, the latest successful week-ahead load observation and
the current truth-ledger cutoff. The correction's issue time is its reservation;
the original baseline generation time remains visible. All market versions and
values used are retained. No provider source timestamp establishes availability.

Runs and normalized targets are separate immutable research tables, sharing the
original study's ledger and advisory lock. Reservations resume pending work and
allow one run per original household generation. The baseline's entire UTC grid
is preserved, including DST quarters. Coverage beyond the generation or load
forecasts stays unavailable. Missing inputs have explicit reasons; no replacement
model, clipping, artificial prediction bound or quality gate is introduced.

Completion distinguishes **training eligibility** from **scoring eligibility**.
Both require future targets unknown to TEST at save, plus an unpublished original
baseline. Training needs complete frozen features; scoring additionally needs a
corrected price. A price arriving during fitting excludes that target from both.
The original ledger lock serializes this decision with price publication. Identical
retries succeed and conflicting completed retries fail.

The study self-seeds: first runs retain baseline and feature observations with an
explicit unavailable correction. Published truth then supplies residual labels.
Labels can train after publication even if delivery is still in the future.
Each later reservation freezes its training labels and revision IDs below its own
cutoff. The training window is 30 days, with one latest original example per UTC
target quarter and local lead group. Repeated refreshes cannot multiply its weight.
Pre-study market data is not retroactively attached to earlier household forecasts.

Both studies share one SQL score calculation and one GUI while their records,
cohorts, schedules and reports remain separate. Reports show identical-quarter
MAE, bias, daily-mean error, distinct target dates, origins, partial coverage and
waiting states. Browser projections omit coefficients and private training inputs.
The private CLI saves a snapshot and exactly replays the latest run, including a
feature-collection run before corrections become available.

## Synthesis decision

Use the read-only Codex review's separate study and prospective self-seeding
design. Keep generation/load selection in a dedicated research reservation rather
than changing the household producer or reconstructing historical forecasts.
Retain the original experiment and share its ledger, score math and rendering.
The user explicitly waived the architect skill's Claude review after automatic
approval rejected sending repository context to Anthropic. No Claude candidate
or two-model agreement is claimed.

## Tradeoffs accepted

- We accept an initial collection period in exchange for original forecast-feature
  residual pairs with demonstrable availability and no retrospective leakage.
- We accept a baseline that may precede the correction in exchange for keeping all
  fitting and research failures off the household price-preparation path.
- We accept separate run/target tables in exchange for preserving the original
  study's closed schema and assumptions.

## Operation and verification

The migration is dormant. The explicit TEST deployment command enables a separate
six-hour schedule at minute 37 UTC, after generation acquisition at minute 17,
and requests the first run. Endpoint, private configuration and deployment guards
restrict it to `vxqpgbzseckgceopitpm`. Ordinary production deployment excludes it.
Its private-token authentication is configured explicitly with `--no-verify-jwt`
in that TEST-only deployment command, without editing the global function config
and selecting unrelated household services for redeployment.
No household replan is requested.

Synthetic tests cover residual arithmetic, the unchanged baseline, no clipping,
same-feature training/inference, duplicate origins, late truth, DST, missing
market coverage, initial training collection, revised truth, price arrival during
fitting, immutable retries, access control and separate study scores. The shared
GUI has a mocked-backend navigation test. Run the complete Deno suite, migration
identity check, typecheck, lint, TEST build and local E2E before committing. Hosted
verification must confirm the first genuine run and exact replay; unavailable
correction at first activation is expected rather than evidence of forecast skill.
