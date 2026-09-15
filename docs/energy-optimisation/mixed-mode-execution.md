# Mixed-mode execution scope (schema 9)

## Replacement scope terminology — 15 September 2026

The schema-9 four-local-mode implementation below is historical basis for the next contract. The replacement has HA inclusion, website Monitoring/Planned, and HA Verification/Controlling. Planned Verification equipment stays separately identified but external to executable decision variables. Base consumption and fixed external demand are distinct; add uncontrolled Planned demand once. Battery supply eligibility may include a Planned Verification device without treating its hypothetical actions as real.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

A live battery must not depend on a hypothetical shutdown of a pool or heater
that SHS is only planning or verifying. Schema 9 carries two independently
solved plans: the top-level planning preview and a self-contained
`execution_plan` used by devices in Controlling mode. Verification continues to
use the preview. Both solves use the same planner and prices.

Home Assistant captures `operating_scope` with canonical device modes, physical
model owners, and external-demand forecasts before server comfort enrichment.
For execution, non-controlling models are removed from dispatch and their frozen
empirical demand is added exactly once to base demand and its bounds. A valid
last-completed meter quarter conditions the current quarter only; future slots
retain their empirical expectations. Missing observations are explicit nulls;
observed zero is valid evidence. Monitoring devices already belong to base load.

Controlled pool power and partial boiler demand are rebuilt from retained
members. Unsupported partial EV and thermal-zone control is rejected. A fixed
plan must be rescinded before schema 9 planning. Execution clears hypothetical
continuity, and never enables a capability disabled in the snapshot.

Every command checks that all captured modes still match local modes. Any mode
change requests a new plan; promoting a device cannot authorize a cached
hypothetical schedule. Schema 8 cached plans cannot authorize schema 9 control.
The portal defaults to Live operation when any device is Controlling and offers
a separate Planning preview. The HA schedule selects requests per device mode.

## Evidence and limits

The September 15 supplied replay had battery Controlling, pool Control
verification and pump Planning. The preview expected about 0.83 kW house demand
and 1.24 kW surplus solar charging. With actual completed-quarter device demand,
execution expects about 2.92 kW and no such surplus. The unchanged battery policy
requests only a small grid charge in that quarter. This establishes a demand
accounting defect; it does not establish an adequate evening reserve under all
future weather and usage. No battery target or uncertainty setting is changed.

## Delivery

Deploy the schema 9 backend before installing the corresponding HA beta. Both
repositories must be delivered together for the new behavior. The change adds
a second solve and plan payload. Validate a fresh mixed-mode replay after
rollout, checking external demand, the execution battery request and actual
controller readbacks. Generated schema 9 fixtures and tests cover conservation,
current-quarter evidence, staged solving, mode changes, and the user-facing
scope selection.

## Charge timing after the accounting correction

The later 14:53 Stockholm capture started at 37.6% SOC; the subsequent live
reading was 38.2%. It did not demonstrate a negative charge-tracking error.
Under its expected external forecast the plan held until 15:15 and first bought
battery energy at 21:30, with about 0.33 stored kWh above cutoff beforehand.
Keeping the measured pool/pump demand through 21:30 changed the immediate replay
request to about 3.29 kW charging. This is a sensitivity, not a run-duration forecast.

The [opportunity-cost adjustment](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-opportunity-cost.md)
requires charge-now and wait comparisons from the same actual state, each with
adapted future actions. It uses the existing C/F/J policy architecture and keeps
forecast risk explicit. It adds no automatic top-up to a forecast SOC and no
hardcoded cheap-price window. Documentation only: the current accounting fix
and the future compiled-policy host cutover remain separate deliverables.
