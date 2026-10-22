# TEST generation mix experiment

## Usage and ownership

```ts
// Collector, after saving the current acquisition batch. No household-plan writes.
const forecast = forecastGenerationMixV2({
  origin: clock().toISOString(), actuals, weather, published, hydro, nuclear,
});
await store.saveGenerationRun({ id: crypto.randomUUID(), zone: forecast.zone,
  origin: forecast.origin, algorithm: forecast.algorithm, forecast, source_refs });
// Offline report reads immutable runs and subsequent actual observations.
const scores = scoreGenerationRuns(runs, actuals);
```

The versioned forecasters are pure: they return a frozen 72-hour UTC panel,
training counts and explicit per-model unavailability. Inputs are full-generation
ENTSO-E intervals, ten-site ECMWF weather and published day-ahead wind/solar.
The collector owns provider authentication, redacted raw evidence, acquisition
identities and append-only storage. The run pins the exact successful observation
IDs used; all acquisition commits finish before its origin is chosen. Provider
publication dates cannot make subsequently retrieved evidence available earlier.

## Shape

The existing collector gains an authenticated `{generation:true}` research mode.
A separate TEST cron requests it every six hours, sharing the existing private
credential. Ordinary hourly collection is unchanged. Research mode additionally
captures 28 days of generation actuals and requests 28 past weather days alongside
seven forecast days. Older null weather remains null. Historical weather acquired
today can train future predictions; it cannot establish historical forecast skill.

The ENTSO-E adapter retains generation/consumption direction. Only production MW
enters the generation panel. An hour requires complete native interval coverage;
identical duplicates count once and conflicting overlaps are unavailable. Keep
PSR codes: missing categories are not zero and B20 is not relabelled as CHP.

Every observed production type gets an independent recent-output benchmark.
A calendar analog model predicts dispatch from preceding observed hours of the
same local hour and day type. Wind and solar also get weather analog candidates,
using train-only scaling and weighted means of measured MW, not a weather index
relabelled as generation. Features retain all ten sites; radiation labels refer
to the preceding hour. Positive analog weights avoid arbitrary clipping. Published
day-ahead MW is another independent comparator wherever complete coverage exists.
There is no run-time model substitution when a candidate lacks evidence.

`energy_generation_forecast_runs` stores algorithm, origin, full model output and
exact source observation IDs. Service-role access is SELECT/INSERT only. Errors
remain archived; source failures yield explicit unavailable predictions, never
cached substitute inputs. Scores are derived using matching complete actual hours,
per PSR/model/24-hour lead band, counting distinct Stockholm target dates.

## Synthesis decision

Use Codex's pure per-type panel and independent append-only run ownership. Adopt
Claude's shared collector/cron credential and explicit independent benchmarks to
avoid duplicating acquisition infrastructure. Use a fixed weather analog model
rather than unconstrained linear MW regression for the first measurable pilot.
Do not require a Nordic dispatch optimiser before producing empirical forecasts.

## Tradeoffs and alternatives

- We accept empirical hydro/nuclear forecasts in exchange for measurable forecasts now.
- We accept a modest weather analog model in exchange for transparent, replayable MW output.
- We accept repeated 28-day acquisition in exchange for self-contained training evidence.

A joint dispatch optimiser requires unavailable bids, water values and border
constraints, with much greater operational risk. Direct weather-to-price models
remain necessary comparators: intermediate generation errors may worsen prices.

## Evidence gaps and validation

SE3 currently reports gas, reservoir hydro, nuclear, solar, onshore wind and other.
Actual production targets are available; a complete nuclear fleet roster is not.
Outage quantities describe available MW; revisions/cancellations must be resolved
before a separate availability candidate is introduced. Reservoir stored energy
and inflow need verified geographical coverage. Neither availability nor rainfall
is automatically a generation forecast. Load and imports are separate price
inputs; do not force local generation to equal local demand.

Freeze the first model policy before observing its prospective outcomes. Verify
hour coverage, duplicates/conflicts, radiation alignment, missing sites/types,
future-label exclusion and deterministic replay. Score generation first, then
compare price candidates on identical future target dates with train-only history.
No price improvement is claimed until prospective paired results exist. This
experiment does not alter household price estimates, plans or production.

Each new household price archive context also pins the latest committed mix run ID
before calculation. Existing ingest already preserves this context verbatim; no
producer deployment is necessary. This records what research prediction was
available, without feeding it into the live estimator. Later price experiments
must use that explicit reference rather than a hindsight timestamp join.

## Operating the experiment

`deno task deploy:market-archive` applies only the listed research migrations and
deploys only the collector to TEST. The generation cron is `17 */6 * * *` UTC.
`deno task research:generation:report --out NEW_DIRECTORY` saves a read-only TEST
evidence bundle and JSON report, verifies exact replay, and scores completed
outcomes. Each model includes paired persistence/calendar errors on identical
hours; fewer observations cannot masquerade as better accuracy. Truth uses the
newest acquired document for each whole hour, retaining older archived windows
so targets remain scoreable after 28 days. The report names its truth vintages.

First verified run: `7c6296fb-7e82-4443-976f-91c4dead0998`, issued
2026-10-22 17:29:54 UTC, targets 18:00 UTC through 2026-10-25 17:00 UTC.
All six types have 670 complete training hours; solar has 642 paired weather
hours and wind 640. Both weather candidates cover all 72 target hours. Published
wind/solar comparators cover 28 hours. Frozen-input replay matches exactly.
No future target has settled yet, so this establishes functioning collection and
prediction, not forecast skill or a price improvement. Service-role validation
confirmed inserts work, updates are denied, incomplete source references are
rejected, and the price context pins the visible generation run.

## Hydro and nuclear extension (version 2)

Caller usage stays `forecastGenerationMixV2({...v1Inputs, hydro, nuclear})`, then
append a run referencing all acquisition IDs. Offline replay dispatches on the
stored algorithm. The v1 forecaster remains unchanged; v2 wraps its four models
and adds independent hydro-state and nuclear-availability candidates. Scoring
must retain algorithm identity so the two experiments are not pooled.

Use Codex's additive versioned domain adapter as the base, and Claude's independent
ratio/delta nuclear comparators and explicit A77/A80/A71 verification seams.
Reject a full dispatch model and arbitrary corrections to the existing curves.
Use the shared collector, TEST guard, private cron credential and append-only
observations. Generation mode adds a bounded Swedish report batch plus separate
A77, A80 and A71 observations. The SQL trigger requires the additional source IDs
only for v2; older v1 runs retain their original identities and schema.

The Swedish adapter discovers the latest six weekly reports from Energiföretagen's
actual index links, preserving raw PDF bytes, hash, version, geography and HTTP
Last-Modified independently of local acquisition. Parse only page 1 sequentially;
verify hosted CPU/memory before enabling its recurring use. A serverless PDF.js
build avoids reliance on native canvas. Capture each failed source explicitly.
Do not substitute another source/parser when acquisition fails. Six reports bound
both work and the history required by the existing 28-day training window.

The hydro-state candidate learns positive analog weights from SE3 reservoir
filling and Sweden-wide inflow anomaly. Pair historical generation only with
reports whose completed period and provider-modified time precede that hour.
This reconstruction is training evidence acquired now, not proof of historical
forecast skill. Target features hold the latest known weekly state across the
72-hour horizon. National inflow is not SE3 inflow and is not a future forecast.

The nuclear adapter resolves document versions and cancellations before merging
unit timelines. Quantities are available MW, not lost MW. Combine overlapping
notices on one unit without double counting; parent production constraints and
child generator constraints require verified roster identities. Unknown joins,
conflicting revisions or response truncation leave the candidate unavailable.
Neither an empty outage response nor an outage-derived partial roster proves
fleet completeness. First enable the closed TEST A77/A71 probe vocabulary, inspect
real responses and verify the current operator roster before activating nuclear
output. Compare announced fleet availability at the latest measured nuclear hour
and each target hour. Ratio and change candidates remain separate experiments;
never treat capacity as guaranteed production or clip surprising predictions.

Public sources: [Energiföretagen Kraftläget](https://www.energiforetagen.se/statistik/kraftlaget/)
and [weekly archive](https://www.energiforetagen.se/statistik/kraftlaget/kraftlagets-arkiv/);
[ENTSO-E extraction guide](https://transparency.entsoe.eu/content/static_content/download?path=%2FStatic+content%2Fweb+api%2FIG-for-TP-data-extraction-process.pdf),
A77 production outages, A80 generation outages, A71/A33 installed units.
[NVE](https://www.nve.no/energi/analyser-og-statistikk/hydrologiske-data-til-kraftsituasjonsrapporten/)
provides separate Norwegian hydrology; it is not used as a substitute for Swedish
inflow. SMHI's advertised energy-inflow forecasts are a separate commercial
service, not a verified open feed. Preserve attribution; no public redistribution
of the source reports is part of this TEST experiment.

The first hosted v2 run is `36036737-6c08-4d95-979b-13eececbc491`, issued
2026-10-22 19:24:41 UTC. All nine sources returned data. Six reports (weeks 37–42)
provided five historical states paired with 670 observed hydro hours. Hydro-state,
nuclear-delta and nuclear-ratio each produced all 72 target hours. Current announced
nuclear capacity is 3,693 MW after resolving notices for all six production units;
this agrees with the operating reactors implied by operator maintenance pages.
The week-42 report gives SE3 storage 1,806 GWh / 63.5%, with national weekly inflow
1,059 GWh / 91% of its seasonal median. Hosted acquisition and forecast saving
succeeded; every stored v1 and v2 run replayed exactly.

The offline truth resolver now clears the entire complete-hour request window
when applying a newer actual-data observation, including omitted first/last hours.
A partial requested edge cannot invalidate older complete truth outside that
scope. Per-hour source identities are retained in the report. This prevents
unintentional filling of a revised data gap with an older observation.
