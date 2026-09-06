# Historical record: Forecast And Comfort

[Architecture index](../../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [History index](README.md)

> **Historical evidence, not current requirements.** This is a preserved part of the pre-split document, including superseded claims, old implementation statuses, and unresolved experiments. The current topic specifications linked from the architecture index take precedence. References to deployed behaviour describe the date of the original entry, not a fresh verification.

<!-- BEGIN PRESERVED SOURCE -->
<a id="legacy-section-1.4"></a>

### 1.4 The objective past the day-ahead window (2026-08-13)

Decided with Phil on 2026-08-13, after the live plan came back **infeasible**
with `priority: terminal SOC 5.0% is below 20.0%` and a schedule whose second
and third days made no sense — pool-room floor heating in August, and loads
piled into hours nothing justified.

<a id="legacy-section-1.4.1"></a>

#### 1.4.1 The unpriced two-thirds of the horizon had no objective

Nord Pool publishes day-ahead. The horizon is 72 hours. So **roughly one third of
every plan is priced and two thirds are not**, and this is permanent, not a
fault. Confirmed on the live plan: `binding_until` 2026-08-14T22:00Z against an
`issued_at` of 2026-08-13T21:45Z — about 26 hours priced out of 72. The portal
showing "39.4 kWh grid import · 0.0 priced" is therefore *correct*: the import
all falls in the unpriced tail. That reading was initially mistaken for a
pricing bug, and it is not one.

What the unpriced tail had instead was this, at `energy-optimisation.ts:1148`:

```js
const score = slots[index].binding
  ? solarW / 1_000 * SLOT_HOURS * slots[index].export_price_sek_per_kwh! +
    gridW / 1_000 * SLOT_HOURS * slots[index].import_price_sek_per_kwh!
  : gridW / 100;
```

Three defects in that one fallback:

1. **No time preference.** 03:00 and 18:00 score identically, so a deferrable
   load lands wherever the tie-break puts it.
2. **Linear in power, so no reason to spread.** Splitting a load across four
   slots and dumping it in one score the same. Nothing in the objective has ever
   preferred a flat grid draw.
3. **Not in SEK.** The priced branch is money; this is watts over an arbitrary
   100. The two are compared against each other whenever a service can be placed
   on either side of the day-ahead boundary, and the exchange rate between them
   is meaningless.

<a id="legacy-section-1.4.2"></a>

#### 1.4.2 One mechanism, not four patches

Phil asked for four things: use solar rather than grid; prefer historically cheap
hours when unpriced; spread grid load to limit peak demand; and export on a price
spike when the energy can be cheaply replaced. These are not four features. They
are four consequences of one missing quantity — **what a kWh is worth in a given
slot** — so the planner gains exactly that:

```
shadowImport(slot) = published import price                      when binding
                   = shapePrior(quarter-of-day) × recentLevel     otherwise
```

- **Solar** already falls out: `gridW` excludes `solarW`, so self-consumption
  wins whenever the shadow price is positive.
- **Time preference** is `shapePrior`.
- **Peak** is a convex adder, below.
- **Export** compares the export price against the *replacement* cost of the
  energy, below.

Everything stays in SEK, so the day-ahead boundary stops being a discontinuity
in the objective.

<a id="legacy-section-1.4.3"></a>

#### 1.4.3 The shape prior is measured, not assumed

Phil's description — "peaks are usually early morning and late evening" — is
correct and is exactly the kind of claim [§1.3.1](portal-and-reporting.md#legacy-section-1.3.1) exists to warn about: it must not
be hard-coded as a constant. It is **derived from the home's own stored prices**,
which is possible now only because [§1.3.7](portal-and-reporting.md#legacy-section-1.3.7) gave us somewhere to store them:
`energy_optimisation_price_slots` holds real all-in per-quarter prices, and the
backfill fills it 120 days back.

So the prior is a by-quarter-of-day median over the stored archive, normalised to
its own daily mean, computed per home and recomputed as the archive grows.
Properties that matter:

- **Normalised shape × recent level**, not an absolute historical price. Shape is
  stable across seasons in a way that level is not, so a July prior must not
  price a January slot.
- **Weekday and weekend are separate**, matching how the base-load profile is
  already built.
- **One estimator, no tiers and no floor** (rewritten 2026-08-18). This
  originally read "below a coverage floor there is no prior, and the planner
  says so rather than inventing one", on the grounds that a home with three
  days of archive has no business claiming to know its price curve. Both that
  and the two-tier patch that briefly replaced it were wrong, for the same
  reason: the fallback was never *no* claim. It was a **flat** tail, and since
  the planner reasons entirely in shadow prices (`planDispatch` bids against
  them, `batteryValueCurve` is built from them, export replacement cost and
  thermal scoring read them), a flat tail deletes time preference from the
  objective itself. That is a far stronger and worse claim than the weak one
  the floor was protecting against, and it is what every young installation got.

  There is now a single weighted estimate and no branch anywhere on how much
  data exists. Every observation contributes with a weight:

  | Factor | Form | What it buys |
  |---|---|---|
  | Recency | Exponential, 21-day half-life | Three days and three years are the same computation; a tariff change works through in about a month |
  | Day type | Same type 1.0, other type 0.35 | A home that has only seen weekdays still gets a weekend answer, softened, instead of a hole |
  | Season | Gaussian over circular day-of-year, σ 45 days | Last February informs this February once the archive holds one, and is inert before that rather than a separate mode |

  Each observation is divided by its own day's mean before it counts, which is
  what keeps shape separable from level, and thinly sampled quarters shrink
  toward a multiplier of 1 — "no opinion" — so a single day cannot spike.

  The floor under all of it is that **the plan's own published day-ahead window
  is an observation**. A home with an empty archive still has a day of real
  prices in front of it, so a shape can always be estimated from something
  measured. The only remaining unshaped case is a plan carrying no prices at
  all, which is a broken price source rather than a young one.

  Two traps this had to survive, both found by reading the live chart. The
  archive holds *tomorrow's* published prices as well as history, because the
  snapshot carries them and they are stored on ingest — so anything phrased as
  "the most recent days" silently included the days it was about to predict.
  And a part-archived day would let a handful of quarters define their own
  slots outright while contributing nothing to the rest. Observations are
  therefore aged against the snapshot's own capture time, never the wall clock,
  and a day under half archived is dropped entirely.

<a id="legacy-section-1.4.4"></a>

#### 1.4.4 Peak spreading survives the effektavgift being suspended

The grid tariff currently has no demand charge — `peak_demand_kw: null` on the
live cost sensor — and Phil expects something equivalent to return. The peak term
is therefore added now with a weight that is deliberately small: enough to break
ties toward a flat grid draw, not enough to override a real price difference.
Being **convex** in grid power is what does the work; the magnitude only decides
how much price it is worth trading away. When a demand charge returns, the weight
becomes its actual rate and the mechanism is already in place.

<a id="legacy-section-1.4.5"></a>

#### 1.4.5 Export is an opportunity cost, not a threshold

Battery export already exists — `battery-export-planner-v6`, gated at
`energy-optimisation.ts:1689` on:

```js
slot.export_price_sek_per_kwh! >= policy.battery_export_min_price_sek_per_kwh
```

A fixed threshold cannot express the condition Phil actually stated, which is
comparative: export when the spike beats **what it will cost to put that energy
back**. That replacement cost is knowable from the plan's own horizon:

```
replacementCost = 0                             when forecast surplus PV will
                                                refill the reserve anyway
                = min(shadowImport over the remaining horizon)
                  / (charge_efficiency × discharge_efficiency)   otherwise
```

Export when `exportPrice > replacementCost`, subject to the existing reserve SOC
floor. The static threshold stays as a hard floor beneath it, because a spike
that beats a cheap tomorrow can still be a bad trade in absolute terms.

This also addresses the infeasible plan. Terminal SOC was violated because
nothing past the priced window valued stored energy, so the battery was worth
draining. Once `shadowImport` extends across the whole horizon, the terminal
valuation the plan already computes has something to price against.

<a id="legacy-section-1.5"></a>

### 1.5 `forecast_w_by_slot` is a command, not a forecast — IMPLEMENTED 2026-08-14

**Status: fixed for setpoint-controlled heating zones.** The empirical profile
remains appropriate for non-thermal devices; it is no longer allowed to become
a room-heating schedule.

<a id="legacy-section-1.5.1"></a>

#### 1.5.1 Why this outranks the objective

[§1.4](forecast-and-comfort.md#legacy-section-1.4) changed *when* the planner places load. It cannot change *how much*, and
the numbers that make a plan unreadable are magnitudes:

| Device | Planned, 72 h | Measured, 72 h |
|---|---|---|
| Pool room floor heater | **10.98 kWh** | ≈ 0 |
| Base load — everything else | **67.2 kWh** | 36.6 kWh |
| Car charging | 1.7 kWh | 19.1 kWh |

Floor heating for eleven kilowatt-hours in August is not a scheduling decision.
Nothing in the objective creates load; it only moves it. That number comes from
`device_models[].forecast_w_by_slot` in the snapshot, built by the integration in
`optimisation.py`, and the portal's planner consumes it as given.

**The critical property, in Phil's words: it "is not making a forecast, it is
deciding what controllable loads to actually run."** For a controllable device
the planner does not predict demand and then satisfy it — the forecast *becomes*
the schedule the automations execute. A forecast that says three hours of
basement floor heating is an instruction to run it for three hours. So an error
here is not a cosmetic mis-estimate on a chart; it is the wrong physical
behaviour, and it is why the automations are not wired up yet.

Judging the schedule is impossible until this is right, and no further work on
the objective is worth doing before it.

<a id="legacy-section-1.5.2"></a>

#### 1.5.2 Where to look

- `custom_components/shs_energy/optimisation.py` — `build_empirical_device_profile()`
  and `build_base_load_profile()`. These produce the per-slot series.
- `OPTIMISATION_PROFILE_DAYS = 10` in `const.py` — the sample window.
- The profile is keyed on weekday/weekend and quarter-of-day, like the price
  shape in [§1.4.3](forecast-and-comfort.md#legacy-section-1.4.3).

<a id="legacy-section-1.5.3"></a>

#### 1.5.3 Questions worth answering first

1. **Is a seasonal load being projected out of season?** A ten-day trimmed mean
   has no notion of "the heating season ended". If the sample window catches any
   heating at all, or a thermostat self-test, it becomes a standing daily
   expectation. Check what the pool room floor heater actually drew over the
   sample window — `sensor.pool_room_floor_heater_energy` — before assuming the
   statistic is wrong; the meter may be reporting something real.
2. **Is a `setpoint` device being modelled as an energy demand at all?** Twelve
   of the seventeen mapped devices are `setpoint`, but they are meters and
   actuators rather than thermal zones. A room's demand is a function of its
   measured temperature, fitted response, outdoor temperature and scheduled
   objective ([§9.3](models-and-delivery.md#legacy-section-9.3)), not of what one heater drew last Tuesday. A duty-cycle mean
   is the wrong model for it, and that would explain heaters appearing in an
   August plan.
3. **Why is planned base load 1.8× measured?** Both figures now mean the same
   thing after the device-list fix, so the comparison is finally sound. Suspect
   double counting: `build_base_load_profile` subtracts modelled devices from the
   house total, so a device that is metered but *not* modelled stays inside base
   load while also appearing as its own row.
4. **What should a device with no usable history do?** Silence and a standing
   average are both wrong. A device the planner cannot model should probably be
   excluded from control and left in base load, rather than issued a schedule
   derived from noise.

<a id="legacy-section-1.5.4"></a>

#### 1.5.4 What actually predicts the five loads (Phil, 2026-08-14)

Recorded verbatim in substance because it is the domain knowledge the statistics
were missing, and it reframes the whole problem.

**Five loads matter. Everything else is base load:**

1. Car charging
2. Water boiler
3. Pool heating
4. Air conditioners
5. Electrical heaters

**Four factors predict them:**

| Factor | Availability |
|---|---|
| Season | Known exactly, free |
| Outdoor temperature | Forecast, already in the snapshot. Kept **separate from season** on purpose — a mild January and a cold May are not their seasons |
| Solar gain (passive heating through glazing) | Derivable from the PV forecast, but needs work: the panels measure *electrical* yield, and what matters here is *thermal* gain into the house. Related but not the same curve |
| **Occupancy** | **Missing. This is the gap.** |

A ten-day trimmed mean of past consumption is a proxy for all four at once and
therefore for none of them. That is the whole defect: `build_empirical_device_profile`
answers "what did this device draw at this quarter last week", when the question
is "what will this room need, given who is home, how cold it is outside and how
much sun is coming through the windows".

##### The occupancy model already exists — in Node-RED

Phil's occupancy model is, in effect, the room heating schedules in Node-RED. It
must not be a runtime dependency — **nothing in the website may call Node-RED** —
but the schedules are the best statement of household routine available and
should be *extracted once* to prime the website's own model.

Shape, from the `cronplus` "Heating Schedule" node:

| Schedule | Cron | Writes |
|---|---|---|
| `morning_high` | `00 5 * * *` | `high-temp` |
| `morning_low` | `30 9 * * *` | `low-temp` |
| `evening_high` | `0 14 * * *` | `high-temp` |
| `evening_low` | `30 21 * * *` | `low-temp` |

So a zone is *occupied-warm* 05:00–09:30 and 14:00–21:30, and setback otherwise.
The thirteen zones each own an `input_text.<zone>_heating_mode`, confirmed live:

`basement_bathroom`, `entrance_hall`, `ground_floor_bathroom`, `kitchen`,
`laundry`, `living_room`, `marks_bedroom`, `master_bathroom`, `master_bedroom`,
`parents_room`, `phils_office`, `sophia_s_bedroom`, `tv_room`

Their states right now are a mix of `off`, `low-temp` and `high-temp`, so the
mode is real, per-zone, and already machine-readable.

**Implemented routine input, replacing the trimmed mean for heating rooms:**

- A per-room weekly **comfort schedule** — quarter-of-day × day-type → one of
  `off` / `low-temp` / `high-temp` — seeded by a one-off import of the cron
  expressions above, then editable in the portal. It is a *household routine*,
  not a device statistic, and is keyed by the stable Home Assistant area ID.
- The room's demand for a slot is then the **thermal model** ([§9.3](models-and-delivery.md#legacy-section-9.3)) evaluated
  against that mode's objective and the outdoor forecast — not a historical
  mean. June–August use an explicit heating lockout. Outside that lockout warm
  outdoor air contributes passive heat through the fitted physics, but does not
  falsely claim that a currently cold room is already at its next objective.
- `ble_trilateration` (Phil's work in progress) can later replace the seeded
  schedule with observed room occupancy. The interface should therefore be
  "a per-room occupancy/comfort series", so swapping the source changes nothing
  downstream.

##### What must stay reactive, and must not enter the plan

Some occupancy is unpredictable by construction. These belong to the reactive
controller ([§7](contracts-and-controls.md#legacy-section-7), **not yet built**) and the planner should not pretend to model
them:

1. **Pool usage.** Only detectable through `sensor.pool_room_th_humidity`: it
   spikes when the cover comes off and falls once the FTX has pulled the
   moisture back out. The existing Node-RED FTX flow already encodes usable
   thresholds — humidity limits scaled by pool-room temperature (>50% above
   24 °C, >60% at 20–24 °C, >70% at 16–20 °C, >80% below 16 °C), a 3-hour
   maximum FTX run, and a `counter.swim_count` incremented on a >65% spike.
   That counter is a genuine occupancy signal and is already being recorded.
2. **Sauna.** Not metered as a device at all, and enormous — unmetered draw has
   been seen spiking to 16 kW, with the low setting around 8 kW. Nothing can
   plan around it; the reactive layer has to absorb it. Worth noting it will
   also corrupt any base-load statistic that includes it, which is an argument
   for fitting base load robustly (median, trimmed) rather than on the mean.
3. **Car usage.** Ordinary departure/return variance.
4. **Away for a few hours.** Phil's existing automation drops every zone to
   `low-temp`. **The reactive controller should deliberately do nothing here.**
   The recovery is the problem, not the setback: every zone returning to
   `high-temp` simultaneously produced a large coincident spike, which mattered
   under effektavgift and matters *more* under 15-minute spot pricing, since the
   return can land on an expensive quarter. Any future handling must stagger the
   recovery, not just trigger it.
5. **Vacation.** The simple case, and the one worth building first: let the house
   fall to a floor (~12 °C), then reheat gradually starting ~48 h before return,
   spreading the recovery to limit peak draw. Needs explicit away-dates as an
   input — which the portal is the natural place to hold.

##### Sequencing this work

1. Fit heating rooms from the thermal model + comfort schedule instead of the
   historical mean. Largest single correction, and it fixes the August floor
   heating outright.
2. Import the Node-RED cron schedules once to seed the comfort schedules.
3. Separate solar *thermal* gain from PV electrical yield.
4. Boiler, pool and EV keep demand-based models (litres, degrees, kWh to
   departure) rather than occupancy schedules — they are services with
   deadlines, which [§5.5](contracts-and-controls.md#legacy-section-5.5) already describes.
5. Vacation dates as a portal input; reactive controller later.

<a id="legacy-section-1.5.5"></a>

#### 1.5.5 Implemented comfort-driven forecast (2026-08-14)

The fix keeps the routine in the portal, Home Assistant identity and telemetry
in the integration, and the fitted physics in the planning edge. Nothing calls
Node-RED at runtime.

**Room identity and configuration**

- Thermal intent is keyed by Home Assistant's stable **area ID**, with the live
  area name retained as its display label. An Energy Dashboard meter is no
  longer treated as a room. Several meters and several heater/climate actuators
  may map to the same room; their energy and rated power are summed for one
  temperature model and one objective.
- Both direct-setpoint devices and on/off room heaters ask for a temperature
  sensor and all controlled heater/climate entities; only the setpoint contract
  additionally offers a direct target entity. The integration derives one
  stable room ID from the actuators' entity or parent-device areas. Save fails
  if an actuator has no area or the actuators span multiple rooms. It no longer
  asks for a duplicate room selector, scheduled comfort/setback helpers or
  reactive manual-override fields. The portal groups every Ready room control
  by that area and shows the complete actuator list beside its schedule.
- An explicit `setpoint` planning role is authoritative regardless of the
  Energy Dashboard category. Heating meters, heat-capable air conditioners and
  pool-room equipment therefore create the same room-owned comfort schedule;
  an inferred `cooling` or `pool_heating` label cannot hide a Ready mapping.
- A `switch_schedule` mapping joins the room model when its category is
  `heating` or `cooling`; this covers resistive heaters and reversible air
  conditioners without turning pool pumps or household switches into rooms.
  Multiple such devices in one area remain one comfort objective.
- The planned-control mappings otherwise use the same smaller contract: switch
  minimum run is optional; availability/season is gone; power is one field that
  accepts either a W/kW entity or reviewed watts; and variable-power control
  uses one number entity plus optional minimum and maximum.
  Entity bounds are proposed automatically, while entered bounds take
  precedence.
- Each device card has its own Save action. Home Assistant validates the card,
  sends the resulting mapping to the server and changes the card to **Ready**
  only from the acknowledged response. Live entity, device and area names are
  uploaded on later exchanges. A complete-inventory marker retires Energy
  Dashboard devices that were removed, while reappearing keys clear retirement;
  renamed devices and rooms therefore update without creating phantom controls.

**The schedule's meaning**

- `energy_optimisation_comfort_schedules` stores one 96-quarter weekday row and
  one weekend row per room, plus its Off, Setback and Comfort temperatures. A
  trigger creates and renames the row from ready room mappings, preserves it
  when another heater joins the room, and keeps it dormant if the final heater
  is retired or temporarily unmapped. Existing rows are seeded once with the Node-RED routine:
  05:00–09:30 and 14:00–21:30 at `high-temp`, `low-temp` otherwise.
- Energy Modeling has a **Comfort** tab. The customer selects a room, chooses an
  Off / Setback / Comfort brush and paints weekday and weekend rows in
  15-minute cells. Tooltips open without a hover delay. Temperatures are
  editable per room, and either day can be copied to the other.
- A yellow Comfort cell is an exact temperature objective, not a command to
  switch heaters on and not a broad comfort band. The room must already have
  reached the configured Comfort temperature when the cell begins. A single
  yellow cell therefore behaves as a 15-minute appointment: recovery may start
  in earlier blue Setback cells, and the next cell's objective governs after
  that instant. Consecutive yellow cells express a period that must remain
  comfortable at each quarter boundary.
- Blue Setback and grey Off cells remain lower temperature objectives, not
  forbidden heating windows. The scheduler may use them for recovery before a
  later yellow deadline. This preserves the freedom needed to stagger rooms
  instead of reproducing Node-RED's simultaneous high/low transitions.

**How room heat enters the shared plan**

- Outside the explicit June–August lockout, the edge joins each room to its
  latest temperature, fitted room-level 1R1C model, summed reviewed heater
  power, portal schedule and slot-aligned outdoor forecast. A backwards pass
  finds the latest physically feasible recovery trajectory. This is the
  unplanned/baseline reference, not the final command.
- The shared electrical planner then moves room heat earlier when doing so
  improves the selected plan's price/solar/peak objective. It evaluates all
  rooms against the same home import envelope and battery reservation, which is
  what permits recovery to be spread across rooms. Moving heat across time
  compensates for thermal decay, so a watt-hour moved earlier is not assumed to
  have identical value at the deadline.
- Every candidate schedule is projected through the fitted room physics. Each
  future quarter must meet its exact temperature objective, heater power cannot
  exceed the combined room rating or grid envelope, and preheating cannot exceed
  the room's Comfort temperature plus the small planner safety ceiling. If
  these constraints cannot all hold, that plan is infeasible rather than
  publishing a plausible-looking but physically false schedule.
- The resulting room wattage is allocated across the room's underlying device
  rows in proportion to reviewed active power, preserving the electrical
  balance and exposing executable per-device requests without inventing a room
  meter.
- Outside summer lockout, a selected room with a missing schedule, stale room
  temperature, untrained model, missing rating, inconsistent mapping or
  incomplete weather horizon fails the plan. It never silently falls back to
  last week's consumption.
- Generated heating device models retain `forecast_method =
  seasonal_heating_lockout_v1` or `thermal_comfort_schedule_v1`; other
  controllable devices carry `empirical_recent_history`. Planned slots also
  carry the authoritative `room_heating_w` map used by the thermal projection.

This version intentionally does **not** derive passive solar heat from the
PV electrical forecast. Outdoor temperature and seasonality are now real
inputs; a calibrated glazing/solar-gain term remains the next thermal-model
increment rather than an invented conversion factor. A `cooling`-category room
control is interpreted as a reversible unit supplying heat because that is the
reviewed installation contract. The heating fit still excludes quarters where
the unit actually cooled; active cooling planning needs its own fitted response
and is not inferred by running the heating model backwards.

<a id="legacy-section-1.5.6"></a>

#### 1.5.6 Constraint on any fix

The portal validates the snapshot but does not second-guess a thermal result.
The planning edge now converts the integration's room telemetry into validated
`thermal_zones` constraints before hashing and storage. Schema 5 retains each
device's `forecast_w_by_slot` as the unplanned/reference trajectory, with
provenance explicit through `forecast_method`; the shared planner's
`room_heating_w` output is the authoritative room-heating decision. An empirical
3 kW heater series and a comfort/physics-derived constraint are therefore no
longer interchangeable, and a thermal input failure refuses the plan instead of
publishing the empirical series under the thermal method.

<a id="legacy-section-1.6"></a>

### 1.6 First readable plan, and what it shows (2026-08-15)

The plan reached the portal end to end for the first time on 2026-08-15 after
the routing defect in [§1.6.2](forecast-and-comfort.md#legacy-section-1.6.2) was cleared. That makes the schedule itself
legible for the first time, and it is not good. Nothing in this section has
been acted on: the scheduler is deliberately untouched until the load model
underneath it is trustworthy, because a plan built on a wrong forecast cannot
be judged.

<a id="legacy-section-1.6.1"></a>

#### 1.6.1 Observed scheduling defects (Phil, 2026-08-15)

Recorded against the 72-hour plan issued 2026-08-15 22:30, model
`thermal-room-planner-v8`. Horizon days: **day 1 = Sunday 16 Aug, day 2 =
Monday 17 Aug, day 3 = Tuesday 18 Aug.**

| Day | Observation |
|---|---|
| 1 | Pool is **over-scheduled**. Too little of the solar surplus is allowed to reach the house battery, so the house draws grid import overnight to cover what the battery should have carried. Bad scheduling. |
| 2 | Pool is already fully heated and the house battery is fully charged — and the planner **exports the surplus rather than charging the car**. |
| 3 | **No pool heating, no car charging.** House battery charges, and everything else is exported. |

The common thread across all three days is that **export is being chosen over
on-site sinks that still have unmet demand**. An EV below its target SOC and a
pool below its daily requirement are both worth more than the export price in
every hour these plans export, so either the objective is ranking export too
highly, the sinks' remaining demand is not visible to it, or the service
windows have already closed by the time the surplus appears. Day 3 having
neither pool nor car scheduled at all suggests the second: a service whose
requirement is already satisfied on paper generates no demand for the planner
to place, even when the physical device would accept the energy.

This is a scheduling-objective question ([§8](objective-foundations.md#legacy-section-8)) and a service-sizing question
([§5.3](contracts-and-controls.md#legacy-section-5.3)), not a thermal one. It is written down here rather than fixed because
[§1.6.3](forecast-and-comfort.md#legacy-section-1.6.3) shows the forecast feeding it is still wrong on one of the three days.

<a id="legacy-section-1.6.2"></a>

#### 1.6.2 Why this was not visible before

`_build_services` selected each service by **meter category** and asserted a
fixed category→control-type table, so a pool-room floor heater metered as
`pool_heating` but mapped as a `setpoint` room control raised
`must use switch_schedule control` and the entire plan was abandoned. Routing
now goes through `device_controls.planning_path()`, the single authority on
which planning model owns a device. A category never implies a control
contract.

Two further consequences were fixed with it, both of the same shape:

- A service was sized from its whole meter category, so the pool service
  demanded the daily kWh of the pool room's floor heater as well. Each service
  is now measured from the meters it actually controls.
- The portal's `empiricalDeviceLoads` shared a service's planned watts across
  every model in the category, including one already planned as a thermal
  room, which under-counted total load.

<a id="legacy-section-1.6.3"></a>

#### 1.6.3 `forecast_w_by_slot` conformance to [§1.5](forecast-and-comfort.md#legacy-section-1.5) — partial

**Implemented.** The [§1.5](forecast-and-comfort.md#legacy-section-1.5) headline fix holds. Room-controlled devices no longer
receive an empirical duty-cycle mean: `prepareThermalPlanning` replaces their
`forecast_w_by_slot` with a comfort/physics-derived series and stamps
`forecast_method = thermal_comfort_schedule_v1` (or
`seasonal_heating_lockout_v1` under summer lockout). A missing thermal input
refuses the plan rather than silently reverting to last week's consumption.

**Not implemented: base load.** [§1.5.4](forecast-and-comfort.md#legacy-section-1.5.4) says four factors predict the loads —
season, outdoor temperature, solar gain, occupancy — and that a rolling mean is
a proxy for all four and therefore for none. That still describes
`build_base_load_profile()` exactly. It remains a per-quarter median of the
last `OPTIMISATION_PROFILE_DAYS = 10` days, split only by weekday/weekend.

**This explains the day-1 anomaly.** Base load exceeds 4 kW across day 1 while
days 2 and 3 look reasonable. Day 1 is the horizon's only weekend day, and a
ten-day window is a poor weekend sample. For the plan issued 2026-08-15 the
window was 05–15 Aug:

| Day type | Days in window | Applies to |
|---|---|---|
| Weekend | **3** (Sat 8, Sun 9, Sat 15) | Day 1 — Sunday 16 Aug |
| Weekday | **8** (6, 7, 10, 11, 12, 13, 14 …) | Days 2 and 3 |

Each weekend quarter is therefore a median of three values — two of which are
Saturdays — applied to a Sunday. One atypical weekend (guests, sauna, oven,
laundry) becomes the standing expectation for every future weekend quarter,
and there are not enough samples for the median to reject it. The weekday
profile has eight samples and is correspondingly calmer. The same 2–3 sample
weakness applies to `build_empirical_device_profile()`, which is keyed the same
way.

So the reported symptom is not a scheduler fault and not a [§1.5](forecast-and-comfort.md#legacy-section-1.5) regression: it
is the known base-load defect, made visible now that a plan renders at all.
Raising the sample window would help the arithmetic and would still be the
wrong model — a longer mean is a longer proxy. [§1.5.4](forecast-and-comfort.md#legacy-section-1.5.4) remains the target.

**Open, in priority order:**

1. Base load needs a model with the four factors as inputs, not a rolling mean
   keyed on day type. Occupancy is still the missing one ([§1.5.4](forecast-and-comfort.md#legacy-section-1.5.4)).
2. Until then, weekend quarters should carry their thin evidence honestly —
   the plan already publishes `base_p10_w`/`base_p90_w`, and a three-sample
   weekend band is wide. The portal does not yet show it.
3. Only after 1 is the scheduling critique in [§1.6.1](forecast-and-comfort.md#legacy-section-1.6.1) worth acting on.

<a id="legacy-section-1.6.4"></a>

#### 1.6.4 Base load, first correction (2026-08-16)

The weekday/weekend keying is gone. Both defects above were visible directly in
the plan: because every future weekday drew the same 96-value series, 17 and 18
August were byte-identical, and the weekend profile rested on two Saturdays and
one Sunday.

`build_base_load_model()` replaces `build_base_load_profile()`. Splitting into
seven independent day-of-week profiles would have made the sample problem worse,
so it pools rather than splits: one shared quarter-of-day shape learned from
every day, a scalar level per weekday that needs only a few whole days to
emerge, and a per-quarter deviation held near one until the samples justify it.
Evidence is weighted by recency on a fortnight half-life, and thin cells widen
the published `p10`/`p90` band instead of narrowing it. With a short window
every day collapses to the shared shape, which is no worse than what it
replaced; as history accumulates, real routine separates on its own.

This is a correction to the *statistics*, not the model class. Open item 1
stands: season, outdoor temperature, solar gain and occupancy are still not
inputs, and a better-pooled proxy for four factors is still a proxy. What it
buys is that days now differ for a defensible reason and that thin evidence is
visible rather than hidden.

Two constraints found while making the change, both bearing on what comes next:

- Home Assistant's recorder keeps 5-minute statistics for about ten days, which
  is why the window was ten days. A longer window has to come from the
  portal's own `energy_optimisation_actual_slots` archive, which began on
  2026-08-10 and is therefore still shorter than the recorder's. The estimator
  is written to improve monotonically as that archive deepens; moving it
  server-side is the natural next step, and the per-slot snapshot contract
  already allows it without a contract change.
- There is **no hot-water tank temperature sensor in the house**. The [§8.3](objective-foundations.md#legacy-section-8.3)
  litre-degree utility curve is therefore not implementable for hot water
  today; the boiler must keep its duty-cycle contract with inhibition until
  a tank sensor exists. Pool water temperature, pool heat-pump COP and every
  room temperature *are* measured, so those curves are unblocked.


<!-- END PRESERVED SOURCE -->
