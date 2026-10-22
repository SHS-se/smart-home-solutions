# TEST price forecast research — 22 October 2026

## Usage (caller's view)

```sh
deno task research:prices:collect --from 2026-08-11 --to 2026-10-24 --out /tmp/shs-price-research
deno task research:prices:compare --input /tmp/shs-price-research --out /tmp/shs-price-report
```

Collection uses only TEST (`vxqpgbzseckgceopitpm`). The ENTSO-E token stays in
the edge-function environment. Raw provider replies and a manifest are saved
locally; comparison is offline and calls the actual `buildPriceOutlook`.

## Problem

The current price level uses a 30-day wind/weekend regression without an
out-of-sample comparison. The daily coverage checks mistakenly accept 20
quarter-hour observations as 20 hours. We need evidence about wind and other
market inputs before changing the executable forecasting policy.

## Shape

- `energy-price-shape.ts` retains its public archive contract and existing
  rolling/UTC day boundaries. Its coverage reducer assigns each stored quarter
  its explicit 15-minute duration; gaps and duplicates cannot add coverage.
- A private `energy-market-research` endpoint owns ENTSO-E transport and token
  custody. Its project guard and CI exclusion keep it out of production. It
  never writes planner data or requests replanning.
- `entsoe-market-data.ts` owns the closed query vocabulary and provider XML
  interpretation, with explicit interval resolution, source metadata and gaps.
- `price-forecast-research.ts` owns rolling origins, feature eligibility,
  fitting, common-sample comparisons and metrics. Saved forecast issues must
  precede their origin. Current historical observations are identified as
  revised training data, rather than claimed to be original publication vintages.
- `scripts/price-forecast-research.ts` owns TEST acquisition and local files.
  Failed provider queries are reported, never replaced by zero-valued factors.

Core sketch:

```ts
interface MarketInterval { startMs: number; endMs: number; value: number }
interface MarketSeries { signal: string; evidence: 'retrospective'; intervals: MarketInterval[] }
interface ResearchBundle { prices: StoredPriceRow[]; observedWind: WindDay[]; windForecasts: WindIssue[]; market: MarketSeries[] }
function comparePriceForecasts(bundle: ResearchBundle): ComparisonReport; // pure, offline
```

## Synthesis decision

Use the Codex candidate's small acquisition/research boundary. Adopt Claude
Opus High's explicit CI exclusion and real-estimator comparison requirement.
Reject its required duration field on the planner wire contract: production
archive rows already represent quarters, and this correction needs no schema
change. Retain the existing separate half-day shape policy. Reject assumed
publication deadlines as proof of a recoverable historical forecast vintage;
a latest/revised ENTSO-E series is retrospective unless its issue history is
actually available. A publication deadline is not an earliest release time.

## Tradeoffs accepted

- We accept a short saved-SMHI-issue comparison window in exchange for using
  forecast information that was actually stored before each origin.
- We accept local research artifacts in exchange for no new database schema,
  background jobs or live model activation.
- We accept explicitly retrospective factor experiments in exchange for learning
  whether collecting those forecast vintages is worth pursuing.

## Alternatives considered

Adding ENTSO-E directly to live ingest would couple provider availability and
unvalidated modelling changes to household planning. A general market-data
platform would add storage and deployment obligations before demonstrating value.

## Open questions and risks

ENTSO-E sample requests currently return HTTP 599 upstream connection timeouts.
No usable ENTSO-E dataset has yet been acquired. Wind and non-wind comparisons
can proceed from existing TEST archives; additional factor comparisons must
report unavailable evidence until requests succeed. Overlapping rolling horizons
are correlated samples and cannot be counted as independent days.

## Implementation and validation

The daily coverage correction requires 80 distinct native quarter records
(20 hours), rather than 20 records (5 hours). It preserves existing rolling
24-hour normalization buckets, UTC wind-fitting buckets and the separate
intraday-shape policy. The public planner archive contract is unchanged.

The private research endpoint is deployed in TEST only. CI explicitly excludes
it from production, and the handler rejects every other project URL. The token
stays server-side. There are no new database tables, migrations, cron jobs or
live model-selection changes.

The collector retains provider status, timestamps, raw bytes, creation metadata
in source documents and a manifest. It keeps explicit native intervals, A01
missing-point gaps and A03 held blocks. Generation outages are retained for
inspection, not converted into an invented aggregate supply feature. ZIP outage
archives are explicitly recorded as unused. Transmission outages need selected
borders; there is no fabricated aggregate SE3 transmission dataset.

## Results from TEST

Collected 7,096 quarter price rows (11 August through the published prices for
23 October), 150 observed-wind days and 134 saved forecast rows. Nineteen origins
from 3–21 October had paired wind/no-wind evidence, covering 19 unique target
dates and 3,408 overlapping origin/quarter predictions. Origins are at 20:00 UTC;
72-hour horizons overlap and the predictions are correlated.

| Error, SEK/kWh | Without wind | Saved calibrated SMHI wind |
| --- | ---: | ---: |
| Quarter MAE | 0.5021 | 0.4208 |
| Daily mean MAE | 0.3925 | 0.2840 |
| D+2 quarter MAE | 0.4363 | 0.3795 |
| D+3 quarter MAE | 0.5780 | 0.4684 |
| Signed quarter bias | -0.0987 | -0.1184 |

Wind reduces quarter MAE by about 16.2% on this shared sample. It improves 14
origins and worsens 5. Both versions underestimate prices overall. This supports
retaining wind as a useful input, while challenging a constant claim that it is
the dominant price driver.

The evaluator invokes the real `buildPriceOutlook` and `forecastCalibration`.
Only saved issues at or before an origin and completed observed UTC days are
eligible. Published prices through the next local day are assumed available;
original publication vintages and original observation revisions are unavailable.
This is a historical reconstruction, not a fully vintage-preserved backtest.
Missing target quarters and missing wind issues are excluded from both paired
models. Earlier intraday SMHI issues can have been overwritten in storage, so
this reconstruction may use an older surviving issue. Non-identical overlapping
market intervals make the affected factor unavailable, and all available factor
ablations score the intersection of their held-out target days. Current historical ENTSO-E downloads would be labelled retrospective;
target-day actual-factor experiments cannot establish achievable forecast gains.

All nine ENTSO-E datasets returned HTTP 599 with
`uu-gateway-router/connectTimeout` / “Unable to access service within time limit.”
One-day A44 price and A69 wind retries also returned that error. The request
shape matches the user-supplied guide and ENTSO-E's official parameter reference.
These are transport/gateway failures rather than successful XML query responses;
they do not establish that the token was accepted by the provider.

Consequently load, solar, nuclear and outage comparisons remain unavailable.
No performance improvement from those inputs is claimed. Local acquisition
manifest: `/tmp/shs-price-research-final/manifest.json`; full comparison:
`/tmp/shs-price-report-final/comparison.json` and `comparison.md`.

## Accuracy work recommended after acquisition works

1. Archive input vintages at collection time so evaluation can reproduce what
   was known before each forecast, including repeated intraday issues.
2. Compare calendar/price-lag, wind, load-plus-solar and combined models on the
   same chronological held-out dates. Compare D+2 and D+3 separately and report
   daily level error separately from quarter-hour shape error.
3. Test residual demand (load less wind and solar) and nuclear availability;
   introduce border-specific transfer constraints only with an explicit border
   dataset and coverage policy. A single SE3 wind-speed proxy cannot explain
   the full interconnected market.
4. Consider choosing or shrinking the wind adjustment based on recent held-out
   error, rather than accepting it solely because its fitted slope is negative.
   This short sample is insufficient to activate a new switching policy.

Claude Opus High's review reinforced isolation of research from live planning,
use of the real estimator, paired validation and forecast-vintage discipline.
No production requests or production configuration changes were made.

Final checks: 1,744 Deno tests passed; typecheck passed; frontend TEST build
passed; all mocked-backend E2E suites ran (82 passed, one existing skipped).
ESLint passed with zero errors and 27 existing warnings. HA contract fixtures
regenerated with the updated planner model fingerprint. Planner WASM source
manifest regenerated; binary unchanged.

References: [official request endpoint](https://transparencyplatform.zendesk.com/hc/en-us/articles/15696677194644-Request-Endpoint),
[official mandatory parameters](https://transparencyplatform.zendesk.com/hc/en-us/articles/12784372841748-Request-Parameters-Mandatory-vs-Optional),
[user-supplied guide](https://progrunners.com/entso-e-api/#the-shape-of-a-request).
