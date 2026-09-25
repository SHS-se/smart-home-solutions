# Historical record: Planner Experiments

[Architecture index](../../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [History index](README.md)

> **Historical evidence, not current requirements.** This is a preserved part of the pre-split document, including superseded claims, old implementation statuses, and unresolved experiments. The current topic specifications linked from the architecture index take precedence. References to deployed behaviour describe the date of the original entry, not a fresh verification.

<!-- BEGIN PRESERVED SOURCE -->
<a id="legacy-section-8.13"></a>

### 8.13 Store value must be derived for every buffered store, not only the battery (2026-08-27)

Acceptance test [§8.12](objective-foundations.md#legacy-section-8.12) #3 — *overheat the pool before a forecast cloudy day; cut
it short or skip it on a cloudy day* — does not pass in a whole plan, and the
emergence path [§8.3](objective-foundations.md#legacy-section-8.3) claims for it cannot produce it. [§8.12](objective-foundations.md#legacy-section-8.12) states the test to
apply: a heuristic the formulation contradicts is either a modelling error or a
correction to the heuristic. This one is a modelling error, and it is the same
one in both directions.

Evidence throughout is plan `1bdbb1b1`, snapshot `schema 6`, planner
`marginal-value-planner-v11`, input hash `f4bb6a72d486`, solved
2026-08-27T16:00Z over 288 quarters. Four replay capsules were downloaded from
different quarters of it; all four carry the same input hash and the same
generation request, so they are four windows onto one solve.

#### What the plan did

| Day | PV | Surplus | Import price | Pool got | House exported |
|---|---|---|---|---|---|
| 27 Aug (evening only) | 2.3 kWh | 1.3 kWh | **2.26 mean — dearest in the horizon** | **20.1 kWh** (9.4 from grid, 33.3 SEK) | 0.6 kWh |
| 28 Aug | 32.6 kWh | 25.4 kWh | 1.42 mean | 70.0 kWh | 0.8 kWh |
| 29 Aug (overcast) | 2.2 kWh | 0.0 kWh | 1.51 mean | 0 | 0 |
| 30 Aug | **37.0 kWh** | **30.4 kWh** | 1.39 mean | **0** | **13.6 kWh** |

The heater ran 23.75 hours without interruption from 27 Aug 18:15, through the
dearest quarters in the horizon, and then declined 30 kWh of surplus on the
sunniest day and exported it. Both halves of heuristic #3 failed in one solve.

The refusal on 30 Aug is the sharper of the two, because the pool is at 27.4 °C
at the time — *below* the household's own "really want heat" threshold — and the
energy on offer costs 0.41 SEK/kWh:

```
30/08 12:00   surplus at 0.46 SEK/kWh   pool 27.79 °C   raw bid 5.61   × retention 0.082 = 0.46   marginal
30/08 14:00   surplus at 0.41 SEK/kWh   pool 27.65 °C   raw bid 5.63   × retention 0.055 = 0.31   refused
30/08 16:00   surplus at 0.41 SEK/kWh   pool 27.51 °C   raw bid 5.64   × retention 0.028 = 0.16   refused
```

#### Three findings

**1. [§8.4](objective-foundations.md#legacy-section-8.4) was implemented for the house battery and for nothing else.**

[§8.4](objective-foundations.md#legacy-section-8.4) says the battery's curve is computed, never configured, and that its
marginal value is the expected cost of replacing that energy later. That is
built: `deriveBatteryValueCurve` reads the covering window's forward import
prices, the remaining forecast surplus and the expected draw, and returns a
curve derived from them. [§8.3](objective-foundations.md#legacy-section-8.3) then assigns the pool and the EV *supplied*
curves — "household taste, one curve" — and asserts in the same section that the
two-way soft target "falls straight out of the curve". It does not, because a
supplied curve contains no forecast.

The asymmetry is visible in one row of the plan's own `store_diagnostics`:

| Store | Curve source | Bids | Published price band |
|---|---|---|---|
| Battery | derived from the forecast | **0.93 SEK/kWh** | 0.86 – 2.87 |
| Pool | supplied, static | **7.77 SEK/kWh** | 0.86 – 2.87 |
| EV | supplied, static | 2.70 SEK/kWh | 0.86 – 2.87 |

A derived value lands inside the price band by construction, because it *is* a
price taken from the forecast — which is why the battery shapes correctly and
ends the horizon full. A supplied value lands wherever the customer's thresholds
and the anchoring reference put it, and here it lands 2.6× above the dearest
quarter on the board. A store whose bid exceeds every price in the horizon
cannot express *when*, only *whether*.

This is a class property, not a pool property. The EV carries the same defect
and is merely masked: it sits exactly at its own 80 % cap, so it had no room to
bid at all.

**2. The steep segment of a preference curve is the operating point, not an
exception.**

`curveFromPreference` pins the *comfortable* threshold at what the energy costs
and the *urgent* threshold at `URGENT_MULTIPLE = 3` times that, so that "the
steep segment clears the dearest hour a household would ever face". Against this
home's anchoring reference of 2.51 SEK/kWh all-in, urgent is 7.52 SEK/kWh, and
the dearest hour the household actually faced was 2.87. The multiple is applied
to a *typical* all-in price and compared against *actual* all-in prices, so it
clears the dearest hour by a factor, not by a margin.

That would still be tolerable if the steep segment were rare. It is not. A 55 m³
pool holds 63.97 kWh per °C and rests well below 28 °C in late August, so
`urgent_below = 28` describes the pool's normal state rather than an exception.
The observed trajectory over four unheated days (24–27 Aug) is 28.50 → 26.86 °C.
The steep segment is where the pool lives.

That trajectory is an observation, not a fit. Those four days are the
air-to-water heat pump's removal, and `sensor.pool_pump_energy` falls from
0.8–2.3 kWh/day to 0.14 and then 0 across them, so circulation had stopped and
the water-temperature probe is not reliably reading bulk water. It is enough to
say the seeded `SEEDED_POOL_LOSS_KW_PER_K = 0.35` is roughly double what the
pool actually did — 0.35 kW/K predicts about 1.1 °C/day against the 0.55 °C/day
observed — and not enough to replace it. A defensible loss fit needs circulation
running, and has to wait for the ground-source unit now replacing it.

**3. The retention weighting is an anti-deferral tax roughly ten times larger
than any price signal.**

The pool store is given `usage_weight` uniform across the horizon and no
terminal weight, so `retentionBySlot` values a unit of heat by the number of
remaining usage occasions. Across this horizon that runs **0.81 at the start to
0.08 at the end**. Heat bought on the last day is discounted tenfold against
identical heat bought on the first.

This is a defensible model of *continuously consumed* warmth and it is the exact
opposite of what [§8.12](objective-foundations.md#legacy-section-8.12) #3 requires. Deferring to a cheaper day is penalised
harder than any intraday or interday price difference can compensate for, and
banking against a cloudy day fails whenever the cloudy day is near the horizon
edge. Since the horizon rolls, "the day after tomorrow" is permanently
half-discarded.

The battery is exempt by construction: `retention_per_slot: 1`,
`usage_weight` all zero, `terminal_weight: 1`. Its stored energy is worth the
same whenever it is put in, and its terminal state carries value past *T*. That
is the [§8.4](objective-foundations.md#legacy-section-8.4) treatment, and it is why the battery can bank and the pool cannot.

#### The experiment that separates physics from value model

Three solves of the same snapshot. The middle row corrects only the physics; the
last row corrects only the value model on top of it.

| | Pool energy | Ends at | Pool energy cost | House import | House export | 27 Aug (dearest) | 30 Aug (sunniest) |
|---|---|---|---|---|---|---|---|
| As shipped | 90.1 kWh | 27.36 °C | 111.6 SEK | 86.4 kWh | 15.0 kWh | 20.1 kWh | 0 |
| Lower loss coefficient only | 78.8 kWh | 28.89 °C | 100.8 SEK | 74.8 kWh | 14.3 kWh | 20.1 kWh | 0 |
| Loss + value model | 81.3 kWh | **29.65 °C** | **59.0 SEK** | **57.2 kWh** | **1.2 kWh** | **1.4 kWh** (all solar) | **21.0 kWh** (20.6 solar) |

Correcting the physics alone changes *how much* and not *when*: the 27 Aug
evening block and the 30 Aug refusal are unchanged to the tenth of a kWh. The
timing is governed entirely by the value model. That is also why the provisional
loss coefficient above does not weaken the finding — every row shares the same
value model or the same physics, and the two effects separate cleanly.

The last row was produced by rescaling the pool curve and carrying its retention
past the horizon edge (`terminal_weight` set to the discounted tail of an
indefinitely repeating usage weight, 2.538, with the curve rescaled by the
inverse so the effective bid was unchanged). It is an experiment, not a proposed
design — the numbers are not the finding. The finding is that both halves of
heuristic #3 appear as soon as the anti-deferral tax is removed, and that they
appear while delivering *more* heat, a pool 2.3 °C warmer, and roughly a third
of the energy cost.

#### What this requires

1. **Every buffered store's marginal value is derived from the forecast**, on
   the [§8.4](objective-foundations.md#legacy-section-8.4) pattern already built for the battery. For the pool the quantity is
   the cost of obtaining the same stored heat at the best remaining opportunity,
   net of the surplus still forecast to arrive, discounted by the heat actually
   retained until it is wanted. "Tomorrow is sunnier" then lowers today's bid and
   "the next two days are overcast" raises it, with no rule for either — which is
   the test [§8](objective-foundations.md#legacy-section-8) sets for itself.

2. **The customer's three thresholds become a constraint and a shortfall price,
   not the bid.** "At least 28 °C by Saturday afternoon" is a comfort constraint
   the plan must satisfy; what it is worth paying to get there is the forecast's
   business. The present formulation conflates *I want it warm* with *I will pay
   7.52 SEK/kWh for it*, and that conflation is finding 2. The editor built in
   [§8.12.2](objective-foundations.md#legacy-section-8.12.2) stays; what changes is what its output is used for.

3. **Terminal value must carry past the horizon for every store, not only the
   battery.** A value function that decays to zero at *T* discards the last day
   of every rolling solve, which contradicts the Bellman decomposition [§8.4](objective-foundations.md#legacy-section-8.4)
   relies on to make the monthly objective tractable.

4. **Scope is buffered stores only** — pool, EV, house battery. Hot water and
   room heat are deadline and comfort problems, not storage-arbitrage problems,
   and keep their existing contracts: the boiler's duty-cycle permit/inhibit
   ([§1.6.4](forecast-and-comfort.md#legacy-section-1.6.4)) and the rooms' comfort-band constraints ([§5.5](contracts-and-controls.md#legacy-section-5.5), [§7.5](contracts-and-controls.md#legacy-section-7.5)). Deferral there
   is a comfort question, not a price question, and must not inherit this
   treatment.

#### Open questions

- **The covering window for a leaky store.** The battery derives its value over
  the longest single deficit run — one night. A pool leaks continuously and its
  relevant window is closer to *until the next dependable surplus*, which is
  longer and forecast-dependent. Choosing this window is most of the work.
- **How the comfort constraint and the derived value compose** when they
  disagree: a pool below its constraint with no affordable window in the horizon
  must do something, and "buy at any price" is the current answer by default
  rather than by design.
- **What the customer curve editor becomes** once its output is a constraint.
  The three thresholds remain the right thing to ask for; the shortfall price is
  a fourth number nobody can state and should be derived.

#### Two secondary defects found in the same replay, recorded separately

Neither changes the decisions above — both were patched out and re-run with
byte-identical plans — but both are wrong and both distort the published
evidence [§8.12.2](objective-foundations.md#legacy-section-8.12.2) exists to provide.

| Defect | Effect |
|---|---|
| `recostSlot` counts battery discharge as spare PV (`pv_w + returnedW − fixed_load_w`) and prices the resulting charge at the *export* price | During 07:15–08:15 on 28 Aug — the four dearest quarters of the day — the pool books all 3500 W as solar at 1.09 SEK/kWh while PV is 693–1135 W and the import price is 2.15. The battery is emptied into the heat pump and the transfer is booked at a price neither side pays. `returnedW` belongs in `headroomW`, which is a feasibility question; it does not belong in a cost |
| The pool store declares neither `min_power_w` nor `power_step_w` | The pool heat pump is `switch_schedule` at 3429 W with a four-quarter minimum run, but the auction may bid it at any power from zero. Latent while the curve dominates and every bid is full power; the moment the bid stops dominating the plan schedules 38 W, 59 W and 340 W tracking PV, which the hardware cannot execute. This blocks finding 1's fix rather than merely accompanying it |

Also: `StoreDiagnostic.reason` has no case for a store at its own state cap and
falls through to `outbid`. The EV in this plan is exactly at its 80 % target and
had no room to bid; the plan says it lost an auction it never entered. This is
the [§8.12.2](objective-foundations.md#legacy-section-8.12.2) distinction — *considered and declined* against *could not
participate* — one level further in.

#### Acceptance tests to add to [§8.12](objective-foundations.md#legacy-section-8.12)

| # | Behaviour that must emerge | Emerges from |
|---|---|---|
| 8 | Skip a dear evening entirely when the next two days carry enough forecast surplus to reach the same state, and reach it | Derived store value over the forecast ([§8.13](planner-experiments.md#legacy-section-8.13)) |
| 9 | Absorb surplus that would otherwise export, ahead of a forecast overcast day, in proportion to how dear the replacement energy will be | The same derived value, in the other direction |

Both are whole-plan tests. Heuristic #3 is currently reproduced only at the unit
level against `store-models.ts` ([§8.12.1](objective-foundations.md#legacy-section-8.12.1)), which is why a plan contradicting it
in both directions shipped without a failing test.

#### Implementation status (2026-08-27), and what the fix actually was

`marginal-value-planner-v12`. Three changes, none of them the derived curve this
section asked for.

| Piece | State |
|---|---|
| Findings 2 and 3, the value model | **Landed.** The stored preference curve is re-stated against the horizon's own prices at plan time, and pool heat is valued as state carried to the horizon edge instead of by how much of the horizon remains |
| The pool's power contract | **Landed.** `min_power_w` equals `max_power_w`, and both come from the service's declared `fixed_power` rather than a seeded constant |
| Finding 1, a curve derived on the [§8.4](objective-foundations.md#legacy-section-8.4) pattern | **Not landed.** See below — the anchoring is a cheaper approximation and its limit is known |
| `recostSlot` counting battery discharge as spare PV | **Landed** in `marginal-value-planner-v19`. Spare is PV surplus alone: a discharging store's output is a transfer it was already paid for through its own allocation, and counting it again handed the charging store a discount nobody funded. The auction never included it — only the settled re-pricing did — so the plan was decided on one number and explained with another |
| `StoreDiagnostic.reason` for a store at its state cap | **Landed.** `at_state_cap`, distinct from `outbid`: a car at its own charge limit never entered the auction, and reporting a contest it could not take part in is [§8.12.2](objective-foundations.md#legacy-section-8.12.2)'s complaint one level in |
| The EV carrying the same defect | Not started |

Against capsule `1bdbb1b1`, all four quarters:

| | Pool | Ends at | Pool energy cost | House import | House export | 27 Aug (dearest) | 30 Aug (sunniest) |
|---|---|---|---|---|---|---|---|
| v11 | 90.1 kWh | 27.36 °C | 111.6 SEK | 86.4 kWh | 15.0 kWh | 20.1 kWh | 0 |
| v12 | 124.8 kWh | **29.48 °C** | 119.6 SEK | 101.7 kWh | **1.9 kWh** | **0** | **43.2 kWh** (26.2 solar) |

Both halves of [§8.12](objective-foundations.md#legacy-section-8.12) #3 now appear. The plan buys *more* pool energy and ends
2.1 °C warmer, which is the point: the objective was never to heat less, only to
heat where it is cheap. Whole-plan net cost falls from 97.3 SEK to 68.7.

**What the fix was.** Not a new value function — a correction to where an
existing one is evaluated. `curveFromPreference` already converts three
thresholds into money using a reference price, and [§8.10](objective-foundations.md#legacy-section-8.10)'s rule is that the
customer states where the thresholds are and the arithmetic states what they are
worth. The arithmetic was being done once, in the browser, against whatever price
was showing when the editor was last opened, and frozen into the stored curve.
Doing it at plan time against the horizon makes the same three thresholds and the
same `URGENT_MULTIPLE` land where they were always meant to: urgent moves from
7.52 SEK/kWh, nearly three times the dearest quarter on the board, to 2.78, which
is what "clears the dearest hour a household would ever face" means.

The reference is the cheapest tenth of the horizon rather than its middle,
because `curveFromPreference` defines the comfortable threshold as the price a
store will still pay while declining an expensive hour. That is the price of
cheap grid, and a low quantile is where it lives.

**The limit of doing it this way.** The anchor reads the *price* of cheap energy
and not *how much* of it there is, so a horizon with one cheap quarter and a
horizon with fifty anchor identically. A curve built the way `deriveBatteryValueCurve`
builds one — over the merit order of the energy actually available — would not
have that blind spot, and finding 1 still stands. `CHEAP_PRICE_QUANTILE = 0.1` is
also calibrated against a single horizon; the two acceptance tests below hold it
in place, but a quantile is a weaker thing than a merit order and should be
replaced by one rather than tuned.

**Two existing tests changed, and neither was adjusted to pass.**

The fixture in "the plan explains why each store bought what it did" held its air
at 22 °C against 30.15 °C water, so over 72 hours the pool lost 3.4 °C into the
steep part of its curve. Buying cheap surplus to prevent that is correct, and the
test only ever passed because `retentionBySlot` discounted the far end of the
horizon to nothing. Its subject is the diagnostic, so the air now sits at the
water temperature and the decay it was never testing is gone.

Acceptance tests 8 and 9 from the table above are added, both whole-plan, both
carrying the reference home's actual stored curve so that what they exercise is
the anchoring rather than a convenient fixture.

<a id="legacy-section-8.14"></a>

### 8.14 The pool heat pump changes type, and the model must tier rather than move (2026-08-27)

The reference installation's pool heat pump is being replaced: air-to-water out,
a Nibe S1256 13 kW ground-source unit in, driven over Modbus TCP and also
pre-heating the water feeding the existing electric boiler. `switch.pool_heater` last ran 23 Aug 12:34–16:12 and has been
off since, with `unavailable` transitions on 25 and 27 Aug; circulation stopped
with it, `sensor.pool_pump_energy` falling from 0.8–2.3 kWh/day to 0.14 and then
0. `pool_model` is null throughout, so every plan in this period uses the seeded
air-to-water figures for a machine that is not there.

The air-to-water model is not obsolete — it is the more common installation and
stays a first-class supported case. What has gone is the ability to *validate*
it here, because this was the only pool in the fleet exercising it. Both facts
have to be built for, and they pull in opposite directions: the new model needs
writing, and the old one needs freezing before it rots.

#### What actually changes in the physics

| | Air-to-water | Ground-source |
|---|---|---|
| COP depends on | Air temperature, water temperature | **Brine/ground-loop temperature**, water temperature |
| Source temperature over a day | Swings 12 °C in late August | Effectively flat |
| Source temperature over a season | Follows the weather | Drifts slowly as heat is extracted |
| Below about 12 °C air | Efficiency collapses; `cutout_air_c: 8` returns zero output | **No cutout** |
| Operating season here | Shut down Sept/Oct, restarted April/May | **Year round** |

Two consequences that are not re-tuning.

**One heuristic disappears and one becomes the whole game.** [§8.3](objective-foundations.md#legacy-section-8.3) argues that
"in spring the COP varies more across a day than the price does, so heating when
the air is warm rather than when power is cheap emerges from the arithmetic",
and [§8.12](objective-foundations.md#legacy-section-8.12) #5 makes that an acceptance test. Both are true of an air-source unit
and false of a ground-source one: with a flat source temperature the COP no
longer varies across a day at all, and **price becomes the only intraday signal
the pool has**. Everything in [§8.13](planner-experiments.md#legacy-section-8.13) about the pool being unable to see price
therefore stops being one defect among several and becomes the entire value of
planning the pool.

**The season the planner was never asked about is now the important one.** A
year-round pool in this climate is probably the largest controllable load in the
house, and its hardest months are the ones with volatile prices and almost no
surplus. That is where [§8.13](planner-experiments.md#legacy-section-8.13)'s cross-day deferral pays most, and where its open
question is hardest: "how long until the next dependable free top-up" is a clean
question in August and close to meaningless in December. The winter form of the
pool's covering window is likely not about surplus at all — it is about the
cheapest window in a price forecast that does not extend that far, which is the
same terminal-value problem as [§8.13](planner-experiments.md#legacy-section-8.13) finding 3 in a harsher form.

#### Requirement: the model tiers, it does not move

`SEEDED_POOL_HEAT_PUMP` is air-shaped in every parameter — `rated_air_c`,
`cop_per_air_c`, `cutout_air_c` — and `poolCop(model, airC, waterC)` and
`stepPoolTemperature(model, waterC, airC, electricalW)` both take air as the
single source temperature. Replacing those values in place would delete the
air-to-water model. What is needed instead:

| Piece | Change |
|---|---|
| `PoolHeatPumpModel` | Becomes a tagged union on `source: "air" \| "ground"`, each variant carrying its own rating point and slope |
| `poolCop` | Dispatches on the tag. The ground variant has no cutout and no air term |
| `stepPoolTemperature` | Signature change, not a parameter swap: the pool still *loses* heat to air while now *gaining* it from the ground loop, and one `airC` argument currently serves both roles |
| `pool-training.ts` | Fits a different regressor set per variant. `MIN_AIR_SPREAD_C` is an air-only identifiability gate; the ground variant needs a brine-spread gate or none |
| Snapshot | Carries the installed type. This is a commissioning fact, [§9.1](models-and-delivery.md#legacy-section-9.1) "hard installation" class — not inferable and not a customer preference |

#### Requirement: the fit needs an epoch boundary, before the new unit runs

`TRAINING_WINDOW_DAYS = 21` with `REFIT_INTERVAL_HOURS = 24`. Once the new unit
starts, every daily refit for three weeks will regress across air-to-water
samples, an outage with circulation stopped, and ground-source samples as though
they described one machine.

It will not fail loudly. `MIN_POOL_FIT_R2 = 0.4` is easy to clear because the
cooling term explains most of the variance unaided, so the blend will return a
`rated_cop` and a `cop_per_air_c` for a machine that does not exist, be stored,
and be consumed by the planner. That is precisely the failure
`MIN_HEATED_POOL_SAMPLES` was introduced to prevent, restated at the level of
the window rather than the sample count: **worse than a refusal, because it
looks like an answer.**

The fix is a recorded commissioning instant per home, before which heat-pump
samples are excluded from the fit. Two details:

- The **loss** fit may span the boundary — loss is a property of the pool, not of
  the machine heating it — but must exclude quarters where circulation stopped,
  because an uncirculated pool's temperature probe is not reading bulk water
  ([§8.13](planner-experiments.md#legacy-section-8.13)).
- `TRAINING_WINDOW_DAYS` currently lives in `thermal-training.ts` and is shared
  with the room fit. A pool-specific window cannot be set without splitting it.

#### Requirement: freeze the air-to-water model against fixtures

This home can no longer exercise the air-to-water path, so from commissioning
onward the only evidence that model still works is a fixture. The data is not at
risk — `energy_optimisation_pool_slots` is retained 1095 days and
`energy_optimisation_device_slots` 400 days, so the whole air-to-water era is
already archived at quarter resolution — which makes this a data-selection task
rather than a race against Home Assistant's ten-day recorder.

A fixture is only useful if it pins the behaviours that distinguish the model.
At minimum it needs windows covering: a spring day where COP varies more than
price and heating follows air rather than tariff ([§8.12](objective-foundations.md#legacy-section-8.12) #5); a cold window where
delivered heat falls below the loss rate and heating correctly stops; and a
mid-season window with heating, circulation and a clean temperature trajectory
from which `fitPoolModel` returns an accepted fit. These belong with the [§10.1](models-and-delivery.md#legacy-section-10.1)
canonical seasonal fixtures.

#### One machine, two sinks: the meter stops meaning what it meant

The unit is a **Nibe S1256 13 kW**, and it will heat the pool *and* pre-heat the
water feeding the existing electric boiler. The boiler needs no new model for
that — see below — but the pool's does, because the measurement underneath it
changes meaning.

`sensor.pool_heater_energy` is a three-phase Shelly on the heater supply. Today
it measures one machine doing one job. Pointed at the S1256 it measures one
machine doing two, and nothing in the snapshot distinguishes them.

`fitPoolModel` regresses pool temperature rise against that meter's energy. Any
quarter where the compressor was making hot water instead contributes
electricity with no corresponding temperature rise, so the fitted COP comes out
**too low**, and — as with the epoch blend above — it clears `MIN_POOL_FIT_R2`
anyway because the cooling term carries the variance. A confident wrong answer,
again.

Two further consequences of one compressor serving several demands:

- **The pool's available power is not a nameplate.** Nibe's internal logic
  prioritises hot water. A pool store declaring a constant `max_power_w` claims
  capacity the unit will not always give it.
- **The control contract moves.** The air-to-water unit was `switch_schedule`:
  the planner closed a relay. The S1256 is driven over Modbus TCP, and the
  planner's lever becomes *block, and nudge setpoints* — the unit chooses within
  what it is allowed. [§4.4](contracts-and-controls.md#legacy-section-4.4) already specifies pool heating as *permit/request
  only*, so this is not a new row in that table: it is the implementation, which
  went to direct relay scheduling, being forced back to what the table always
  said. [§4.4](contracts-and-controls.md#legacy-section-4.4)'s "seasonal enable" for this class is air-source reasoning and does
  not survive either.

The fix for the first is a register rather than a model. The S-series publishes
which demand the compressor is currently serving, which turns "was this
quarter's electricity pool heat or hot water?" from a confound into a regressor.
Securing that register is therefore a precondition for fitting the ground
variant at all, not a nicety.

#### The boiler needs no model change, and will retrain itself

Pre-heating reduces what the boiler must supply, and the existing contract
absorbs that without alteration. The boiler's whole forecast in capsule
`1bdbb1b1` is about 2.0 kWh/day (1.07 / 2.06 / 1.98 / 1.27 across the four
days), declared deferrable under a 20-quarter inhibit cap. Halving it saves
roughly a kilowatt-hour a day, which is inside the noise of everything else in
the plan, and `forecast_method: empirical_recent_history` over a 10-day window
means the reduction is learned rather than configured.

The one predictable artefact is the boiler's own version of the epoch problem:
for about a fortnight after commissioning the planner will reserve hot-water
energy that is no longer needed. At this magnitude that is worth knowing so it
is not diagnosed as a defect, and not worth code.

Worth one check at the same time: 2.0 kWh/day is low for household hot water —
some 38 minutes of a 3.1 kW element. If the meter mapping is catching only part
of the boiler, then both the saving and the baseline it is measured against are
understated.

#### Commissioning checklist, and what still cannot be settled

The integration path is Modbus TCP into Home Assistant's `nibe_heatpump`, which
supports the S-series. The cloud path exists and should not be used for control.
Pool registers on Nibe come from an accessory rather than the base unit, so
their presence is a question for the installer and not an assumption.

Each row below is a model requirement first and a register second; the register
names are the expected shape and must be confirmed against the live map.

| What the model needs | Expected source | Consequence if absent |
|---|---|---|
| COP source term, replacing air temperature | Brine in / out (BT10, BT11) | Ground variant degrades to a constant COP with an assumed seasonal drift |
| Pool water temperature | Pool sensor (BT51), pool accessory only | Keeps `sensor.filtered_pool_water_temperature`; check which is authoritative rather than carrying both |
| **Which demand the compressor is serving** | Priority / operating-mode register | The COP fit cannot separate pool heat from hot water, per the section above |
| Whether the compressor modulates | Compressor frequency | The pool is a variable-power store, which promotes [§8.13](planner-experiments.md#legacy-section-8.13)'s `min_power_w` / `power_step_w` omission from latent to load-bearing |
| Electrical input | Unit-reported power if present | Keep the Shelly on the supply; note it measures both sinks either way |
| Control: pool | Pool start/stop setpoints, pool activation | No pool actuation at all |
| Control: block | External adjustment / blocking registers | The planner has no lever, and the pool leaves the dispatch |

What genuinely cannot be settled yet is how the unit behaves when the planner
and its own controller disagree — whether a block is honoured immediately, how
long a demand it has already started will run, and whether setpoint nudges are
rate-limited. That is the difference between commanding a device and influencing
one, and it determines whether the pool can stay a dispatched store or has to
become a permission contract like the boiler.

#### Until commissioning

`capabilities.pool` is still true and the pool is still the top bidder in every
solve — 7.77 SEK/kWh against a price band topping out at 2.87 ([§8.13](planner-experiments.md#legacy-section-8.13)) — so it
outbids the house battery and the car for a heat pump that is physically being
removed, and the plan in capsule `1bdbb1b1` schedules 90 kWh into it. The pool
should be marked out of service for the duration. The capability is built in the
integration rather than the edge functions, so this is an integration-side
change; [§8.12.2](objective-foundations.md#legacy-section-8.12.2)'s rule applies to how it is reported, which is that a pool
withdrawn for works and a home with no pool must not look the same in the plan.

#### Implementation status (2026-08-27)

| Piece | State |
|---|---|
| Epoch boundary on the pool fit | **Landed.** `heat_pump_epoch_start` on `energy_optimisation_pool_model`; `poolTrainingWindowStartMs` clamps the rolling window to it and `poolRefitIsDue` forces a refit when an epoch is recorded after the standing fit, so stating a changeover takes effect at once rather than up to a day later |
| Air-source physics pinned at plan level | **Landed.** Two tests in `energy-optimisation.test.ts`: below `cutout_air_c` no price makes pool heat schedulable, and the pool's published marginal value tracks COP(air) exactly. These are the air-only behaviours a careless tiering can drop while every ground test still passes |
| Model tiering | Not started |
| Ground variant and its fit | Blocked on the register map |

The epoch is set by staff, per home, as a timestamp. Nothing infers it: detecting
a machine change from its own output is the kind of rule [§8](objective-foundations.md#legacy-section-8) refuses to write.
Until one is recorded the rolling window stands alone, which is every home that
has never had a changeover.

`TRAINING_WINDOW_DAYS` was left shared with the room fit. Clamping to an epoch
needs no pool-specific window length, and splitting the constant to express one
would have been a change without a reason.

Two corrections to what this section asked for before it was built.

**The air-to-water model is better protected than "only a fixture" suggested.**
`pool-training.test.ts` simulates history from a known pool and requires
`fitPoolModel` to recover the parameters that produced it, and
`store-models.test.ts` already pins the cut-out, the COP slope and the
delivered-heat comparison that heuristic 5 rests on. What none of them could
catch is the air path being lost between the model and the schedule, which is
what the two new plan-level tests close. A captured real-data fixture is still
worth having and is not urgent: `energy_optimisation_pool_slots` retains 1095
days and `energy_optimisation_device_slots` 400, so the whole air-to-water
season is archived at quarter resolution and is not going anywhere. It should be
built from that archive rather than scraped back out of Home Assistant, whose
five-minute statistics carry ±0.05 °C of noise against a signal of roughly
0.02 °C per quarter.

**A defect of the same family is already live, and predates the changeover.**
`refitPoolModel` takes every meter whose category is `pool_heating` and sums
them into the heat pump's electrical energy. On the reference home that is three
meters: the heat pump, the circulation pump and the pool *room* floor heater.
The pump alone clears `HEATED_SLOT_MIN_KWH` — 412 W for a quarter is 0.103 kWh —
so pump-only quarters count as heated samples in which energy went in and the
water did not warm, inflating `heated_sample_count` on evidence that is not
heating and biasing the fitted COP down. This is "one machine, two sinks" above,
arriving early and by a different route; a category is not a control contract.

<a id="legacy-section-8.15"></a>

### 8.15 A validator may only fail a plan against a constraint the planner was given (2026-08-28)

`infeasible` is in this document, and it means one of two things: the stated
constraints could not all hold — [§6](contracts-and-controls.md#legacy-section-6)'s room projection, where comfort, heater
rating and thermal physics have no common solution — or a required input was
missing or stale, where the plan refuses "instead of publishing a partial
answer" ([§8.12.3](objective-foundations.md#legacy-section-8.12.3)). Both are claims about the *inputs*. Neither is a claim about
the planner's own output being unsatisfactory to the planner.

To that, the post-plan validation adds a third, legitimate kind: a self-check
that the schedule it just built is physically coherent. Energy balances at every
quarter, no simultaneous import and export, nothing unserved, the EV inside its
current envelope, simulated service load equal to delivered. Those fire only
when the planner has a bug, and marking the output infeasible is exactly right.

**The rule the third kind implies, and which was broken.** A validator may fail
a plan only against something the optimiser was actually constrained by.
Checking a target the optimiser was never told about does not discover an
infeasibility; it manufactures one, and it is unfalsifiable — no plan can pass a
test the search space was never restricted to satisfy.

The service checks obey this. `min_run_slots`, run contiguity, the duty-cycle
inhibit cap and delivered-versus-required are all contracts the block scheduler
is built to honour, and each is skipped for a device the dispatch owns
(`schedule.dispatched.has(service.device)`), because a dispatched store has no
block to reconcile. `battery_target_is_hard` obeys it too, and says so where it
is written: "A hard SOC target is meaningless once the battery bids by marginal
value: the trade-off is priced rather than switched ([§8.4](objective-foundations.md#legacy-section-8.4)), and enforcing a
target on top would override the very comparison that replaced it."

`terminal_soc_min` was the one exception, and it was the strongest form of the
error: not merely unenforced for the dispatched case but **unenforced
everywhere**. It appears in the snapshot contract and in the post-plan check and
in no optimiser. The battery store's floor is `min_state: 0`, which is
`min_soc` — so the auction was free to end anywhere above 5% and was then failed
for ending below 20%.

Live plan `3ebf8f4d`, 2026-08-28: a battery at **15.9%** against a 20% reserve.
The plan raised it to **17.9%** and reported itself infeasible for the
improvement. The state it was judged on was the one it inherited, and the only
plan that could have passed was one that force-charged at any price — the hard
target [§8.4](objective-foundations.md#legacy-section-8.4) deleted. All three scenarios carried the same error, so the whole
plan showed as infeasible in the portal.

**Resolved** by extending the existing exemption rather than inventing a new
mechanism: a dispatched battery carries its terminal state at
`terminal_weight: 1` against a curve derived from the forecast ([§8.4](objective-foundations.md#legacy-section-8.4)), so where
it ends *is* the priced answer. Nothing is hidden — `policy.terminal_soc_min`
and `summary.battery_soc_end` are both published, so a surface that wants to
show "17.9% against a 20% reserve" has both numbers. What it no longer is, is a
verdict. No decision changed: the schedules are identical either side of the
fix, which is what distinguishes removing a false verdict from changing a plan,
and why `model_version` does not move.

The block-model path keeps the check. That battery is given no terminal value
either, so there the floor is the only thing that reports a plan ending low —
weaker than pricing it, and the reason schema 5 is legacy.

**Open when this was written.** The reserve was then unenforced *and* unpriced
for a dispatched battery, which was honest but incomplete: [§8.4](objective-foundations.md#legacy-section-8.4)'s table promises
"Battery reserve SOC → outage insurance and peak insurance, both priced", and
neither was built. Pricing it looked to need the value of not being empty, the
same figure [§8.13](planner-experiments.md#legacy-section-8.13)'s open questions call a shortfall price and the same one
nobody can state. Resolved below by looking for a different figure.

#### The reserve is priced (2026-08-28, `marginal-value-planner-v18`)

The blocker recorded above was that pricing a reserve needs the value of not
being empty, which nobody can state. That was the wrong figure to look for.

**A reserve insures against the plan being wrong, so what it is worth is the
worst hour on the board — not the expected one.** The merit order already prices
the forecast path; what having nothing left exposes a household to is the spike
the forecast did not carry, or the peak event. The dearest quarter in the
horizon is exactly that number, and the plan already has it. Nothing is asked
for that was not already configured: `terminal_soc_min` says how much, and the
horizon says what it is worth.

So the reserve is the **price of the bottom of the pack**, not a floor under it.
`batteryValueCurve` lays a band from zero to `reserveKwh` at
`worst × discharge_efficiency − wear`, and the merit order takes over above it.
The same kilowatt-hours serve both purposes; what the reserve changes is only
what the lowest ones are worth.

**It is self-limiting, which is what keeps it from re-becoming the hard target
[§8.4](objective-foundations.md#legacy-section-8.4) deleted.** The battery will not go below the reserve for an ordinary dear
hour, and it *will* for one at the horizon's worst — that being the event it was
kept for. There is no state it cannot reach and no plan it can make infeasible,
which matters because [§8.15](planner-experiments.md#legacy-section-8.15) exists precisely because the previous treatment did
both.

Against the live capsules, sweeping `terminal_soc_min`:

| | reserve 5% | reserve 20% | reserve 40% |
|---|---|---|---|
| `3ebf8f4d` — starts at 15.9% | low 8.4%, ends 10.7%, 42.93 SEK | low 14.1%, **ends 20.5%**, 46.25 | low 12.7%, ends 40.0%, 45.78 |
| `0a8116dd` — starts at 19.6% | low 6.7%, ends 20.0%, 38.48 SEK | low 9.2%, ends 20.4%, 41.56 | low 11.0%, ends 37.6%, 39.46 |

A battery that starts *below* its reserve climbs back to it — which is the case
that produced the infeasible plan [§8.15](planner-experiments.md#legacy-section-8.15) was written about, now answered by
buying rather than by complaining. The premium is about 3 SEK over three days at
20%, and it is legible: `curve_input` publishes `reserve_kwh` and
`worst_import_sek_per_kwh` beside the curve they produced.

The trough still dips under the reserve — 9.2% against a 20% reserve on
`0a8116dd`. That is the design and not a defect: a price floor is crossed when
the price justifies it. A household that wants a floor no plan may cross has
`min_soc`, which is imposed on every quarter.

**Outage insurance remains unbuilt.** This is the peak-insurance half of [§8.4](objective-foundations.md#legacy-section-8.4)'s
promise. Pricing an outage needs the cost of being without power, which is a
figure about the household rather than about the horizon, and none of the above
supplies it.

<a id="legacy-section-8.16"></a>

### 8.16 The plan must shape power, not only energy (2026-08-28)

Requirements from Phil, heading into the first winter this planner will run. The
short form: the objective in [§8.2](objective-foundations.md#legacy-section-8.2) prices *energy* and treats *power* as nothing
but a constraint to stay under. Every behaviour below is about power, and none
of them can emerge from an objective that does not price it.

#### What the current planner does

Live plan `0a8116dd`, 2026-08-28, an ordinary late-summer horizon:

| | |
|---|---|
| Battery charged | 11.5 kWh across 25 quarters |
| Of those, at full 8.8 kW | 3 |
| Grid import, peak | **13.07 kW** against a 13.2 kW limit |
| Grid import, mean | 1.74 kW |

A peak-to-mean ratio of 7.5:1, and the peak is battery charging: at 08-29 00:00
the battery draws 8.25 kW on top of a 4.82 kW house load and uses 99% of the
grid connection in one quarter.

A synthetic Swedish winter — no PV at all, 2.5–6 kW of heating, a real day/night
price spread — is worse and shows why this gets more serious rather than less:

| | |
|---|---|
| Battery | 20% → **98.8%**, charged in **7 quarters** at up to 8.8 kW |
| Grid import, peak | **13.20 kW** — the import limit exactly |
| Grid import, mean | 3.81 kW |
| Covering window | **all 288 quarters, 273 kWh** |
| Discharge | **none, in any quarter** |

Two things there are structural rather than incidental. The covering window
`deriveBatteryValueCurve` computes is "the longest single deficit run", which
assumes a surplus eventually interrupts it; with no solar there is never a
surplus, so the window degenerates to the entire horizon and the whole battery
is priced against the dearest 17 kWh of three days. And the battery buys 15 kWh
and returns none of it — worth its own investigation, because a battery that
only ever accumulates saves nothing.

#### Requirement 1 — charging spreads across the window it is drawn from

Given *n* quarters at a comparable price and no competing scheduled load, a
charge of *E* kWh is drawn as evenly as the hardware allows across the *n*,
rather than at maximum power across the fewest quarters that fit.

**This does not follow from the current objective, and saying so matters.**
Under energy-only pricing, spreading is at best free and usually slightly
dearer: concentrating on the cheapest quarters of a window is what an energy
objective *should* do, and the planner is not malfunctioning when it does. The
requirement is therefore a statement that power has a price the objective is
not yet carrying. Three sources of that price, in descending order of how well
we can currently quantify them:

- **The demand charge ([§8.5](objective-foundations.md#legacy-section-8.5)).** The clearest and the one that is not yet
  billable. Everything below stands without it.
- **Headroom against forecast error ([§8.7](objective-foundations.md#legacy-section-8.7)).** A quarter at 99% of the grid
  connection has no margin for the base-load forecast being wrong or for the
  unplanned draw [§8.5](objective-foundations.md#legacy-section-8.5) sets aside — the sauna, the oven, the guest weekend. The
  plan does not merely risk a fuse; it spends the whole safety margin buying
  something it could have bought slightly later for nearly the same money.
- **The physics the model currently cannot see.** A battery charged at 8.8 kW
  is less efficient and wears faster than the same energy at 4.4 kW.
  `charge_efficiency` and `degradation_sek_per_kwh` are both constants, so the
  model is blind to C-rate. Were they rate-dependent, spreading would fall out
  of the arithmetic with no rule written anywhere — which is the test [§8](objective-foundations.md#legacy-section-8) sets
  itself, and the reason this is the preferred route rather than a smoothing
  penalty bolted on.

#### Requirement 2 — one whole-home power envelope, below the fuse

The planner already shares a whole-home envelope: `headroomW` gives each
candidate `import_limit + pv + returned − fixed_load − occupied`, so the battery
cannot charge into power another load has taken. What is missing is that the
envelope is the *physical* limit. A configurable planning ceiling, below the
fuse, must bound the same sum — so that when heating draws 10 kW the battery
sees what is left of the ceiling, not what is left of the connection.

Stated as a ceiling on the total, never as a per-device cap: capping the battery
alone would leave the same peak reachable by two other loads, and the quantity
the tariff and the fuse both care about is the sum.

#### Requirement 3 — what an empty battery costs is derived from the forecast draw

Already the design ([§8.4](objective-foundations.md#legacy-section-8.4)) and already built: `batteryValueCurve` prices stored
energy at the merit order of the imports it displaces, so "how full" is answered
by filling until the marginal value falls below the price of charging, not by a
target. Two gaps stop it working in winter.

**The covering window has no winter form.** "The longest single deficit run"
means "one night" only because a surplus ends it. With no solar it is the whole
horizon, the whole battery is valued against the dearest hours in three days,
and the curve loses the discrimination that makes it useful — it says *full*
under nearly every condition. The winter question is not "when does the sun
next refill this" but "what is the dearest stretch this charge can realistically
cover before it can next be recharged cheaply", and that is a different window.

**And it must not degenerate at the horizon edge.** A 72-hour horizon in
December sees perhaps two price cycles. The terminal value has to carry the
reserve beyond it, or each plan ends with a battery whose remaining charge is
worth whatever the last quarter says.

#### Requirement 4 — discharge spreads when the store cannot cover the peak

When forecast demand across a dear window exceeds what the battery holds, the
discharge is spread to reduce the maximum import across that window, rather than
spent dearest-quarter-first until empty.

**This is requirement 1 seen from the other side, and it has the same
prerequisite.** Dearest-first is what minimises energy cost, and it is what the
marginal auction correctly does today. Spreading trades a little energy cost for
a lower peak, and the exchange rate between those is exactly the price of power
that requirement 1 also needs. One mechanism answers both; two separate
smoothing rules would be the wrong shape.

Worth stating explicitly because it is counter-intuitive: with 10 kWh against a
20 kWh evening, the right answer is *not* to run the battery flat over the
dearest half. It is to cover about half of every quarter, so the grid draw is
halved throughout rather than eliminated then doubled.

#### What this asks for, in one line

A price on power, alongside the price on energy, carried by the objective rather
than by four behavioural rules. [§8.5](objective-foundations.md#legacy-section-8.5) already specifies the mechanism — a second
state variable and a second value function — and defers it until the tariff is
published. **That deferral is what needs revisiting**, because three of the four
behaviours above are wanted before any effektavgift returns and are justified by
headroom and physics without it. A shadow price on power, small and stated,
produces all of them; when the tariff arrives it replaces the shadow price and
nothing else changes.

#### Implementation status (2026-08-28)

| Requirement | State |
|---|---|
| 1 — charging spreads across its window | **Built and on**, at 0.6 SEK/kWh per kW. One convex cost on total grid import |
| 2 — one whole-home envelope | **Built** by the same term: the cost depends on what the quarter already draws, so a store backs off as other load rises |
| 4 — discharge spreads across a peak it cannot cover | **Partly.** Relief moves how much is discharged and over how many quarters — 63 quarters and 7.5 kWh become 76 and 11.1 on capsule `0a8116dd` — but it cannot spread *within* a peak. See below |
| 3 — a winter form of the covering window | **Built.** The window ends at any refill, and is the dearest stretch rather than the longest |

**One mechanism, as [§8.16](planner-experiments.md#legacy-section-8.16) argued.** `DispatchLimits` gains a shaping threshold —
half the connection, so ordinary household load is untouched — and a rate in
SEK/kWh per kW above it. `energyCostSekPerKwh` adds the average marginal cost
across the power being added, and the discharge side subtracts the mirror
relief. Requirements 1, 2 and 4 are all consequences of that cost being
*convex*; none of them is written down.

**The candidate power levels had to change with it, and that is the part worth
recording.** The auction offers each store a set of executable power levels and
takes the one with the greatest surplus. Those levels were the breakpoints of
things that are piecewise — surplus running out, the utility curve turning —
which was sufficient while cost was piecewise-constant in power. A shaped peak
is not: its marginal cost rises continuously, so the profit-maximising power is
an interior point no breakpoint lands on. Without it the auction could only take
a block whole or leave it, and the first measured result was a battery that
stopped charging altogether at rates above 0.6 rather than charging more gently.
Adding the closed-form optimum — `(value − price)/rate − overshoot` — is what
turned "off" into "spread":

| Rate | Charge quarters | Peak charge power | Grid peak | Mean import |
|---|---|---|---|---|
| 0 (off) | 17 | 8.8 kW | 13.20 kW | 3.84 kW |
| 0.6 | 34 | 7.0 kW | 9.53 kW | 3.84 kW |
| **1.5 — shipped** | **55** | **5.5 kW** | **8.04 kW** | 3.86 kW |
| 3.0 | 42 | 4.1 kW | 6.64 kW | 3.84 kW |

A no-solar winter horizon, and the mean import is flat across all four rows:
the same energy is being bought, moved rather than reduced. On live capsule
`0a8116dd` the four dearest quarters fall from 6.89 kW to 6.43 and the
terminal-adjusted cost falls slightly with it; on `3ebf8f4d` the peak falls from
8.17 kW to 6.83 for about 1.2 SEK over three days.

**Requirement 3 landed in `marginal-value-planner-v15`, in two parts.**

*A refill, not only a surplus, ends a covering window.* A cheap enough hour puts
charge back into a battery exactly as well as the sun does, and in summer the two
coincide because surplus is the cheapest energy there is — which is why one
definition covers both seasons and the summer behaviour is unchanged. "Cheap
enough" is the arbitrage condition, `price < median × round-trip`, rather than a
quantile: a strict quantile comparison excludes an entire flat block of identical
night prices, which is precisely what a night trough is, and an inclusive one
makes every quarter of a flat week a refill opportunity. The arbitrage form has
neither failure and is self-limiting — on a flat horizon `median × round-trip <
median`, nothing qualifies, and the battery correctly goes back to carrying
everything.

*And the window is the dearest such stretch, not the longest.* Longest was right
while a surplus was the only boundary, because then there was one run a day and
it was the night. Once a cheap hour also ends a run the horizon breaks into
several, and the longest is frequently a placid stretch of ordinary prices rather
than the peak the battery exists for: with only the first change in place, the
winter probe priced its whole pack against a 33-hour lull and came out at 1.36
SEK/kWh while the dearest hours in the horizon were 3.20. Each run is now scored
by what this battery's own capacity would save in it, which is the question
[§8.16](planner-experiments.md#legacy-section-8.16) asks in the form it asks it.

On the reference home's 18.08 kWh pack the winter probe's published window falls
from **288 quarters and 273 kWh to 12 quarters and 18.9 kWh** — the morning peak,
and a draw comparable to the pack itself. The plan itself is unchanged there,
because a window that saturates the battery either way values it the same; what
changed is that the Economics tab now names the stretch the pack is being held
for instead of three undifferentiated days. Both live capsules improve slightly:
`0a8116dd` 38.03 → 37.74 SEK terminal-adjusted, `3ebf8f4d` 43.04 → 42.76.

**Not validated: a battery large against its peak.** At 40 and 80 kWh the scoring
selects the long lull over the short peak — correctly by its own arithmetic, since
a pack that can already cover the morning outright is bound by the bigger
stretch — and the plan then declines to fill it. Whether that is better than the
previous behaviour of filling regardless is untested, and the reference
installation cannot answer it. Worth revisiting against a home that has one.

**The shaped cost is integrated, not averaged (`v17`).** The marginal price is
zero below the threshold and rises above it, so the average of an interval's
endpoints is the true cost only while both ends are above. Across the kink it
overcharges — and over-credits the mirror case on the discharge side by as much
as five times, crediting 1.44 SEK for a 9.6 kW discharge whose real relief was
0.30. The first shipped rate of 0.6 was calibrated against that overcharge, so
the exact form shapes less at the same number and the default moved to 1.5. The
table above is measured with the exact form.

**Requirement 4 is only half built, and the missing half is structural.** The
relief term reaches the right answer across quarters and cannot reach it within
one. Spreading a 17 kWh pack across a sixteen-quarter evening is worth 16 SEK of
relief against 6 SEK for concentrating it in six, and the auction takes the
concentrated answer every time: within a slot it chooses the power level with
the greatest *total* surplus, which is `(price − givenUp) × kWh + relief`, and
the first term grows with power while relief is capped at the triangle above the
threshold. Maximum power therefore always wins, and the slot is then locked
against revisiting. Reaching the better answer needs the auction to be able to
add to a slot it has already allocated — a change to its structure, not to this
term — so acceptance test #13 has no test and should not be claimed as covered.

**Below about 0.3 nothing moves.** The rate has to be comparable to the gap
between what a store believes its energy is worth and what the quarter costs,
which for a battery mid-winter is 1.5–2 SEK/kWh. An earlier default of 0.05 —
chosen to be unobtrusive — was simply inert, which is worth knowing before
anyone calibrates against a demand charge: the shaping price is not small
relative to energy, and a tariff that produces one this large is doing real work.

**It ships on at 0.6, after fixing a bound defect it exposed rather than
caused.** A shaped plan changes the order allocations are made in, and one order
revealed that the dispatch could schedule charge a store's own `max_state`
cannot absorb: `project` clamped the state silently while the schedule kept the
power, so a plan bought 22.08 kWh for a car that stops accepting at 20.38.

The cause was narrower than it first looked, and worth recording because the two
bounds that exist both looked sufficient. `fullW` bounds each slot of a block
against `chargeRoomW(suffixMax)` — the room left at the highest the trajectory
still reaches — and `chargeCandidate` walks the block's own cumulative
trajectory against `max_state`. Neither sees a *multi-slot block placed earlier
than work already scheduled*: at slot 7 the local state was the vehicle's
starting 257.81 km while the suffix already reached 353.03, so two quarters that
each individually fitted the room together carried it past 375. It appeared only
at one shaping rate, which is what a defect that depends on allocation order
looks like from the outside.

Fixed by measuring the block's cumulative gain from the suffix maximum rather
than from its first slot's state. Drift only ever removes some of what was added
— a leaky store loses heat, it does not gain it — so bounding the total is exact
for a store that holds and conservative for one that leaks. The per-quarter
invariant is now asserted rather than the total alone: no quarter may leave a
vehicle above the limit it will refuse past.

#### Acceptance tests to add to [§8.12](objective-foundations.md#legacy-section-8.12)

| # | Behaviour that must emerge | Emerges from |
|---|---|---|
| 10 | A charge that fits in four quarters at full power is spread across the whole comparably-priced window when nothing else competes for it | A priced peak, or C-rate-dependent efficiency and wear ([§8.16](planner-experiments.md#legacy-section-8.16)) |
| 11 | Battery charge power falls as other scheduled load rises, keeping the total under a stated ceiling rather than under the fuse | One whole-home envelope at the planning ceiling. **Covered**, and it found a defect: the shaping cost has a kink at the threshold, and until that kink was offered as a power level a quarter starting below the threshold charged at full power and the shaped plan matched the unshaped one exactly. Two earlier versions of the test also passed with shaping off because the *fuse* was doing the clipping — the envelope [§8.16](planner-experiments.md#legacy-section-8.16) says is not enough — so the fixture now runs a connection the charger cannot reach |
| 12 | With no solar in the horizon, the battery still charges to a level set by the dearest stretch it can cover — not to full, and not to a target | A covering window with a winter form ([§8.4](objective-foundations.md#legacy-section-8.4), [§8.16](planner-experiments.md#legacy-section-8.16)) |
| 13 | A battery too small to cover a dear evening halves the draw across all of it rather than eliminating the draw across part of it | The same priced peak as #10. **Not covered and not achieved** — the auction allocates a slot once and takes maximum power in it, so it concentrates. Every fixture written for this either had `coverW` doing the ordering or measured that concentration; a test asserting the desired behaviour would fail |

#### Open questions

- **What is a kilowatt of peak worth before the tariff exists?** Still open, but
  bounded by measurement: below about 0.3 SEK/kWh per kW nothing moves, 1.5
  takes a winter grid peak from 13.2 kW to 8.0, and past about 3 there is little
  left to gain. Where in that range a household sits is a preference and not a
  derivation.
- **Can the auction revisit a slot?** Requirement 4's missing half needs it, and
  so would any future term whose value falls with the power already committed.
  The present structure — allocate a slot once, at maximum power, then lock
  it — is what makes the greedy auction tractable, so this is not a small
  question.
- ~~**What replaces "the longest deficit run" in winter?**~~ **Answered above**:
  the dearest stretch between two chances to refill, with a refill defined by
  the arbitrage condition rather than by the sun. What remains open is the case
  of a battery large against its own peak, where the scoring prefers a long lull
  to a short spike and the reference installation cannot say whether that is
  right.
- ~~**Why does the winter probe never discharge?**~~ **Answered in [§8.17](planner-experiments.md#legacy-section-8.17)**: a
  stored kWh was valued at `P / round-trip` instead of `P × discharge`, so
  discharging required an hour 17% dearer than the dearest hour the curve had
  already taken. Fixed in `marginal-value-planner-v13`.

<a id="legacy-section-8.17"></a>

### 8.17 A stored kilowatt-hour is worth what it delivers, not what it took to store (2026-08-28)

The open question [§8.16](planner-experiments.md#legacy-section-8.16) ended on — why a battery in a no-solar winter horizon
charged 15 kWh and discharged in none of 288 quarters — has an answer, and it is
one arithmetic error in `batteryValueCurve`.

The curve answers one question: what is a kilowatt-hour *in the battery* worth.
One stored kWh delivers `discharge_efficiency` kWh to the house, each displacing
an import at price *P*, so it is worth `P × discharge_efficiency`. The charge
side never enters, because this is not the value of *acquiring* a kWh.

It was computed as `P / (charge_efficiency × discharge_efficiency)`. Both
efficiencies were then applied a *second* time by the dispatch, which already
converts on the flow: `units_per_kwh` multiplies a charge by
`charge_efficiency`, and `state_per_kwh_out` divides a discharge by
`discharge_efficiency`. Counting them twice, and in the inverting direction,
inflated a stored kWh by `1 / (charge × discharge²)` — about 17% on a 95/95
pack.

**The consequence was one-way, which is why it looked like a battery policy
rather than a defect.**

| | Condition the code enforced | Condition that is correct |
|---|---|---|
| Discharge | `P_now > 1.166 × P_future` | `P_now > P_future` |
| Charge | `C < P_future / discharge` | `C < P_future × charge × discharge` |

Discharging required the present hour to beat the hour the curve was priced
against by 17%. Since the covering band takes the *dearest* hours first, no such
hour exists by construction — the battery could never discharge into the very
peak it was charged for. Charging was the mirror error and cleared at any price
below `P / discharge` where the true break-even is `P × charge × discharge`, so
it bought cycles that could not pay back. Charge freely, never discharge, and
the observed behaviour follows exactly.

The instrumented probe agrees to four decimals: giving up the marginal stored
kWh was priced at 3.2586 SEK/kWh against a dearest available hour of 3.2000, and
3.2586 is `(3.2 / 0.9025 − 0.45) / 0.95`.

**Resolved** by valuing a stored kWh at `P × discharge_efficiency` throughout the
curve, including the band above covering. The same winter horizon now charges
31.8 kWh and returns 15.0 across 10 quarters. On the two live capsules:

| | Terminal-adjusted cost | Grid import peak |
|---|---|---|
| `0a8116dd` before / after | 37.19 → **39.63** SEK | 13.07 → **7.06 kW** |
| `3ebf8f4d` before / after | 43.72 → **41.80** SEK | 9.48 → **8.17 kW** |

One capsule is dearer on that metric and one cheaper, and the dearer one is not
a regression: `net_cost_sek` prices imports and exports and charges nothing for
throughput, while `terminal_adjusted_cost_sek` values what is left in the pack at
the flat `terminal_energy_value_sek_per_kwh` rather than at the derived curve.
A battery that over-values its own charge by 17% therefore looks *better* on
both figures precisely when it is buying cycles it should not — the wear it
burns is the one cost neither metric carries. That the peak fell by nearly half
on the same plan is the more reliable signal, and it is [§8.16](planner-experiments.md#legacy-section-8.16)'s requirement 1
arriving for free rather than by design.

`marginal-value-planner-v13`. The invariant now pinned in `store-value.test.ts`
is the physical one that was violated: a stored kilowatt-hour is never worth more
than the import it displaces. It is worth exactly the energy it gives back, and
that is what makes discharging into the hour it was priced against break even
rather than impossible.

**And `curve_input.round_trip_efficiency` becomes `discharge_efficiency`** in the
published battery diagnostic, because a diagnostic whose job is to explain the
curve must name what the curve actually used. The round trip is still the right
quantity for `sellLegIsPublished`, which asks a genuine round-trip question —
whether a buy now can be sold later — and is unchanged.

<a id="legacy-section-8.18"></a>

### 8.18 The auction and the settlement are one fixed point (2026-08-28)

Live plan `eb2ffa5e`, 2026-08-28. Prices: a flat 0.86 SEK/kWh night and
afternoon, and an evening peak reaching 2.21. The battery started at its 5%
floor with 18.08 kWh of capacity and a whole cheap day in front of it. The plan
it shipped charged to 28.3% by 01:30, held that for fifteen hours, discharged
from 17:15 to 20:00 — and then stopped, sitting on 1.41 kWh while the house
imported through 20:15, 20:30, 21:00 and 21:15 at 2.19–2.21 SEK/kWh, the four
dearest quarters of the day. Discharging into any of them was worth about
+0.13 SEK and needed nothing that had not already been bought.

**What the auction actually decided.** It bought the cheap night *and* an
afternoon top-up at 12:45–14:30, and it planned to discharge continuously from
17:15 to 23:30. That is the behaviour asked for. The plan that shipped was not
the plan the auction made.

**What the settlement did to it.** [§8.12](objective-foundations.md#legacy-section-8.12)'s settling pass re-prices every
commitment where the executed trajectory actually puts it and releases what no
longer pays. It is removal-only, and the note justifying that argued a
monotonicity: releasing a charge lowers every later state, which raises what the
charge still standing is worth, so no release can create work for another.

That holds for a pure sink. A store that also **discharges** breaks it in both
directions:

- releasing a charge *starves* the discharges it was funding, and the pass drops
  them as unsupplied; and
- releasing a discharge *raises* every later state, which on a concave curve
  lowers the marginal value there and pushes the charges that fed it under
  water.

The two feed each other downwards. Here the afternoon top-up went first, the
discharges it funded were then starved — from the back, so the *dearest*
quarters were the ones dropped — and each release made the next one easier.
146 releases in the first pass, and no mechanism to put anything back.

**The rule.** A settled schedule must be one the auction would have stopped at.
Every commitment pays where it lands *and* no absent one would pay to be added.
The pass enforced only the first half, so its output was a fixed point of
removal and of nothing else.

**Resolved** by alternating the two until a settlement releases nothing. Each
round bids against the trajectory the previous one actually left; a round that
releases nothing satisfies both halves by construction. The capsule converges in
13 rounds and 1001 auction iterations against 349 before, and plan generation
stays at about 1.4 s. Termination is bounded twice: by the iteration budget the
auction already spends from, and by `MAX_SETTLE_ROUNDS`, which reports
`stopped_because: "settle_cap"` rather than spinning.

On `eb2ffa5e` the battery now discharges through 20:15–21:15 and refills at
22:30 when the price falls to 1.30. Grid import across 17:45–22:00 falls from
2.507 kWh to 1.277 kWh, and its cost from 4.99 SEK to 2.38 SEK. Over the whole
three-day horizon the terminal-adjusted cost falls from 77.59 to 77.16 SEK — the
horizon is mostly cheap and flat, so the win is concentrated in the one evening
that is not. `model_version` does not move: no pricing rule changed, only
whether the plan is solved to a fixed point.

**What this does not fix, and the number that governs it.** The battery still
charges only to ~29% on this capsule, not to the ~45% that covering the whole
17:45–22:00 evening would need. That is the wear cost doing its job, not a
defect. At `battery_degradation_sek_per_kwh = 0.45` on a 95/95 pack, a stored
kWh must displace an import dearer than

    0.86 / (0.95 × 0.95) + 0.45 / 0.95 ≈ 1.43 SEK/kWh

to be worth buying at a 0.86 SEK night. The quarters left on the grid are the
ones below that line. Sweeping the parameter on this capsule:

| wear SEK/kWh | pre-evening peak SOC | 17:45–22:00 grid import |
|---|---|---|
| 0.45 (default) | 29.0% | 1.28 kWh |
| 0.30 | 33.1% | 2.30 kWh |
| 0.10 | 36.6% | 0.98 kWh |
| 0.01 | 44.5% | 1.53 kWh |

**Open.** `deriveBatteryValueCurve` reads
`DEFAULT_VALUE_SETTINGS.battery_degradation_sek_per_kwh` directly, so the
per-customer value `value-curves.ts` resolves never reaches the planner. The
setting is configurable and inert. Wiring it through is the prerequisite for
answering "should this household cycle harder", which is a question about the
pack's warranty and price, not about the horizon.

#### Acceptance tests to add to [§8.12](objective-foundations.md#legacy-section-8.12)

- **A settled schedule is auction-stable.** No quarter may import at a price
  where discharging the battery would have paid, while the battery holds usable
  charge and the discharge is feasible against its own floor. Covered by
  `dispatch-plan.test.ts`, "[§8.18](planner-experiments.md#legacy-section-8.18) — the settled schedule is one the auction
  would have stopped at", which fails on the pre-fix code at exactly this
  property.


<a id="legacy-section-8.19"></a>

### 8.19 Wear may only price a resource that is actually scarce (2026-08-30)

`battery_degradation_sek_per_kwh` was defined, stored, resolved — and never
read. `deriveBatteryValueCurve` took `DEFAULT_VALUE_SETTINGS` directly, so the
column added with the value curves was configurable and inert, and every home
was priced against a figure nobody had chosen. It is now wired through the
snapshot from both entry points, resolved by the same `resolveValueSettings` the
edge uses so a capsule or fixture cannot feed the curve a negative wear.

**What the figure actually controls.** Not an accounting entry — a threshold.
Charged once per kWh *stored*, by lowering what stored energy is worth, it makes
the battery decline any round trip that does not clear

    buy / (charge × discharge)  +  wear / discharge

At 0.45 SEK/kWh against a 0.86 SEK night that demands an evening **66% dearer**.
At 0.05 it demands 17%, against a floor of about 11% that is pure round-trip
efficiency and cannot be avoided. That is the whole behavioural content of the
number, and it is the form to think in: the smallest price spread the battery
will get out of bed for.

**Why 0.45 was wrong, and it was not the arithmetic.** The formula behind it —
purchase price over warranted lifetime throughput — is correct for a battery
consumed by cycling. It has no denominator worth dividing by for a pack the
calendar retires first.

Sigen Battery 10.0, the pack this was measured against: **10,000 cycles** rated
(cell-level, 25 °C, 0.5C, to SOH=60%), 100% depth of discharge, **ten-year
warranty with no throughput limit**. Exhausting 10,000 cycles by 2036 needs
about 49.5 kWh a day through the pack; the household's entire non-flexible base
load is roughly 16 kWh a day, so a battery serving *all* of it every day of the
year still reaches only a third of the rating. Measured across the planner's
whole wear range on capsule `eb2ffa5e`, throughput moves only between 110 and
147 equivalent full cycles a year — 11% to 15% of the rating either way, and the
comparable cost is flat below 0.10 and jumps above 0.15:

| wear | min spread | comparable cost, 3 days | throughput | rating used by 2036 |
|---|---|---|---|---|
| 0.45 | +66% | 77.51 SEK | 111 cyc/yr | 11.1% |
| 0.15 | +29% | 77.82 | 143 cyc/yr | 14.3% |
| 0.10 | +23% | 70.25 | 144 cyc/yr | 14.4% |
| **0.05** | **+17%** | **69.62** | 120 cyc/yr | 12.0% |
| 0.01 | +12% | 70.98 | 119 cyc/yr | 11.9% |

The non-monotonic wobbles between neighbouring rows are greedy-search noise, not
signal. What is signal is the plateau below 0.10 and the step above 0.15.

**So the default is 0.05, and what survives is not degradation.** A pack whose
rated cycle life is unreachable inside its warranty has no scarce throughput to
price, and charging for cycles nobody can spend simply refuses the arbitrage the
battery was bought for. The reason to keep the figure above zero is different in
kind: prices past the day-ahead window are a shaped prior ([§8.15](planner-experiments.md#legacy-section-8.15)), and a round
trip decided on a 12% modelled spread that does not materialise is a real loss.
0.05 buys a margin against *forecast error*, which is the risk that is there,
rather than against wear, which is not. A pack that genuinely is
throughput-limited overrides it from its own row.

**Effect on `eb2ffa5e`, with [§8.18](planner-experiments.md#legacy-section-8.18) already in.** The battery charges to 40.2%
across the cheap window instead of 28.3%, and covers **every quarter from 17:15
to 21:15 with no grid import at all** — the whole evening peak, which is what
prompted this. Import across 17:45–22:00 falls from 2.507 kWh / 4.99 SEK to
1.245 kWh / 2.21 SEK. Roughly 950 SEK a year on a flat summer horizon, more in
winter when spreads widen.

**A note on where this number belongs.** There is no portal editor for
`energy_optimisation_value_settings`, so the row is reachable only by migration.
That is tolerable while the fleet is one home and the right value is a product
default; it is not tolerable once a customer's pack genuinely differs, because
the figure is then a commissioning input like `min_soc` and belongs beside the
curves editor.

#### Acceptance tests to add to [§8.12](objective-foundations.md#legacy-section-8.12)

- **The home's own wear reaches the curve.** A snapshot carrying
  `value_settings` must produce a curve built from it, published in
  `curve_input.degradation_sek_per_kwh`, and must change the decision: a 50%
  evening spread is refused through 0.45 and taken through 0.05. A snapshot
  without one gets the shipped default. Covered by `energy-optimisation-allocation.test.ts`,
  "[§8.19](planner-experiments.md#legacy-section-8.19) — the home's own wear cost reaches the curve".
- **Behavioural fixtures state their own wear.** Three tests turned on the
  battery declining a round trip and read the shipped default to do it, so
  moving that default silently changed what they asserted. Each now pins the
  figure it means (`PRICED_WEAR`), and the covering-window test asserts against
  the wear the plan published rather than a literal.


<a id="legacy-section-8.20"></a>

### 8.20 A plan the planner did not write must be scorable too (2026-09-05)

[§8.12](objective-foundations.md#legacy-section-8.12) asks whether the operating heuristics *emerge*. For weeks the answer has
been "no" for three of them — the plan draws from the grid with a charged
battery, exports into cheap prices instead of storing, and buys the car's charge
in short 11 kW bursts — and each round of work has treated that as a defect in
some rule. It cannot be settled that way, because a plan that looks wrong has
two possible causes needing opposite fixes:

- the **search** failed to find the best schedule the objective allows, or
- the **objective** prefers the wrong schedule.

Nothing in a plan distinguishes them, because the planner's own schedule was the
only one ever priced. The objective lived as a closure inside `planDispatch` and
only ever ran on schedules `planDispatch` had just produced.

**So the objective became a function.** `scoreDispatch(slots, stores, limits,
schedule)` prices *any* schedule, `planDispatch` selects on it rather than on a
private copy, and `dispatchWorkbench(snapshot)` hands back the exact slots,
stores and limits the auction was given — read out of the cache `buildPlan`
fills, never rebuilt, so the workbench cannot drift from the planner it
interrogates. The portal's **Build a plan** tab (`PlanWorkbenchTab`) puts the
auction's schedule in an editable grid and prints both scores.

Three properties make the comparison mean something:

- **Both sides run the same arithmetic.** "The planner picked this" and "this
  scored better" are the same claim, so a difference is attributable.
- **Infeasible schedules are reported, not clamped.** `project` silently bounds
  a state, so a hand-built plan that overfills the battery, exceeds the service
  fuse, misses the charger's 690 W increment or breaks a compressor's minimum
  run would otherwise score as though the clamp were free.
- **A breach the planner already had is not charged to the household.** The
  editor opens on the planner's schedule, so its faults are inherited by every
  draft; only what a draft *introduces* is reported against it.

**And the panels come with it.** A number says a plan is better; it does not
say whether it *looks* right, and the shapes people actually check — is the car
charging under the solar bell, does the pack come back up before the evening
peak, does the storage curve flatten against its ceiling — are read off the
chart. So the tab draws the same five panels as the plan view (`PlanPanels`,
[§7.6](contracts-and-controls.md#legacy-section-7.6)) from the schedule being edited, redrawn on every keystroke, with a toggle
between the household's plan and the planner's so the difference can be read as
a shape and not only as kronor. `buildWorkbenchChart` declares its own row type
rather than importing one from a `.tsx`, because `deno task test` runs
`src/lib`; structural typing keeps the two in agreement and `tsc` fails at the
call site if they drift. Charging the pack is drawn as a flow and never as
consumption, so the same kilowatt is not drawn twice.

The chart and the table are one view of one window. The day tabs narrow both,
so a reader cannot edit one afternoon while looking at another, and clicking a
quarter in the chart selects it in the table — switching day if the whole
horizon was on screen, tinting the column and scrolling it to the middle. The
running cost restarts at the window's own edge, as the plan view's does.

Two mechanics that were wrong first and are worth not rediscovering. The scroll
is measured in a `requestAnimationFrame`, not in the commit that changed the
day: reading a rect before that relayout describes the table being replaced, and
lands at the right fraction of the wrong width. And `PlanPanels` now resolves the
quarter under the pointer from the event's own position rather than from `hover`
state — a click can land in the same batch as the move that set it, and a *tap*
has no preceding pointermove at all, so the quarter under a finger was
unreachable on touch. That last one was a live defect in the plan tab too.

Three things the editor owes a reader beyond the score. A derived **grid in /
out** row, signed the way the flow panel draws it — plus is bought, minus is
sold — because "am I buying while the battery is full?" is the question the
whole exercise is about and it was previously only answerable by eye off the
chart. An **export** of both schedules, their inputs, their scores and the
snapshot they came from, as one JSON file: a score settles which plan is better
and the reason is in the quarters, which have to be able to leave the machine.
And a breach now carries its quarter as data rather than in its sentence
(`DispatchInfeasibility`), so the alert prints a time and clicking it takes the
reader to that column — "slot 58" is a number nobody holds, and a plan is
corrected by looking at 10:30.

The editor also shows **what a stored kilowatt-hour is worth**, per store, per
quarter, stated in SEK/kWh *delivered* so a curve over kilometres is already
through the car's own efficiency and can be read directly against the price two
rows above it. It uses `marginalValueHeld`, not `marginalValue`: what is held at
the top of a curve is still worth the top of it, and a buy-side figure
collapsing to zero at full would read as "this energy is worthless" beside a
discharge being priced at anything but. This is the number the whole objective
turns on, and until now it was only visible in the store-decisions table after
the fact.

Two things follow from the boxes being deliberately coarse. A hand-typed figure
is **balanced onto the load it meant to cover**: 0.7 kW against a 676 W load is
not a decision to sell 24 W, so a residual export inside the editor's own 0.1 kW
resolution is trimmed off the discharge — downwards only, never inventing energy
to make a quarter look tidy. Beyond that resolution it is left alone, because
then it *is* a decision. And grid flow under a microwatt is reported as zero:
288 quarters of float error produced 1.1e-13 W, which read as a sale and tripped
the pack's export contract.

Selling from store is a contract, not a capability, so the editor carries an
**allow-export switch per quarter** (`DispatchSchedule.allow_export`). Asking
what an hour of selling would be worth is a legitimate question to put to the
objective; refusing to price it would make the answer unavailable. The permit
changes what is *allowed*, never what it is *worth* — both sides score
identically, which is what makes the answer usable.

Selling from store is a **constraint on the schedule, not a note on the report
of it**. The permit was a validation flag first, and that was the wrong shape: a
household could type the pack past the house load, watch the grid row go
negative, and only then be told it was not allowed. With the switch off the pack
is held at the load it can cover — in the editor as the figure is typed, and
again in `scheduleFromDraft`, which is authoritative. Sunshine may still push a
quarter into export on its own; what the permit governs is whether the *pack*
is part of that.

**The workbench must solve against the plan's own prices.** It re-estimated
them, and two thirds of a 72-hour horizon is modelled rather than quoted
([§1.4.3](forecast-and-comfort.md#legacy-section-1.4.3)). Everything derived from that tail moves with it — including the
battery's value curve, which is built from it — so a locally re-estimated solve
produced a curve with a handful of breakpoints where the deployed plan's had
dozens, and the editor priced stored energy against a different day from the one
the household was reading in the value-curve view. `dispatchWorkbench` now takes
the stored plan's `price_outlook`. The export carries each store's curve points
and every quarter's state and marginal value beside the powers, because "why is
a stored kilowatt-hour worth that" has to be answerable from the file.

Two readings the editor was leaving to inference, both of which produced a
false alarm before they were added. The state row now prints **what moved**, not
only where the trajectory landed: a quarter of 5 kW into the pack raises it by
1.19 kWh, and beside a bare level that reads as though nothing arrived. And
**service delivered is broken out per store**, because it is the term that
decides most comparisons and a single total cannot say which store carried it.

<a id="legacy-section-8.20.2"></a>

#### 8.20.2 The bill, beside the score (2026-09-06)

[§8.1](objective-foundations.md#legacy-section-8.1) is right that minimising cost alone is degenerate, and the objective is
built accordingly: cost *net of the service delivered*. But that makes the score
depend on the utility curves, and a household that suspects a curve — correctly,
as it turned out — has no way to judge a plan without them. So `scoreDispatch`
also reports `billable_sek`: energy bought less energy sold, and nothing else.

What is deliberately not in it. Wear and start costs, because nobody invoices
them. The peak term with them: [§8.16](planner-experiments.md#legacy-section-8.16)'s shadow price on power is a stated shaping
choice, not a tariff, and this grid has no demand charge today. And the service
delivered, which is the whole point — the bill says what a plan *costs*, never
whether it was worth it, and a plan that charges nothing always wins on money.
That trap is pinned by a test: doing nothing is cheapest on the bill and worst on
the objective. The two figures are shown side by side for exactly that reason.

`billable_quoted_sek` narrows it further, to the quarters the market has
actually published. Two thirds of a 72-hour horizon is priced against a shaped
prior ([§1.4.3](forecast-and-comfort.md#legacy-section-1.4.3)), so the whole-horizon figure is a forecast wearing a currency
symbol; this one is money.

<a id="legacy-section-8.20.3"></a>

#### 8.20.3 A cap is a state of charge; a curve is a range (2026-09-06)

The workbench's first real verdict, and the correction that came with it.

Phil's plan bought grid energy for the car at nearly every hour. The measured
cause was not the search: at the car's own charge limit the curve still valued
another kilometre at 0.4346 SEK — about **2.45 SEK/kWh** through a Model Y's
efficiency, against import prices of 0.86–2.40. A *full* car outbid the grid,
so [§8.3](objective-foundations.md#legacy-section-8.3)'s "charging to the limit from the grid is rarely correct" could not
emerge. The comparison the workbench makes — same objective, two schedules —
is what separated that from a search failure: the hand-built plan bought 15.6
kWh less and delivered 44 SEK less service, and the objective was right.

The first attempted fix was wrong and is worth recording. Scaling the curve so
its indifference point lands on the reachable range makes the last unit worth
nothing, so the car can never reach its own limit even when power is nearly
free — the mirror of the defect. Two existing tests caught it, one of them
stating the rule directly: *a limit is a ceiling, not a reason to decline cheap
energy*.

The second attempt was wrong for a better reason. **The hardware enforces a
state of charge, not a range.** `max_state` already derives from it
(`departure_target_soc × capacity ÷ kWh-per-km`, recomputed every solve), so
the cap is already seasonal. But the kilometres in one SOC move a long way
between January and July, so restating a *threshold* in kilometres against
today's reachable range would bake a season into a permanent setting — and
[§8.3](objective-foundations.md#legacy-section-8.3) chose range as the curve's unit precisely so that winter raises the value
of the same SOC without a seasonal parameter. Both are right: the need is in
kilometres, the cap is in SOC.

So both curves are **clamped** to the state their hardware will hold —
`curveWithinReach`, applied to the vehicle at its charge limit and to the pack
at its usable band. Clamped, not scaled: scaling drags the indifference point
onto the ceiling, making the last reachable unit worth nothing and the limit
unreachable at any price, which two existing tests refuse. Clamping keeps every
value the household stated for every state the store can actually be in, ends
the curve at the ceiling with the value interpolated there, and says nothing
above it. Inside the reachable band the plan is unchanged; outside it there is
no longer an opinion to act on.

It matters more for the pack than it first appears. Now that the discharge
cut-off is read from the plant rather than typed beside it, the usable band can
move under a curve derived before it did.

One diagnostic moved with it. `at_state_cap` is now asked before
`state_above_curve`, because a clamped curve ends at the cap and both answers
became true at once — "it is at the limit you set" names something the household
can change, while "it is above its curve" names a consequence of that. Ordered
the other way, the specific answer became unreachable the moment clamping
landed.

Clamping does not decide the household's taste, so `curvesBeyondReach` still
reports the condition as a
**fraction of what the store can hold** — unit-free, and identical in every
season because both sides divide by the same kWh/km. Multiply it by the charge
limit to read it back: Phil's curve tops out at 1.28 of the cap, which against
an 80% limit is a curve asking for **102% SOC**, with "comfortable" at 82%
against a limit of 80%. Stated that way the contradiction is plain and holds
all year: the household has asked for a comfort level its own charge limit
forbids, so the car can never be satisfied and never stops bidding. Which of
the two settings gives way is theirs to decide, not the planner's.

<a id="legacy-section-8.20.4"></a>

#### 8.20.4 The workbench reads today's settings, not the snapshot's (2026-09-06)

A snapshot carries the value curves it was captured with, and the workbench
re-solves that snapshot — so editing a threshold and coming here showed the
*old* curve. The worth row said 4.87 SEK/kWh where the curve editor's own chart
said 2.05 for the same 239 km, and the two numbers were both correct about
different curves.

Worse than a stale figure, it made the question the editor exists to answer —
*does this threshold stop the car outbidding the grid?* — unanswerable until a
replan happened to land. The curves are now read from
`energy_optimisation_value_curves` and merged over the snapshot's, so a row
exists only where the household has stated something and the snapshot still
answers for every other store. A badge says which source is in play.

Both sides of the comparison are re-solved with them, deliberately: "what the
planner would do under the preferences you hold now" is the useful question,
and scoring two plans against different curves would not be a comparison at
all. This is the same correction as the price outlook ([§8.20.2](planner-experiments.md#legacy-section-8.20.2)'s neighbour) —
a workbench that re-derives an input the deployed plan was given is a workbench
answering about a different day.

Reading the result: **lower is better** — the score is cost net of service
delivered, so it is routinely negative. A hand-built plan that scores lower is
proof the search left money on the table, and the fix is a better solver. One
that scores higher while still reading better to the household indicts a utility
curve instead. A pair that scores within rounding of each other says the
objective is degenerate, and no solver will help until a tie-breaking term has a
real magnitude.

<a id="legacy-section-8.20.1"></a>

#### 8.20.1 What it found on first contact: the battery discharges into export

The workbench was pointed at the shared 72-hour fixture and immediately refused
a schedule the planner itself had issued. Five quarters carry a battery
discharge tagged `discharge_destination: "load"` in a quarter where the house is
exporting, which this pack's contract does not permit — 20 W at slots 65, 161
and 257, and **2.46 kW at slot 227 and 2.17 kW at slot 228**.

The mechanism is [§8.18](planner-experiments.md#legacy-section-8.18)'s, with the signs that reach a bill. The discharge is bid
against a deficit that exists when the bid wins; a later release removes the load
it was covering and nothing re-checks the discharge. What is left sells stored
energy at the export price against a value booked at the import price it thought
it was avoiding — 1.0–2.7 SEK/kWh apart on this fixture. It is a small instance
of exactly the behaviour [§8.12](objective-foundations.md#legacy-section-8.12)'s heuristics 1 and 6 are failing on, which is the
first time that failure has been visible as a rule breach rather than a
judgement call.

Not fixed here: the finding is pinned by
`plan-workbench.test.ts`, "the only rule the planner's own plan breaks is the
export leak", which asserts the *class* so a new kind of breach in the planner's
own output fails rather than hiding behind this one.



<!-- END PRESERVED SOURCE -->
