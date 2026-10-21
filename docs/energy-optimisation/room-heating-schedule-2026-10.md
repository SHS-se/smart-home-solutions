# Price- and deadline-aware thermostat rooms

User requirement, 19 October 2026. A room controlled by setpoint thermostats
(the reference house's Master bathroom floor, previously a fixed Node-RED
schedule) uses outdoor temperature, electricity prices and its fitted 1R1C
model. The user chose a per-room programme before the household solve, comfort
before cost, and setpoint rooms first.

## Meaning of the schedule

A Comfort quarter is a deadline at its start, as
[the comfort history](history/forecast-and-comfort.md#legacy-section-1.5.5)
states: the room must have reached Comfort when the first yellow quarter
begins, and stay there at every boundary of the period. Setback and Off are
lower objectives, not forbidden heating windows. Each quarter therefore asks
the room to end at the higher of its own objective (`comfort_min_c`) and the
next quarter's. Heat may not lift the room above `comfort_max_c` (Comfort +
0.5 °C); passive warmth above it is not penalised.

## Planning

`room-heating-schedule.ts` runs a backward dynamic programme over room
temperature for each modelled room whose controlled members are setpoint
thermostats, relays (`switch_schedule`), or both, with at most four relays. Each
quarter chooses an on/off state for every relay, which Home Assistant only
switches for whole quarters, and continuous thermostat power on top, between
zero and the combined thermostat rating. The room's total stays within its power
ceiling (zero in the June–August lockout) and the household import headroom left
by earlier rooms; a relay that would overrun either, or lift the room above
`comfort_max_c`, stays off. Committed and booked quarters keep their retained
relay states and power exactly.

Added 20 October 2026: the Master bathroom gained its heated towel rack as a
planned control, and the relay dropped the room back onto the per-quarter path,
which only heats inside the Comfort quarter itself and drifted the room to
Setback. Heat per watt is the room's whichever member gives it, so the rack
mostly joins when the floor alone is short of power.

The objective is lexicographic. Shortfall below the objective carries a weight
far above any electricity price, so an attainable deadline is always met and an
unattainable one gets the closest recovery and the existing `comfort_shortfall`
warning. The weight is not a willingness to pay and no plan is refused. Among
plans that serve comfort equally the cheapest wins: the room holds Setback or
coasts while power is dear, keeps or stores warmth when it is cheap, and
recovers as late as possible when prices are flat.

Energy is priced at the resolved import price, except power that forecast
solar surplus (after base, boiler and other fixed loads, and earlier rooms)
already covers, which costs foregone export, the rule hot-water ranking uses.
Battery behaviour is unknown before the solve and is not counted on; the
solver sees the chosen room power as fixed demand and may still cover it from
the battery. This accepts less joint optimality than placing rooms inside the
native solver, in exchange for no ABI, Wasm or contract change.

The cost-to-go lives on a 0.05 °C grid with linear interpolation. The forward
pass starts from the measured temperature and evaluates every kink of the
piecewise-linear objective (grid points, end of surplus, the objective, the
power limit), so planned temperatures are exact model transitions. A 48-hour
room takes about 15 ms.

## Delayed rooms

A room whose fitted model has a heat delay (see [models](models-and-forecasts.md#house-boundary-and-heat-delay-20-october-2026))
is planned over two states, temperature and the heat already on its way, on a
0.1 °C × 7-point grid; its forward pass is exact physics from the measured
temperature and the delivered heat built up by the last day's metered power. Heat
put into a floor now warms the room for hours, so the ceiling cannot cap this
quarter's power: a delayed room pays 1,000 SEK per °C planned above
`comfort_max_c`, below a comfort shortfall and above any price, and so never
parks heat in the floor that later overshoots. A house-coupled room with no house
forecast is not run on a guess; it falls back to measured demand with a warning.
On the 19 October replay the delayed bathroom's room planning took 56 ms locally.

## Preferences are read when planning

The prepared forecast caches only a room's slow evidence: its heating devices,
fitted model, rated power and per-quarter power ceiling. Its Comfort routine, its
latest temperature and the heat its floor still holds are read when a plan is made
(`room-planning-zones.ts`). Until 20 October 2026 the product cached finished
zones, so a plan made seconds after Comfort was lowered from 22 to 21 °C still
planned toward 22 °C with a 22.5 °C ceiling; the cache is rebuilt every quarter
but only read by the plans that follow it.

## Commands

A relay is on or off for the quarter as planned. A thermostat takes
temperatures, not watts. Each quarter's `target_c` is the
planned temperature at the end of that quarter, clamped into its
`[minimum_c, maximum_c]` = `[comfort_min_c, comfort_max_c]`. The quarter before
Comfort therefore already asks for Comfort, and a coasting quarter's setpoint
is the passively cooled temperature, so the thermostat only heats when the room
cools faster than modelled. Home Assistant rounds to the thermostat's step.

## Unchanged

Rooms with more than four relays, rooms without a usable model, a measured
temperature or a complete outdoor forecast keep the previous quarter-by-quarter
path. Ingest still publishes the backward-pass power forecast as each room's
unplanned reference. No snapshot, plan or HA contract changed.

## Native thermostat commands and power, 21 October 2026

This section supersedes the continuous-thermostat-power and end-temperature
command descriptions above. The bathroom replay showed why: targets between
21.11 and 21.46 °C all became 21 °C on its whole-degree thermostat, while the
planner expected 686 W and the observed thermostat stayed idle.

The snapshot now carries each native thermostat's supported target grid, current
target, own measured temperature and HVAC heating/idle state. The HA gateway
preserves `hvac_action` in its ordered observations. These facts are captured
freshly, independently of fitted room parameters. Missing native evidence uses
the existing empirical estimate policy, without publishing invented temperatures.

The room programme chooses supported targets directly, together with full-quarter
relay states. Its state includes each thermostat's heating latch as well as room
temperature and delayed heat. User requirement, 21 October: heating starts when
the target exceeds the thermostat's own temperature by at least 0.5 °C. Heating
stops at the target; within that band the observed/predicted latch is retained.
The own sensor is projected from the room using their measured offset at capture.
That constant-offset assumption is an approximation, renewed on the next capture.

A shared projector integrates on-cycle electrical power and the fitted room
transition at intervals of at most one minute, including the shortened first
quarter. The same projection supplies optimisation, published device watts and
room temperatures. A heater is never assigned fractional native power to fit
headroom: new commands must fit their actual projected on-cycle demand. Retained
commands remain exact, but their old watt forecasts are recomputed from native
state. The unplanned comfort reference uses the same thermostat physics.

New setpoint commands carry actual native targets and native hardware bounds in
`minimum_c`/`maximum_c`. Those bounds describe actuator settings; the zone's
`comfort_min_c`/`comfort_max_c` remain room-temperature objectives. This distinction
allows, for example, a supported 22 °C native target to heat a room whose ceiling
is 21.5 °C. The room programme still evaluates the resulting room temperature.
HA's existing nearest-step rounding, halves up, is unchanged, including for exact
retained commands from older plans. No controller ownership or handover changes.

The checked-in bathroom regression preserves captured physics, weather, old
commands and actuals, with a labelled native-state overlay from HA Recorder
because the original export omitted these facts. Replaying historical commands
is separate from assessing a changed schedule: later historical measurements
cannot validate a counterfactual heating schedule.
