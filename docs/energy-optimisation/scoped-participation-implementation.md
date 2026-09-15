# Participation and scoped supply: implementation status

15 September 2026. **Partial implementation; the live battery replacement is not
connected or commissioned. Do not deploy this as the fix for the September 15
battery discharge incident.** The normative decisions remain in
[device participation and battery supply](device-participation-and-battery-supply.md).

## Implemented

- Inclusion belongs to HA; website roles determine Monitoring/Planned; Schedule
  offers Verification/Controlling for Planned equipment. Local inventory remains
  visible after exclusion so a device can be re-included.
- Complete outbound inventory omits Excluded devices. Local exclusion fences
  optimization authority immediately. Device telemetry, associated system SOC/
  temperature, and storage source bindings respect inclusion. Whole-house balance
  can still use local storage flows before removing their individual payload fields.
- Admission is bound to the acknowledged website role revision and physical owner.
  Demotion, exclusion and changed admission remove the old controlling permission.
  Configuration migration 14 clears existing grants; re-admitted Planned equipment
  starts in Verification. Existing issued-effect/release records are retained.
- Missing setup for Planned equipment is a planning blocker, rather than silently
  treating that equipment as Monitoring.
- Website grey consumption is gross base, before PV. Small/excess Planned bands
  are grouped as Other planned devices. The executable chart restores Verification
  demand from the captured external-demand projection without changing commands.
  Historical membership is explicitly labelled as reclassification using the plan.
  Invalid measurements propagate through stacking and SVG rendering as gaps.
- `battery_supply.py` validates the five scope forms, proportional solar sharing,
  membership revisions, freshness/alignment, unique measurement sources and gross
  reconciliation. Interval averages and reviewed watts cannot authorize instant
  subgroup supply. The user-named house/PV entities are discovery candidates;
  their common AC measurement boundary still needs verification.
- Closed execution-policy v2 adds mandatory scope, proportional attribution and
  explicit wear basis. Both compiler and evaluator reject native responses that
  exceed scope, including house supply during forced export. They never silently
  clamp a scored native target or widen it to the battery rating.
- Offline household schema/scorer v2 supports both explicit AC-throughput wear and
  discharged-storage wear. The latter matches the existing planner's degradation
  basis. Current permissions remain strict; future continuation uses its own
  explicit per-quarter permissions. Current ineligibility cannot by itself erase
  an otherwise permitted future charge/export opportunity.
- Runtime authority now binds the actual supply selector, not only its revision
  label. Checkpoint v6 carries the updated policy/authority shape and rejects older
  offline checkpoints; no production host was using that checkpoint format.
- The async `HomeHost` implements reducer effects, durable-before-send, final
  authority checks, ambiguous transport outcomes and conservative restart. A pure
  native adapter only composes supplied commissioned transitions. Neither module
  is attached to HA setup or granted physical authority yet.

## Production conditional projection

`generateOptimisationPlanWithBatteryProjection` returns the existing plan and a
separate resolved battery projection from the same generation. The existing plan
API and HA wire output are unchanged. Schema 9 returns the execution branch's
projection; provenance is trimmed with that branch's remaining horizon.

Each continuity candidate carries its own materialization. The selected candidate
supplies unrounded final household demand after thermal/device scheduling, exact
remaining-quarter durations and battery flows. Its selected dispatch bundle
supplies tariffs, limits, usable-energy state, terminal curve and discharged-storage
wear. There is no second workbench solve and no reconstruction from display values.

The projected household problem freezes the final non-battery schedule. Its total
plus `dispatch_total_offset_sek` reproduces the **conditional one-battery** dispatch
score; the offset is initial stored-energy utility. Initial import is null because
batch dispatch has no initial-to-first-slot ramp charge. This does not assert joint
optimality of the earlier auction and subsequent thermal scheduling.

Ready projections are detached and immutable. Unsupported models/constraints or
infeasible selected trajectories return explicit reasons and cannot authorize a
substitute command. Grid charging is feasible in the dispatch scoring domain;
ordinary charge-bidding heuristics are not treated as physical permission. This
record grants no device authority and is not yet a native execution-policy request.

Parity tests compare alternative battery schedules under two different fixed
household schedules, negative/positive prices, partial first quarters, losses,
wear, shaping, ramp and terminal utility. A production thermal example also
cross-scores using its actual resolved store. Tests cover selected continuity,
quarter-boundary provenance, mixed-mode external demand and unchanged plan output.

## Work still required before the battery replacement is complete

1. Compile and exchange a native execution policy from the resolved conditional
   projection. Bind the approved supply selector, proportional forecast bounds,
   participation revisions, commissioned catalog and explicit native permissions.
   Economic feasibility is not a physical grant; current and future native
   permissions must be intersected at that boundary.
2. Extend represented constraints if needed. Nonzero shaping thresholds, hard
   per-boundary targets, positive reserves for enabled battery export, fixed-plan
   authority and curtailment remain explicitly unsupported by this projection.
3. Connect policy exchange/renewal, same-capture physical evidence, durable grant
   arbitration and commissioned adapter IO to HA setup. Fence/release the old
   battery writer before any new runtime grant; requested Controlling alone is not
   effective authority. Make uncommissioned/uncovered status visible on Schedule.
4. Establish physical native-mode response, power units/quantization, transition
   ordering, write/response latency, stale-input behavior, shared AC meter boundary
   and subgroup enforcement precision. A successful 406 W cap observation is not
   evidence for every mode or transition.
5. Replay the captured incident through that connected path, including a contrary
   case where conserving energy is cheaper, then coordinate both-repo rollout.

The current `ScheduledController.execute_battery` remains the live writer in this
checkout. The rated/forecast command path has **not** been replaced by these offline
policy changes. Unit tests are not evidence that the house now runs scoped C+V
control. No HA settings, native mode, service command or deployment was changed.

## Validation

Regression coverage includes proportional PV (base 1 kW / house 3 kW / PV 1 kW
allows 2/3 kW), stale/missing/duplicate/average measurements, changed admission and
scope, exact native-response rejection, wear parity across current/continuation
scoring, current restrictions with permitted future recovery, durable writes,
transport ambiguity, and mixed-mode chart partition/rendering. Repository test,
frontend test, build, lint and mocked-browser results are reported with the commit.
