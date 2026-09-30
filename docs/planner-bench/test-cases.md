# Planner bench test cases — spec

Status: **draft for review**. Nothing below is built yet except where marked.

## Purpose

A battery of test cases to score successive planner versions on, so the
planner gets empirically better over time. A test case is **not** a replay of
what happened on a day. It is a 72-hour scenario the planner has to plan for.
Where a scenario's numbers came from (a replay file, a window of recorded
history, a hand edit) does not matter once it is a test case.

The bench lives its own life: its test cases, household, adapter, runner and
scores are owned by `bench/` and its own tables. The only thing it takes from
the rest of the codebase is the planner, one version at a time.

## Concepts

| Term | Meaning |
|---|---|
| **Test case** | One 72-hour dataset in the bench's own format (below). Never changes once made, except by an explicit edit. |
| **Household** | The devices the bench plans in every case, with their parameters and the owner's preferences. One definition for all cases, versioned. |
| **Planner version** | The planner's code, identified by what it does, not by commit (already built: `bench/planner-version.ts`). |
| **Adapter** | The one piece of bench code that turns *test case + household* into the input a given planner version expects. The only bench code that knows planner schemas. |
| **Result** | One planner version's plan for one test case under one household version, with its score. |

## Test case format (`shs-bench-case`, version 1)

Plain JSON, 288 quarters (72 h × 15 min) starting on a quarter boundary.
Every series is an array of 288 numbers, one per quarter. No planner schema
fields.

```jsonc
{
  "format": "shs-bench-case",
  "version": 1,
  "name": "C-0905",
  "notes": "",
  "origin": { "kind": "replay" | "history" | "manual", "detail": "file name, window, …", "created_at": "…" },

  "start": "2026-09-05T12:00:00Z",       // first quarter, UTC
  "timezone": "Europe/Stockholm",
  "location": { "latitude": 59.456, "longitude": 18.041 },

  "prices": {
    "import_sek_per_kwh": [ … ],          // null where not yet published at the start
    "export_sek_per_kwh": [ … ],
    "outlook": { … } | null               // the estimate for unpublished quarters, when the source had one
  },
  "solar_forecast_w": [ … ],              // what the planner is told the panels will produce
  "base_load_forecast_w": [ … ],          // everything the household does not plan, as fixed demand
  "outdoor_temperature_c": [ … ],         // recorded at the house (see Weather)
  "solar_irradiance_w_per_m2": [ … ],     // recorded at the house, when available

  "start_state": {                       // per case; persisted when edited
    "battery_soc": 0.64,
    "pool_water_c": 23.4,
    "ev": { "soc": 0.55, "plugged_in": false, "target_soc": 0.80 }
  },

  "history": {                           // what came before the start, for planners that read it
    "prices": [ { "start": "…", "import_sek_per_kwh": 0.88, "export_sek_per_kwh": 0.07 }, … ],
    "grid_import_kwh": [ { "start": "…", "kwh": 0.3 }, … ]   // month to date, for peak tariffs
  },

  "preferences": null                    // optional owner overrides; null = planner decides
}
```

Rules:

- **Base load includes every device the household does not plan.** Hot water
  and room heaters are fixed demand folded into `base_load_forecast_w` until
  the household plans them. Adding one to the household later means taking its
  share back out of base load, which needs its own per-device series, so the
  converter also keeps `other_devices_w: { "<key>": [ … ] }` for that purpose.
- **Starting state belongs to the case, not the household.** The converter
  fills it from the source: the replay's readings, else the recorded history
  at the start quarter (battery, pool water, car). An edit on the bench page is
  saved into the case. The car keeps whatever the source says, including
  unplugged or already at its target; there is no invented departure time.
- **No value curves in a case.** Curves are the planner's to work out from the
  case (prices, history, states). A case stores only explicit owner
  preferences, and by default none.
- **History is part of the case.** Planners increasingly read what came before
  the start: the live planner estimates unpublished prices from the last 60
  days, and the checkpoint branch builds price regimes and monthly peaks from
  history. The case stores that history, extracted once, so any planner
  generation finds what it needs.
- **A case is complete or it is not run.** A case whose weather is not yet
  recorded (its window reaches into the future) waits; the runner fills it in
  once the history covers the window.

## Household (`bench/household.ts`, versioned)

Version 1 plans:

| Device | Parameters | Default start state |
|---|---|---|
| Home battery | 18.08 kWh, 8.8 kW in, 9.6 kW out, 95 % each way | 50 % |
| Car | 75.6 kWh, 3 × 16 A charger | 50 %, target 80 %, no departure |
| Pool | 55 m³, 764 W pump + 2314 W heater, heat loss 0.13 kW/K | 29 °C |

Defaults apply only where neither the source nor the history has a reading.
The pool's loss is a property of the pool: 0.1308 kW/K is what the idle-loss
fit gives once its reads are paginated (fix on `planner-refactor-checkpoint`,
`0d6d5cc`; the test database's own fit is still rejected as unphysical).

The household holds devices only, not preferences or curves. Heating and hot
water join later. Changing the household's devices bumps its version and every
result is run again; adding a test case never touches existing results.

## Adapter

`adapt(testCase, household, planner) → planner input`. Today every planner on
the bench takes the schema-9 snapshot, so there is one branch. When a planner
version needs a different input, the adapter gains a branch for it; test cases
never change. The planner declares which input it takes by exporting a
constant from its entry module; a planner without one takes schema 9.

## Value curves

How much a kWh in the battery, a degree in the pool or a km in the car is
worth is planner logic, worked out per case:

- **Today (`dev`):** the pool and car curves are the planner's shipped
  defaults unless the owner edited them; the battery curve is either the
  planner's *balanced* curve, or a *price_only* search that the server runs
  before planning (`_shared/battery-cost-curve.ts`, outside the planner
  folder) and freezes into the snapshot. Old replays carry that frozen result.
- **Checkpoint branch:** pool and battery values come from price regimes and
  water values fitted to price history, i.e. from the case itself.

So: the battery cost-curve search moves into the planner folder, the adapter
lets each planner version compute its own curves from the case, and each
result records the curves that version planned with. The bench page shows
them per case and per planner version.

## Where test cases come from

1. **Replay files (upload on the bench page).** Converted to a test case on
   upload: prices, solar and base load (plus the non-household devices'
   forecasts) from the replay's slots; starting state from its readings. The
   replay itself is not kept. History and weather come from the recorded
   tables; a freshly uploaded replay's weather is recorded over the following
   three days, and the runner fills it in automatically once it is.
2. **The existing seven cases.** Converted the same way, once, with history
   and weather extracted in the same step. C-0928a and C-0928b get the rest of
   their weather automatically on the first bench run after 11:15 UTC on
   1 October 2026; nothing has to be done by hand.
3. **Recorded history (later).** Any 72-hour window since 12 August 2026 can
   become a test case from the stored quarter tables
   (`energy_optimisation_price_slots`, `_actual_slots`, `_outdoor_slots`,
   `_pool_slots`, `_device_slots`). Open question below on forecast versus
   actual solar and load.

## Weather

- **Test cases** use the outdoor temperature (and irradiance) Home Assistant
  recorded at the house (`energy_optimisation_outdoor_slots`), treated as a
  perfect forecast. It is precise to the house, which no forecast is.
- **Live planning** is separate: the server gives every plan SMHI's forecast for
  the grid point nearest the home. *(Built: commit 0a5c143, not yet deployed.)*

## Storage

A new `bench_cases` table holds the test case JSON, replacing
`bench_scenarios.input` (the stripped replay). Results reference the case and
record the household version they were planned for. The old scenarios are
converted, then the replay column is dropped.

## Not in scope now

- Random history windows as a button (the converter will make it easy later).
- Scoring plans against what actually happened (actuals), rather than against
  the plan's own projected cost.
- Planning heating or hot water.

## Open questions

Decided:

- **Unpublished prices:** a history case hides them; the planner estimates
  them from the price history the case stores.
- **Solar and load in history cases:** actuals, used as a perfect forecast.
- **Preferences:** worked out automatically per case; explicit overrides only.

Still open:

1. **How much price history a case stores.** The live planner reads 60 days
   (not 14) and weights them with a 21-day half-life. Storing 3 days would
   make every bench planner estimate differently from the live one.
   Proposal: store 60 days, and let each planner version use what it reads.
