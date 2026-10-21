# Comparison and savings in ROI

The monthly comparison calculates automatically for the selected home, up to 12
calendar months. Default cost, recorded cost, scheduler savings, separate contract
savings, subscription and SHS net appear without rendering any graph. The hero,
monthly average, period ROI and payback use the same successful monthly rows.
Failed months are excluded explicitly; estimates disclose sensor gaps, starting
state assumptions and reconstructed price quarters. Costs and comparison-contract
settings are collapsed. Contract savings are excluded from SHS ROI.

**View graphs** or a month's **Graph** button opens the shared graph only on
request. Previous/Next and **72 h / Month** then load uncached periods automatically.
An eight-entry browser-memory cache makes visited graphs immediate. Compact
monthly summaries survive graph eviction. Refreshing or changing home discards
the session. No baseline plan, score or calculation result is stored in the database.

The first generation pins the equipment models, home timezone and latest
completed recorded quarter for the session. Frames cover 72 elapsed hours.
Months follow the home's local calendar, including DST and leap years; the
latest month stops at the pinned recorded end. Navigation cannot move beyond
that end. A month projects continuously from its initial state rather than
combining independently initialised 72-hour frames.

Missing required prices are reported, including source and timestamp. Missing initial
sensor readings use explicit model assumptions: house battery 0%, EV 80% and pool
30°C. These are exported as `batteryInitialAssumed`, `evInitialAssumed` and
`poolInitialAssumed` and shown in collapsed model details. Recorded SOC and
temperature remain missing in the Actual graph.
A failed period leaves navigation available. Each historical read covers at most seven
elapsed days (672 quarters), matching the existing device-history RPC limit
and staying below REST's row cap. Three readers load windows in parallel and start
the next window as soon as a reader finishes. Archived price windows use the same
bounded queue instead of serial queries. Initial pool
and EV readings are fetched once before the entire selected period.

## Inputs and models

The source reads bounded windows of actual and device quarters. Prices come from
our authenticated `backfill-energy-prices` function's explicit `{mode: "read",
start, end, home_id}` mode, limited to 32 days. It first reads archived all-in
quarters, then fills holes using real market intervals and the configured grid
and supplier versions effective on each local date. This mode performs no writes;
the existing relative-day backfill writer remains separate. Reconstructed quarters
and assumed historical supplier revisions are disclosed. The configured supplier
is assumed to apply throughout the period; historical customer contract changes
are not archived. Archived all-in totals remain authoritative. The grid/supplier
split for contract comparisons uses the configured historical grid tariff.
It uses recorded solar production and all-in import/export prices, including
negative prices. Fixed load is total household consumption minus the exact
pool/EV meter identities being replaced, joined by device UUID. Other measured
loads remain unchanged. Missing energy readings (absent quarters, absent meter
keys or null values) contribute zero. If the household total is missing, fixed
load is the sum of the available other device meters, excluding the pool/EV
identities being modelled. This also works without any modelled stores. Missing
solar production contributes zero. Gap counts are exported and shown in collapsed
model details; absent device keys outside the modelled group cannot be counted
without a historical device inventory. Invalid numeric values and measured device
totals exceeding a valid household total still fail. Outdoor observations are needed
only for a pool loss model that explicitly depends on outdoor temperature.

The session's pinned home capture supplies battery/charger/heater/thermal models. There
is no archive of historical fitted models, so model capture time is shown.
Initial battery SOC and pool temperature use the preceding quarter's means.
When that battery reading is absent or null, the baseline starts at 0% rather than
using a current reading or assigning reserve energy. Zero is a depleted state,
including below the configured discharge cutoff; later solar can charge it normally.
Initial EV SOC uses the latest non-null recorded reading before the frame, with
its timestamp shown. If unavailable, the model starts at its 80% charging target;
the first available SOC establishes the observed driving-demand reference without
inventing a trip from that assumed start. Missing pool temperature starts at the
30°C thermostat threshold. Valid historical initial readings remain authoritative.
These are approximate initial states.

## Default controls

- Battery: maximum self consumption within the home's physical limits, including
  supplying EV charging.
- EV: positive drops between consecutive recorded SOC readings are treated as
  driving demand: drop × current battery capacity. Recorded charging increases
  do not top up the default projection. Drops are applied at their observed
  quarter and summed by local day for inspection. Across telemetry gaps, a drop
  is assigned to the next known reading; the gap count is shown. Each local
  midnight starts maximum configured charging toward80%, with native taper.
  Overnight connection is assumed. Unobserved driving masked by simultaneous
  charging cannot be reconstructed. Demand exceeding modelled available car
  energy fails rather than clipping a trip.
  Availability is inferred from SOC, not measured charger connection: a decline
  makes the car unavailable until a fresh nondeclining observation. A recovered
  hourly mean is fresh only at its original hour boundary; its three copied
  quarters and missing readings cannot establish a return. Precise quarter
  observations keep their resolution. Both models use this same timeline.
  Independently initialized captures retain the assumed initial connection;
  seeded graph frames slice the monthly trajectory, including its availability.
- Pool: thermostat starts at30°C and stops at30.5°C. The native physical stop
  resets the latch. Initial heater state is `off_unobserved`; historical startup
  phase is unavailable.
- Pump: continuous60W circulation. That floor is counted once: it is added to
  fixed load and deducted from the native full-heating auxiliary draw. A
  full-power auxiliary model below60W fails.

The isolated worker performs one reactive native `project` per baseline quarter,
carrying battery/car/pool/heater state. Scheduler comparison also runs native
`solve` over a rolling 72-hour forecast at each local day boundary and EV
inferred return when withdrawals have made its selected plan stale, then projects
its chosen commands quarter by quarter. A daily solve after the last withdrawal
already knows the depleted state and future availability, so that return does not
need another solve. The Wasm
artifact is verified by SHA256. These historical simulations do not dispatch
commands or modify live planning.

Candidate scoring reuses exact pool-heating transitions within one immutable
solve, with bounded memory and unchanged search work, accounting and output.
Daily and homecoming replans retain their 72-hour horizons. See the
[profiling and month-horizon experiments](roi-performance.md) for measurements
and the reasons for retaining this replay protocol.

The retained hour uses the same battery allocation sizing as live publication:
forced charges and exports commit the power projected by native physics after
storage and grid saturation, with zero allocations becoming idle. Automatic
battery modes keep their permission ceilings. Replanning therefore retains the
executable allocation rather than an unattainable power ceiling.

The Plan page, planner bench and ROI use `energy/charts/EnergyChart.tsx`.
ROI displays the entire selected frame without day buttons. Controls and costs
sit above the graph; rounded parameters, daily EV demand and provenance sit
in a collapsed Model details section below it.

The shared renderer accepts any contiguous horizon, an explicit home timezone,
and a configurable axis label limit. Longer horizons use spaced local dates
instead of hourly labels, retaining every quarter for costs and interaction.
The same chart renders both 72-hour frames and calendar months. **Default model /
Actual** switches the entire graph without another history fetch or projection.
Actual quarters use the shared `buildEnergyTimeline` history adapter, followed by
`projectPlanChart`, exactly as the Plan view. The capture includes measured battery
flows, SOC, all catalogued device meters and pool temperatures for the whole period.
The period comparison table includes an Actual consumption column with measured
grid imports, solar consumption and exports. Its cost uses the same complete
electricity/grid invoice pair as the monthly ROI table; incomplete months and
72-hour frames show no invoice total.
Actual graph prices use dated invoice contract terms, independently of the
current Tibber scenario used by the two models. Karlstads `Medelspotpris` is a
monthly rate; Tibber quarters use market spot plus that invoice's per-kWh
adders. Invoice grid transfer, energy tax and VAT are included once. Fixed fees
and demand charges stay in the full invoice totals and do not enter graph kWh
prices. Unbilled live quarters use their archived price receipts; assumed
portal backfills do not establish an actual contract. A missing nonzero flow
price leaves a cost gap rather than making that energy free.
Missing energy is zero; missing SOC and temperature remain gaps. Recorded charging
is plotted only in Actual and is never used to charge the baseline EV.

Solar consumption is generation minus exports, including energy retained in the
battery. The baseline excludes curtailed generation. Export meters lack source
attribution, so actual exports are treated as solar; battery exports can affect
that estimate. This definition is available in collapsed model details. JSON export includes native engine hash, captured inputs,
commands, series and the signed grid ledger.

Electricity cost is imports less export revenue. Baseline and Scheduler ROI costs
add prorated supplier and grid fixed fees and exclude demand charges (effektavgift).
Actual uses complete invoice totals, including demand charges. Modeled cumulative
graph costs add only the fixed fees to variable quarter costs; subscription is
included only in the ROI result. The initial state quarter contributes no cost.
Missing grid energy is zero and counted;
negative prices, export revenues and negative savings retain their signs.

`roi-pricing.ts` owns this financial projection for monthly summaries, period
tables, graph cost lines and exports. Saved physical ledgers retain their full
dated tariff evidence and pool identities; applying this pricing policy never
repins or regenerates completed simulations. Exports identify the pricing policy
and present demand-free modeled bills, with original bills named `tariffEvidence`.

Scheduler saving = Baseline cost − Scheduler cost. Identical contract fees cancel.
SHS net subtracts the prorated subscription; full DST months pay one subscription.
The monthly average is total net / sum of month coverage. Period ROI is total net /
(equipment + installation); payback is investment / monthly average when positive.
These are based on the selected period, with no claim of representative annual savings.

Contract savings compare the recorded imports' supplier cost with the selected
alternative. Grid costs and export revenue are held constant. They use the same
successful home months as scheduler ROI, rather than account-level daily supplier
costs or invoices. Editing fees, subscription or contract terms reuses these ledgers.

One home capture source owns pinned models, an eight-capture LRU, compact monthly
ledgers and shared in-flight generation. Viewer and monthly report have independent
cancellation interests: leaving a graph does not cancel a report that still needs
the same month. Last-consumer cancellation aborts history/worker work and prevents
late results caching. Fresh graph generation replaces the corresponding compact ledger and updates the monthly report.
Reports process months sequentially, retain successful rows if another month fails,
show future months as unavailable and total only calculated rows. Range/home changes
cancel obsolete report work. Subscription and comparison-contract edits do not fetch
or project models. The discarded Defaults-vs-SHS benchmark tab and ROI benchmark
preview have been removed.

## Verification

`deno task bench:roi` times a synthetic 31-day comparison with the real Wasm
engine, separating scheduler solves from quarter projections. Pass a previous
Wasm path to compare both speed and the checksum of all physical/financial
outputs. Scheduler refinement reuses only an unchanged command prefix projected
from the same problem. Battery allocation computes unchanged pool/EV service
points once per quarter. Work accounting and search budgets remain unchanged;
the final selected plan is still independently projected and certified in full.
Steady heater heat is reused within thermostat searches, and calendar formatters
are reused per timezone when preparing history and prices. In three local runs,
the August fixture decreased from a mean 16.12 seconds to 14.68 seconds (9%),
with identical output checksums. This measures calculation time, excluding network
reads; real homes' solve time depends on their equipment and inputs.

Unit tests cover calendar boundaries, bounded reads, continuous monthly state,
auto-navigation, cache eviction, sensor gaps and stale-result cancellation. They compare
captured model conversion with unchanged live preparation,
then cover UUID meters,60W accounting, optional stores, missing input, signed
prices, midnight/taper, thermostat stops, inferred driving demand, DST frame
adjacency and native projection parity. Mocked-browser tests exercise real Wasm
generation, keyboard-accessible charts, older frame loading, memory caching,
missing history, responsive layout and absence of writes.

## Invoice updates after deployment

Retained embedded-text PDF invoices are retried automatically after each successful
deployment by `scripts/retry-energy-invoices.ts`, using the deployed billing parser
and the original uploader/customer metadata. Imports commit atomically before their
private sources are removed. A receipt on the retained record allows interrupted
cleanup to resume without recreating an invoice. Rejected files, scanned PDFs,
images, declarations and CSVs remain available for review. Operational retry failures
fail the retry job after unaffected files have been processed.

The ROI comparison refreshes invoice evidence every 30 seconds while open. New
complete electricity/grid pairs fill Actual and Savings vs Actual, including totals,
using the saved monthly baseline and scheduler ledgers. Adding invoices does not
repin the equipment model or regenerate those ledgers. Recalculate remains an
explicit request to regenerate model results; it is unnecessary for new invoices.

## Solar before installation

ROI models can run the current solar array over months before its installation.
Reconstructed generation is stored separately in `energy_roi_solar_hours`; it is
never written into measured energy history or the issued-forecast archive.
Both the baseline and scheduler use the same reconstructed supply. Actual
invoices and measured graphs remain unchanged. Within and after the installation
month, models continue to use recorded production, including genuine zeros.
Owner-stated months are stored in `energy_roi_installations` and shown beneath
the month period in the comparison table. They do not disable hypothetical equipment before installation.

Preparation is explicit and service-owned:

1. Install the pinned provider model with Python 3.11 or later:
   `python -m pip install -r scripts/roi-solar-requirements.txt`.
2. Provide a private JSON configuration with `pv` containing `latitude`,
   `longitude`, `peak_kw`, `inverter_kw`, `tilt_degrees`,
   `compass_azimuth_degrees`, `efficiency`, `morning_damping`, and
   `evening_damping`; plus `time_zone`, `solar_installed_month`,
   `reconstruction_months` (inclusive first/last month), `training_months`, and
   independent `validation_months`. Supply recovered actual hourly readings in
   the same `{start_ts, actual: {solar_production_kwh}}` shape as ROI history.
3. Run `scripts/reconstruct-roi-solar.py --config CONFIG --actual-hours ACTUAL
   --cache-dir CACHE --output PREPARED`. This sends location and array geometry to
   Open-Meteo's Historical Forecast API. Obtain authorization for that data use.
   Missing provider hours or incomplete measured calibration months fail clearly.
4. Review the independent validation months. The output retains raw energy,
   calibrated energy, configuration, provider/library identities and source
   hashes. The energy-weighted correction uses complete measured training months;
   corrected generation respects inverter capacity. Solar weather reconstruction
   is distinct from comparing archived HA forecasts issued before their targets.
5. Publish using `scripts/publish-roi-solar.ts PREPARED HOME_UUID CUSTOMER_UUID`
   with the intended `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Use Deno
   permissions for the input file, those environment variables and target host.

Publication atomically replaces the profile and its complete hourly coverage.
It invalidates saved months overlapping the changed solar coverage and updates
the pinned solar identity, preserving other months' financial ledgers;
identical publication is a no-op. Pin/save/publication serialize per home, and
stale generations or solar identities cannot save results. ROI v4 rejects older
writers. The known equivalent v3 release is rolled forward by removing obsolete
display outputs, preserving its financial results without recalculation. Reopening ROI automatically calculates the revised models; Recalculate
also starts a new generation. Each modeled hour is distributed evenly across its
four quarters, preserving energy and UTC daylight-saving boundaries. A missing
hour inside the published reconstruction period fails instead of supplying zero.

The installation notes replace assumption disclosures. Physical starting values
remain calculation inputs; the removed sensitivity scenarios are no longer run.


## Pool history

An owner-stated seed belongs to one home in `energy_roi_pool_seeds`. The requested
seed is 30°C at local midnight on 1 October 2025. Both models start there and carry
their own native pool temperature and heater state across subsequent calendar
months. Observed pool readings remain Actual evidence and do not reset a seeded
model in June or any later month. Battery and EV initialization retain their
existing policy.

`createCaptureSource` resolves earlier dependency months even outside the selected
report range. Complete month checkpoints persist separately from the twelve
presentation summaries. Thus October's continuation survives while November–
October occupies the table. Seeded 72-hour graphs slice the same monthly
trajectories; they do not run another simulation from an observed temperature.
Partial months cannot seed successors. Parent hashes and report generations are
checked under the home's existing advisory transaction lock. Replacing an earlier
checkpoint removes its descendants; repinning or publishing changed solar inputs
clears the seeded chain. ROI-v5 rejects stale v4 writers.

Publication is service-only through `publish_energy_roi_pool_seed(home, customer,
month, temperature_c)`. Import required history and publish the reconstructed
solar coverage before setting a seed. A missing prerequisite fails explicitly;
the source cannot silently move the initialization to a later month. Solar and
pool publications preserve actual telemetry and original invoice totals.
