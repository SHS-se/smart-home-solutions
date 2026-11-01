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
