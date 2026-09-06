# Historical record: Models And Delivery

[Architecture index](../../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [History index](README.md)

> **Historical evidence, not current requirements.** This is a preserved part of the pre-split document, including superseded claims, old implementation statuses, and unresolved experiments. The current topic specifications linked from the architecture index take precedence. References to deployed behaviour describe the date of the original entry, not a fresh verification.

<!-- BEGIN PRESERVED SOURCE -->
<a id="legacy-section-9"></a>

## 9. Parameter model

<a id="legacy-section-9.1"></a>

### 9.1 Parameter classes and ownership

| Class | Examples | Source/owner | Can be learned? |
|---|---|---|---|
| Hard installation | Fuse/import/export limit, rated power, battery min/max SOC, inverter modes, actuator relationship | Staff commissioning + integration verification | No |
| Customer policy | Comfort targets/ranges, EV target SOC and optional departure, quiet hours, reserve preference | Customer/staff in portal | No; suggestions only |
| Live state | SOC, temperatures, presence, cycle complete, override, availability, work completed | Integration from HA | No substitution |
| Forecast | PV, outdoor temperature, base load, import/export prices | Integration adapters + server models; outdoor temperature may also be read from met.no server-side when the home's adapter falls short ([§9.1.1](models-and-delivery.md#legacy-section-9.1.1)) | Bias/error can be learned |
| Device dynamics | COP, modulation, startup, efficiency, thermal capacity/loss, power curve | Manufacturer profile, then measured calibration | Yes, within validated bounds |
| Market/tariff | Effective version, price series, demand rule, month peak | Portal catalogue + integration recorder | No |
| Orchestration | 15-minute step, 72-hour look-ahead, binding horizon, replan thresholds | SHS model version | Product-controlled |

<a id="legacy-section-9.1.1"></a>

#### 9.1.1 Outdoor temperature: one exception to integration ownership

Every other forecast reaches the planner through the home's own integration,
and outdoor temperature normally does too. It carries one exception, because
the integration cannot always deliver what the provider actually published.

Home Assistant's weather platform exposes only the part of a forecast the
provider marks hourly. For met.no that is roughly two days, against a 72-hour
look-ahead — yet the same met.no response describes air temperature for ten,
hourly at first and six-hourly after. The missing 24 hours were never missing
from the provider, only from the adapter. Room comfort forecasting is the one
thing that needs them: a 1R1C zone cannot be projected forward without knowing
what it loses heat to.

So the integration publishes `outdoor_temperature_c` only when its provider
covers every slot, and never a series with holes in it — the two must stay
distinguishable, because a hole means a series was built and not filled, while
absence means no adapter reached that far. On absence the planning edge reads
met.no directly for the home's coordinates, caches the response by rounded
coordinate until the provider's own `Expires`, and records the result as
`sources.outdoor_temperature` with an empty `entity_ids` so the origin stays
legible.

Coordinates are a property of the home, published at the snapshot's top level
as `location` since integration 0.8.0-beta.7. They were previously carried only
inside `sources.pv`, which made weather a privilege of homes that generate;
`homeLocation()` still falls back to that field for homes on older versions.

<a id="legacy-section-9.1.2"></a>

#### 9.1.2 Solar irradiance

The same reasoning extends past temperature. A room gains far more heat from
the sun than from anything the planner switches on, and the 1R1C fit currently
has one constant — `background_gain_c_per_h` — standing for sunshine, cooking,
lighting and occupants at once. A constant cannot separate a bright day from a
dull one: over the eight days to 2026-09-05 this site received between 0.24 and
4.79 kWh/m², a twentyfold spread that a single averaged term must
under-predict at one end and over-predict at the other.

`shortwave_radiation` — global horizontal irradiance, W/m² — is recorded per
completed quarter on `energy_optimisation_outdoor_slots` for **every** home,
whether or not it generates. Solar gain through a window has nothing to do with
owning an inverter, and a PV forecast is the wrong quantity for it regardless:
that series reports expected AC output, already through array orientation,
shading, temperature derating and inverter efficiency. A wall gains heat from
the sky.

Open-Meteo is the source, because met.no publishes no irradiance. One request
returns the forecast plus 92 days of history, so the column is recorded now
rather than waiting on accumulation — and recorded now because it can only be
recovered for so long: a quarter left unrecorded past that window is gone.

The column is nullable and stays nullable. Rows written before it existed have
no irradiance, unlocated homes can have none, and the provider's reanalysis
does not cover its own oldest days. It is evidence where it exists, never a
precondition.

**The fit.** The zone regression is now four-regressor:

```
y = a·P + γ·(T_out − T_in) + s·I + g
```

`s` is stored as `solar_gain_c_per_h_per_wm2` and is never negative — sunshine
cannot cool a room, so a negative solution is a correlation (drawn blinds on
the brightest afternoons will produce one) and the zone falls back to three
regressors rather than publishing it.

The bias this removes is not confined to the constant. On a synthetic room
driven by a known solar coefficient, fitting blind costs far more than the
background term:

| | r² | `gain_c_per_wh` | `cooling_constant_per_h` | `background_gain_c_per_h` |
|---|---|---|---|---|
| Three-regressor | 0.695 | −9.7% | −15.4% | 0.168 (true 0.05) |
| Four-regressor | 1.000 | exact | exact | exact |

A 15% error in the cooling constant is a 15% error in the home's fitted heat
loss coefficient, because `heat_loss_w_per_c` is derived from it. Omitting the
sun was never only about the constant.

Two rules keep the two model shapes interchangeable downstream. Every consumer
reads the free-heat rate through `backgroundRateForSlot()` rather than the
constant directly, so neither the comfort forecast nor the projection knows
which shape it was handed. And `solar_mean_w_per_m2` is stored with the
coefficient, so a zone with a solar term but no irradiance forecast evaluates
at its own fitted mean — which reproduces the flat background exactly. Losing
the forecast costs accuracy, never correctness, and never shortens the horizon
the way missing temperature does.

Sample sets are chosen once, before any sum is accumulated. Moments are only a
valid regression if every sum ran over the same rows, so a window is either
restricted to the quarters carrying irradiance — when those are at least 80% of
it, and at least `MIN_TRAINING_SAMPLES` — or fitted on everything with three
regressors. It is never mixed, and an unrecorded hour is never read as an hour
without sun.

**Refit on deploy.** Existing models were fitted when `g` still absorbed the
sun, so their constants are inflated and their heat-loss figures low. They are
replaced on each zone's next scheduled refit (`REFIT_INTERVAL_HOURS = 24`), and
the training window's missing irradiance is backfilled from the provider's
92-day history first, so the first refit after deploy already has a full
window to fit on rather than three weeks of nulls.

Three properties keep this from eroding integration ownership:

- it is a fallback, never a default — whatever the home's adapter covers, the
  adapter's figures are used;
- it never invents weather, only interpolates inside the provider's own
  resolution, and yields nothing rather than a partial series;
- it cannot stop a plan. A weather outage costs the home its comfort forecast
  for that push; every other load still plans on prices and recent history.

<a id="legacy-section-9.2"></a>

### 9.2 Minimum device specifications

**Battery/inverter**

- usable capacity, current measured SOC, min/max/backup reserve;
- maximum charge/discharge power as a function of SOC if applicable;
- charge/discharge efficiency and optional cycle-wear valuation;
- grid-charge, export, and island-mode permissions;
- plant import/export limit and unambiguous command sign/mode mapping; and
- write confirmation and recovery behaviour.

**EV/charger**

- presence/cable state, SOC source and freshness, and usable remaining energy;
- a mapped EV energy meter whenever EV scheduling is enabled, so historical EV
  demand can be removed from base load before a new EV service is added;
- target SOC, optional departure deadline (rolling-horizon end when absent),
  and urgent threshold;
- charger current steps and vehicle limit; three 230 V phases and 92% charging
  efficiency are integration invariants, while usable capacity is derived from
  live remaining energy and SOC;
- customer force-charge/manual semantics; and
- behaviour when SOC is unavailable but the vehicle is connected. This must be
  an explicit policy, not a guessed SOC.

**Hot water**

- heater power, tank temperature or a validated energy-to-state estimator;
- normal target, hard minimum/maximum, hygiene/legionella requirement;
- standing loss/usable thermal capacity, occupancy demand pattern;
- minimum run/off time and completion sensor; and
- whether interruption is permitted once heating starts.

**Pool**

- seasonal enabled/closed state, water target and hard bounds;
- pool volume/thermal capacity, heat loss, cover state if available;
- pump filtration requirement distinct from heating requirement;
- pump/heater coupling and confirmation; and
- freeze, flow, and equipment protection constraints.

**Thermal zones and aircon**

- zone-specific temperature sensors, UA, thermal capacity, and heater mapping;
- occupancy-specific normal target plus soft/hard bands;
- rated resistive power or heat-pump input/capacity surface;
- minimum modulation, start/stop/defrost behaviour, and operating cutoffs;
- heating/cooling mode and seasonal transition policy; and
- manual override precedence and expiry.

**Base load and event appliances**

- base load excluding all separately modelled loads;
- weekday/weekend/occupancy/weather features and adequate history;
- event cycle stages, interruptibility, allowed/start-by windows, and user
  intent; and
- metering boundaries that prevent aggregate plus child double counting.

<a id="legacy-section-9.3"></a>

### 9.3 Empirical thermal zone model

Zone thermal properties are **derived from history, not entered**. This is the
main reason to build this rather than deploy an existing optimiser: EMHASS
requires `heating_rate` and `cooling_constant` to be hand-tuned per zone and
suggests 5.0 and 0.1 as starting points. A portal that already stores
per-device quarter-hour energy and room temperature can fit them, and re-fit as
the house changes.

Empirically estimating heat loss is also the right way to size heating cycles.
"How much energy does this room need to reach 21 °C by 06:30, and when must
that start?" is answerable from a fitted zone and unanswerable from a rated
wattage.

The model is the standard first-order (1R1C) lumped-capacitance zone, written
in EMHASS's parameterisation so a fitted zone stays portable:

```
T[k+1] = T[k] + a·P[k]·Δt − γ·Δt·(T[k] − T_out[k]) + g·Δt
```

`a` is temperature rise per watt-hour, `γ` the cooling constant per hour per °C
of difference, `g` a background gain. EMHASS's `heating_rate` is `a·P_nom` and
its `cooling_constant` is `γ`. Physical quantities follow: `C = 1/a` is the
lumped heat capacity, `UA = γ·C` the envelope loss coefficient, and `1/γ` the
time constant.

Fitting is ordinary least squares on the difference equation, regressing the
observed rate of change on heat input, outdoor difference and a constant.

**Two failure modes make the naive form wrong, and both are systematic.**

The first is omitting `g`. A house is heated by far more than its heaters —
appliances, lighting, cooking, refrigeration, occupants at roughly 100 W each,
and window solar gain. Computing `UA = Q/ΔT` from heating energy alone
attributes the whole indoor-outdoor difference to the heaters, when the
envelope was really losing heater output *plus* all of that. The result is a
heat loss coefficient that is too low, every time. Carrying `g` as a free
parameter lets the regression discover those gains instead of folding them into
the loss term.

The second is the steady-state assumption. `UA = Q/ΔT` holds only when the zone
is neither warming nor cooling. On any real day some energy goes into the
structure rather than through the walls, so a warming day overstates `UA` and a
cooling day understates it. This bites hardest exactly where deep setback is
used, because that is when storage does the most work. Regressing the rate of
change keeps that term in `a`, where it belongs.

A related trap appears when splitting envelope loss between air-exposed and
ground-coupled surfaces. Apportioning measured heat by *area* fraction and then
dividing by each path's ΔT is circular: how heat divides depends on each path's
`U×A`, which is the unknown. The honest form,
`Q = UA_air·ΔT_air + UA_ground·ΔT_ground`, is unidentifiable from one day but
identifiable across many, because air temperature swings while ground
temperature barely moves. Independent variation is what separates the
coefficients, and only a multi-day fit can exploit it.

Seasonality is a permanent property of the fit, not a bootstrap problem. The
rolling window drains of heated quarters every spring and refills every autumn,
and in between it holds enough samples to solve while carrying almost no
heating information. Such a window is not rank-deficient, so it produces a
heating gain resting on a handful of quarters, usually alongside a healthy R²
because the loss term explains most of the variance unaided. A minimum count of
genuinely heated quarters is therefore required in addition to a minimum sample
count.

Rejections are ordered so configuration faults are diagnosed before data
sufficiency: a room sensor tracking outdoor air is wrong no matter what the
season is doing, and reporting "not enough heating" would send someone looking
in the wrong place. Only a configuration fault is surfaced as blocked; waiting
for the heating season is surfaced as waiting, because it needs no action.

**A fit is refused rather than published with a caveat** when there is too
little history, when too little of it was heated, when the design is
rank-deficient (a zone whose heater never
ran cannot identify a heating gain), when the fit is poor, when a coefficient
is non-physical, or when the room sensor tracks outdoor air closely enough that
it is evidently not measuring a room. A refused zone reports why.

Fixed COP values deserve specific care. Heat-pump COP falls as it gets colder,
so a constant assumption biases in a way that *correlates with the regressor*,
which is systematic error rather than scatter. Reversible units also record
cooling energy through the same meter, which must not be added as heat.

Scheduled band control produces unusually good identification data. A zone held
flat by a thermostat deadband barely moves, and small excursions buried in
sensor noise identify the parameters poorly. Long free-cooling coasts give a
clean read on `γ`; hard full-duty recoveries give a clean read on `a`.

<a id="legacy-section-9.4"></a>

### 9.4 Per-zone mass and why one strategy does not fit a house

Setback saves energy because it lowers the *average* indoor temperature, and
loss is `UA·(T_in − T_out)` integrated over time. It is not because a heater
running at 100% for a short block is more efficient than one cycling at partial
duty — a resistive element is 100% efficient either way, and the same delivered
heat costs the same. Getting the mechanism right matters, because it predicts
where the strategy stops working:

- **Low-mass zones** (wall panel convectors) recover fast, so deep setback is
  nearly free and the shifting window is wide.
- **High-mass zones** (concrete floor heating) recover slowly. Recovery must
  start long before the band tightens, which shrinks the window the planner can
  shift within and can make a shallower band cheaper overall.
- **Inverter heat pumps and aircon** break the resistive intuition entirely.
  COP varies with load and outdoor temperature, and many units are *more*
  efficient at partial load. Deep setback followed by hard recovery delivers
  the most heat at high output, possibly at a colder hour, and can lose to a
  shallower band.

The same house therefore wants opposite strategies in different rooms, which is
why per-zone `a`, `γ` and recovery lead are fitted individually rather than one
whole-house figure being applied everywhere.

<a id="legacy-section-10"></a>

## 10. Seasonal and condition scenario matrix

<a id="legacy-section-10.1"></a>

### 10.1 Canonical 72-hour seasonal fixtures

Maintain four deterministic mock snapshots of exactly 288 quarter-hours. Each
uses the same home/device capabilities and initial-state contract so changes in
planner output are attributable to the seasonal inputs rather than a different
inventory.

| Fixture | Forecast character | Primary behaviour under test |
|---|---|---|
| Winter | Little PV, sustained cold, high room-heat demand, coincident thermostat requests and volatile prices | Comfort preservation, fair heating allocation, peak limiting and recovery |
| Spring | A cold first day followed by a 10–20 °C warm-up, increasing PV and moderate prices | Avoid unnecessary reheating before forecast warmth without violating comfort |
| Summer | High/uncertain PV, pool and EV demand, hot-water duty cycles, no comfort heating | Surplus allocation, battery headroom, pool/EV deadlines and boiler inhibition |
| Autumn | Falling temperature, cloud fronts, intermittent heating restart and evening price peaks | Stable seasonal restart, preheating and forecast-error recovery |

The current schema can already mock PV, empirical base load, import/export
prices, battery/grid state, EV, pool, hot-water services and fixed empirical
device forecasts over those 288 slots. It cannot yet evaluate coordinated room
heating: a generic controllable `device_model` is currently an exogenous
`forecast_w_by_slot`, not a scheduling decision. Marking a heater controllable
therefore exposes its series but does not optimize its thermostat or timing.

Before the fixtures can make honest room-heating claims, add a thermal-zone
contract containing, per zone:

- current indoor temperature and timestamped outdoor-temperature forecast;
- occupancy-dependent preferred, soft and hard comfort bands by slot;
- heater rated power, actuator/confirmation identity and minimum on/off time;
- either calibrated heat-loss/thermal-capacity parameters or a versioned
  empirical temperature-response model with confidence; and
- room priority plus the whole-home heating/grid power envelope.

The planner output then includes aggregate heating power, per-zone expected
temperature/heat energy, comfort margin and reason codes. Seasonal fixtures can
be built concurrently with that contract and must be run in shadow/historical
replay before any relay executor is enabled.

<a id="legacy-section-10.2"></a>

### 10.2 Condition scenario matrix

Yes: more scenarios are required before parameters or control policy can be
considered complete. Tests should assert invariants and direction of behaviour,
not one brittle exact schedule.

| Scenario | Essential setup | Expected behaviour / invariant | Parameters exercised |
|---|---|---|---|
| Sunny summer, EV away | Battery near target, pool below normal target, large midday surplus | Charge useful electrical/thermal storage toward hard limits; export only after eligible sinks are satisfied | PV bias, pool loss/capacity, battery headroom, soft/hard targets |
| Sunny today, rainy tomorrow | More surplus than normal daily needs | Pre-charge/preheat according to future avoided import and terminal value | 72 h forecast, terminal state, thermal storage |
| Sunny summer, EV home below urgent SOC | Same as above with low-SOC connected EV | EV is conditionally promoted; pool may undershoot normal target but not hard minimum | EV urgency/deadline, conditional ranking |
| Cloudy today, sunny tomorrow | Low current PV, high forecast PV | Avoid unnecessary grid-funded overshoot today; preserve room for tomorrow's PV | Forecast confidence, terminal capacity |
| Flat-price summer | No economic time spread | Avoid gratuitous switching and peaks; satisfy service with simple stable operation | Tie-breakers, hysteresis |
| Negative or extreme prices | Very low/negative import or unusually valuable export | Respect hard limits and use actual economics; do not assume export is always last | Objective policy, battery wear, grid permissions |
| Dark deep winter | Near-zero PV, high heat demand, varying prices | Maintain hard comfort; use battery/thermal flexibility without inventing solar work | COP, zone UA/C, reserve, base-load forecast |
| Extreme cold / heat-pump cutoff | Outdoor temperature near device limit | Preserve comfort with available sources; never schedule unavailable capacity | Capacity curve, backup heat, hard comfort |
| Cold but sunny winter | PV coincides with heating and low COP | Allocate PV using actual source efficiency and zone need | COP surface, resistive-vs-HP choice |
| Shoulder season with rapid weather change | Heating demand toggles around cutoff | Replan without chatter; manual and occupancy rules remain authoritative | Seasonal thresholds, hysteresis, forecast error |
| Heatwave / active cooling | High indoor temperature and strong PV | Hard maximum indoor temperature outranks savings; pre-cooling only inside comfort policy | Cooling model, occupancy, soft/hard band |
| Pool closed / freeze protection | Pool season disabled or cold equipment space | No comfort heating when closed; mandatory protection still runs | Seasonal enable, hard safety rule |
| EV absent, then arrives late | Original plan assumed no EV | Arrival triggers bounded replan; no phantom EV work before presence | Live availability, replan trigger |
| Boiler/pool already complete | Daily service was completed before replan | Required remaining service is zero; no duplicate run | State-derived requirement |
| Unexpected stove/sauna load | Large uncontrolled load starts during planned charging | Shed lowest-priority controllable load and stay inside connection envelope | Import envelope, reverse priority, confirmation |
| Near a real monthly demand peak | Effective tariff has a demand rule and month peak is known | Value only the incremental new billed peak; existing peak is sunk | Tariff rule, month-to-date peak |
| Sensor unavailable/stale | SOC, temperature, price, or power source expires | Affected device becomes ineligible; no guessed value; repair/status explains why | Freshness, safe disengagement |
| Actuator fails to change state | Command sent but power/state does not confirm | Enter fault, stop reallocating assumed watts, notify, replan without device | Confirmation timeout, fault state |
| Manual override/vacation | User changes local mode | Manual state wins immediately and is included in the next snapshot | Precedence, override expiry |
| DST transition | 23- or 25-hour local day | UTC slots remain contiguous and no service is duplicated or omitted | Time contract, daily reset semantics |
| Forecast miss | Planned sun does not arrive, or surplus exceeds forecast | Local allocator corrects within hard policy; material drift triggers replan | Reactive reserve, deviation threshold |

For each scenario, record at least energy balance, cost, import peak, export,
self-consumption, comfort violations, unmet service, switching count, final
states, and all reason codes.

<a id="legacy-section-11"></a>

## 11. Missing information and specifications

<a id="legacy-section-11.1"></a>

### 11.1 Must be decided before any production control

1. **Objective policy:** ~~resolve the self-consumption-versus-money
   conflict~~. **Resolved 2026-08-16** by the rewritten section 8: service is
   priced alongside energy, self-consumption stops being a competing objective,
   and the `battery_target_is_hard` switch is deleted rather than answered.
   What remains is to elicit the five utility curves ([§8.3](objective-foundations.md#legacy-section-8.3)) and the degradation
   cost, and to complete the seasonal replay in [§8.11](objective-foundations.md#legacy-section-8.11) before any control.
2. **Multiple-instance policy:** token/read/plan binding to one `home_id` is
   implemented; still define whether multiple HA instances may represent one
   home and which instance is authoritative.
3. **Control authority:** confirm that optimisation is advisory for thermal and
   service loads, and define when battery direct control is permitted.
4. **Global precedence:** approve the conflict order in section 6.3 and define
   what “manual override” means for every device.
5. **Connection constraints:** confirm real import/export limits, whether the
   temporary 5 kW EMHASS cap should disappear, and whether any device-level
   concurrency exclusions exist. Phase balancing remains out of scope.
6. **Tariff truth:** verify the active commercial tariff publication. The code
   correctly models no demand charge from June 2026; future rules must arrive as
   effective-dated versions rather than assumptions.
7. **Battery policy:** reserve, grid charging/export permission, cycle-wear
   treatment, terminal SOC value, and behaviour in backup/island mode.
8. **Required state sources:** identify reliable tank/pool/zone temperature,
   EV SOC/presence, completion, power, and actuator-confirmation entities.
9. **Soft versus hard targets:** define normal, acceptable, and inviolable limits
   for EV, hot water, pool, and each thermal zone.
10. **Failure behaviour:** approve plan expiry, stale-sensor, failed-command,
    backend-unavailable, and partial-forecast behaviour. No hidden fallback
    numbers are allowed.
11. **Privacy/retention:** approve uploading 15-minute home and device aggregates,
    retention duration, customer disclosure, and deletion/export behaviour.
12. **Baseline/savings method:** define the clean pre-control period and the
    counterfactual method. The current dumb/smart ROI runs are not valid for this.

<a id="legacy-section-11.2"></a>

### 11.2 Needed to parameterise Phil's house

- the Energy Dashboard and current planner source inventory is now reconciled;
  actuator, availability and command-confirmation bindings remain for each
  executor;
- meter-boundary reconciliation, including the negative unmetered helper and
  the unidentified Shelly channel;
- battery capacity/power/SOC sources are verified; usable-vs-rated capacity,
  efficiency calibration, reserve policy and Sigen write-mode semantics remain;
- EV charge-current granularity and live power are verified; an optional
  explicit departure timestamp and SOC reliability remain commissioning
  decisions;
- boiler tank state, hard temperature bounds, losses, and hygiene policy;
- pool water state, cover/season policy, loss model, filtration requirement,
  and hard bounds;
- zone-specific heat loss and thermal capacity are now fitted per zone from
  collected history rather than split equally ([§9.3](models-and-delivery.md#legacy-section-9.3)); what remains is enough
  accumulated observation for each zone to pass the fit's acceptance checks,
  and a comfort band per zone to constrain planning;
- heat-pump/aircon measured input curves, mode, defrost/startup behaviour, and
  consistent IR power thresholds;
- at least a full heating season of base-load and zone response history, or an
  explicit lower-confidence commissioning model until that history exists;
- live commissioning evidence for the SHS supplier-price and PV adapters,
  including source-freshness and publication-gap behaviour; and
- a current export of all Node-RED control, pool, EV, IR, and override flows.

<a id="legacy-section-11.3"></a>

### 11.3 Forecast horizon specification

The requested three-day horizon needs an explicit uncertainty rule because
exact spot prices do not cover all 72 hours. Recommended:

- `binding_until`: end of the exact overlapping import/export price series;
- later slots: advisory weather/PV/load plus a documented price forecast or
  terminal value;
- only the first binding slot is executed before the next regular replan; and
- the portal visibly distinguishes exact, forecast, and missing data.

Without this distinction a three-day schedule has false precision.

<a id="legacy-section-12"></a>

## 12. Data model changes

The bounded-volume exchange implemented now adds:

- `home_id` to pairing codes and device tokens with a database consistency
  constraint and server-side ownership check;
- `energy_optimisation_actual_slots`, unique by home/start, for sparse completed
  quarter-hours with 120-day retention;
- `energy_optimisation_current`, one overwritten full snapshot/plan per home;
  and
- `energy_optimisation_plan_runs`, compact summaries/errors only, with 30-day
  retention.

This deliberately avoids appending roughly 250–500 kB of repeated 72-hour JSON
every hour. The exact current plan is explainable; historical evaluation uses
the compact run summary plus actual slots. If regulatory/product audit later
requires every historical slot, archive a compressed daily plan artefact in
object storage rather than duplicating rolling horizons in PostgreSQL.

Before multi-home energy-history/billing is enabled, also add `home_id` to the
older category readings, supplier costs, and tariff calculations and update
those screens to select a home. They remain customer-scoped today.

The control-product stages still need:

- `ha_home_bindings` for source adapters and whole-home entities;
- `ha_device_bindings` for device state/measurement/actuator/confirmation maps;
- `energy_control_policies` for versioned normal/soft/hard targets and rules;
- `energy_device_model_parameters` for versioned installed and calibrated model
  values plus provenance/confidence;
- `energy_control_events` for request/command/confirmation/fault/reason events;
  and
- a model-evaluation record linking baseline, plan, actual, model version, and
  forecast error.

The full current plan is mutable by design and bounded; its immutable compact
run record is not. The integration accepts only a verified, unexpired plan for
its bound home.

<a id="legacy-section-13"></a>

## 13. Implementation sequence

### Phase 0 — specification and truth cleanup

- Resolve every item in section 11.1.
- Mark current portal smart/dumb ROI as experimental or disable it until the
  scenarios actually differ.
- Remove production-path guessed defaults and define the canonical contracts.
- Bind HA tokens and data to homes.
- Reconcile the tariff note with the intentional June 2026 no-demand revision.

Exit criterion: a commissioning report can say **ready** or name every missing
field without running a guessed model.

### Phase 1 — observe-only data plane

- Expose 15-minute resolution in the integration options flow.
- Implement canonical supplier, PV, weather, base-load, and live-state adapters.
- Add all-in import/export forecast entities using only the series overlap.
- Add device bindings and upload 15-minute actuals/control state.
- Store baseline data before enabling any optimiser command.

Exit criterion: 30 consecutive days have complete, balanced, home-scoped inputs
and explainable gaps; no control has changed.

### Phase 2 — server planner in shadow mode (initial heuristic implemented)

- Run the verified edge heuristic now; deploy the Python/MILP optimiser behind
  the same typed API when thermal/device constraints require it.
- Start with battery physics, grid balance, prices, PV/base-load forecast,
  import/export envelopes, opportunity ranking, and surplus policy.
- Seed every solve from measured state and produce 72-hour/15-minute plans.
- Compare plans against EMHASS and replay historical seasonal fixtures.
- Persist plan-versus-actual and explanations.

Exit criterion: energy balance and all hard constraints pass, stale/missing data
fails loudly, and shadow results beat the agreed baseline without execution.

### Phase 3 — planned advisory control

- Add per-device request entities and executor blueprints/adapters.
- Start with boiler and coupled pool heating under local termination, then EV.
- Keep thermal zones advisory through bounded setpoint changes.
- Commission battery direct control separately after inverter write/confirmation
  tests and reserve/island behaviour are approved.

Exit criterion: every command is confirmed, every rejected request has a reason,
and baseline/manual control remains independently operable.

### Phase 4 — reactive allocation and shedding

- Implement the single local allocator, power hysteresis, confirmation-aware
  allocation, and reverse-priority shedding.
- Validate the two solar-cliff cases, unexpected-load case, and forecast misses.
- Add event-triggered replanning with rate limits.

Exit criterion: no double allocation, no oscillation, and no connection/comfort
hard-limit violation in replay and live commissioning.

### Phase 5 — heating-season models and calibration

- Collect quarter-hour thermal observations and fit zone `a`/`γ` from them
  ([§5.6](contracts-and-controls.md#legacy-section-5.6), [§9.3](models-and-delivery.md#legacy-section-9.3)). **Done**; zones accumulate history until they pass the fit's
  acceptance checks.
- Build the comfort-band schedule editor and data model ([§5.5](contracts-and-controls.md#legacy-section-5.5)), seeded once
  from existing local helper values. **Next.**
- Consume the band as a planner constraint, and publish a setpoint trajectory
  rather than relay grants ([§7.5](contracts-and-controls.md#legacy-section-7.5)).
- Fit base-load forecasts, HP/COP behaviour, and device completion/loss models
  from actuals.
- Add winter, shoulder-season, cooling, and DST scenario fixtures.
- Replace one-house Node-RED assumptions with versioned product parameters and
  native HA controller templates.

Exit criterion: model error and comfort/service metrics meet agreed thresholds
across representative seasonal conditions.

### Phase 6 — customer value and fleet operation

- Calculate transparent counterfactual savings with uncertainty.
- Show planned versus actual energy, money, comfort, and reasons in the portal.
- Add model-drift, stale-source, failed-command, and fleet health monitoring.
- Roll out by device class and home cohort with explicit enablement.

<a id="legacy-section-14"></a>

## 14. Verification strategy

Use four complementary levels:

1. **Contract tests:** units, signs, UTC/DST, slot overlap, freshness, missing
   fields, plan expiry, idempotency, and schema/model version rejection.
2. **Model tests:** battery conservation, SOC bounds, device state transitions,
   thermal balance, coupling/exclusion/sequencing, and terminal state.
3. **Scenario/replay tests:** every row in section 10 using synthetic fixtures
   and selected historical days from each season.
4. **Live shadow/commissioning:** compare forecast, plan, actual, baseline, and
   command confirmation before enabling each executor.

Required invariants include:

- per-slot electrical energy balances within a stated tolerance;
- no power, SOC, temperature, service, availability, or relationship constraint
  is violated;
- required work is derived from live state and cannot become phantom demand;
- a missing source never becomes a plausible numeric value;
- one watt of surplus is allocated at most once;
- expired plans issue no new optimisation requests;
- manual override changes local behaviour without waiting for the backend; and
- every action can be reconstructed from plan version, inputs, policy, reason,
  command, and measured result.

<a id="legacy-section-15"></a>

## 15. Immediate next actions

1. Freeze new Home Assistant-facing plan semantics except for correcting the
   current rejected-plan defect. Capture the six existing Home Assistant
   endpoints in the normative OpenAPI/JSON Schema source defined by [§5.7](contracts-and-controls.md#legacy-section-5.7),
   including the generated-plan and Home Assistant acknowledgement lifecycle.
2. Generate the TypeScript and Python structural readers, build the shared
   provider-produced contract corpus, and make both repositories' CI required
   deployment gates. The first regression fixture must be a schema-6 dispatched
   EV charging at valid minimum/target/maximum current steps.
3. Add explicit accepted-plan-version negotiation, the common error envelope
   and request IDs before the next plan-schema change. Then add plan
   acknowledgement so the portal can distinguish generation failure, HA
   rejection and ordinary expiry.
4. Deploy the migration, edge functions and portal to the test environment;
   install the matching integration build and pair it to the intended home.
5. Install the current matching integration build, run **Live / automatic**,
   then apply the two explicit installed ratings that discovery cannot infer
   while equipment is off: 3.0 kW boiler and the confirmed pool rating if its
   commissioning measurement is unavailable.
6. Keep the 80% end-of-solar target as a priced preference during shadow mode;
   make it hard only after replay demonstrates that the resulting displaced
   loads and imports match the intended customer promise.
7. Obtain a fresh Node-RED export and create one visible, confirmation-aware
   executor per device that consumes the planned and reactive request entities.
8. Capture at least 30 observe-only days, reconcile the model against HA's
   Energy dashboard, and publish forecast-versus-actual error by source.
9. Build and replay the seasonal/condition fixtures in section 10 before fitting
   thermal, pool, boiler or weather-sensitive parameters or enabling control.

The central architectural principle is: **the server decides what energy is
valuable and when; the home decides whether a device may safely act right now.**

<!-- END PRESERVED SOURCE -->
