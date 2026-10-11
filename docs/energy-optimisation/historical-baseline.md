# Historical default model in ROI

At the bottom of ROI, **Generate model** projects the selected
home under fixed default controls. Previous period / Next period selects adjacent
72 elapsed-hour frames. Only Generate fetches inputs; visited frames are kept in an eight-frame
browser-memory cache. Refreshing the page or changing home discards it. Nothing
writes a baseline plan, score or result to the database.

Each frame has288contiguous quarter-hour intervals. The initial frame ends after
the latest completed recorded energy quarter; navigation stays anchored there.
Missing required history is reported, including the source and timestamp.
Older frames remain accessible when a selected frame has incomplete inputs.

## Inputs and models

The viewer reads bounded windows of existing actual, price and device quarters.
It uses recorded solar production and all-in import/export prices, including
negative prices. Fixed load is total household consumption minus the exact
pool/EV meter identities being replaced, joined by device UUID. Other measured
loads remain unchanged. Missing meters or load inconsistent with their sum fail;
unknown readings are never interpreted as zero. Outdoor observations are needed
only for a pool loss model that explicitly depends on outdoor temperature.

The current captured home supplies battery/charger/heater/thermal models. There
is no archive of historical fitted models, so model capture time is shown.
Initial battery SOC and pool temperature use the preceding quarter's means;
initial EV SOC uses the latest non-null recorded reading before the frame, with
its timestamp shown. These are approximate initial states.

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
288reactive projections with carried battery/car/pool/heater state. The existing
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
This prepares the charts for a calendar-month view; baseline generation still
uses 72-hour frames. JSON export includes native engine hash, captured inputs,
commands, series and the signed grid ledger.

Electricity cost is imports less export revenue. It excludes fixed fees, SHS subscription,
wear and terminal stored-energy credit. A baseline inspection frame alone does
not establish scheduler savings or annual payback. Contract savings remain a
separate ROI calculation. The discarded Defaults-vs-SHS benchmark tab and ROI
benchmark preview have been removed.

## Verification

Unit tests compare captured model conversion with unchanged live preparation,
then cover UUID meters,60W accounting, optional stores, missing input, signed
prices, midnight/taper, thermostat stops, inferred driving demand, DST frame
adjacency and native projection parity. Mocked-browser tests exercise real Wasm
generation, keyboard-accessible charts, older frame loading, memory caching,
missing history, responsive layout and absence of writes.
