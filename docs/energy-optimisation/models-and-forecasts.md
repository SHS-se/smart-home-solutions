# Device models and forecasts

## Authoritative load partition — 15 September 2026

Gross base consumption is whole-house non-battery consumption minus all Planned device consumption. Verification and Controlling devices are planned identically: the mode decides only whether SHS writes the schedule, never what it contains ([authoritative plan contract](authoritative-plan-contract.md)). A Verification device's logged requests are not assumed delivered; execution accounts for its measured consumption. Monitoring/Excluded consumption stays in the aggregate. PV is separate and subtracted once to obtain signed net demand. Do not derive the partition from visible chart bands or treat missing subgroup measurements as zero. Future uncontrolled demand still requires forecasts even when current watts are measured.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Planner](planner.md) · [Model history](history/models-and-delivery.md)

Status: current modelling requirements and known limitations, reconciled 2026-09-13. Measured, fitted, assumed, and commissioned values must remain distinguishable.

Installation examples are kept separately: [Phil's house](reference-installations/phils-house.md)
records its shared pool/hot-water preheater, downstream electric water heater,
native service settings and metering helpers. Develop the general model first;
use that house as a concrete validation case without adopting its connections or
settings as defaults for other homes.

## Parameter ownership

| Class | Authority |
|---|---|
| Installation | Physical limits, usable capacity, wiring/phases, control modes, couplings, rated/minimum power; no commissioned minimum-runtime settings |
| Live state | Valid HA measurements for SOC, temperatures, presence, completion, overrides, availability. Realistic state beyond a target is planned as it is; a reading no device can produce, or none at all, leaves out only its device ([measured state](authoritative-plan-contract.md#measured-state-and-impossible-readings)) |
| Customer intent | Approved comfort preferences, readiness/deadlines, dated absences, reserve preferences, quiet hours |
| Device dynamics | Manufacturer evidence and validated fits for heat response, COP, efficiency, losses, modulation, starts |
| Forecast | Timestamped PV, outdoor temperature, irradiance, base load, prices, and their error models |
| Market/tariff | Effective-dated commercial terms and billing-state definition |
| Orchestration | Versioned horizon, timestep, refresh, expiry and source-validity rules |

Configuration should be low-maintenance, but changing trips, schedules, equipment, and vacations are legitimate inputs, not defects. An override is evidence to investigate, not proof that discomfort was priced too low. Learned policy changes remain suggestions until approved, as the original parameter-ownership table requires. Learning physical response is a separate process.

## Base load and electrical shape

Whole-home consumption and device meters must have reconciled boundaries. Subtract only separately modelled device series with adequate data, then add their planned load exactly once. Base-load devices remain in aggregate consumption. Meter category alone cannot select a service model or imply an actuator.

Electrical shape and control authority are orthogonal. Fixed full-load, variable/staged, duty-cycle, and inverter profiles describe draw. Run/stop, supported current, permit/inhibit, and bounded setpoint describe what may be requested. A probability-weighted duty profile is not a relay schedule.

The pooled weekday/quarter model is an empirical forecast, not a claim that season, occupancy, weather, and solar gain have been explained. Thin history and outliers remain uncertainty. Unexpected appliances belong in the observed residual. An 8 kW step needs timely balance/limit evaluation without waiting to identify a sauna or guessing duration. Known duration can improve forecasting only when supported by actual information. Smaller loads may be served economically by grid/battery without shedding. Raw electrical data governs physical balance; filtered discretionary surplus governs stable economic additions, including both PV underproduction and overproduction.

## Deferred thermal modelling workstream

Scope decision, 14 September 2026: thermal modelling is deferred until after the
initial battery controller work. This is a **significant area of engineering,
calibration and verification**, not a small configuration task or completed work
because the offline scorer accepts synthetic thermal inputs.

The deferred scope includes general room/pool/tank dynamics; electrical-to-thermal
conversion and COP; losses, withdrawals and service valuation; shared heat-source
routing, native priorities and transition/interlock response; model identification,
equipment epochs, uncertainty and out-of-sample validation. Keep manufacturer
capabilities, installation topology and household settings separate. Fit Phil's
house to that general model later.

This does not block starting step 3's battery policy compiler. Its initial scope
varies battery actions and reoptimises the future battery schedule against declared
PV and aggregate non-battery electrical demand. Thermal demand remains an external
forecast, counted once; no thermal action, achieved thermal service or economic
benefit from rescheduling heating is inferred. Scope and forecast assumptions must
be explicit in cases and coverage. Battery input resolution and its own policy,
reconciliation and commissioning gates still apply.

Revisit this workstream before enabling thermal optimisation or adding pool/shared
heat-pump actions to the compiler. Pool remains second and EV third in device
rollout; deferral does not remove the relevant thermal/service verification gates.

## Thermal state and identification

For the basic room model:

```text
T[k+1] = T[k] + a × P[k] × dt
                 + gamma × (T_out[k] − T[k]) × dt
                 + background_gain[k] × dt
```

If `P` is delivered thermal power, `C = 1/a` and `UA = gamma × C`. If `P` is electrical heat-pump input at a known constant COP, `a = COP/C`; `1/a` is an effective electrical-response parameter, not physical thermal capacity. With changing COP or mixed heaters, a fitted aggregate coefficient is valid only over the operating conditions and heater mix supported by its data.

Do not label effective fitted coefficients as physical envelope properties without that basis. Changes in the inferred `UA = gamma/a` depend on both coefficients: the earlier synthetic errors of −15.4% in gamma and −9.7% in a imply roughly −6.3% in their ratio, not −15.4%.

Train on aligned temperature and electrical observations. Time-weight actuator states; use `hvac_action` to distinguish cooling from heating. Exclude unrepresentative equipment epochs and invalid sensing. Require sufficient excited/heated samples, rank, physical plausibility, and predictive quality; sample count or R² alone is not identification proof.

Solar gains may use separately sourced irradiance rather than PV AC output. Record fitted solar coefficients, coverage, and the irradiance source. The documented fitted-mean evaluation when irradiance is missing is an approximation; it can worsen comfort prediction and must not be described as losing accuracy but never correctness. Forecast error remains relevant even when a trajectory satisfies the fitted model.

An approved room schedule supplies versioned intent. The target design values ordinary temperature outcomes through editable curves, with a declared continuous utility rate; it does not convert every desired temperature into a hard boundary promise. Current hard-target/band scheduling remains an implementation limitation until the scorer migrates. Physical protections are separate. See [settled D1](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d1-comfort-and-service-promises) and [economic timing](controller-policy.md#one-objective-boundary-and-ownership).

Summer lockout describes an existing policy/implementation, not a physical law. It cannot override an agreed safety floor. Any future forecast-based replacement must honour versioned household intent and physical protections; this documentation changes no installed calendar setting.

## Battery and EV

Battery physics use measured SOC, usable capacity, physical floor/ceiling and power limits, explicit grid-charge/export permissions, efficiency at each flow, and a declared wear basis. Model economically valuable empty capacity as well as stored energy, using [intermittent-PV headroom evaluation](controller-policy.md#battery-headroom-for-intermittent-pv). It is not an added hard SOC target or a second reward atop the same future savings. Electrical and backup/island behaviour are installation contracts.

Rated cycle life does not prove marginal cycling wear is zero. Calendar life, capacity loss, temperature, SOC, and cycling can all affect useful performance. The historical parameter named degradation has also served as a forecast-risk margin; that ambiguity requires explicit accounting/calibration as recorded in [D3](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d3-preferences-risk-and-battery-economics), not a physical derivation adopted here.

An EV has a hardware/vehicle SOC cap and a household range/readiness preference. A car measured above its cap is planned as it is and needs no charge; a cap limits what a schedule adds, not where measured state may be. A car at 0% keeps the battery size last derived from its own readings. A departure outside the horizon, already past or unset leaves that plan without a departure. Clamp the feasible state domain to what the vehicle accepts; do not silently rescale household intent to make it fit. A desired range above the reachable band is a visible conflict. Changing kWh/km changes the range corresponding to an SOC, so range thresholds and SOC caps must be compared in the same current units. A range representation alone does not prove a particular change in marginal utility in winter.

Readiness and dated departure requests are curve-valued service, with hardware caps separate. Desired conditional charging is planned irrespective of present cable/location; actual execution and achieved service remain separate. Present vehicle location must not imply a hard absence schedule. Its possible use in notifications is an example for a later specification. Explicit future arrival/absence intent can shape the conditional opportunities. Anchor their usage events so a rolling-horizon deadline cannot defer readiness indefinitely; do not award one event repeatedly. Detailed direct-request API semantics are deferred. The settled direction is [D2](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d2-ev-readiness-without-a-trip-and-unreachable-preferences).

## Pool, hot water, and shared heat pumps

Pool water and a hot-water tank are lossy thermal stores. Thermal capacity (kWh per degree) and compressor electrical absorption rate (kW) are separate model inputs. Ground-source heating combines electrical work with ground heat, even when water is hotter than its surroundings. Sunny-today/cloudy-tomorrow preheat must value retained heat and avoided later purchases after losses and shared-compressor use. Phil's current zero marginal warmth value above 32 °C is editable, not a hard cap; future avoided cost must be scored once, separately from immediate warmth benefit. A boiler without a trusted tank-state model retains its limited permit/inhibit contract and local thermostat/hygiene control; learned daily energy is not measured usable hot water.

Pool loss and delivered heat must be separated. Air-source and ground-source heat pumps require distinct source-temperature models; loss to surrounding air is not the same as the heat pump's source temperature. Flat brine temperature does not remove intraday PV opportunity cost, changing sink temperature, modulation, or competition for the compressor. Delivered heating below current losses can still slow cooling; it is not automatically worthless.

An equipment change creates a training epoch boundary. Pool loss samples may cross it only if water measurements remain representative; a stationary circulation probe may not measure bulk water. Select electrical training inputs by actual heat-delivery route, not the whole pool category containing a pump or room heater.

The Nibe shared pool/hot-water installation requires confirmed operating-demand attribution, electrical input, sensor validity, modulation, available control levers, response times, and hard interlocks. A shared compressor cannot simultaneously promise full independent capacity to both sinks. Automatic retraining of the auxiliary boiler's energy profile does not solve that shared-resource constraint.

This commissioning scope remains [D6](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d6-device-control-scope-and-commissioning). The reference installation has since been surveyed and its source loop observed to be ground source (see [control surfaces](reactive-controls.md#surveyed-control-surfaces)); that is one installation's measured fact, and it still authorises no default for another home and no register write anywhere.

Native interlocks and observed transition availability remain physical evidence. Retire generic SHS minimum-on/off configuration and run-duration locks in the target; do not introduce equivalent commissioning settings through a model. If native equipment declines or delays a request, retain possible draw and update the model/observation rather than assuming instantaneous compliance.

## Forecast sources and evidence

Every forecast identifies its origin, issue time, coverage, and whether it is published, modelled, calibrated, or assumed. A proposed intermittent-PV model needs correlated subquarter net-surplus trajectories or a validated equivalent, including gross battery throughput, clipping and source-routing response. Daily yield and quarter averages alone cannot establish profitable headroom creation. Preserve high-resolution evaluation evidence and as-issued information; empirical replay has not yet established accuracy or runtime. This modelling requirement does not change privacy/upload permissions or deploy new data collection. Preserve as-issued forecasts separately from later observations. Forecast error is evaluated by lead time and operating season.

Published import and export series use effective commercial terms, taxes, VAT treatment, and compensation appropriate to the home. Assumed historical terms remain labelled assumptions. Blanket statements about all exports, all homes, or a country's demand charges are not substitutes for the catalogue.

A price-shape estimator must not learn its own forecast as observed data. Normalisation must define finite behaviour under negative and near-zero prices without mislabelling clipped predictions as measured prices. Existing numerical guards require explicit negative-price regression coverage; this is engineering work, not a new customer setting.

Manufacturer ratings, forecast statistics, fitted models, and one-house replay results are evidence with limits. Validate hardware constraints and out-of-sample operation separately; a synthetic fit recovering its generating coefficients cannot establish real-home service guarantees.
