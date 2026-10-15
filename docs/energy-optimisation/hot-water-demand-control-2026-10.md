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

Select opportunities after one native household solve. Prefer quarters without
chosen pool/EV runs, outside the typical 06:00–09:00 and 18:00–21:00 peaks, and
at or below that day's median other-household demand. Within those preference
groups sort by marginal electricity price, other demand, then time. Solar's
marginal price is foregone export. These are preferences, not measurement-validity
bounds or hard household-demand gates. Full declared running power must fit the
configured grid headroom. Include any simultaneously operating heat-pump demand
in the relevant physical load model; do not presume a shared meter isolates it.

Distribute empirical forecast electricity over the selected capacity, capped at
the declared running draw; preserve committed watts exactly. Ten quarters at
3 kW offer at most 7.5 kWh, not a promise of electricity or usable water. There
is no planner tank queue, catch-up deadline, thermal state or moving threshold.

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
heater drawing above 500 W, keep permission on until its live heater power falls
strictly below 500 W. Exactly 500 W retains permission. Reevaluate on meter
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

Installation mappings require a separate reviewed `running_power_w` field for
the boiler. An instantaneous power sensor is completion evidence, never the
rating. Missing rating names its editor and holds existing control settings.
Other homes provide their own equipment rating; 3 kW is not a global default.

The allowance strip sits in the bottom **Slot control** section, alongside
economic findings, with its status in the tooltip's information block above
power readings. Cases without identifiable boiler consumption still show the
permission schedule, but mark consumption and heating assessment unavailable.
