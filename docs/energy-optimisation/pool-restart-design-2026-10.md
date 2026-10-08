# Pool starts and model-owned startup — 8 October 2026

## Problem

Score −2 once on a pool command start less than 12 hours after its last stop.
Continue to stack the existing rules, including the independent short-gap rule.
The benchmark omitted the existing configured Bergvärme startup response and
always began off, so its electricity and heat predictions were instantaneous.

## Usage (caller's view)

```ts
const heater = publishHeater(household.pool.heater);
let state = scenario.start_state.pool_heater;
const step = stepHeater(heater, state, commandedOn, intervalSeconds);
gridDemand += step.electric_w;
poolC = stepThermalStore(store, poolC, step.heat_w, outdoorC, hours);
state = step.next;
// The independent referee stores step.start; the scorer compares off_seconds
// with the configured threshold. Electricity is never used to infer a start.
```

## Shape

The device-model module owns publication, independent startup integrals and
command transition memory. State is off with unknown stop (`off_unobserved`),
off for a known duration, running for a known duration, or confirmed steady.
Every solver branch and referee alternative owns its state. An on-to-off command
stops at the interval's beginning; subsequent off intervals accumulate duration.
An off-to-on command produces one start event; continuing on produces none.
Unknown stop history remains unknown until an actual projected stop occurs.

The existing TEST `heater_response` is captured unchanged as bench calibration
data. Its electricity ramp and supply/return temperature-difference heat proxy
remain distinct; heat flow was not measured. This is configured calibration,
not a newly implemented automatic trainer. Future background device publishers
can replace the artifact without changing scheduler policy. No historical reads,
model training or forecast generation are introduced in solve.

`device-models.ts` publishes and steps the heater; Rust `models` mirrors those
pure transitions. `physics.rs` consumes electric and thermal output separately
and attaches start evidence to its quarters. `policy.rs` scores that evidence in
construction, final accounting and witness recomputation. The referee uses the
same captured initial state for actual simulation, alternatives and reachability.
The scorer stores start events, so threshold/sign edits require no new simulation.

## Synthesis decision

Use Opus's immutable publication and persisted event design as the base. Adopt
Astra's explicit per-branch model state and small increment instead of a generic
provider registry. Reuse the real existing calibration rather than either
review's conditional proposal to approximate ten minutes. Reject a scheduler
cooldown, a scan of fluctuating electrical power, and duplicate thermal inference.

## Tradeoffs accepted

- We accept a mirrored TS/Rust physical transition in exchange for an independent
  referee, checked with shared transition vectors and complete solver parity.
- We accept ready ABI 3 and case version 2 in exchange for required explicit
  initial state, with no runtime acceptance of obsolete ready inputs. Historical
  bench engines continue to load their own committed codec for comparisons;
  the current engine does not substitute an older decoder.
- We accept a one-time TEST-only `bench/schema.sql` conversion of version-1 bench cases to their previously
  specified off initial state with unknown stop age. This preserves the original
  test convention; it does not claim a historical stop was observed. Newly
  converted replays retain captured runtime and refuse running states without age.
- We accept stored transition evidence in exchange for fast score previews;
  referee/scorer versions invalidate evaluations missing that evidence.

## Alternatives considered

A generic provider registry would rewrite search, state vectors and witnesses
without known contracts for future devices. A quarter-indexed startup table would
lose partial-quarter and initial-age accuracy. A witness-based restart rule would
require a counterfactual for a fact that is directly observable from commands.

## Open questions and risks

The calibration comes from one observed start and a temperature-difference proxy;
further measured runs can refine it in the device model. Existing rule priorities
may still choose penalized starts: additive points do not impose a prohibition.
Economic witnesses remain economic comparisons under their existing service
contract, not proofs that an alternative improves the whole scorecard. Production
activation, generic model discovery and background publishers remain qualification
work; this increment continues to run the new engine only in TEST bench.

## Next implementation step

Implement and verify the pure transition before wiring the rule. Check unknown
history, exact 12-hour boundary, zero-draw startup, continuation, stop reset,
fractional intervals, signed stacking and TS/Rust electrical/thermal parity.
Rebuild Wasm, regenerate the HA fixture, run full Deno/Rust/lint/build/E2E checks,
then publish dev for TEST bench comparison.
