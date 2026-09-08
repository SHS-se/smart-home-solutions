# Device models and forecasts

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Planner](planner.md) · [Model history](history/models-and-delivery.md)

Status: current modelling requirements and known limitations, reconciled 2026-09-06. Measured, fitted, assumed, and commissioned values must remain distinguishable.

## Parameter ownership

| Class | Authority |
|---|---|
| Installation | Commissioned limits, usable capacity, wiring/phases, control modes, couplings, rated/minimum power |
| Live state | Valid HA measurements for SOC, temperatures, presence, completion, overrides, availability |
| Customer intent | Approved comfort preferences, readiness/deadlines, dated absences, reserve preferences, quiet hours |
| Device dynamics | Manufacturer evidence and validated fits for heat response, COP, efficiency, losses, modulation, starts |
| Forecast | Timestamped PV, outdoor temperature, irradiance, base load, prices, and their error models |
| Market/tariff | Effective-dated commercial terms and billing-state definition |
| Orchestration | Versioned horizon, timestep, refresh, expiry and source-validity rules |

Configuration should be low-maintenance, but changing trips, schedules, equipment, and vacations are legitimate inputs, not defects. An override is evidence to investigate, not proof that discomfort was priced too low. Learned policy changes remain suggestions until approved, as the original parameter-ownership table requires. Learning physical response is a separate process.

## Base load and electrical shape

Whole-home consumption and device meters must have reconciled boundaries. Subtract only separately modelled device series with adequate data, then add their planned load exactly once. Base-load devices remain in aggregate consumption. Meter category alone cannot select a service model or imply an actuator.

Electrical shape and control authority are orthogonal. Fixed full-load, variable/staged, duty-cycle, and inverter profiles describe draw. Run/stop, supported current, permit/inhibit, and bounded setpoint describe what may be requested. A probability-weighted duty profile is not a relay schedule.

The pooled weekday/quarter model is an empirical forecast, not a claim that season, occupancy, weather, and solar gain have been explained. Thin history and outliers remain uncertainty. Unexpected appliances belong in the observed residual; the forecast need not identify a specific sauna to budget uncertain household demand.

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

An approved room schedule supplies intent. A target can still allow several heating schedules; a band adds flexibility. Exact-boundary targets, guaranteed lower bounds, and priced comfort are not interchangeable. The final customer promise is [D1](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d1-comfort-and-service-promises).

Summer lockout describes an existing policy/implementation, not a physical law. It cannot override an agreed safety floor. Replacing calendar lockout with forecast-based operation is part of the remaining service choice and commissioning, not a change silently made by this split.

## Battery and EV

Battery physics use measured SOC, usable capacity, commissioned floor/ceiling and power limits, explicit grid-charge/export permissions, efficiency at each flow, and a declared wear basis. Electrical and backup/island behaviour are installation contracts.

Rated cycle life does not prove marginal cycling wear is zero. Calendar life, capacity loss, temperature, SOC, and cycling can all affect useful performance. The historical parameter named degradation has also served as a forecast-risk margin; that ambiguity is a live policy decision in [D3](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d3-preferences-risk-and-battery-economics), not a physical derivation adopted here.

An EV has a hardware/vehicle SOC cap and a household range/readiness preference. Clamp the feasible state domain to what the vehicle accepts; do not silently rescale household intent to make it fit. A desired range above the reachable band is a visible conflict. Changing kWh/km changes the range corresponding to an SOC, so range thresholds and SOC caps must be compared in the same current units. A range representation alone does not prove a particular change in marginal utility in winter.

Explicit departure commitments remain supported. A rolling-horizon deadline is not a learned departure distribution and can repeatedly defer readiness. Behaviour without a departure is [D2](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d2-ev-readiness-without-a-trip-and-unreachable-preferences).

## Pool, hot water, and shared heat pumps

Pool water and a hot-water tank are lossy thermal stores. A boiler without a trusted tank-state model retains its limited permit/inhibit contract and local thermostat/hygiene control; learned daily energy is not measured usable hot water.

Pool loss and delivered heat must be separated. Air-source and ground-source heat pumps require distinct source-temperature models; loss to surrounding air is not the same as the heat pump's source temperature. Flat brine temperature does not remove intraday PV opportunity cost, changing sink temperature, modulation, or competition for the compressor. Delivered heating below current losses can still slow cooling; it is not automatically worthless.

An equipment change creates a training epoch boundary. Pool loss samples may cross it only if water measurements remain representative; a stationary circulation probe may not measure bulk water. Select electrical training inputs by actual heat-delivery route, not the whole pool category containing a pump or room heater.

The Nibe shared pool/hot-water installation requires confirmed operating-demand attribution, electrical input, sensor validity, modulation, available control levers, response times, and hard interlocks. A shared compressor cannot simultaneously promise full independent capacity to both sinks. Automatic retraining of the auxiliary boiler's energy profile does not solve that shared-resource constraint.

This commissioning scope remains [D6](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md#d6-device-control-scope-and-commissioning). The reference installation has since been surveyed and its source loop observed to be ground source (see [control surfaces](reactive-controls.md#surveyed-control-surfaces)); that is one installation's measured fact, and it still authorises no default for another home and no register write anywhere.

## Forecast sources and evidence

Every forecast identifies its origin, issue time, coverage, and whether it is published, modelled, calibrated, or assumed. Preserve as-issued forecasts separately from later observations. Forecast error is evaluated by lead time and operating season.

Published import and export series use effective commercial terms, taxes, VAT treatment, and compensation appropriate to the home. Assumed historical terms remain labelled assumptions. Blanket statements about all exports, all homes, or a country's demand charges are not substitutes for the catalogue.

A price-shape estimator must not learn its own forecast as observed data. Normalisation must define finite behaviour under negative and near-zero prices without mislabelling clipped predictions as measured prices. Existing numerical guards require explicit negative-price regression coverage; this is engineering work, not a new customer setting.

Manufacturer ratings, forecast statistics, fitted models, and one-house replay results are evidence with limits. Validate hardware constraints and out-of-sample operation separately; a synthetic fit recovering its generating coefficients cannot establish real-home service guarantees.
