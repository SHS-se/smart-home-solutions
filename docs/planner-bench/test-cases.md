# Planner bench test cases

How the bench compares planner versions like for like. Built on `dev`; the
decisions still open are at the end.

## Purpose

A battery of test cases to score successive planner versions on, so the
planner gets empirically better over time. A test case is **not** a replay of
what happened on a day. It is a 72-hour scenario the planner has to plan for.
Where its numbers came from (a replay file, a window of recorded history, a
hand edit) does not matter once it is a test case.

The bench lives its own life: its test cases, household, adapter, referee and
scores are owned by `bench/` and `src/lib/planner-bench/`, with their own
tables. It takes the planner one version at a time, plus the history home’s current
saved comfort preferences before each planning run.

## The parts

| Part | Where | What it owns |
|---|---|---|
| **Test case** | `src/lib/planner-bench/case.ts`, `bench_scenarios.dataset` + `.recorded` | 288 quarters of what a planner is told, plus what was recorded for the same window afterwards. |
| **Household** | `src/lib/planner-bench/household.ts` | The devices planned in every case and their physics. |
| **Comfort** | `energy_optimisation_comfort_targets`, `bench/comfort.ts` | The history home’s saved pool temperature and car range, captured in each case before planning. No money. |
| **Adapter** | `bench/adapter.ts` | Builds a planner version's input from case + household, and reads its plan back as decisions. The only bench code that knows planner schemas. |
| **Referee** | `src/lib/planner-bench/referee.ts` | Carries the battery, pool and car forward with the household's physics, through the load and solar the home measured, and prices every quarter at what electricity really cost. |

A planner is told only what was knowable at the start and works out the rest
itself, so its price estimate and its value curves are part of what is being
compared. It is given no price outlook, no value curve in money, no battery
cost curve and no previous plan. It hands back decisions (pool, car and
battery power per quarter); it does not get to state its own cost, pool
temperature or battery level.

## Test case format (`shs-bench-case`, version 1)

Authored part (`dataset`), made by a converter and edited on the bench page:

```jsonc
{
  "format": "shs-bench-case", "version": 1,
  "origin": { "kind": "replay" | "history" | "manual", "detail": "…", "created_at": "…" },
  "start": "2026-09-05T12:00:00.000Z",      // first quarter, UTC; the planner's "now"
  "timezone": "Europe/Stockholm",
  "location": { "latitude": 59.456, "longitude": 18.041 },
  "known_prices": {                          // null from the first quarter not published at the start
    "import_sek_per_kwh": [ … ], "export_sek_per_kwh": [ … ]
  },
  "solar_forecast_w": [ … ],                 // final figure; the home's own correction already applied
  "base_load_forecast_w": [ … ],             // everything the household does not plan
  "other_devices_w": { "<meter>": [ … ] },   // the devices folded into base load, kept separable
  "start_state": { "battery_soc": 0.64, "pool_water_c": 23.4,
                   "ev": { "soc": 0.55, "target_soc": 0.8 } },  // target_soc is the car's charge limit
  "start_state_unread": [ "pool_water_c" ],  // only while a default stands in for a missing reading
  "comfort": null                            // runner captures { pool_c, ev_km } from the home before planning
}
```

Recorded part (`recorded`), filled by the runner from the home's quarter tables
(`bench/history.ts`) once the 72 hours have passed:

```jsonc
{
  "prices": { "import_sek_per_kwh": [ … ], "export_sek_per_kwh": [ … ] },  // real, all 288 quarters
  "actual": { "base_load_w": [ … ], "solar_w": [ … ] },  // what the house drew and the panels gave; absent if not measured in full
  "outdoor_temperature_c": [ … ],            // measured at the house; a perfect forecast for planners
  "solar_irradiance_w_per_m2": [ … ],
  "wind": { "zone": "SE3", "days": [ { "day": "2026-09-20", "mean_speed_m_s": 3.4 }, … ] },  // observed, 45 days before the start to the end
  "history": {
    "prices": { "start": "…", "import_sek_per_kwh": [ … ], "export_sek_per_kwh": [ … ] },  // up to 60 days before the start
    "grid_import_kwh": { "start": "…", "kwh": [ … ] },                                      // month to date
    "demand_days": [ { "day": "2026-09-23", "forecast_kwh": 25.6, "actual_kwh": 26.6 }, … ]  // up to 28 days before the start
  },
  "recorded_at": "…"
}
```

Rules:

- **Planners never see the recorded prices.** They get `known_prices` and the
  price history; the referee scores with the real ones.
- **A case runs only when complete.** Until its window is recorded it shows as
  "waiting", with the reason. The runner completes it on its own; nothing is
  done by hand.
- **Start state belongs to the case.** It comes from the source's readings, or
  from recorded history at the start where the source had none. An edit on the
  page is saved into the case. The car is planned whether plugged in or not and
  has no departure time: it is a store with a target, like the pool.
- **Wind is observed, and a perfect forecast for planners.** One mean wind
  speed per UTC day over the price area (`energy_market_wind_observed`, filled
  by the server from SMHI), from 45 days before the start to the end of the
  window. Planners estimate the price level of unpublished days from it. Like
  the temperature it is what happened, not what was forecast, so the told lane
  flatters a planner by however wrong the wind forecast was; the forecasts as
  issued are kept from 2026-10-02 (`energy_market_wind_forecast`) for cases
  made later. A case recorded before wind was kept gets it added by the runner.
- **Planners never see what the house then drew.** They get the forecasts and
  `demand_days`: for each matured day before the start, what the base load was
  forecast to be the day before and what it was. A planner may level its
  forecast to that ([demand.md](demand.md)).
- **History is stored, not read at run time.** 60 days of prices (what the live
  planner reads) or as much as exists, and the month's grid import for planners
  that use peak tariffs.

## Measured windows

Where the home measured a case's whole window, the referee carries the
household through what it drew (`actual.base_load_w`: measured load less the
pool and the car, which the bench plans itself) and what the panels gave, not
through the forecasts. A window whose device meters add up to more than the
house drew in more than a few quarters is not used, and that case is refereed
on its forecasts as before.

From 17 August to 3 October 2026 the home recorded its car charging twice
(`ev_charging_kwh`): the charger's dashboard meter plus a second meter for the
same charger left in the integration's settings, one of them an hour late.
Taking that out of the house's draw left the base load at nothing while the car
charged, refused the window outright for C-0905 and C-0919, and understated the
days before every case of that period. On 4 October 2026 the integration was
fixed to count each load once and the recorded quarters were put right: from
8 September from the dashboard meter, before that from the hourly statistics of
the charger's power integral, spread evenly over each hour. The cases were then
read again from the tables (`rerecord`), replacing a hand repair of C-0905,
C-0919, C-0920 and C-0927 made earlier that day.

The battery then does what it does in the house, where a plan is a permission
and not a power:

- **Supplying the house**, it follows the house: all of what is drawn when the
  plan covered the whole forecast need, up to the planned power when the plan
  covered part of it.
- **Left to itself** (holding, charging on surplus, supplying), it takes
  whatever surplus sun there is.
- **A grid charge or a sale to the grid** is a fixed power and stays as planned.

The limits are the plan's own where it states them (`battery_command`, read by
the adapter into `decisions.battery_follow`), and otherwise worked out from the
decisions against what the planner was told, by the same rule. So a plan
charged for exactly the forecast runs dry on a day that draws more and buys the
rest at that hour's price. Running dry that way is a cost, not a violation:
whether a plan asks for what the household cannot do is still judged on what
the planner was told.

## Household and targets

Devices, in `HOUSEHOLD`, as numbers only: battery 18.08 kWh (8.8 kW in, 9.6 kW
out, 95 % each way, 5–100 %); car 75.6 kWh, 0.16 kWh/km, 92 %, charged at whole
amps from 5 to 16 on three phases; pool 55 m³ with the home's ground-source
heat pump and a 764 W circulation pump; site limits 13.2 kW each way, SE3. What
a device does with its numbers is the planner's own device models
(`planner/device-models.ts`), which the referee steps for every planner version
alike ([design](device-models-design.md)).

The heat pump is on at its setting or off. Its numbers are what the home's
machine was measured to take and give at the four settings it has run at
(September 2026, rounded): 6 kW 1.25 kW in and 5.9 kW of heat out, 8 kW 1.65
and 7.8, 10 kW 2.25 and 10.5, 12 kW 3.0 and 12.45. COP is never stated; it is
heat over electricity, 4.7 at the lower settings and 4.15 at 12 kW, and it does
not follow the weather. The bench runs it at 12 kW, as the house does now: on,
the pool draws 3764 W with its pump, which heats nothing, and gains 12.45 kW.
A plan that asks for a power between off and on is carried out as off, and the
difference is a violation (`pool_step`). No device has a minimum run: a quarter
is the least anything runs for.

The charger holds whole amps (3450 to 11 040 W) or is off. A plan that asks for
a power between two of them is carried out at the lower, below 5 A not at all,
and the difference is a violation (`ev_step`).

The pool loses 0.13 kW for every degree its water is above 13.5 °C, whatever
the weather: 2.1 kW at 30 °C, a third of a degree in ten hours. The home's own
pool, unheated above 29 °C, lost 2 to 3 kW on days of 13 °C and of 25 °C
outdoors alike (June, July and September 2026), so its loss is to its room and
the ground and does not follow the outdoor air. Not modelled: the home's pool
nearly stops cooling below about 29 °C for half a day at a time.

Planners on the bench are told the same household in the fields they read
(`bench/adapter.ts`): the pool's draw as its one power, its cooling by water
temperature, and what a kWh of the compressor adds to it, which is the COP over
the pool's heat capacity. A test holds the planner's own figure for a kWh of
pool draw to the referee's.

Before each planning run, the runner reads the history home’s saved preferences
from `energy_optimisation_comfort_targets` and captures them as `dataset.comfort`
for every selected case. These are the same settings edited in the home’s
Comfort preferences card. Every planner and the referee use those captured
targets. A change alters the input hash and replans the affected results.
There are no internal default targets or case overrides in database runs.
Local case files must supply both comfort targets explicitly.

The home is selected by `BENCH_HOME_ID`, or by the most recent recorded outdoor
quarter when it is unset, as for history. Missing saved preferences fail the run.
`--shas none` only rescores existing decisions using the case’s captured targets;
it does not load new preferences or replan.

Hot water and room heaters are not planned yet; they are fixed demand inside
base load. Taking one over later means adding it to the household and taking
its series out of base load, which `other_devices_w` keeps possible.

## Value curves

A value curve says what one more unit in a store is worth at each level: a kWh
in the battery, a degree in the pool, a kilometre in the car. It is the
planner's own working, derived every plan, and the single place where "what is
energy worth" meets "when to buy". It is not an input and not a customer
setting.

- **Battery:** the *balanced* curve, from the case's solar, load and prices
  (what a stored kWh will save later).
- **Pool and car:** target service utility (`planner/target-economics.ts`). A
  reachable unit below the target is worth the existing urgency multiplier
  times the positive import reference, converted to the device's physical
  units. Utility saturates at the target; free solar changes procurement cost,
  not willingness. Pool comfort and a car without a departure count throughout
  the horizon in service days. A declared car departure counts once at that
  event. Bids read the marginal value along the physical future trajectory;
  whole-run selection uses the same fixed service account. See
  [comfort target economics](../energy-optimisation/comfort-target-economics.md).
- **The one control left** is a scale per store (default 1) that multiplies the
  derived curve: an administrator's dial, not a customer's.

Planner versions from before single targets get the target as the comfort band
and urgency they read (`bench/adapter.ts`), and the redesign branch builds its
planning basis from the case's price history with its own code.

Each result stores the curves the planner reported and how it derived them; the
case view shows current and test planner side by side. Curves are never rebuilt
by the page.

## Lanes: telling why a plan cost what it did

Every case is planned six times per planner (`lanes.ts`), all refereed on the
same real prices:

| | low (0.71×) | nominal (1×) | high (1.41×) |
|---|---|---|---|
| **told** the published prices | | the planner as it runs live | |
| **oracle**: told the real prices | | | |

From these the page works out, per case:

- **what the price estimate cost:** told/nominal minus oracle/nominal;
- **what the valuation cost:** oracle/nominal minus the best oracle variant
  (a variant only counts as best if its comfort is not worse than nominal's);
- **which variant did best** under each price lane. If low or high keeps
  winning across cases, the derivation is biased and needs fixing in the
  planner, not a dial turned per home.

What is left after both, against a perfect plan, is the planner's dispatch
logic. The bench has no perfect plan to measure that against yet.

Planners without a scale input get the variant as urgency, which moves only the
part of the pool and car curves below target and leaves the battery alone; each
result records which it was.

## Scoring

The [scoring catalogue](scoring.md) defines comfort, physical failures and
future-dependent economic opportunities. The headline adds raw comfort and
known-price economic points without weighting or normalization. The economic contribution is based on independently replayed
alternatives, preserving service and final stores; simply consuming cheap energy
gets no reward. A warm pool is a thermal buffer, not automatically a penalty.

Rule cards show where each rule applies and the evidence behind each finding.
Known-price and hindsight savings are separated. The car is deliberately treated
as always plugged in, with no unplugged or arrival penalty. Every planner uses
the same rule version and the same case inputs. `--shas none` rescores every
stored successful result in every lane and verifies coverage without requiring
the historical planner commits.

## Results

What a planner decided is the stored truth for a result (`bench_results.record`).
The referee's account of it (series, cost, terminal state, score) is derived
and recomputed from it when the referee or scorer changes, with no planner run.

A result is up to date when its `input_hash` matches the present case,
household, comfort and adapter. Editing a case re-runs that case; changing the
household or comfort re-runs everything; adding a case re-runs nothing.

Each result shows, per case: cost at real prices and, separately, what the
planner expected it to cost; the value of the energy left in the stores at the
end; decisions the household could not carry out; and the planner's own plan
status.

## Where test cases come from

1. **Replay upload on the bench page.** Converted in the browser
   (`convert-replay.ts`); the replay is not kept.
2. **The existing scenarios.** Converted once by the runner on its next run.
3. **Recorded history (not built yet).** Any 72-hour window since 12 August
   2026 can become a case from the quarter tables; actual solar and load are
   then used as a perfect forecast, and unpublished prices hidden.
4. **Hourly history, for windows before the quarter tables.** Home Assistant
   keeps hourly statistics for good. `bench/seed-history.ts` turns 72 hours of
   them (load, solar, the pool's and the car's meters, outdoor temperature,
   start state) into a complete case (`convert-history.ts`). Nothing finer
   than the hour was measured, so each hour is spread over its four quarters
   on a curve that meets the neighbouring hours and keeps the hour's mean
   exactly: such a case tests how a planner behaves under those conditions,
   not what the house did in each quarter. Measured solar and load are the
   perfect forecast; prices are real quarter prices, hidden from the end of
   the last day published at the start. The window and the 60 days before it
   are priced from the day-ahead spot price with the home's supplier and grid
   terms of the day, which gives the prices recorded in August and September
   2026 back to 0.00001 kr/kWh.
   Such a case has no irradiance, no month-to-date grid import and no days of
   forecast against actual. The summer cases were made this way, because no
   day since 12 August gave 60 kWh of sun: C-0616 (24 kWh today, 78
   tomorrow), C-0717 (61 kWh today, 20 and 18 on the days after, at prices
   that fall with the sun) and C-0627 (70 kWh today, 31 tomorrow, at prices
   that rise).

## Not built yet

- A perfect-foresight plan to measure dispatch logic against.
- Planning a case again each day from where the stores then stand, as the
  live planner does. A plan made once for 72 hours repeats on days two and
  three whatever it got wrong on day one ([demand.md](demand.md)).
- The car's conditional "desired" schedule when unplugged (needs the Home
  Assistant integration).
- Giving cases the wind forecast as it was issued instead of the observed wind
  (the forecasts are being kept; no case uses them yet).
