# Offline battery policy compiler — step 3

Implemented 14 September 2026. This is the first bounded battery compiler slice:
explicit battery alternatives, future battery rescheduling and reconciled current/
future economic values. It is an offline exact-condition prototype, not a shipping
HA policy or an inverter command implementation.

[Thermal modelling remains a significant deferred workstream](models-and-forecasts.md#deferred-thermal-modelling-workstream).
One battery is modelled; PV and aggregate non-battery electrical demand are
external forecasts. Thermal/EV equipment, thermal stores and service events are
rejected. No thermal benefit or achieved service is inferred from electrical load.

## Usage

```typescript
import { compileBatteryPolicy, selectBatteryPolicy } from "./battery-policy.ts";

const result = compileBatteryPolicy({
  problem: resolvedBatteryProblem,
  reference_id: "hold",
  alternatives: [
    { id: "hold", current: { actions: holdPath, pv_curtail_w: curtailment } },
    { id: "charge", current: { actions: chargePath, pv_curtail_w: curtailment } },
  ],
  search: {
    energy_levels_kwh: [0, 2, 4, 6, 8],
    pv_curtailment_fractions: [0, 1],
    retained_per_level: 2,
    max_interval_evaluations: 2_000_000,
  },
});
if (result.status === "compiled") {
  // Offline applicability demonstration; this does not operate equipment.
  const decision = selectBatteryPolicy(result, resolvedBatteryProblem);
  const alternative = result.alternatives[0];
  console.log(decision, alternative.current, alternative.future_delta);
}
```

Each current path specifies a battery action and explicit PV curtailment for
**every input interval remaining before the next UTC quarter boundary**. Battery
actions use the existing scorer shape: `kind`, `charge_w`, `discharge_w`,
`solar_charge_w`, `export_w`. These are imposed physical response paths, not native
operation names or ceilings that are assumed to cause a particular draw.
The horizon must reach the current quarter's end. The caller names the reference;
there is no automatic substitute if it cannot be solved feasibly.

Run the included synthetic cases:

```sh
deno run --allow-read scripts/compile-battery-policy.ts docs/energy-optimisation/fixtures/battery-policy/fixed-tail-reversal.json
deno run --allow-read scripts/compile-battery-policy.ts docs/energy-optimisation/fixtures/battery-policy/negative-price-recovery.json
```

The CLI reads data only, prints JSON and exits nonzero if compilation is rejected
or the reference is unavailable. No input-supplied module is executed. These cases
are analytical examples, not calibrated models or measurements of Phil's house.

## Ownership and synthesis

`battery-policy.ts` owns one closed compile operation: validation, a cache of
prefix scorers, a finite target-energy search, cost splitting and exact-condition
coverage. Its search state is private to each invocation. The CLI owns file I/O;
`benchmark-battery-policy.ts` provides a reproducible synthetic sensitivity study.
Existing `household-score.ts` and `household-physics.ts` remain unchanged and own
all objective and physical validation. Shipping planner output and HA contracts
are unchanged.

Independent read-only Claude Opus/High and Codex designs were compared. Codex is
the base: retain distinct energy states, score complete prefixes with the existing
oracle and avoid rounding physical state. Adopt Claude's preflight work estimates
and authoritative final rescoring. Reject immediate extraction of interval kernels:
a local benchmark of the existing scorer completed 288,000 interval evaluations
in 0.30 seconds, and the complete compiler measurements below support reuse for
this bounded slice. Revisit that decision if larger workloads disprove it.

The exact compiler keeps exact input coverage and explicit finite-search omissions.
The subsequent [time/state coverage module](battery-policy-coverage.md) reuses this
solver to build diagnostic bands, with a restricted physical feasibility witness
and empirical held-out error evidence. General feasibility certificates remain
deferred. No second physics/economic implementation or solver dependency is added.

## Search and status semantics

The shared target set contains requested energy levels, physical bounds, initial
energy and every feasible forced-current endpoint. A suffix expansion proposes
movement toward each target plus holding the actual state, using declared duration
and efficiency. It considers requested PV-curtailment fractions and the exact
minimum curtailment needed to respect the export limit. Proposals are not clipped
to battery bounds or rated power; the scorer rejects illegal ones.

For this one-battery objective, source attribution uses maximum available solar
for charging and minimum necessary battery export. These allocations have no
independent economic reward. The scorer still verifies availability, both source
permissions, energy balance and all physical constraints.

Every prefix is evaluated by a scorer over that prefix, with terminal utility
omitted until the full horizon. State is the scorer's actual numerical energy and
previous import. Only identical state/import pairs can be merged by cost dominance.
A nominal target bucket limits retained paths; it never replaces physical energy.
Keeping paths per target preserves costly charging prefixes whose benefit arrives
later. Pruning remains a heuristic and can remove a future winner.

The complete winning candidate is rescored against the original problem. A score
or feasibility disagreement throws as a compiler defect, not as an infeasible
household choice. All alternatives, including the reference, receive the same
search domain, retention rule and work convention.

- `rejected`: invalid/unsupported input or a work/output limit prevents compilation.
- `reference_unavailable`: the named reference lacks a complete feasible result;
  no economic deltas are published.
- `current_infeasible`: the explicitly forced first block violates scorer constraints.
- `no_solution_found / declared_graph_exhausted`: no completion in the finite
  proposed graph; this does not prove continuous physical infeasibility.
- `no_solution_found / search_pruned`: no completion survived a pruned search.
- `compiled`: feasible alternatives carry full candidates, component ledgers,
  ranking and work evidence. Pruned results are labelled `unproven_after_pruning`;
  graph optimality is claimed only when every compared search was exhaustive.

Neither graph optimality nor a width-refinement result establishes a continuous
optimum or a regional error bound. Unrepresented power/curtailment levels remain
outside the search domain. `approximation_error_bound_sek` is explicitly null.

## Current/future reconciliation and coverage

For each alternative, `full` is J and `current` is both L and C. With reference r:

```text
future_delta = (J_a − J_r) − (C_a − C_r)
current_a − current_r + future_delta_a = full_a − full_r
```

The identity is retained component by component, including bill, gross wear,
shaping, ramp and terminal value. The reference's future delta is zero. Terminal
value belongs to the closing account, outside C, even when the horizon ends at
the current quarter boundary. The ramp cost on the first suffix interval belongs
to the future. No separate battery opportunity price is added.

Coverage embeds the complete validated problem and names the current quarter end.
`selectBatteryPolicy` accepts only an equal parsed problem; changed time/state,
prices, demand, PV, permissions or intent require another compile. There is no
interpolation or extrapolation. The selector demonstrates offline applicability;
it is not a hostile-wire reader, freshness monitor, physical guard or actuator API.

## Bounds and measured evidence

Before suffix search, the compiler estimates worst-case scorer interval work from
prefix lengths, target count, curtailment count and retained paths. Both CLI and
API bound input size to 2 MB. Cardinality checks cap intervals at 288, alternatives
at 12, residual series at 32, combined targets at 48, explicit curtailment fractions
at 4, retention at 8 paths per target, and terminal curve points at 64. Terminal
coverage is at most one battery entry. Input series lengths are checked before
full model parsing. Aggregate scorer work is capped at 40 million interval
evaluations and output at 2 MB. Forced-prefix validation is bounded separately
before constructing the final shared target set. These are prototype engineering
limits, not commissioned runtime guarantees.

The fixed-tail fixture gives the following exact ideal-battery results:

| Immediate choice | Frozen idle future | Reoptimised future | Current C | Future delta F |
| --- | ---: | ---: | ---: | ---: |
| Hold (reference) | 3.25 SEK | 0.75 SEK | 0.50 SEK | 0 |
| Discharge | 2.75 SEK | 2.75 SEK | 0 | 2.50 SEK |

Freezing the future chooses discharge; rescheduling correctly chooses hold by
2.00 SEK. The grid-recovery fixture adds negative prices, 95% efficiencies and
0.10 SEK/kWh gross wear; charging now and recovering later scores 0.0413125 SEK.

Reproduce the longer synthetic study:

```sh
deno run --allow-read scripts/benchmark-battery-policy.ts
```

| Horizon | Retained per target | Measured elapsed | Scored intervals | Ranking |
| --- | ---: | ---: | ---: | --- |
| 24 hours | 1 | 0.26 s | 252,880 | Hold, discharge |
| 24 hours | 2 | 0.45 s | 505,392 | Hold, discharge |
| 72 hours | 1 | 2.45 s | 2,457,056 | Hold, discharge |
| 72 hours | 2 | 4.40 s | 4,913,360 | Hold, discharge |

These are single-run local measurements, with other validation also running.
Both widths pruned paths. In these cases, doubling width changed objectives only
at floating-point noise scale and preserved rankings; this is measured sensitivity
on those cases, not a general accuracy or latency guarantee. Tiny test cases also
compare every result against independent exhaustive power enumeration, including
negative prices, wear, shaping and ramp costs.

## Remaining delivery work

The implemented slice establishes battery counterfactual search and C/F accounting.
The subsequent [regional coverage stage](battery-policy-coverage.md) adds bounded
time/state bands and empirical held-out checks. The HA repository also contains a
pure decision/reconciliation runtime, energy ledger and exact-anchor policy binding.
Production work still includes resolved real-case inputs, additional forecast/state
coverage, commissioned native inverter response, supported operation templates and
a versioned regional acceptance contract connected to the runtime.
Hardware activation still requires its delivery and commissioning gates. Thermal
model calibration and joint thermal recovery stay deferred to their own workstream.
