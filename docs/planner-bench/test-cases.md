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
tables. The only thing it takes from the rest of the codebase is the planner,
one version at a time.

## The four parts

| Part | Where | What it owns |
|---|---|---|
| **Test case** | `src/lib/planner-bench/case.ts`, `bench_scenarios.dataset` + `.recorded` | 288 quarters of what a planner is told, plus what was recorded for the same window afterwards. |
| **Household and comfort** | `src/lib/planner-bench/household.ts` | The devices planned in every case and their physics; what the owner wants, in °C and km. No money. |
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
  "comfort": null                            // { pool_c, ev_km } for this case only; null = the bench's targets
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

Devices, in `HOUSEHOLD`: battery 18.08 kWh (8.8 kW in, 9.6 kW out, 95 % each
way, 5–100 %); car 75.6 kWh, 0.16 kWh/km, 3 × 16 A, 92 %; pool 55 m³, 764 W
pump + 2314 W heater, 0.13 kW/K loss, heat pump COP 4.5 at 20 °C air and
27 °C water; site limits 13.2 kW each way, SE3. Only the heater heats the
pool: the pump circulates and must run with it.

What the owner wants, in `TARGETS`: **pool 30 °C, car 300 km.** One number per
store; no bands, no urgency, no money.

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
- **Pool and car:** from the target by merit order (`planner/merit-order.ts`):
  every quarter offers energy, surplus solar at what exporting it would earn
  and import at its price, each worth more or less of the store depending on
  that quarter's temperature. Cheapest first, the price of the last unit needed
  to end the horizon on target is what a unit is worth at the target.
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
   start state) into a complete case (`convert-history.ts`). Each hour's value
   holds for its four quarters; measured solar and load are the perfect
   forecast; prices are hidden from the end of the last day published at the
   start. The window and the 60 days before it are priced from the day-ahead
   spot price with the home's supplier and grid terms of the day, which gives
   the prices recorded in August and September 2026 back to 0.00001 kr/kWh.
   Such a case has no irradiance, no month-to-date grid import and no days of
   forecast against actual. The two summer cases were made this way, because
   no day since 12 August gave 60 kWh of sun: C-0616 (24 kWh today, 78
   tomorrow) and C-0717 (61 kWh today, 20 and 18 on the days after).

## Not built yet

- A perfect-foresight plan to measure dispatch logic against.
- Planning a case again each day from where the stores then stand, as the
  live planner does. A plan made once for 72 hours repeats on days two and
  three whatever it got wrong on day one ([demand.md](demand.md)).
- The car's conditional "desired" schedule when unplugged (needs the Home
  Assistant integration).
- Giving cases the wind forecast as it was issued instead of the observed wind
  (the forecasts are being kept; no case uses them yet).
