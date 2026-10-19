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
temperature for each modelled room whose controlled members are all setpoint
thermostats. Each quarter chooses room power between zero and the smallest of
the combined thermostat rating, the room's power ceiling (zero in the June–August
lockout) and the household import headroom left by earlier rooms. Committed
and booked quarters keep their retained power exactly.

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

## Commands

A thermostat takes temperatures, not watts. Each quarter's `target_c` is the
planned temperature at the end of that quarter, clamped into its
`[minimum_c, maximum_c]` = `[comfort_min_c, comfort_max_c]`. The quarter before
Comfort therefore already asks for Comfort, and a coasting quarter's setpoint
is the passively cooled temperature, so the thermostat only heats when the room
cools faster than modelled. Home Assistant rounds to the thermostat's step.

## Unchanged

Rooms with relays (`switch_schedule`), rooms without a usable model, a measured
temperature or a complete outdoor forecast keep the previous quarter-by-quarter
path. Ingest still publishes the backward-pass power forecast as each room's
unplanned reference. No snapshot, plan or HA contract changed.
