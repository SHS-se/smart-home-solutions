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

  "start_state": {
    "battery_soc": 0.64,
    "pool_water_c": 29.9,
    "ev": { "soc": 0.40, "plugged_in": true, "target_soc": 0.80, "departure": "2026-09-06T05:00:00Z" }
  }
}
```

Rules:

- **Base load includes every device the household does not plan.** Hot water
  and room heaters are fixed demand folded into `base_load_forecast_w` until
  the household plans them. Adding one to the household later means taking its
  share back out of base load, which needs its own per-device series, so the
  converter also keeps `other_devices_w: { "<key>": [ … ] }` for that purpose.
- **Starting state is explicit and editable.** The converter fills it from the
  source (replay reading, else the household default), and it can be changed by
  hand afterwards.
- **A case is complete or it is not run.** A case whose weather is not yet
  recorded (its window reaches into the future) waits; the runner fills it in
  once the history covers the window.

## Household (`bench/household.ts`, versioned)

Version 1 plans:

| Device | Parameters | Default start state |
|---|---|---|
| Home battery | 18.08 kWh, 8.8 kW in, 9.6 kW out, 95 % each way | 50 % |
| Car | 75.6 kWh, 3 × 16 A charger | Plugged in at 40 %, 80 % by 07:00 next morning |
| Pool | 55 m³, 764 W pump + 2314 W heater, fitted loss 0.1 kW/K unless the source has a fit | 29 °C |

The household also holds the owner's preferences (value curves, battery policy,
curve mode), taken once from the most recent capture, so every case plans with
the same preferences. Heating and hot water join later. Changing the household
bumps its version and every result is run again.

## Adapter

`adapt(testCase, household, planner) → planner input`. Today every planner on
the bench takes the schema-9 snapshot, so there is one branch. When a planner
version needs a different input, the adapter gains a branch for it; test cases
never change. The planner declares which input it takes by exporting a
constant from its entry module; a planner without one takes schema 9.

## Where test cases come from

1. **Replay files (upload on the bench page).** Converted to a test case on
   upload: prices, solar and base load (plus the non-household devices'
   forecasts) from the replay's slots; starting state from its readings. The
   replay itself is not kept. Weather comes from recorded history once
   available (below), so a freshly uploaded replay waits up to three days.
2. **The existing seven cases.** Converted the same way, once. Their weather is
   extracted from recorded history in the same step; C-0928a and C-0928b become
   complete after 11:15 UTC on 1 October 2026, when their windows are recorded.
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

1. **Prices for unpublished quarters.** A replay carries the server's estimate
   (`outlook`); a history window knows the real prices. Should a history case
   hide the unpublished part and give the planner an estimate, or show the
   real prices (a perfect price forecast)? Proposal: hide, and estimate from
   the preceding 14 days' prices, which the case stores.
2. **Solar and load in history cases.** History has what actually happened,
   not what was forecast. Proposal: use the actuals as a perfect forecast, the
   same choice as for temperature, and say so in the case's origin.
3. **Preferences from one capture.** Is taking value curves and policy from the
   most recent capture right, or should they be set by hand in the household?
