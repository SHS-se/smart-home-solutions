# Shared device models: design

Status: steps 1 to 4 below are built (4 October 2026): the bench and the
planner both plan and judge with the device models. The live side and Home
Assistant are next. Two independent candidates (Claude and Codex) were compared; where
they differed is in [Synthesis](#synthesis-decision).

## Problem

The bench referee and the planner each carry their own device physics, and
both pool models are wrong in the same way: the heat pump's COP follows the
outdoor air. Decided on 4 October:

1. Bench and planner use the **same device models**, and they are **part of the
   planner** (in its folder, versioned with it).
2. The referee still judges every planner version in **one world**, and the
   **numbers** in a model are data from the bench household (live: fitted from
   Home Assistant), never constants in planner code.
3. A heat pump's COP varies with its **operating power**, which is
   configurable; later the planner chooses that power.
4. The charger runs at **whole amps** (5 to 16 A, three phases).

What makes the shape non-obvious: old planner versions run their own old code
from a worktree, so "same models" cannot mean the referee loads the tested
planner's models. And the planner folder already has a general household model
(`household-case.ts`, `household-physics.ts`) that knows amp steps and heater
power steps, but as one strict whole-horizon stepper with COP as a series per
quarter.

## Usage (caller's view)

The bench household holds the numbers and no physics:

```ts
export const HOUSEHOLD: Household = {
  site: { /* as today */ },
  ...parseDeviceModels({
    battery: { capacity_kwh: 18.08, /* as today */ },
    car: {
      battery: { capacity_kwh: 75.6, kwh_per_km: 0.16, charge_efficiency: 0.92 },
      charger: { voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 16, current_step_a: 1 },
    },
    pool: {
      store: { capacity_kwh_per_c: 63.965, loss: { kind: 'linear', kw_per_c: 0.13, surroundings_c: 13.5 } },
      heater: {
        setting_unit: 'kw_thermal', control: 'switch', selected_setting: 12,
        operating_points: [                 // compressor W in, heat W out; COP is derived, never stored
          { setting: 6,  electric_w: 1_250, heat_w: 5_875 },   // 4.70
          { setting: 8,  electric_w: 1_650, heat_w: 7_755 },   // 4.70
          { setting: 10, electric_w: 2_250, heat_w: 10_520 },  // 4.68
          { setting: 12, electric_w: 3_000, heat_w: 12_450 },  // 4.15
        ],
        auxiliary_w: 764,                   // the circulation pump: runs with it, heats nothing
      },
    },
  }),
};
```

The referee steps a plan with the planner's kernels and its own policy:

```ts
const carLevels = chargerLevels(car.charger);        // off, 5 A = 3450 W, …, 16 A = 11 040 W
const poolLevels = heatPumpLevels(pool.heater);      // off, the selected setting (draw includes the pump)
const charging = carryOut(carLevels, asked(i, d.ev_w[i]), STEP_TOLERANCE_W);   // reports ev_step
const heating = carryOut(poolLevels, asked(i, d.pool_w[i]), STEP_TOLERANCE_W); // reports pool_step
poolC = stepThermalStore(pool.store, poolC, heating.run.heat_w, air[i], HOURS);
```

The audit moves car charge in whole steps (`step-moves.ts`), and the planner
reads the same operating point:

```ts
const [, run] = heatPumpLevels(devices.pool.heater);
const degreesPerKwh = run.heat_w / run.draw_w / devices.pool.store.capacity_kwh_per_c;
```

## Shape

One leaf module, `supabase/functions/_shared/planner/device-models.ts`. It
imports nothing and states no device number.

```ts
export interface ChargerModel { voltage_v; phase_count; min_current_a; max_current_a; current_step_a }
export interface OperatingPoint { setting: number; electric_w: number; heat_w: number }
export interface HeatPumpModel {
  setting_unit: string;
  operating_points: OperatingPoint[];     // strictly increasing
  selected_setting: number;               // what the owner set
  control: 'switch';                      // 'setting' when the planner chooses the power
  auxiliary_w: number;
}
export type StandingLoss =
  | { kind: 'linear'; kw_per_c: number; surroundings_c: number | null }   // null = the outdoor air
  | { kind: 'measured'; points: { at_c: number; c_per_h: number }[] };
export interface ThermalStoreModel { capacity_kwh_per_c: number; loss: StandingLoss }

export interface Level { setting: number; draw_w: number }          // off first, rising draw
export interface HeatLevel extends Level { heat_w: number }

export function parseDeviceModels(input: unknown): DeviceModels      // validates once; kernels take the result
export function chargerLevels(m: ChargerModel): Levels                // built
export function carryOut(levels, wantedW, toleranceW): Carried        // built
export function operatingPoint(m: HeatPumpModel, setting: number): OperatingPoint   // interpolates; throws outside
export function heatPumpLevels(m: HeatPumpModel): Levels<HeatLevel>
export function idleCPerHour(m: ThermalStoreModel, storeC: number, outdoorC: number): number
export function stepThermalStore(m, storeC, heatW, outdoorC, hours): number
```

Who owns what afterwards:

| File | Owns | Loses |
|---|---|---|
| `planner/device-models.ts` | model types, validation, every device kernel | |
| `planner/energy-optimisation.ts` | reads `snapshot.device_physics` (listed in `PLANNER_INPUTS`); pool and car stores from the kernels | the seeded heat pump and loss, `poolHeaterShare`, the air-following COP |
| `planner/store-models.ts` | vehicle range | its pool COP and pool stepping |
| `src/lib/planner-bench/household.ts` | `HOUSEHOLD` (numbers); comfort captured in the case | `poolCop`, `stepPool`, `poolIdleCPerHour` |
| `referee.ts` | the loop, clipping and reporting, measured worlds, pricing, the battery | all pool arithmetic |
| `step-moves.ts`, `opportunities.ts` | whole-step moves for car and pool | fractional car and pool moves |
| `bench/adapter.ts` | one projection of the household into each planner generation | reading device fields ad hoc |

Invariants: the bench imports one planner file, and that file imports no other,
so the world is that file plus `HOUSEHOLD`; a test pins its code hash next to
`REFEREE_VERSION`, so changing a kernel without re-judging fails. No type has a
COP field. Levels have one source for referee, audit, adapter and planner.

Planners already on the bench cannot read `device_physics`. The adapter tells
them the same world through fields they do read: the pool's draw as its fixed
power, `pool_model.response` with the idle cooling and a gain of COP ÷ capacity
in every bin, and a zero outdoor slope. 040a9fe and later all read that gain,
so they believe exactly the referee's heat per kWh.

Home Assistant interface (not built): the integration sends two more meters in
its existing quarter stream, the heat delivered and the compressor's
electricity, plus the operating setting as a state. It never pairs them: the
heat is reported about an hour late, so alignment and the fit belong to the
server, which turns them into `operating_points`.

Deliberately not done: the planner choosing the setting; COP against water or
brine temperature; the battery's arithmetic; turning the bench into a
`HouseholdProblem`.

## Synthesis decision

Base: the Claude candidate. One parsed `DeviceModels` value and small generic
kernels (`Levels`, `carryOut`) keep referee policy out of the planner folder.
From the Codex candidate: Home Assistant sends raw streams and never pairs heat
with electricity; step legality gets its own 1 W tolerance instead of the
referee's 5 W clipping tolerance; the pool audit's fractional refill is
replaced by whole quarters in the same step as the car. Rejected from Codex:
`executeCharger`/`stepBattery` kernels that carry the referee's clip-and-report
policy and charge-limit handling into the planner module, and moving the
battery arithmetic now.

## Tradeoffs accepted

- We accept two stepping loops (the referee's and `materializeHousehold`'s) in
  exchange for one set of kernels both call; they differ in policy, not physics.
- We accept named slots (battery, car, pool) in exchange for a model that maps
  directly onto today's snapshot and stores; a second heat pump is a version 2.
- We accept that the current planner and the referee share kernel code, so a
  kernel bug is invisible to the bench, in exchange for the planner version
  being the only variable. Kernel tests are pinned to measured facts.
- We accept one full re-plan of every result when the household changes shape.
- We accept a curve fitted from two weeks of readings as the bench's stated
  assumption, in exchange for not waiting on the live fit.

## Alternatives considered

- **The referee on `materializeHousehold`.** It rejects where the referee clips
  and reports, cannot follow the house with the battery in a measured window,
  and keeps COP per quarter. Lost.
- **Models owned by the bench, the planner told through the snapshot.** Today,
  tidied. Contradicts decision 1 and leaves two implementations to drift.
- **The referee loading each tested planner's models.** The world would change
  with the planner, and a planner's own physics error could raise its score.

## Open questions and risks

- **Decided:** the bench household runs at 12 kW, as the house does now.
- **Does COP move with water or brine temperature?** The four points carry
  neither. If the fit shows it does, `OperatingPoint` gains an axis.
- **The car's last quarter.** In whole amps a plan cannot land exactly on the
  car's charge limit; `ev_full` is left as it is.
- **Audit yield.** Whole-quarter pool moves may find less than the fractional
  refill did; compare known savings per case before and after.
- **Live cut-over.** The planner keeps its `pool_model` path until the server
  supplies `device_physics` for every pool home.

## Next implementation step

1. **Built (4 October):** `device-models.ts` with the charger; the referee
   reports `ev_step`; the audit's car alternatives are whole-step moves
   (`step-moves.ts`). No stored plan of any version had a car quarter off its
   steps, so no result fails on it. Rescore only.
2. **Built (4 October):** heat pump, thermal store and `parseDeviceModels` in
   `device-models.ts`, with tests pinned to the four measured points.
3. **Built (4 October), one re-plan:** the household as numbers (`HOUSEHOLD`
   holds `battery`, `car`, `pool` directly, without a `devices` level), the
   heat pump at its 12 kW setting, referee and audit on the kernels,
   `pool_step`, whole-quarter pool moves, the adapter's projection, the bench's
   own physics deleted. The audit's pool alternatives may end up to one running
   quarter (0.05 °C) warmer than the plan, never colder.
4. **Built (4 October), a new planner version:** the planner reads
   `snapshot.device_physics` (listed in `PLANNER_INPUTS`). Where a device has a
   model there, the pool's store is built from the heat pump's operating point
   and the shared thermal step, and the battery's, the car's and the charger's
   numbers come from their models; the older fields are not read for it. The
   bench adapter hands the household's models to planners that list the input.
   A test plans the same case with every older field saying something else and
   gets the same plan.
   Still to do here: a server resolver that fills `device_physics` for live
   homes. Until it does, a live snapshot carries no models, the planner plans
   it from `pool_model` and its seeded pool physics as before, and those stay.
5. `household-physics.ts` adopts the kernels.
6. Home Assistant sends heat, compressor electricity and the setting; the
   fitted curve replaces the bench's assumed one for the live home.
7. Later: `control: 'setting'`, the planner chooses the operating power.
