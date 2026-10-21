# Daily hot-water allowances

User requirements, 14 October 2026. This replaces the household-load threshold
policy and its economic refinement. The planner controls permission, not tank
energy or thermostat demand.

For each local day select at least 150 permission minutes (ten complete
quarters). Preserve elapsed daily opportunities and the exact committed next
hour across replans. The plan's `hot_water_permissions` ledger is carried through
`get_energy_replan_state`; future uncommitted opportunities may move. Local-day
identity handles 23/25-hour DST days; UTC starts distinguish repeated hours.
A partial current quarter contributes its remaining minutes. A horizon or real
equipment limit that prevents 150 minutes produces explicit
`hot_water_shortfall_minutes`, not fabricated heat or permission.

User requirement, 21 October 2026: the boiler never goes more than 12 hours
without a permitted quarter, measured from the end of one to the start of the
next and across local midnights. The ledger therefore also keeps the last 12
hours and the latest permission however old. Where the daily choice leaves a
longer gap, add the fewest quarters that close it, each the best-ranked (same
preferences as above) among the quarters that still leave the rest closable
and whose run fits the headroom. An overdue gap is closed at the first
eligible quarter; with no record the gap counts from the horizon start. The
boiler is in series after the heat pump's hot water, so this bounds standing
time at the tank rather than comfort.

Select opportunities after one native household solve. Prefer quarters without
chosen pool/EV runs, outside the typical 06:00–09:00 and 18:00–21:00 peaks, and
at or below that day's median other-household demand. Within those preference
groups sort by marginal electricity price, other demand, then time. Solar's
marginal price is foregone export. These are preferences, not measurement-validity
bounds or hard household-demand gates. Full declared running power must fit the
configured grid headroom. Include any simultaneously operating heat-pump demand
in the relevant physical load model; do not presume a shared meter isolates it.

User requirement, 21 October 2026: model the tank as a heat deficit, Wh below
a satisfied thermostat, instead of each day's electricity as one lump that
permission may deliver at any time. The boiler's forecast consumption per
quarter is the water drawn (a day the horizon covers in full is scaled to its
daily requirement; a partial day keeps the forecast's shape, and the current
day's requirement beyond the rest of its forecast is owed at the start). Heat
only replaces what has been drawn: a permitted quarter heats at the measured
running power until the deficit is zero, so the tank is never heated beyond
full, and a block leaves the water it draws owed across midnight. Each day
chooses one run, permitted for as long as the tank keeps it heating, and the
quota's other quarters after it, preferring as above and then the lowest cost
of the heat it delivers plus what the tank still owes at the day's end, valued
at the horizon's median import price. The bench referee steps the same tank
through the measured draw. There is still no measured tank temperature or
capacity limit; the deficit is an electrical estimate.

Water is normally excluded from battery supply. Each quarter publishes
`boiler_battery_allowed`. A stored-energy exception reserves the full permitted
running power, only against otherwise exported solar at a future full battery,
allowing for both conversion efficiencies and all intervening household demand
and the physical reserve. Each refill budget can be spent once. Calendar month
and high state of charge alone confer no exception. Native projection uses the
same proportional-PV supply partition that HA enforces from actual device power.
Pool/EV decisions stay fixed; water requires one final projection and no extra
solve. This accepts less joint economic optimality in exchange for bounded,
simple scheduling. Preserve actual cost, wear and terminal-credit accounting.

HA receives only `permit_inhibit`. When a scheduled block encounters a permitted
heater drawing at least 50 W, keep permission on until its live heater power falls
strictly below 50 W (user requirement, 21 October 2026; was 500 W). Exactly 50 W
retains permission. Reevaluate on meter
changes inside the quarter, including after restart. An already blocked heater
is never started by this rule. The device needs an instantaneous heater power
sensor; a static watt rating or total house power is not completion evidence.
Existing manual override, mode handover and unavailable-reading continuity keep
their authority. Completion can extend into an expensive or busy quarter; actual
energy remains visible to the existing deviation accounting.

The shared live/bench chart shows only the planned blue/grey Allowed/Blocked
strip. Remove the load-gate line, its axis contribution and threshold tooltip.
The controller's live explanation identifies a finishing run separately from
planned permission. Bench tank debt remains a synthetic referee diagnostic,
never an assertion of observed real tank state.

Validation covers daily quota/price/load ranking, DST, rolling history, exact
commitments, headroom shortfalls, source permission and finite surplus budgets;
controller 501/500/499 W, same-quarter events, restart, unavailable readings,
Verification and configuration correction; generated real-producer fixtures,
full Deno/HA suites, lint, frontend build, local E2E and complete-handler CPU.

## Separate preheat and final boiler (15 October 2026)

At the reference house the NIBE heat pump preheats water autonomously; only
`switch.water_boiler` controls the separate 3 kW resistive boiler. Use its
own phase energy meters for demand and `sensor.water_boiler_power` for live
completion. The mixed `sensor.hot_water_energy` includes both stages and must
not be used as the controllable boiler's demand. A running compressor cannot
extend boiler permission. No verified usable NIBE permission control exists.

Running power is learned from the boiler's own on-cycle recorder power maxima,
using their median rather than diluted quarter-hour energy averages. Idle or
transitional live readings do not overwrite an established measurement. The
instantaneous sensor also provides completion evidence. Other homes learn their
own equipment power; 3 kW is not a global default.

The allowance strip sits in the bottom **Slot control** section, alongside
economic findings, with its status in the tooltip's information block above
power readings. Cases without identifiable boiler consumption still show the
permission schedule, but mark consumption and heating assessment unavailable.

## Shared electrical run model (17 October 2026)

Live planning and bench execution use `boiler-consumption.ts`. Daily forecast
energy is learned from complete local-day boiler meter totals with recency
weighting and shrunk weekday differences. Sparse history retains the existing
quarter-profile estimate until daily totals can calibrate it. Fitting daily
totals prevents trimming intermittent quarter-hour bursts out of the energy
requirement. Only the boiler's owned meters contribute; heat-pump preheat stays
in household demand. No global daily 3–7 kWh clamp is imposed.

The current day's requirement subtracts already delivered measured boiler
energy in completed quarters and elapsed current-quarter delivery measured by
the live energy counter relative to its Recorder boundary state. Committed
future energy is subtracted exactly once by the run model. Replanning therefore
does not schedule the full day again after an early heating run. Partial current
quarters use their actual remaining duration. Missing counter boundary readings
leave that partial measurement unknown; they do not discard household planning.

Select a contiguous feasible permission window long enough for the expected
heating run, then add later opportunities to meet the remaining 150-minute
daily allowance. Unused permission need not be contiguous. Preserve
the existing price, peak-hour and other-load preferences and all exact locked
commands. Do not begin a forecast run that would have to finish through a known
headroom obstruction. A truncated horizon or insufficient headroom reports
missing minutes, including missing heating duration. This models electrical
consumption and permission, without asserting observed tank temperature or
usable-water availability.

Bench forecast preparation receives only forecast boiler energy. Recorded-world
evaluation uses the same daily run arithmetic with recorded daily boiler energy
and the chosen permissions, including completion of an active run. Recorded
future energy never enters planner inputs. Fully uncontrolled days retain their
recorded consumption. Bench remaining-energy diagnostics are electrical model
quantities, not measured tank debt.
