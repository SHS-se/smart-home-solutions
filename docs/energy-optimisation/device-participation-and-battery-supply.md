# Device participation and battery supply — backend contract companion

**Agreed design, 15 September 2026; production command wiring implemented 16 September. Deployment pending.**
The [canonical cross-repository specification](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/device-participation-and-battery-supply.md)
owns terminology, UI behaviour, accounting formulas, lifecycle, source permissions
and acceptance. This companion maps those decisions to the producer and reporting
boundaries; it is not another independent definition or a deployed wire schema.

## Ownership and payloads

- **HA Devices: Included/Excluded.** Included inventory is the eligibility boundary.
  Exclusion stops device-specific metadata, bindings, profiles and telemetry as well
  as planning/control. Versioned complete Included inventory retires old membership;
  aggregate house consumption and independently shared sensors remain. Do not purge
  old history implicitly or resurrect devices through a stale planning update.
- **Website: Monitoring/Planned.** Monitoring is unshifted base consumption; Planned
  has individual scheduling intent and accounting. These replace website inclusion
  terminology. Do not change HA control authority from a website role write.
- **HA Schedule: Verification/Controlling for Planned equipment only.** New Planned
  admission starts in Verification. Acknowledged revisions and physical-owner groups
  govern actual execution; requested authority is not proof of acquired authority.

Remove duplicate local plan-inclusion/review/Website-link rows and the local four-
mode selector. Website, snapshot producer, planner projection and HA acceptance must
consume one coherent revision-bound contract rather than deriving conflicting flags.
The existing schema-9 implementation remains evidence, not the final vocabulary.

## Planning and measurement partition

Gross house consumption excludes home-battery charging. Base consumption is gross
house consumption minus all Planned appliance consumption. Verification appliances
remain Planned on charts and hypothetical schedules, but their real demand is
external in the executable projection. External demand is base plus Planned loads
without effective physical authority, counted once; logged actions cannot remove it.

HA resolves aligned current gross demand, PV, stored energy and necessary device
measurements. The server forecasts the future, retaining uncertainty for external
appliances. Aggregate net demand and subgroup demand have different observation
requirements: energy counters provide interval averages, not exact instantaneous
watts. No missing subgroup reading becomes zero or a broader supply permission.

## Required battery intent

The producer emits an explicit supply selector: None, Whole house, Base only,
Selected Planned devices, or Base+selected. Use the canonical union and stable
membership/physical-owner revisions, not chart-band identifiers or a list inferred
from nominal discharge. Verification membership does not prohibit battery supply to
that device's real consumption, but its simulated schedule remains non-executable.

**Solar is shared proportionally across gross consumption.** A selected scope gets
its proportional share of self-consumed PV, using the same aligned current demand
partition as the response model. For base 1 kW, other load 2 kW and PV 1 kW, base-only
scope permits about 0.67 kW of house supply. The canonical formula handles None,
zero demand, selected unions and PV surplus without double subtraction. Do not use
base-first allocation or invent a forecast/rated-power fallback.

Scope is a constraint on feasible accounting amounts, not physical routing, a
requirement to discharge, a permanent device ranking, or a fixed energy entitlement.
Grid-charge and battery-export permissions are separate; forced routes cannot evade
the house-supply constraint. The economic policy decides the operation and amount
inside the measured scope using current cost and future consequences.

### Existing-module responsibilities

| Boundary | Required change |
|---|---|
| Configuration exchange / schema validation | Separate owner revisions and Included inventory; validate complete acknowledged participation |
| `operating-scope.ts` | Project controlling decision variables and external Verification demand from effective authority; retain gross base provenance |
| Planner / policy compiler | Publish explicit scope and proportional solar identity; include scoped feasibility in matched economic alternatives and future witnesses |
| Native response / household scorer | Enforce the same feasible house-supply amount and physical routing; count objective components once |
| HA conditions / evaluator / host adapter | Observe aligned real demand, enforce scoped native response, rank with existing C + V, preserve sole writer and coverage/release rules |
| Portal / chart / workbench | Explain explicit intent independently of forecasts and actuals; grey is gross base, with Other planned devices for omitted Planned series |
| Replay / diagnostics / fixtures | Capture scope, role, source attribution, measurement quality, evaluated action, pending effects and complete economic evidence |

These are extensions to the current boundaries, not authorization for another
BatteryService dispatcher or a local future optimizer. `battery-execution-policy-v1`
and current schema-2 commands do not already contain these new fields. Select and
validate the new versioned wire shape during implementation, regenerate fixtures,
and coordinate producer/consumer rollout. No compatibility interpretation is added.

## Reporting and historical truth

Exclude device metadata at the ingestion boundary and separately fix chart display
folding. Today small Planned series and series beyond the eight-band cap join grey;
removing excluded inventory does not change that rule. Keep Planned consumption
separate regardless of display size, with an Other planned devices band as needed.
PV and storage remain separate from the positive consumption stack.

Explain scope as “battery may offset …”, show measured eligibility and chosen
operation, and distinguish those from nominal watts and delivered power. Per-device
solar/battery attribution is accounting, not evidence of measured source routing.
Historical comparisons retain then-effective roles, source convention and scope;
reclassifying an old chart under today's settings must be explicitly labelled.

## Supersession and delivery

The user rejected the v35 full-forecast-deficit-to-rated-discharge shortcut as the
long-term solution. Preserve it as versioned implementation history, and supersede
it with explicit supply intent plus measured conditions and economic evaluation.
A documentation edit neither reverts code nor changes running plans. Simply
restoring forecast-sized ceilings would restore the original defect.

Use the canonical acceptance matrix: exclusion and stale membership, re-admission
defaults, effective authority and pending release, shared controls, small/>8 Planned
chart series, uncontrolled Verification loads, all supply scopes, proportional PV,
missing/overlapping/time-misaligned meters, source-route enforcement and latency,
and competing future-price cases. A valid contract or wider discharge is not proof
of better cost. The full scope-capable host/adapter remains required implementation.

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) ·
[Planner](planner.md) · [Execution policy](battery-execution-policy.md) ·
[Portal](portal-and-reporting.md) · [Acceptance](verification-and-delivery.md)

## Production Sigen connection — 16 September 2026

Generated plans now carry explicit `battery_supply_scope` (`whole_house` for the
current planner). The policy exchange rejects a DC request whose selector differs
from its source plan. Native catalog changes, including local operating-mode
revisions, change scope identity and require fresh admission.

The production HA owner connects the existing future-cost policy to actual Sigen
mode and ESS-limit commands, with live measurements, source-cut energy counters,
one durable writer, final shared-lock checks and cloud-independent release.
Verification evaluates without issuing new optimization commands. Planned devices
remain separately measured in either local mode.

ESS watts and battery energy are DC; grid and household delivery are converted
AC quantities. Versioned directional gain/fixed-overhead curves are shared by
current and future scoring. Suitable isolated history identifies discharge and
grid-charge curves; insufficient evidence retains labelled configured assumptions.
Solar residuals do not identify pure DC conversion efficiency, and separate
PV-to-house conversion remains unmodelled in this version.

See [implementation and rollout](scoped-participation-implementation.md) and the
[HA live guide](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/battery-live-commissioning.md)
for signs, sensor freshness, adapter timing, loss-fit evidence and deployment tests.
