# Shared marginal state values for battery, EV and pool

Architecture decision, 4 October 2026. Based on independent Claude Opus High and Codex reviews, traced runtime code, git history, and isolated local timing probes. This is a design and timing prototype; production planner code is unchanged.

## Problem

The current static store curves combine household service preferences, scheduling bids, and terminal inventory value. Battery generation can erase every marginal difference by clipping all points to a terminal median. EV and pool values are derived from supply costs, which do not by themselves express the household's willingness to pay for service. Pool-first solar claiming also affects the EV seed. The bench plots the reported values faithfully.

One shared algorithm can calculate scheduling values for all three devices. Their physical models and service timing must remain different. Curvature is evidence, not a constraint: equal prices, discrete actions and charge ceilings can legitimately produce plateaus or discontinuities.

## Usage — caller's view

The planner resolves one immutable household problem, advances one shared search, and publishes a complete selected schedule with its economics and associated value evidence:

```ts
const problem = resolveHouseholdProblem(input);
const request = continuation.search
  ? { kind: 'resume', checkpoint: continuation.search }
  : { kind: 'new', previous: previousSelectedEstimates };
const step = solveHouseholdStep(problem, request, workerBudget);
if (step.done === false) return encodeContinuation(step.checkpoint);
return assemblePlan(input, step.selected.schedule, step.selected.evidence);
```

Offline experiments call the same operation to completion. The bench reads marginal slices from the selected solve, alongside the captured home targets and physical ceilings. It never supplies actual future prices to the live solver. See [the interface sketch](interfaces.md) for three call sites, types, signatures and algorithm pseudocode.

## Shape

Use **one full-horizon conditional Bellman engine, coordinated by shared electricity prices, with bounded joint household rollout**. A Bellman table answers what the best future economic outcome is at each possible device state. Differences between neighbouring states estimate the marginal value of another kWh, kilometre or degree.

Every round computes tables for all devices. The battery supplies bidirectional transitions, efficiencies, wear and discharge permissions; the EV supplies supported current steps, charging efficiency, charge ceiling and readiness timing; the pool supplies heat gain, loss and native startup memory. Reuse the existing device models and physical accounting. No second simulator or independent device optimizer is introduced.

The joint rollout proposes combinations of executable commands, advances actual physical state, and checks shared grid/equipment limits. It evaluates the complete household under one fixed objective. Coordination prices inform the next round; they are search estimates, never household preferences or physical limits. The selected result is the best complete physically validated schedule explored, not a claim of a global optimum.

The fixed objective owns import/export, configured shaping/continuity, wear and native starts, graded service utility, and beyond-horizon continuation value. Pool service is integrated over useful time; EV readiness is counted at its usage event. In-horizon energy savings occur in the Bellman calculation, not again in terminal credit. The battery's terminal replacement estimate may be flat without making its in-horizon state value flat. Wear has one explicit throughput basis and is charged once.

Home targets are read from captured current settings; the search cannot lower them or change their service utility to improve its score. A target alone does not specify a SEK shortfall price. Initial offline comparisons must declare and freeze one versioned existing comfort policy for all candidates. Calibration of that policy is a separate measured decision; do not treat today's supply-clearing prices as proven customer utility or invent new compulsory service floors.

Each selected record owns its schedule, objective breakdown, round prices and value tables together. A later losing round cannot replace the charts for an earlier winning schedule. Marginal slices include their time, native response memory, selected round and approximation meaning. They use a distinct signed state-value type; they are not coerced into the current nonnegative concave `UtilityCurve` preference type.

The worker is the sole writer of numeric search continuation. Immutable input identity covers measurements, targets, forecasts, prices, economics and model versions. Retry resumes the same cursor; changed input creates new work. Transport encoding belongs outside the planner. Search interruption never publishes a partial schedule or silently reruns the old planner.

## Synthesis decision

**Base: Codex's full-horizon state-value engine and joint rollout.** It addresses all three scheduling values and shared scarce energy directly. Compatible Claude strengths: separate service utility from continuation value, freeze economics before search, reuse physical transitions, and account for every service/energy benefit once.

Claude's smaller continuation-only design is a useful alternative but leaves the current in-horizon auction flaws unresolved. Its representative repeated day introduces a new continuation assumption; its forced concave envelope can hide startup and discrete-action effects. These are rejected for this design. Black-box curve search is not mathematically impossible—it can tune a heuristic under a fixed evaluator—but repeated full planner evaluations are too expensive for the first live implementation on the measured fixture.

Both candidates identified exact joint dynamic programming as a structurally different alternative. It gives the clearest exact model but multiplies battery, EV, pool and response-memory state spaces. Use it as a tiny-case oracle, not the initial production solver.

Red-flag screen: one substantial search boundary; physics stays with device models; economics stays with the objective; worker wire types stay outside the planner. No per-device search implementations, prepare/run/finalize public choreography, forwarding modules, shared cache writer, or caller-controlled "objective curve" flag. Native memory is typed separately from stored energy. Validation applies existing physical/data rules, not prediction confidence or invented household promises.

## Resource budget

Start at **eight rounds for the household**, with a ceiling of ten. Each round updates all three devices; this is not eight to ten complete planner calls per device. Initial round counts. Stop at the declared work limit or when the selected trajectory and coordination residual stabilize. Keep the best complete validated result; if no complete candidate exists, report search failure without claiming physical infeasibility.

Prototype ceilings: 12 million Bellman transitions and one million joint action evaluations, with explicit counters and memory accounting. These are search limits, not new equipment or validity constraints. Measure and revise them before rollout. Native response memory increases work; the simple kernel timing cannot establish the final budget.

Measured local synthetic baseline: 288-quarter varied priority solve 8.84 seconds; instrumented repeat 8.64 seconds with 15 auctions. Repeating 25–30 such solves would take roughly 3.6–4.4 minutes if costs stayed similar. The isolated shared Bellman kernel took 0.50 seconds for eight fixed-context sweeps and 0.61 seconds for ten. It excludes coordination, joint rollout, native startup memory, new objective accounting and serialization. It proves neither convergence nor improved household results.

Preserve the existing 20-second production chain deadline, 64-call ceiling and worker CPU controls. Pause at Bellman/rollout work boundaries. Measure complete planning, all scenarios, response memory, transport and HA materialization on the hosted worker; never infer compliance from the isolated kernel.

## Replans — implemented prototype

A new replan seeds its shared prices and compatible value rows from the previous **selected** solve. A paused solve resumes its checkpoint. These are distinct typed operations; a prior problem's checkpoint is never continued as a new problem.

Align overlapping quarters by their planning start and duration. Preserve the previous estimate’s relative position between import and export prices under the **current** tariffs, plus its separate resource premium. Do not mistake the former import/export spread for scarcity when a forecast changes from surplus to deficit. Newly appended and partially elapsed quarters start with current inputs. Value rows require matching economics, physical-model and state-layout identities; native memory and measured initial state always come from the current snapshot. The terminal boundary is always freshly computed.

A complete backward Bellman pass overwrites every row. Copying old tables does not eliminate those transition evaluations. The measured practical value of reuse is in the shared coordinating prices, not a proven reduction in iterations. Persisting the entire table adds roughly 0.9 MB of raw numeric values for this prototype's lattice; do not add that traffic to production without a demonstrated use. The typed seed implementation supports table reuse for evaluation, but durable table storage remains a measured design decision.

Preferences, device models or household resource limits changing restart the shared price estimates from current inputs. Those estimates encode competition among all devices: an obsolete pool preference can bias EV/battery decisions even when only the pool's value row has been discarded. This is current-input initialization inside the same search algorithm, not an old-planner fallback.

The new `bench/experiments/replan-seed.ts` and steady-device `bench/experiments/replan-comparison.ts` implement this experiment. Twelve seed tests plus two integrated prototype tests cover horizon shifts, price rebasing, preference/model/layout/limit changes, partial quarters, ownership, malformed estimates, stale value replacement, and changed-target results. Each complete prototype trajectory is checked by the existing physical scorer; none is sent to the live planner.

Initial reuse without refreshing shared prices performed about 2.8 SEK worse in the model objective after a pool-target change. The revised initialization matches the fresh solve in that case. The routine horizon and tariff changes improved the model objective by approximately 0.94 and 0.97 SEK at eight rounds; the reduced-PV case improved by about 0.03 SEK, and the unchanged case matched. These are synthetic objective differences, not measured household cash savings.

The forty-round reference exposed a search-quality issue: after a large PV forecast reduction, the fresh run improved the objective by 11.72 SEK beyond its eight/ten-round result, while the reused start improved over the fresh eight-round result by only about 0.03 SEK and remained at that result even at forty rounds. The comfort-change reference also improved by about 2.04 SEK beyond ten rounds. Thus reuse is not uniformly beneficial, and eight–ten rounds are **not validated as sufficient**. The next algorithm validation must address search coverage/coordination under changed forecasts; do not merely raise the live budget to forty or declare warm starts optimal.

See [the replan report](replan-report.md) for the comparison table, reproduction commands and limitations. Production scheduling, persistence and model/protocol versions remain unchanged.

## Tradeoffs accepted

- We accept approximate factorized continuation values in exchange for avoiding the product of household state spaces.
- We accept bounded search coverage in exchange for explicit computation ceilings.
- We accept a substantial scheduling-owner migration in exchange for eliminating repeated expensive curve trials.
- We accept plateaus and possibly signed/nonconcave diagnostic slices in exchange for reporting the computed economics honestly.

## Open questions and falsification

The eight-to-ten-round quality claim remains unproven. Shared prices can oscillate, finite beams can miss coordinated actions, state interpolation can distort discrete/native response effects, and comfort price calibration can dominate the result. Do not hide these behind smooth curves.

Compare budgets 1, 4, 8, 10 and a larger offline reference. Report common objective, cash bill, comfort exposure, readiness, closing inventories, feasibility, CPU, memory and continuation bytes separately. Run existing home cases under told information; oracle prices are evaluation only. The current three joint-scale lanes cannot attribute per-device shape gains.

Compare against exact joint enumeration/DP on small horizons: scarce/abundant PV; equal, cheap and negative prices; low/high and out-of-desired-band measured states; EV targets beyond the unchanged charge ceiling; published-price gaps with the existing outlook; pool startup and shortfall; shared import limits and battery permissions. Assert no repeated completed work on retry, no double counting, and charts from the actual winning round. Use jointly rescheduled state perturbations to check the meaning/error of reported marginal slices.

Reject or redesign if larger budgets materially improve results beyond eight-to-ten rounds, physical replay changes the winner frequently, shared-resource values are systematically wrong, or full planning exceeds the unchanged live deadline.

## Next implementation step

The **steady-device offline Bellman/joint-rollout and replan-seeding prototype is now built**, with resource counters and physical rescoring. It holds current fixture utility fixed within each comparison; it is not the completed service-economics policy or production response model. Next add exact small-case comparisons and improve search coverage on the demonstrated changed-forecast case. Resolve service accounting explicitly and benchmark the user's recorded cases before replacing production scheduling.

Then replace the old scheduling owner coherently; remove obsolete curve derivations and sequential PV reservation, publish selected state-value slices, update bench interpretation, and bump model/protocol versions where semantics or continuation change. Retain explicit user preference curves as preference inputs, not competing solver owners. Planner changes require generated HA contract fixtures, full Deno tests, repository lint, dev build and local mocked E2E validation. This commit contains offline experiments and their design; it does not replace production scheduling or change its output.
