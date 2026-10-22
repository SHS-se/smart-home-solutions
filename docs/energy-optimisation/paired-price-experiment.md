# Prospective paired price experiment (TEST)

## Usage

```ts
const reservation = await store.begin(); // Frozen context, durable pending identity.
if (reservation.status === 'pending') {
  const forecast = buildPricePair(await store.inputs(reservation));
  await store.complete(reservation.id, forecast); // DB decides eligibility now.
}
```

```sql
SELECT * FROM public.energy_test_price_pair_scores;
```

A separate TEST worker runs hourly at minute 27. Each committed v2 generation
vintage gets one pair per configured home. The report updates automatically when
published all-in household import prices enter TEST; corrections are separate
immutable observations. No household planner or production policy changes.

## Problem and shape

Mutable price slots and their `received_at` cannot establish first knowledge.
An append-only price ledger records seed, insert and revision events. TEST
activation briefly excludes price writers, installs its trigger and seeds existing
prices atomically. The trigger is installed only by the explicit TEST enable RPC;
the migration alone leaves production dormant. The configured home is explicit.
The producer's finite all-in slots require published supplier prices; missing
supplier/grid prices are null and are not harvested as truth.

The source trigger, reservation and completion RPCs take the same transaction
advisory lock before separate fresh reads. Only READ COMMITTED is supported.
No RPC locks or writes source-price rows while holding that advisory lock.
Consequently source-price commit and forecast completion are ordered. A price
arriving while fitting makes that target ineligible at completion. Initial enable
obtains the source-table writer lock before the advisory lock.

Reservations are unique `(home, generation_run, algorithm)` and freeze exact known
prices, the immutable mix run, generation-actual observation reference and database
as-of time. Retrying a pending reservation reuses these inputs. Completion stores
fits and normalized targets once; identical retries succeed, conflicting payloads
fail. Each target permanently records its eligibility: both predictions present,
future at save and unknown to TEST then. Known targets never become eligible later.
Research tables permit service-role reads and RPC writes only, with immutable
completed evidence. Price revisions are append-only.

`ridge.ts` owns shared train-only standardization and fixed lambda=1 fitting;
`price-pair.ts` owns pure feature construction and paired forecasting. The existing
research ridge caller uses that utility without changing its outputs. Both arms
train on the same intersection of past quarter prices and complete six-type
actual production. Baseline features: Stockholm quarter harmonics (k=1,2), weekend,
exact UTC lag 168h, and complete local-day means at D-4 and D-7. UTC lag explicitly
drifts one local hour across DST; local daily means require 23/24/25 hours as
appropriate. The full arm adds B04/calendar, B12/hydro_state, B14/nuclear_ratio,
B16/weather, B19/weather and B20/calendar MW. Forecast targets use only the pinned
prospective mix, never future actual generation. Missing inputs remain unavailable;
there is no zero replacement, alternative vintage or price clipping. Load is not
an added difference in this experiment: this pair isolates generation mix.

Indexed SQL views join eligible targets to the latest immutable truth revision and
compute paired MAE, bias and daily-mean error, grouped by local lead day. A report
includes its truth cutoff, origin count and distinct target-day count. Overlapping
origins are correlated. D+3 can be partial because a rolling 72-hour window does
not cover three complete future calendar days. These are new shadow ridge models;
the baseline is not the existing live household estimator.

## Synthesis decision

Base: Codex's serialized ledger, normalized targets and automatic score views.
Adopted from Claude: separate worker, shared ridge utility, fixed UTC weekly lag,
TEST-only trigger installation and explicit partial D+3 reporting. Added durable
reservations so concurrent workers cannot freeze different contexts for one pair.
Rejected trigger-maintained outcome copies: indexed views provide immediate
comparison without another mutable or duplicated representation of errors.

## Tradeoffs and alternatives

- We accept TEST ingestion depending on a small ledger trigger in exchange for
  complete evidence of first knowledge. Trigger failures propagate.
- We accept hourly no-op calls between six-hour generation runs in exchange for
  isolating model CPU and failures from provider acquisition.
- We accept actual-MW training versus forecast-MW inference in exchange for testing
  what an eventual estimator could use; prospective results must measure the gap.

Scheduled diffs of mutable prices cannot prove concurrent first knowledge. Fitting
inside the acquisition worker couples PDF CPU and collection failures. Both lose
on correctness or operating risk despite needing fewer entry points.

## Verification and remaining limits

Verify pure replay, identical cohorts, missing inputs, DST and no future training.
Exercise live TEST transactions for price-first/save-first ordering, enablement,
identical upserts, revised truth, immutable retries and access control; synthetic
fixtures roll back. Check the first genuine pair and schedule, then full lint,
frontend build, E2E and unit checks. Initially outcomes will be pending; overlapping
quarters cannot establish improvement until many distinct days have matured.

## Operating the TEST study

`deno task deploy:market-archive` applies the explicit research migration allowlist
to `vxqpgbzseckgceopitpm`, deploys both research functions, verifies there is exactly
one current TEST home, enables that scope and requests initial collection/pairing.
The acquisition cron stays hourly; generation runs remain every six hours at
minute 17 UTC. Pairing runs hourly at minute 27 UTC, recording one pair for each
new generation run. A retry reuses its pending reservation; completed runs are
skipped. Research function names are excluded from ordinary production function
deployment in CI. Merely applying this migration does not install a price trigger
or schedule a study in production.

Run `deno task research:prices:paired-report --out NEW_DIRECTORY` for a read-only
score snapshot, its immutable truth cutoff and exact replay of the latest paired
forecast. The command writes `report.json` and `replay-evidence.json`, never tokens.
The report's known-price exclusion means already-published D+1 slots do not become
prospective evidence. No errors are reported until eligible target prices arrive.

Initial TEST verification on 22 October 2026 saved pair
`0dfae399-39ca-41e0-8260-8cc6276535a4` at 20:31:11 UTC with all 288
predictions and 184 eligible quarters (96 D+2; 88 on the partial, DST-transition
D+3). Replay matched exactly, with zero eligibility violations and zero matured
outcomes. Local PostgreSQL connections verified price-first exclusion,
forecast-first automatic scoring, the activation/writer race and rejection of
stale-snapshot isolation. Rollback-only TEST fixtures verified revised truth and
immutability without retaining synthetic prices or forecasts.
