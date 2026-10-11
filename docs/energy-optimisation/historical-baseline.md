# Comparison and savings in ROI

At the bottom of ROI, **Generate model** activates the selected home's default
model. Previous/Next and the **72 h / Month** buttons then generate uncached
periods automatically. Visited periods display immediately from an eight-entry
browser-memory cache. Refreshing the page or changing home discards the session.
Nothing writes a baseline plan, score or result to the database. The combined **Comparison and savings** card has a collapsed monthly overview
with an on-demand **Calculate months** button for the selected From/To
range. Each month shows default-model cost, recorded cost, electricity savings,
SHS subscription and net savings. A month link opens the same model in the chart.
The selected period has a four-row default/actual summary: grid imports, retained
solar energy, exports and net grid cost, plus savings. Cost settings are collapsed
in the same card; contract savings retain their separate section.

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
and staying below REST's row cap. Two windows load in parallel. Initial pool
and EV readings are fetched once before the entire selected period.

## Inputs and models

The viewer reads bounded windows of existing actual, price and device quarters.
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
- Pool: thermostat starts at30°C and stops at30.5°C. The native physical stop
  resets the latch. Initial heater state is `off_unobserved`; historical startup
  phase is unavailable.
- Pump: continuous60W circulation. That floor is counted once: it is added to
  fixed load and deducted from the native full-heating auxiliary draw. A
  full-power auxiliary model below60W fails.

The isolated worker exposes only native `project`, never `solve`. It performs
one reactive projection per quarter with carried battery/car/pool/heater state. The existing
Wasm artifact is verified by SHA256. No optimisation, forecasting, fitting,
backfill, polling or planner dispatch happens. The working planner and its
artifact remain unchanged.

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
Missing energy is zero; missing SOC and temperature remain gaps. Recorded charging
is plotted only in Actual and is never used to charge the baseline EV.

Solar consumption is generation minus exports, including energy retained in the
battery. The baseline excludes curtailed generation. Export meters lack source
attribution, so actual exports are treated as solar; battery exports can affect
that estimate. This definition is available in collapsed model details. JSON export includes native engine hash, captured inputs,
commands, series and the signed grid ledger.

Electricity cost is imports less export revenue. It excludes fixed fees, SHS subscription,
wear and terminal stored-energy credit. Recorded cost uses the selected home's
recorded grid import/export quarters and the **identical historical quarter prices**
as the baseline. The extra quarter used for initial states contributes no cost.
Missing grid energy contributes zero and is counted in month details. Negative
prices, export revenues and negative savings retain their signs.

Electricity savings = baseline cost − recorded cost. Identical fixed contract
fees cancel. SHS subscription is separate; a partial month pays elapsed period
duration / full home-calendar month duration of the monthly subscription. Full
DST months pay one subscription. Net savings subtract that amount, without
annual extrapolation or a new payback estimate. Contract savings remain a separate
calculation using the comparison contract and account-level supplier/bill history.

One home capture source owns pinned models, an eight-capture LRU, compact monthly
ledgers and shared in-flight generation. Viewer and monthly report have independent
cancellation interests: leaving a graph does not cancel a report that still needs
the same month. Last-consumer cancellation aborts history/worker work and prevents
late results caching. Fresh generation invalidates the corresponding compact ledger.
Reports process months sequentially, retain successful rows if another month fails,
show future months as unavailable and total only calculated rows. Range/home changes
cancel obsolete report work. Subscription and comparison-contract edits do not fetch
or project models. The discarded Defaults-vs-SHS benchmark tab and ROI benchmark
preview have been removed.

## Verification

Unit tests cover calendar boundaries, bounded reads, continuous monthly state,
auto-navigation, cache eviction, sensor gaps and stale-result cancellation. They compare
captured model conversion with unchanged live preparation,
then cover UUID meters,60W accounting, optional stores, missing input, signed
prices, midnight/taper, thermostat stops, inferred driving demand, DST frame
adjacency and native projection parity. Mocked-browser tests exercise real Wasm
generation, keyboard-accessible charts, older frame loading, memory caching,
missing history, responsive layout and absence of writes.
