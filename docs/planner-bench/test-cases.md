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
| **Referee** | `src/lib/planner-bench/referee.ts` | Carries the battery, pool and car forward with the household's physics and prices every quarter at what electricity really cost. |

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
                   "ev": { "soc": 0.55, "plugged_in": false, "target_soc": 0.8 } },
  "start_state_unread": [ "pool_water_c" ],  // only while a default stands in for a missing reading
  "comfort": null                            // owner comfort for this case only; null = the bench's
}
```

Recorded part (`recorded`), filled by the runner from the home's quarter tables
(`bench/history.ts`) once the 72 hours have passed:

```jsonc
{
  "prices": { "import_sek_per_kwh": [ … ], "export_sek_per_kwh": [ … ] },  // real, all 288 quarters
  "outdoor_temperature_c": [ … ],            // measured at the house; a perfect forecast for planners
  "solar_irradiance_w_per_m2": [ … ],
  "history": {
    "prices": { "start": "…", "import_sek_per_kwh": [ … ], "export_sek_per_kwh": [ … ] },  // up to 60 days before the start
    "grid_import_kwh": { "start": "…", "kwh": [ … ] }                                       // month to date
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
  page is saved into the case. There is no invented departure time; the car
  keeps what the source says.
- **History is stored, not read at run time.** 60 days of prices (what the live
  planner reads) or as much as exists, and the month's grid import for planners
  that use peak tariffs.

## Household and comfort

Devices, in `HOUSEHOLD`: battery 18.08 kWh (8.8 kW in, 9.6 kW out, 95 % each
way, 5–100 %); car 75.6 kWh, 0.16 kWh/km, 3 × 16 A, 92 %; pool 55 m³, 764 W
pump + 2314 W heater, 0.13 kW/K loss, heat pump COP 4.5 at 20 °C air and
27 °C water; site limits 13.2 kW each way, SE3.

Comfort, in `COMFORT`: pool 28 / 30 / 32 °C and car 100 / 300 / 400 km (really
wanted below / comfortable / no more wanted above), plus how much more an
urgent unit is worth than an ordinary one (pool 1.8×, car 3×).

Hot water and room heaters are not planned yet; they are fixed demand inside
base load. Taking one over later means adding it to the household and taking
its series out of base load, which `other_devices_w` keeps possible.

## Value curves

What a kWh in the battery, a degree in the pool or a kilometre in the car is
worth is planner logic, worked out per case. The bench supplies comfort levels
only, so each version derives its own:

- **`dev` planner:** the battery curve is its *balanced* curve, from the case's
  solar, load and prices. Pool and car curves are the comfort levels priced
  against the horizon's cheapest-tenth price and the device's physics.
- **Redesign branch:** the adapter lets its own code build its planning basis
  from the case's price history, so its history-based valuation runs.

Each result stores the curves the planner reported, and the case view shows
them for the current and the test planner side by side. A version that reports
none shows as such; curves are never rebuilt by the page.

## Results

What a planner decided is the stored truth for a result (`bench_results.record`).
The referee's account of it (series, cost, terminal state, score) is derived
and recomputed from it when the referee or scorer changes, with no planner run.

A result is up to date when its `input_hash` matches the present case,
household, comfort and adapter. Editing a case re-runs that case; changing the
household or comfort re-runs everything; adding a case re-runs nothing.

Each result shows, per case: cost at real prices beside what the planner
expected, the value of the energy left in the stores at the end, decisions the
household could not carry out, and the planner's own plan status.

## Where test cases come from

1. **Replay upload on the bench page.** Converted in the browser
   (`convert-replay.ts`); the replay is not kept.
2. **The existing scenarios.** Converted once by the runner on its next run.
3. **Recorded history (not built yet).** Any 72-hour window since 12 August
   2026 can become a case from the quarter tables; actual solar and load are
   then used as a perfect forecast, and unpublished prices hidden.

## Decisions still open

See the list handed back with this work: how curves should be derived, the
`price_only` battery mode, the price estimator, car availability, the headline
metric and terminal value, the pool pump's heat, and the fate of old results.
