# Date-normalized price correction experiment

## Usage (caller's view)

```ts
const reservation = await store.begin(algorithm);
if (reservation?.status === 'pending') {
  await store.complete(reservation.id, builders[algorithm](reservation.context));
}
```

```sh
deno task research:prices:correction-replay --input PRIVATE_DIRECTORY --out NEW_PRIVATE_DIRECTORY
deno task deploy:market-archive
deno task research:prices:correction-v2-report --out NEW_PRIVATE_DIRECTORY
```

The offline directory contains `runs.json` (immutable v1 context/forecast rows)
and `outcomes.json` (the matching original v1 outcome-view rows). The evaluator
first reproduces each original v1 forecast exactly, then applies the v2 model to
that run's own frozen training evidence. It never trains on the subsequently
scored outcomes. Its report explicitly identifies retrospective selection and
keeps those results separate from prospective database scores.

The staff TEST view is
`/portal/planner-bench?tab=generation-mix&study=correction-v2`. V1 and the older
generation-mix study remain selectable in the same component.

## Problem

The original correction fits correlated quarter/lead observations with a fixed
absolute ridge penalty and an unpenalized intercept. As quarter rows accumulate,
regularization weakens without a corresponding increase in independent priced
dates. A first unusual priced day can also move the entire forecast level.

Both independent Claude and Codex reviews identified these mechanisms and
recommended date-normalized estimation with neutral priors. Their larger primary
designs separated daily level and intraday shape. The private frozen-run
experiments supported the smaller same-feature alternative for this iteration.
No household measurements, replay files or private numerical evidence were sent
to the external review or added to this repository.

## Shape and ownership

`preparePriceCorrection` is the single owner of frozen cohort selection and the
existing thirteen prospective features. V1 retains its original fitting policy
and serialized predictions. `price-correction-v2.ts` owns a separate, closed fit:

```text
sum over priced dates of mean squared residual error within that date
+ 10 × number of dates × squared standardized slopes
+ squared intercept
```

Each priced target date has total weight one across its quarter/lead examples.
Feature scaling uses those same weights. Centering relative to an observed value
preserves an exactly constant fractional-MW column, avoiding a rounding-sized
standard deviation and artificial future contribution. The slope prior remains
fixed relative to mean-date loss as the archive grows. The intercept prior is one
neutral target date, continuously reducing the influence of very thin evidence.
This is one estimator, with no confidence gate, fallback model, sample-count
switch, prediction bound or price clipping. Missing inputs remain unavailable.

V1 and v2 share only numerical equation solving in `ridge.ts`, immutable feature
policy and storage contracts. The current wind estimator and household planner do
not import either correction. No planner identity, constraint or command changes
are part of this experiment.

The forward migration admits both algorithm identities. Pending reservations,
completed retries, staff navigation and score summaries are version scoped. V1
continues training on v1 examples only. V2 may reuse the original prospective
baseline/features retained by either version: its label is always published truth
minus the genuine original baseline, never another model's prediction. Every fit
retains the original source IDs and bounded ledger revision set. Price arrival
during fitting still excludes that target, and no retrospective v2 forecasts are
inserted into the prospective study.

The existing six-hour TEST worker calculates both versions independently. A
version failure does not prevent the other from saving its own result. No new
cron, provider request, live producer hook or global function configuration is
needed. The existing TEST deployment guards and private token remain authoritative.

## Synthesis decision

Choose the date-weighted single-ridge alternative common to both architecture
reviews. Adopt Codex's per-target-date support and zero-centered intercept prior,
and Claude's insistence on retaining all startup dates and measuring level,
shape and cheap-quarter regret separately. Retain the original feature vocabulary
to isolate the estimation change. Reject a new panel storage layer, quantile
transport and extra market features for this version: they add ownership and
evidence requirements before demonstrating a benefit over the smaller change.

## Tradeoffs and verification

- We accept hyperparameters selected during exploratory replay in exchange for a
  fixed candidate whose next prospective week can independently falsify it.
- We accept a small possible change in within-day ranking in exchange for testing
  a clearer correction of forecast level. Forecast MAE is not a household saving.
- We accept keeping v1 running in exchange for a preserved control and the ability
  to attribute changes to the new estimation policy.

Do not tune v2 during its validation week or exclude its early predictions.
Report identical-quarter MAE for each lead, target-date-balanced error, daily
level error and centered shape error, with distinct priced dates and partial-day
coverage. The replay also reports cheap-quarter regret for 8, 16 and 32 selected
quarters as a ranking diagnostic; this does not simulate device constraints.
Monitor the prospective study for roughly one week before considering live use.

Synthetic tests cover date-weight invariance, an independent two-point ridge
solution, constant fractional features, zero-prior arithmetic, DST and missing
coverage, unchanged baselines, exact historical v1 replay, versioned reservations,
training isolation, ledger cutoffs, immutable retries, independent worker failures
and UI cohort selection. Keep all measured validation and replay artifacts outside
the public repository. Run full Deno tests, migration uniqueness, lint, typecheck,
TEST build and all local mocked-backend E2E suites before committing.
