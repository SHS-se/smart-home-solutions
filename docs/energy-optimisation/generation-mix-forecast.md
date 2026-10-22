# TEST generation mix experiment

## Usage and ownership

```ts
// Collector, after saving the current acquisition batch. No household-plan writes.
const forecast = forecastGenerationMix({
  origin: clock().toISOString(), actuals, weather, published,
});
await store.saveGenerationRun({ id: crypto.randomUUID(), ...forecast, source_refs });
// Offline report reads immutable runs and subsequent actual observations.
const scores = scoreGenerationRuns(runs, actuals);
```

`forecastGenerationMix` is pure: it returns a frozen 72-hour UTC panel,
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
