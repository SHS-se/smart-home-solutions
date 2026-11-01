# Market data foundation

## Usage (caller's view)

```sh
deno task deploy:market-archive
deno task research:market:report --out NEW_PRIVATE_DIRECTORY
deno task research:market:assess --out NEW_PRIVATE_DIRECTORY
```

The collector commits an expected-request batch before contacting providers. Each
observation and its versioned quality assessment commit together. Reports freeze
explicit observation IDs, then read bounded parsed-document projections. Report
artifacts belong outside this public repository.

## Problem

A successful download does not establish complete coverage or forecasting skill.
The archive needs actual demand, neighbouring forecasts, directional network
context, explicit missing collections and repeatable accuracy reports. Failed
price experiments must not be reactivated by deployment. Existing evidence and
the household wind estimator remain independently owned.

## Shape

The existing observation journal retains raw responses, native units, revisions,
request windows and local acquisition identities. Two append-only tables own
expected collection requests and derived, versioned quality assessments. An RPC
commits an observation and its assessment atomically. Old observations retain
unknown batch identity; assessments can be derived from their retained documents.

The hourly collection acquires SE3 day-ahead inputs and JAO Nordic net-position
bounds and directional exchange extrema. Generation research keeps its existing
nine inputs every six hours. A separate six-hour context collection acquires
28 days of actual SE3 demand and day-ahead wind/solar and demand forecasts for
SE2, SE4, NO1, FI and DK1. Neighbour datasets have distinct names and areas so
they cannot replace SE3 pointers. Generation references retain their exact
nine-source contract.

JAO values retain native labels and MW semantics. Individual directional extrema
are not simultaneously available capacity and must never be summed. Missing
future dates remain missing. Full flow-based domains and authenticated NUCS
outage impacts are explicit capability gaps, not zero-valued inputs. Weather
retains the selected model, grid positions, interpolation semantics and unknown
provider issue time. Acquisition time never becomes an invented model issue time.

Quality assessments expose source outcomes, native coverage, nulls, duplicate or
conflicting intervals and provider messages. Freshness is reported against the
configured collection cadence; it is not a household planning admission gate.
No prediction bounds, source-timestamp ordering requirements, substituted inputs
or provider fallbacks are introduced.

Demand reports compare locally available forecast vintages with subsequent actual
demand on identical complete intervals, including 23/25-hour Stockholm days.
Week-ahead minima and maxima are separate daily-extremum forecasts. Reports count
distinct target dates and keep overlapping origins visibly correlated. Newer
successful actual documents replace their requested interval, including gaps;
older truth cannot silently fill a newer omission. Reports freeze their exact
forecast/truth IDs so later revisions cannot change a saved report.

## Synthesis decision

Use the Claude candidate's compact assessment projection and separate context
collection. Adopt the Codex candidate's atomic evidence/assessment commit and
explicit report manifests. Reject a normalized point store, a second raw-data
system, read-time timestamp-only evidence selection and automatic gap filling.
Keep native parsed documents as the value source. Preserve old evidence rather
than fabricating batch identities or deleting unsuccessful results.

## Tradeoffs accepted

- We accept a separate six-hour context batch to preserve generation ownership.
- We accept unknown historical batch identities to avoid manufacturing evidence.
- We accept limited verified network horizons while authenticated longer-range
  access remains unverified.
- We accept explicit failed or incomplete acquisitions instead of substituting
  another provider or concealing missing inputs.

## Retirement and validation

Price-worker schedules and write entrypoints are retired. The ledger trigger,
baseline archive, historical results and frozen replay modules remain available.
Deployment enables ledger capture independently and cannot recreate retired jobs.
All activation remains TEST-only; schema installation alone starts no production
collection.

Validate atomic writes, access controls, interrupted batches, native gaps and
conflicts, DST, ledger continuity, immutable historical results and exact generation
references using synthetic inputs. Run migration uniqueness, full Deno, root
lint, typecheck, TEST build and local browser suites before deployment. Verify
genuine TEST acquisitions and retained history after deployment.

## Weather validation and automatic monitoring

```sh
deno task research:market:status
deno task research:weather:report --out NEW_PRIVATE_DIRECTORY
```

The second design review uses the Claude candidate's SQL collection-health check,
which continues to work if the HTTP workers fail. Weather and demand accuracy run
in separate daily worker invocations to isolate CPU and memory budgets. The Codex
candidate supplies frozen input manifests, station-aware request validation and
exact replacement of revised measurements, including omissions.

A six-hour `weather_truth` batch archives SMHI parameters 4 (10 m wind, hourly
sample of a ten-minute mean) and 1 (2 m instantaneous temperature) at the ten
forecast sites. A fixed `latest-months` request supplies a declared 90-day hourly
window. Provider replies, heights, positions and G/Y quality flags remain native.
G measurements form primary scores; Y measurements are separate diagnostics.
Unknown flags, conflicts, missing measurements and changed locations are explicit
exclusions. No 120 m wind or radiation measurements are assumed. Model grid values
and station measurements have different spatial and wind-averaging semantics.

Accuracy uses complete Stockholm target dates after local forecast acquisition,
with the latest forecast per origin date and target date. Scheduled runs cover
27 complete target dates, which fit the existing 28-day actual-demand product.
Reports preserve exact source identities and scorer versions. MAE, RMSE, bias,
matched and excluded hours and distinct dates are reported per site and lead.
No percentage deterioration alarm is calibrated from the short correlated history;
accuracy is scored automatically and operational coverage failures raise alerts.

Collection health runs hourly in SQL. It reports incomplete batches after fifteen
minutes, collection or source staleness after twice its cadence plus fifteen
minutes, repeated provider failures, semantic changes, internal interval gaps,
weather forecast lead coverage and measured-weather coverage of the previous day.
These are operational monitoring policies, never household forecast admission gates.
Accuracy evaluations become stale after 36 hours. Stable problem fingerprints omit
changing ages and counters, so repeated checks stay quiet. New problems, meaningful
changes and recovery become append-only events. An app heartbeat reads those events
and separately detects failure of the SQL monitor itself.

We accept separate weather and demand invocations in exchange for bounded resource
use, and append-only event state in exchange for avoiding another mutable incident
store. A normalized point warehouse and default-branch CI scheduling were rejected:
the existing journal already owns values and this work must operate in TEST/dev.

### Verified regional sources

The user supplied `NUCS_WEB_API_TOKEN` in TEST. Authenticated read-only probes
verified the five SE3 borders in both directions. Weekly transfer capacities use
NUCS A61/A02 and published daily MW values; transmission notices use A78 and
retain native revisions, cancellation status, reasons and affected series. A
separate six-hour `regional_context` batch archives these twenty requests. The
existing generation and day-ahead batches retain their contracts. Shared bounded
provider acquisition and XML/ZIP decoding own redaction, limits and decoding.

These NTC publications are not a joint flow-based domain. Outage notices must not
be summed into a fictitious available-import number, and unspecified status is
not relabelled as active. A no-matching-outage acknowledgement is retained as
`no_data`, including its HTTP status; it is not a numeric zero or a transport
failure. Authentication succeeded for IG-182/184 flow-based requests, but the
next week and two prior tested weeks returned no matching publications. The public
JAO preliminary D-2 sample was also unavailable at the probe time. Neither missing
product is enabled as a substitute for the verified feeds.

Primary references:
- [NUCS weekly capacity parameters](https://www.nucs.net/nucs/web-api-docs/web-api-di-1-8-forecasted-week-ahead-transfer-capacities-111.html)
- [NUCS transmission availability parameters](https://www.nucs.net/nucs/web-api-docs/web-api-di-2-1-changes-in-actual-availability-in-the-transmission-grid-101b.html)
- [Nordic flow-based publication handbook](https://nordic-rcc.net/wp-content/uploads/2025/10/Publication-Handbook-NUCS.pdf)
