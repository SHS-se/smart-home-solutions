# Historical record: Objective Foundations

[Architecture index](../../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [History index](README.md)

> **Historical evidence, not current requirements.** This is a preserved part of the pre-split document, including superseded claims, old implementation statuses, and unresolved experiments. The current topic specifications linked from the architecture index take precedence. References to deployed behaviour describe the date of the original entry, not a fresh verification.

<!-- BEGIN PRESERVED SOURCE -->
<a id="legacy-section-8"></a>

## 8. Objective function (rewritten 2026-08-16)

This section replaces the earlier priority hierarchy and the
`battery_target_is_hard` policy switch. Both were proxies for optimisation the
planner was not doing. The test applied throughout is: **if a behaviour has to
be written down as a rule, the model is wrong.** Every operating heuristic in
[§8.12](objective-foundations.md#legacy-section-8.12) is reproduced here as a consequence of one objective, not as a policy.

<a id="legacy-section-8.1"></a>

### 8.1 Why cost minimisation alone is degenerate

Minimising cost subject to service constraints has a trivial solution: turn
everything off. The formulation only becomes well-posed when the *service* is
priced as well as the energy. Every setting a customer would otherwise have to
invent — end-of-day battery SOC, export floor price, reserve SOC, car departure
time, pool daily kWh — exists to patch over that missing half of the objective.

The correction is to maximise value rather than minimise cost, where value is
delivered service minus the energy and wear spent obtaining it.

<a id="legacy-section-8.2"></a>

### 8.2 The objective

Over a receding horizon of slots *t*, and stores *s* (house battery, pool, EV,
hot-water tank, each heated room):

```
maximise   Σ_t [ Σ_s U_s(x_s,t)                     service delivered
                 − c_imp,t · g_imp,t                energy bought
                 + c_exp,t · g_exp,t                energy sold
                 − d_batt · throughput_t            battery wear
                 − Σ_j k_j · start_j,t ]            compressor/relay starts
         − C_peak(P_month)                          capacity charge ([§8.5](objective-foundations.md#legacy-section-8.5))
         + V_T(x_T, P_month, T)                     value of what is left
```

subject to the physics of each store, the grid import and export limits, and the
device contracts in [§5](contracts-and-controls.md#legacy-section-5).

Four properties matter more than the algebra:

- **`U_s` is over a physical state, not an energy quantity.** Pool temperature,
  EV range in kilometres, litre-degrees in the tank, room temperature. A
  deferrable load is never "N kWh inside a window"; it is a state that must
  satisfy a requirement when it is actually used. Run duration is an *output*.
- **`U_s` is concave.** The first kWh into an empty store is worth much more
  than the last kWh into a nearly full one. Concavity is what makes marginal
  value well defined, and it is exactly representable as piecewise-linear
  segments, so the whole problem stays a MILP. Sophistication here costs
  nothing in solve time.
- **`V_T` is a value function, not a target.** It prices what the home is left
  holding at the horizon edge, which is the only thing coupling one solve to
  the next.
- **There is no priority ordering anywhere in it.** See [§8.9](objective-foundations.md#legacy-section-8.9).

<a id="legacy-section-8.3"></a>

### 8.3 The utility curves

These are the irreducible inputs. They are *values*, not schedules, they are
stable over years, and they can be seeded with defaults and then fitted from
overrides ([§8.10](objective-foundations.md#legacy-section-8.10)). There are five.

| Store | Curve is over | Shape | Source |
|---|---|---|---|
| House battery | kWh stored | **Derived, never supplied** — see [§8.4](objective-foundations.md#legacy-section-8.4) | Computed |
| Pool | Water temperature °C | Rising steeply to the enjoyable band, flat across it, zero above, mildly negative when too warm | Household taste, one curve |
| EV | **Available range in km** | Steeply concave: low SOC is worth a great deal, the top fifth is worth almost nothing without a known trip | Taste + trip history |
| Hot water | Litre-degrees above draw temperature | Steep up to one household's peak draw, flat beyond | Taste, or fitted from draws |
| Room | °C against the comfort schedule ([§5.5](contracts-and-controls.md#legacy-section-5.5)) | Steep below the objective, flat at and above it, negative when overheated | Comfort schedule + one discomfort price |

Three notes that materially change behaviour:

**The pool is a one-way, lossy store.** Energy in the house battery can serve
any later load; energy in the pool can only ever serve "the pool is warm", and
it leaks at a rate set by air temperature and cover state. Its marginal value
is therefore capped by the utility of pool warmth, which is why the pool should
be charged from surplus that would otherwise export cheaply and should be the
first thing cut when energy is scarce. A soft target in *both* directions falls
straight out of the curve: overheating before a forecast cloudy day is
profitable whenever the marginal utility of the extra degree exceeds the export
price of the energy, and skipping a cloudy day entirely is profitable whenever
it does not.

**The EV curve is defined over range, not SOC.** Stating it in kilometres makes
winter automatic: a learned kWh/km that rises with falling temperature means the
same 60% SOC is worth more in January than in July without any seasonal
parameter. It also explains why charging to the limit from the grid is rarely
correct — the marginal utility of the top segments is below the import price.
For a plug-in hybrid the shortfall price is not a taste at all: it is the petrol
cost per kilometre, which is knowable to two decimals.

**The COP belongs in the physics, not the objective.** An air-to-water pool heat
pump delivers heat at COP(air temperature, water temperature), so the effective
price of pool heat is the electricity price divided by that COP. The rest of
this paragraph is specific to an air-source unit and does not survive the change
to ground-source, where the source temperature is flat across a day and price
becomes the only intraday signal the pool has ([§8.14](planner-experiments.md#legacy-section-8.14)). In spring the
COP varies more across a day than the price does, so "heat the pool when the air
is warm, not when power is cheap" is arithmetic rather than a seasonal rule. The
same physics states when heating stops being worthwhile at all — delivered heat
below the loss rate — which is what the hard-coded June–August room heating
lockout ([§1.5.5](forecast-and-comfort.md#legacy-section-1.5.5)) is currently standing in for.

<a id="legacy-section-8.4"></a>

### 8.4 The value of stored energy, and the end of the SOC target

The house battery's utility curve is **computed, never configured**. Its
marginal value at the horizon edge is the expected cost of replacing that energy
later: the forecast price distribution beyond *T*, grossed up by round-trip
efficiency, weighted by the probability that free surplus does not arrive first.

Every deleted setting follows from it:

| Deleted setting | Replaced by |
|---|---|
| End-of-solar SOC target | Marginal value of stored energy at *T* |
| `battery_target_is_hard` | Nothing. The trade-off is priced, not switched |
| Battery export minimum price | Export whenever the export price exceeds that marginal value |
| Battery reserve SOC | Outage insurance and peak insurance, both priced ([§8.5](objective-foundations.md#legacy-section-8.5), [§8.6](objective-foundations.md#legacy-section-8.6)) |
| Pool daily kWh requirement | Pool state, its loss model and its utility curve |
| EV departure time | Learned departure distribution plus the range curve |

"Roughly 10–12 kWh carries a summer night" must never be entered as a number. It
is the point where the marginal value of the battery falls away, and it should
be computed from tonight's base-load forecast — which yields a different and
correct number in January with no seasonal parameter anywhere. The qualifier
"as long as tomorrow's sun reliably refills it" is where the cliff becomes a
slope: the thirteenth kWh is not worthless, it is worth

```
P(tomorrow disappoints) × cost of covering the shortfall
```

so there is no threshold to tune, and no rule to write.

**This is what makes a monthly objective tractable.** With energy-only pricing,
monthly cost is separable across days except through stored state. Get the
marginal value of stored state right at the boundary and a rolling 48–72 h solve
is optimal in expectation over the month. That is a Bellman decomposition, not
an approximation. The rule for horizon length is that it must exceed the time
constant of the slowest store the value function has to see — comfortably true
of the battery at 72 h, and of the pool in summer, but not of a house's thermal
mass in deep winter, where the horizon should extend rather than the value
function absorb it.

<a id="legacy-section-8.5"></a>

### 8.5 Capacity charges: the second state variable

A demand charge is not another term in the sum. **It breaks the separability
that [§8.4](objective-foundations.md#legacy-section-8.4) depends on**, because monthly cost stops being a function of this
week's decisions alone and becomes a function of the running monthly peak. The
design must carry a second state variable, `P_month`, and a second value
function over it.

Sweden's effektavgift was removed in the June 2026 revision and is expected to
return in some form, driven by the cost-reflective network tariff requirement in
EU electricity market law. **Its exact functional form is not yet known, and the
form matters more than the price.** The requirement is therefore a parameterised
family, not a formula:

| Parameter | Range that must be supported |
|---|---|
| Measurement window | 15 or 60 minutes |
| Statistic | Monthly maximum; mean of the *k* highest, on distinct days; per-day maximum averaged over the month |
| Applicable hours | All hours, or a defined peak window |
| Applicable months | All year, or a winter season |
| Price | SEK per kW of the resulting figure |

The difference is not cosmetic. Under a monthly maximum, one sauna evening
defines the whole month's charge and little else matters. Under a mean of the
three highest hours on distinct days, that same evening costs a third of a step
and the planner has real work to do on the other two. A controller tuned for one
is misconfigured for the other.

The deferral this implies — that nothing about peaks is built until the tariff
is published — is revisited in [§8.16](planner-experiments.md#legacy-section-8.16), which asks for three peak-shaping
behaviours that are justified by grid headroom and battery physics without any
demand charge at all.

That example also marks the boundary of this section. Short unplanned draws —
sauna, an oven, a guest weekend — are not schedulable and the planner should not
pretend otherwise; they belong to the reactive layer ([§7](contracts-and-controls.md#legacy-section-7)), which is not yet
specified. The only bearing they have here is on how sensitive the resulting
bill is to the tariff's statistic, which is an argument for reading the tariff
carefully when it is published, not for reserving capacity against events the
plan cannot see.

**The marginal cost of a peak is probabilistic, and that is what makes it
schedulable.** Setting a new peak *P* at time *t* only costs anything if no
higher peak occurs in the remainder of the month, so

```
E[marginal cost of raising the peak] = tariff × P(this remains binding)
```

Early in the month that probability is low and headroom is cheap; on the 28th
with the month's peak at 8.2 kW it approaches one and the same kilowatt is worth
the full step. This derives the intuition that peaks matter more later in the
month, and it is computable from the home's own load distribution. It is not a
rule to encode.

**Merit order for peak shaving falls out of the marginal costs**, and is worth
stating because it is unintuitive: room heat first (thermal mass stores at
almost no marginal cost, and shifting it inside the comfort curve is invisible),
then pool (nearly free, one-way), then EV deferral (free while the range curve
is flat), then battery discharge (costs `d_batt` per kWh), then service
curtailment. The battery is *not* the first instrument to reach for.

That order is the planner's, and it ranks by marginal cost alone because the
planner is choosing over hours. The reactive controller is choosing over
seconds and ranks by cost per second of response instead, which is a different
list ([§7.7.2](contracts-and-controls.md#legacy-section-7.7.2)).

<a id="legacy-section-8.6"></a>

### 8.6 Heating is the load-balancing instrument — and the main peak risk

Under a capacity charge, household heating becomes the single most important
controllable load, for two opposed reasons.

It is the **cheapest peak-shaving resource available**: the building's thermal
mass is the only store large enough to absorb or shed several kilowatts for
hours without a user-visible service change, and unlike the battery it has no
per-kWh wear cost. Preheating within the comfort curve is close to free.

It is also **the largest single peak risk in the house**. Thirteen zones
recovering from setback at the same instant produce a large coincident draw —
already observed under the old effektavgift and worse under 15-minute settlement
([§1.5.4](forecast-and-comfort.md#legacy-section-1.5.4)). This forces a structural requirement:

- Rooms must be optimised **jointly against the shared peak state**, never
  independently against a common envelope. The joint distribution of room draw
  is the quantity being priced.
- **Staggering is a first-class output**, not a smoothing tie-breaker. The
  planner must be free to place recovery for different rooms in different slots,
  which is exactly the freedom the comfort schedule's "Setback cells are not
  forbidden heating windows" rule ([§1.5.5](forecast-and-comfort.md#legacy-section-1.5.5)) was written to preserve.
- Global events that touch every zone at once — return from away, end of
  vacation setback, morning recovery — are the peak-defining moments and must be
  planned as spread recoveries, not as simultaneous transitions. Reproducing
  Node-RED's synchronous high/low switching would be the worst possible policy
  under a capacity charge.

<a id="legacy-section-8.7"></a>

### 8.7 Uncertainty: why this must be stochastic

Optimising against a point forecast quietly deletes two behaviours the home
depends on.

**Buffer value disappears.** Under a deterministic forecast the battery has no
option value — if the future is known exactly, holding reserve is pure waste, so
the solver drains it every time. The value of keeping charge in hand against a
price spike or a cloudy patch mid-charge exists *only* across scenarios. A
deterministic optimiser will reproduce the depletion behaviour we are trying to
avoid, however good its prices are.

**Flexibility is undervalued.** Shortfall cost is convex, so planning on the
mean systematically understates the cost of being wrong and under-charges every
store. Optimising on the mean is not neutral; it is biased.

The requirements that follow:

- Solve over a modest scenario set for PV and load — a handful is enough to
  restore option value — or at minimum constrain against a pessimistic quantile
  while valuing against the mean.
- Forecast error must be characterised **by lead time**, since near-term
  forecasts are materially better than far-term ones. The far horizon should
  influence `V_T` and almost nothing else; detail out there is noise, and a plan
  that reshuffles hour 40 between solves is behaving correctly.
- Prices beyond the day-ahead window are a *distribution*, not a point. The
  measured price shape ([§1.4.3](forecast-and-comfort.md#legacy-section-1.4.3)) is the prior; `V_T` must consume the spread, not
  just the central estimate.
- **Only the first slot is a commitment.** Everything beyond it is a value
  estimate. Success is measured as realised cost against the counterfactual, not
  as plan stability between solves.

There is no separate risk-appetite parameter, and there must not be one. Risk
appetite is already expressed as the **steepness of each utility curve**. Room
comfort is near-vertical below its objective — nobody wants to live in a cold
house, and the money available from trading comfort away is negligible against
the annoyance — so in practice it behaves as a hard constraint without being
declared one. The pool is genuinely soft in both directions, and the top of the
EV curve is flat. That variation *is* the risk policy, expressed once per store
in the same units as everything else.

The consequence for the product is worth stating plainly: **savings come from
moving load in time, never from delivering less service.** Any plan that
economises by leaving the house cold has misread its own curve.

<a id="legacy-section-8.8"></a>

### 8.8 Prices

The objective is only as good as its two price series.

- **Import** is all-in: spot, supplier margin, energy transfer fee (often
  time-of-use), energy tax and VAT.
- **Export** is spot plus any network compensation. The microproduction tax
  reduction was **abolished on 1 January 2026** and must not appear anywhere in
  the export price.

VAT applies to import and not to export. That asymmetry is most of why
self-consumption usually beats export, and it is why no separate
self-consumption objective is needed: pricing both sides correctly produces the
preference on its own.

<a id="legacy-section-8.9"></a>

### 8.9 There is no priority stack

The old hierarchy ranked services. That cannot express a reversal, and reversals
are the normal case: the car outranks the pool when it is at 30% SOC and the
pool is warm, and the pool outranks the car when the car is at 80% and the pool
has fallen out of its band. Both follow from comparing two marginal utilities;
neither is expressible as a fixed order.

**Priority is an output.** At any instant the ranking is simply the stores
sorted by marginal value per kWh. The `priority` and `cost` plan variants exist
today because the objective was incomplete; once it is complete they converge,
and the surviving comparison is plan versus measured counterfactual ([§8.10](objective-foundations.md#legacy-section-8.10)).

<a id="legacy-section-8.10"></a>

### 8.10 What must be supplied, learned, and modelled

**Supplied by the household** — values only, no schedules:

- the four service utility curves in [§8.3](objective-foundations.md#legacy-section-8.3) (the battery's is derived);
- battery degradation cost per kWh of throughput, computed as purchase price
  divided by warranted lifetime throughput. This is what stops a cost-minimising
  solver from taking three shallow cycles a day for twenty öre and consuming the
  warranty;
- shortfall prices where the curve has a floor — of which a plug-in hybrid's is
  simply the petrol cost per kilometre.

**Learned from the home:** PV forecast error by lead time (the calibration data
is already collected); base load against season, outdoor temperature, solar gain
and occupancy ([§1.5.4](forecast-and-comfort.md#legacy-section-1.5.4) — occupancy remains the open one); trip distances and
departure times; pool and hot-water usage; EV kWh/km against temperature;
fitted room and pool thermal responses.

Utility curves also need a cold start. Ship defaults, then fit from **revealed
preference**: every manual override is a datum. A customer raising a room at
06:00 is stating that the discomfort price is set too low. After a season of
this the household has configured nothing at all.

**Modelled explicitly:** pool and tank thermodynamics with losses; COP(air,
water) for the pool heat pump; battery efficiency and power limits; total grid
import and export limits; compressor start costs and minimum run and off times.

That last item is worth naming, because it is where [§8.7](objective-foundations.md#legacy-section-8.7)'s buffer argument meets
physics. Not wanting to interrupt a pool heating cycle or a car charge is not a
preference — it is a start cost plus a minimum run time. Once both are in the
model, holding battery reserve to ride out a cloud rather than stop a compressor
is something the solver chooses on its own.

Everything in this section is supplied **once**, at commissioning, and then
left alone. That is a hard design constraint rather than an aspiration: the
money available to a household from this system is small compared with the value
of the household's attention, so any parameter needing periodic tuning is a
feature that costs more than it returns. A setting the customer has to revisit
is a defect.

<a id="legacy-section-8.11"></a>

### 8.11 Verification: historical replay before any control

The objective is judged by replay against Phil's own history, across seasons,
before it is allowed to command anything. Three runs over the same period:

1. **Perfect foresight** — the outturn used as the forecast. Not achievable; it
   is the upper bound, and the value of the whole programme is bounded by it.
2. **As-was forecasts** — the PV, weather and price forecasts *as they stood at
   each decision time*, never the outturn. This is the achievable number.
3. **Measured baseline** — what the house actually did and actually cost.

The gap between 3 and 2 is the customer value; the gap between 2 and 1 is what
better forecasting is worth. Reporting only one of these numbers is not a
result.

This requires an **archive of forecasts as issued, by lead time**. The PV
calibration series is the seed of it; weather and price forecasts must be
archived the same way or run 2 is impossible and the exercise degenerates into
run 1.

Periods to replay, chosen for what each one stresses:

| Period | What it tests |
|---|---|
| Deep winter | Import-dominated operation, few cheap windows, whether the battery pays at all, capacity-charge behaviour |
| Spring | Pool COP transition — the season where air temperature outranks price |
| Autumn | Heating restart, shoulder-season base load, the end of the summer lockout |
| Summer | Export decisions, battery sufficiency overnight, pool as a store |

One honesty requirement: the house did not have solar or a battery through the
last winter, so the winter run is a **simulation** against real prices and real
measured base load, not a backtest. It must be labelled as such. Its conclusion
about winter battery value is a modelled result and should be revisited against
the first real winter.

Alongside the seasonal replays, the scenario matrix in [§10](models-and-delivery.md#legacy-section-10) remains the synthetic
counterpart: replay establishes whether the objective is *worth* anything,
fixtures establish whether it is *correct*.

<a id="legacy-section-8.12"></a>

### 8.12 Acceptance tests: the operating heuristics must emerge

These are Phil's observed heuristics for how the house actually behaves
(2026-08-16). None of them may be implemented as a rule. Each is an acceptance
test: given the objective, the curves and the physics, the planner must produce
the behaviour **without being told**. A heuristic that has to be coded is a
defect in the formulation, and a heuristic the formulation contradicts is either
a modelling error or a correction to the heuristic — both are findings.

| # | Behaviour that must emerge | Emerges from |
|---|---|---|
| 1 | Self-consume solar by default, but export when the price is high and tomorrow's sun reliably refills the battery | Concave battery value + probabilistic PV forecast ([§8.4](objective-foundations.md#legacy-section-8.4), [§8.7](objective-foundations.md#legacy-section-8.7)) |
| 2 | Keep a buffer rather than run the battery flat, against price spikes and mid-charge cloud | Scenario-based solve + start costs ([§8.7](objective-foundations.md#legacy-section-8.7)) |
| 3 | Overheat the pool before a forecast cloudy day; cut it short or skip it on a cloudy day when the battery needs the energy | Pool state + one-way lossy store + concave utility ([§8.3](objective-foundations.md#legacy-section-8.3)) — **does not emerge; [§8.3](objective-foundations.md#legacy-section-8.3)'s path cannot produce it, see [§8.13](planner-experiments.md#legacy-section-8.13)** |
| 4 | Car outranks pool at low SOC and stops outranking it near full; winter raises the value of the same SOC | Marginal value comparison + utility over range ([§8.3](objective-foundations.md#legacy-section-8.3), [§8.9](objective-foundations.md#legacy-section-8.9)) |
| 5 | Pool heating tracks air temperature ahead of price in spring, and stops being worthwhile in winter | COP(air, water) in the physics ([§8.3](objective-foundations.md#legacy-section-8.3)) — **air-source only; does not hold for a ground-source unit, see [§8.14](planner-experiments.md#legacy-section-8.14)** |
| 6 | Buy from the grid whenever price is below the marginal utility of a sink; accept expensive imports in winter when no cheaper window exists | The objective itself ([§8.2](objective-foundations.md#legacy-section-8.2)) |
| 7 | Grid-charge the battery only when the intraday spread beats round-trip losses plus wear | `d_batt` + efficiency in the objective ([§8.10](objective-foundations.md#legacy-section-8.10)) |

<a id="legacy-section-8.12.1"></a>

#### 8.12.1 Implementation status (2026-08-16)

| Piece | State |
|---|---|
| Base load and device forecasts per weekday ([§1.6.4](forecast-and-comfort.md#legacy-section-1.6.4)) | **Landed.** Integration `0.7.0-beta.17` |
| Forecast archive as issued ([§8.11](objective-foundations.md#legacy-section-8.11) run 2) | **Landed.** Collecting from first deploy |
| Pool and vehicle as physical state (`store-models.ts`) | **Landed and wired in schema 6** |
| Utility curves, integrals and marginal value (`store-value.ts`) | **Landed and wired in `marginal-value-planner-v11`** |
| Scheduler consuming them | **Landed; exact quarter evidence is published** |
| Capacity-charge state ([§8.5](objective-foundations.md#legacy-section-8.5)) | Not started. The wait on the published tariff is challenged in [§8.16](planner-experiments.md#legacy-section-8.16): a shadow price on power delivers most of the behaviour before the tariff exists |

Heuristics 1, 4 and 7 are already reproduced as executable tests against
`store-value.ts`, without any rule encoding them. Heuristics 3 and 5 are
reproduced against `store-models.ts`. That is the acceptance criterion in
[§8.12](objective-foundations.md#legacy-section-8.12) being met at the unit level, not yet in a whole plan.

The gap that qualifier leaves is not academic: a solve contradicting heuristic 3
in both directions shipped without a failing test ([§8.13](planner-experiments.md#legacy-section-8.13)). Unit-level agreement
with `store-models.ts` says the physics is right, which is a different claim from
the plan being right.

<a id="legacy-section-8.12.2"></a>

#### 8.12.2 The objective has to be legible, not only correct (2026-08-18)

Written after a live plan left a connected car below its own charge limit
unplanned for two days while 66 kWh was exported, and answering *why* took a
replay harness, the Home Assistant history API and most of an afternoon. The
answer was a boolean the system already knew.

**Silence was the defect, not the arithmetic.** `capabilities.ev` was false
because the website had left the charging meter in base load, so no store was
built, no bid was made and no diagnostic row was written. The plan reported
`ready` with no errors and no missing inputs — indistinguishable from a
household that owns no car. Four things follow, all now landed:

| Piece | What it fixes |
|---|---|
| `unplanned_services()` in the integration | Telemetry configured per service and control routed per *meter* can disagree without either side looking wrong alone. Only comparing them makes it visible; it now raises a repair issue rather than nothing |
| Vehicle state carried without the EV capability | State is a *measurement*; a capability is a *control contract*. Requiring them to agree made an unrouted car unrepresentable rather than merely unplanned — the pool already got this right |
| `undispatchedStores()` and the widened `StoreDiagnostic` | A store that loses says what it was worth. A store never built said nothing, so "considered and declined" and "does not exist" looked identical. `marginal_value_sek_per_kwh` is now null rather than zero for a store that never bid, because those are different claims |
| The store-decisions table in the plan view | `store_diagnostics` existed from the first marginal-value plan and was rendered nowhere |

**And a curve nobody can state is not a customer input.** [§8.10](objective-foundations.md#legacy-section-8.10) requires the
curves to be supplied once and left alone, which is worthless if stating one
requires knowing that a 55 m³ pool takes about 14 kWh per degree. So the editor
now asks for three thresholds in the unit the household thinks in — really want
it below here, would like it around here, do not care above here — and
`value-preferences.ts` supplies the levels from the physics, anchoring the
comfortable point at exactly what the energy to reach it costs. The customer
states *where*; the equipment states *what it is worth*.

Two properties of that parameterisation are worth recording. The thresholds
*are* the breakpoints, so opening the editor and saving without an edit cannot
drift. And a curve the editor did not generate is never reverse-engineered: an
earlier version inferred thresholds from the most valuable interior breakpoint,
which reads the pool default correctly and the vehicle default wrongly, because
the vehicle's second point ends the range-anxiety ramp rather than marking the
wanted band. Defaults are now stated rather than inferred.

Finally, a threshold stays abstract until it does something, so the editor
re-solves the persisted snapshot with the edited curve and reports the
difference in hours, kilowatt-hours, kronor and where each store ends up. It
runs **the planner itself** in the browser — the snapshot every plan was built
from is stored alongside the plan — rather than a second, prettier model free
to disagree with the thing it claims to predict. Both sides of the comparison
are solved locally so the difference is attributable to the one thing that
changed.

**Fixed 2026-08-20 in `marginal-value-planner-v10`.** `batteryValueCurve` now
sorts the covering window's residual imports by shadow price and gives each one
its own stored-energy-equivalent kWh band. The first kWh therefore displaces the
dearest import, while later kWh fall through the actual merit order instead of
inheriting the peak price. The dispatcher also bids at those curve breakpoints
and values the whole proposed move by the integral of the curve; otherwise a
full 15-minute inverter interval could still be priced as though every kWh in
it were the first, dearest one.

The whole-plan regression is the original failure in miniature: one expensive
quarter inside a cheap deficit run followed by a solar day. The planner buys
only the stored energy needed for that quarter and leaves enough capacity for
more than 5 kWh of the following surplus. This pins both symptoms rather than
only the curve's shape in isolation.

**Blockers resolved 2026-08-20.** Schema 6 now carries pool state and vehicle
efficiency, the portal persists and previews the customer utility curves, and
integration 0.8 accepts the schema-6 execution contract. Pool, EV and battery
therefore run through the state dispatcher; the remaining boiler duty-cycle and
room-comfort paths are called out separately wherever their later scheduling
order affects the battery ([§8.12.3](objective-foundations.md#legacy-section-8.12.3)).

Test 7 also answers the open question about winter battery value quantitatively.
At an 85% round trip the price ratio must exceed about 1.18 on energy alone;
adding a degradation cost in the region of 0.3–0.7 SEK/kWh means a grid-charged
cycle needs an intraday spread of roughly 0.5–1 SEK/kWh to be worth taking. Cold
Swedish winter days routinely clear that and mild ones do not, so the correct
answer is "on some days", computed per day — which is the point. It is an output
of the model, not a parameter of it.

<a id="legacy-section-8.12.3"></a>

#### 8.12.3 The plan view is the audit surface (2026-08-21)

Price, power and explanation are one decision and must be readable on one time
axis. The separate Economics composite chart duplicated the plan's flows,
duplicated its decision summary and made a reader mentally align two selected
windows. It is removed. The Plan chart owns an explicit **Show prices** overlay:
all-in import/export prices share the quarter grid with PV, load, storage and
grid flow. Solid prices are measured or published; dashed prices are the exact
shadow series used beyond the published day-ahead window. Economics retains the
value-curve editor, which is configuration rather than a second account of the
plan.

The labels must state what the numbers are. Import is the [§8.8](objective-foundations.md#legacy-section-8.8) all-in **variable
per-kWh** price, not spot alone; fixed monthly charges are excluded because no
schedule can change them. A store's `cheapest_energy_sek_per_kwh` is not
necessarily an import price at all: it is the lowest supply opportunity cost
over the full 72-hour solve—either all-in import where demand exceeds PV, or
forgone all-in export revenue where surplus PV is available. Its initial
marginal bid is also a whole-horizon diagnostic. Neither number is an average
tariff and neither may be presented beside a selected-day quantity as though
the two multiply.

The aggregate “And the grid” prose is replaced by a chronological 15-minute
ledger for the selected planned period. The separate whole-horizon store table
is removed: an initial marginal bid beside a horizon-wide floor cannot explain
which part of a declining curve a sizeable quarter crossed. The ledger is the
single audit surface. A click on a planned chart quarter opens it, scrolls to the
matching ledger row and highlights it.

Browser-written causal prose is forbidden. `decision_diagnostics_version = 2`
on the plan and `decision.schema_version = 1` on every `PlannedSlot` version the
descriptive evidence independently of executable plan schema 6. Version 2 adds
the exact derived home-battery value curve; the quarter arithmetic remains
version 1. Each row now
carries:

- every accepted store allocation, including state before/after, the integral
  curve value of the complete move after timing loss, all-in source cost,
  solar/grid split, wear/start cost, net SEK, allocation order and complete
  minimum-run result;
- the battery's accepted charge/discharge comparison or its exact hold reason,
  including the power tested, retained stored value, avoided import/export
  value and physical bounds;
- the final identity `load + battery charge - PV - battery discharge`, its
  residual import/export and any binding grid limit.

The data is additive descriptive contract data ([§5.7.2](contracts-and-controls.md#legacy-section-5.7.2)): Home Assistant ignores
it and continues to validate the schema-6 execution envelope, while the portal
refuses to invent an explanation for an older plan without evidence. One
explicit diagnostic, `load_added_after_dispatch`, records the current ordering
defect where comfort or duty-cycle demand is installed after the store auction;
it says that the resulting import was never offered to the battery rather than
claiming that a battery comparison occurred.

`marginal-value-planner-v11` also fixes four objective defects exposed by making
the evidence concrete:

1. the EV store uses the customer's resolved EV demand-value curve; the live
   planner no longer rebuilds and substitutes a default target curve;
2. every sizeable pool, EV and battery move is valued by the exact curve
   integral, not the first marginal value multiplied by the whole move;
3. a compressor start wins only when the complete minimum-run block clears its
   complete energy and start cost—no unevaluated continuation quarters are
   appended after a single cheap winner;
4. battery discharge covering household load is valued at avoided all-in import,
   while any simultaneous export portion uses the correctly weighted
   import/export value. Export price can no longer make a load-only discharge
   look profitable.

Candidates are ranked by net welfare per kWh with total welfare as the tie-break,
so an 11 kW EV action no longer wins merely because its physical block is larger.
A stale multi-quarter cache entry and sub-microwatt rounding loop that could run
the auction to its iteration cap are fixed; reaching that cap now makes the plan
infeasible instead of publishing a partial answer.

The chart legend is derived from the selected window: a series with no plotted
values is not advertised, including published/modelled price segments outside
that window. Solar, both all-in prices, both grid directions, battery charging
and both SOC lines own reserved semantic colours; the rotating device palette
must not reuse them. The total-consumption overlay is intentionally omitted
because the stacked load already carries it. Battery discharge remains an
explicit positive flow because it is necessary to audit when stored energy is
supplying the plan.

The home-battery curve is no longer an invisible planner intermediate. Every
solve publishes its exact breakpoints, usable-energy origin, starting state,
longest-deficit covering window, forecast surplus, round-trip efficiency and
degradation input. It is read-only and is graphed in **Economics**, beside the
customer-owned pool and EV value curves; it is deliberately not another series
on the Plan power graph. Publishing the derived curve does not turn it into a
customer setting.

Every quarter row ends with a replay download. A quarter cannot be solved by
itself—the auction optimises all 72 hours—so the JSON contains the complete
resolved snapshot, the exact `Date` supplied to `generateOptimisationPlan`, the
exact unrounded 288-quarter shadow-price vector produced by the price-shape
estimator, the generation request identity, the selected scenario and quarter,
and the complete expected planner output. The JSON records the required ISO
string-to-`Date` conversion explicitly. Replaying injects that resolved vector rather than recomputing it from a
price archive that may since have grown. The snapshot is fetched only when the
button is clicked; the portal's 30-second poll must not repeatedly transfer it.
Old current rows are not reconstructed from later database state: replay remains
unavailable until the next solve rolls the row forward, because an approximate
capsule would defeat the purpose of deterministic diagnosis.


<!-- END PRESERVED SOURCE -->
