# Hot-water permission from household demand

User requirement, 14 October 2026: inhibit hot water when house consumption is
high, permit it when consumption is low, and let the planner decide relative
levels. There is **no maximum pause and no forced permitted interval**. The old
one-hour configuration default is retired; it was not evidence of a customer
choice. This supersedes maximum-inhibition requirements in earlier documents.

## Usage and shape

```ts
const water = planHotWaterDemand({ services, slots, hours,
  other_house_w: householdForecastWithoutControlledWater, locked });
// Candidate projections count water.expected_w once in ReadySlot.base_w.
const command = { type: "house_demand_permission",
  expected_permitted: water.permitted[i], ...water.policies[i] };
```

```python
house_w = self.watts(options["house_consumption_power_entity"])
permit = demand_permission(command, house_w, observed_switch_state == "on")
# Existing capture, authority, overrides and journal perform any changed writes.
```

The planner owns `allow_below_w` and `inhibit_above_w`. HA uses gross measured
house consumption, including hot water and excluding battery charging. This is
not grid import or consumption minus solar. Expected permission and electrical
power are forecasts, not actuator state. HA executes a compact policy without
replanning or choosing an economic alternative.

For each service window, the planner finds a load level whose available valleys
could absorb the expected hot-water energy at the declared running power:
`sum(min(rated_w, max(0, level - other_house_w[i])) * hours[i]) = expected_Wh`.
That level is the lower threshold; the upper threshold adds the declared draw.
Allowing the rated draw at the lower boundary cannot immediately reverse
permission. A flat profile stays permitted; colder household forecasts shift
the levels upwards. Forecasts above running power remain usable and unchanged.

At or below the lower level, permit; strictly above the upper level, inhibit;
between them, retain observed switch permission. There is no timer, quarter
latch, fixed watt threshold, battery-only exception or forecast-validity gate.
Missing readings and plans hold the last setting under existing continuity
rules. Explicit modes and overrides retain their authority. The thermostat
determines actual heating while permitted.

`planner/hot-water-demand.ts` prepares policy and empirical electrical demand
together for complete native candidate projections. Deferred energy is forecast into later
permitted quarters of its original service window using available running-power
headroom. Outstanding energy is visible in `duty_cycle_deferred_kwh`. Locked
next-hour expected power and permissions stay exact, and locked commands retain
their complete policy. A locked policy still responds to measurements.

The native ABI is unchanged. Eligible quarters use the closed demand-policy
command discriminator; unsupported readers reject it. Price pauses use the
existing explicit `permit_inhibit: false` command. Update the integration/app before publishing these commands. The new
generated hot-water fixture is tested against both the real producer and HA
consumer; existing generated fixtures remain exact.

The HA gateway receives the shared house-power binding through native
configuration. Readiness names the Energy field even without a battery.
Correction links, highlighting and required-field visibility use the existing
editor catalog. Retired pause settings are removed by the acknowledged app
configuration writer, preserving execution modes and actuator ownership.

## Synthesis and tradeoffs

The independent Codex candidate is the base: planner-owned measured-demand
policy, with HA retaining observation and actuator ownership. Adopt Claude's
conclusion that no new solver ABI is needed, its explicit frozen-policy handling,
and separation of permission from predicted watts. Reject its battery-only gate,
quarter latch, presumed rating subtraction and deferred-energy ledger. Those add
decision conditions or accounting claims beyond the requested control. The
subsequent explicit user decision removes maximum-pause protection.

The subsequent [price-selection design](hot-water-price-selection-2026-10.md)
supersedes thresholds from historical controlled-device forecasts. Complete
candidate projections use chosen pool, EV and home-battery flows. Battery power
enters the site-load level and is translated out of the published gross-house
thresholds. Unforecast appliances can change actual permission; the electrical
trajectory remains conditional, not proof of usable hot water.

The declared running draw must describe the controlled equipment. A shared Nibe
meter is never subtracted as presumed hot-water power. This does not establish
tank state, change Nibe service priority, commission an actuator, correct winter
baseload forecasts or remove battery replan recommendations.

Verification covers seasonal level shifts, own-draw stability, extended
inhibition without forced runs, energy conservation, exact commitments, real
same-quarter execution, subscriptions without a battery, restarts, unavailable
readings, Verification without writes, retired settings, correction navigation
and generated producer/consumer agreement.
