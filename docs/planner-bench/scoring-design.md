# Planner bench v4: architecture decision

## Problem and caller

Quarter price predicates cannot judge multi-day storage. The previous comfort-only score also ignored physical violations and penalized useful pool preheating. The bench needs independent, reproducible evidence of missed opportunities without changing planner behavior.

The runner calls `evaluate(case, record, criteria, lane)`. It invokes the referee and opportunity audit, stores their evidence in `BenchSeries.audit`, and derives the compact score. The UI reads this stored evidence: changing an explanation or opening a witness never runs an optimizer in the browser. Saving changed rules, which are global to the bench, triggers rescoring of every result from stored decisions.

## Ownership

| Module | Responsibility |
|---|---|
| `referee.ts` | One independent physical simulation for recorded and alternative decisions; requested-action violations and recovery trajectories |
| `service.ts` | Shared recovery policy and separate pool/car service exposure guards |
| `opportunities.ts` | Rule catalogue, case applicability, deterministic search, cumulative transfers and known/hindsight evidence |
| `score.ts` | Comfort rules, criteria validation, raw integer point totals, stale-version detection |
| `large-load-overlap.ts` | Cumulative legal EV/home-battery charging transfers out of quarters containing multiple large workloads, keeping pool heating fixed; price-ordered destination search, one distinct destination per source |
| `evaluate.ts` | The single composition point for referee, audit, statistics and stored score |
| `bench/rescore.ts` | All-lane coverage, recomputation from decisions, persisted-version verification and report |
| `BenchRuleCards.tsx` | Grouped visual rules, applicability, threshold bands and one reusable evidence viewer |

`OpportunityAudit` holds its version, lane, service guard, applicability, physical violations, search coverage, known/hindsight money and ordered findings. Each finding owns its saving once, may have several explanatory tags, and stores before/after pool, car and battery trajectories. `StoredScore` carries a compact summary; the existing result-series JSON carries the full evidence. No database schema change is needed.

`CaseScore` retains the quarter breakdown and its `sum`, and adds nullable `economicPoints`, `complete`, `physicalFailed`, applicability and audit state. Missing or stale evidence is visibly incomplete; it cannot enter a current-version comparison. Valuation-lane diagnosis uses the same total points as the headline.

## Alternatives considered

Independent Claude Opus 5.5 High and Codex candidates were grounded in the current design documents and bench code. The chosen design combines cumulative transfer accounting with strict physical endpoints and stored graphical evidence.

- Reject standalone cheap-export/expensive-import penalties: a better use of that energy must be demonstrated. (Partly reversed 2026-10-03 at the owner's request: scorer v8 takes −1 / −2 from a quarter in which flexible load is bought from the grid in the dearest 25 % / 10 % of the plan's quarters; load carried by the sun or the battery loses nothing.)
- Reject scoring extra consumption merely because its price was low. (Reversed 2026-10-02 at the owner's request: scorer v5 rewards flexible load in the cheapest 25 % / 10 % of quarters with +1 / +2 All points add into one total; the lane diagnosis holds a valuation variant to nominal's total points.)
- Reject median-price terminal credits as an optimization objective: they can manufacture savings by depleting or overfilling stores.
- Reject fixed sunny/cloudy day thresholds: physics and opportunity cost determine whether moving heat helps.
- Reject a blanket warm-pool penalty: a warm pool can hold useful future heat. (Scorer v6: warmth above target +2 °C scores +1 when the next day is dearer or less sunny and −1 when it is neither.)
- Scorer v11, audit v5: the owner's overlap rule deducts −1 per quarter with at least two flexible workloads each strictly above 2 kW, only with a feasible move to a strictly cheaper quarter across the full 72 h. Stored independent witnesses preserve service and final inventories and obey equipment limits. This is a separate price-order heuristic, including unpublished actual prices; its points do not claim additional SEK savings or multiply the energy audit's savings.
- Scorer v20, audit v8: overlap moves accumulate into one feasible schedule and reserve a distinct cheaper destination per penalized source quarter, across all devices. Seven overlapping quarters require seven distinct available destinations; neither grid headroom nor intervening storage margins can be reused by independent witnesses.
- Scorer v21, audit v9: pool heating cycles stay fixed in the overlap rule; only EV and home battery charging may move. Running pool heating or charging counts as taking a cheap quarter even when its own store is already at/above target and another store remains short. Shared move evidence names the device, power, source/destination dates and actual prices, with chart navigation from either explanation.
- Scorer v12: the owner's EV supply preference deducts −1 when home-battery discharge remains available to the EV after netting simultaneous battery charging, exports and all non-EV household consumption. Other loads receive battery supply first; simultaneous EV charging and battery discharge alone is allowed. It needs no economic witness and uses existing stored power series.
- Keep hindsight separate from the headline, following the user's explicit preference.

## Invariants

1. The car is deliberately always available to charge. No unplugged, arrival or departure penalties.
2. Physical action violations fail the case independently of rule toggles, manual verdict or numeric points. A measured initial state outside a desired band is preserved rather than rewritten.
3. Every accepted alternative is replayed through the same referee. Pool and car service are guarded separately; one cannot pay for the other. Battery and car terminal inventory must match, and pool terminal heat cannot be depleted.
4. Accepted changes accumulate against the last accepted schedule. Savings are counted once; tags explain the same evidence.
5. Known-price opportunities are searched before hindsight. Every modified interval must have a published price to count as known; oracle lanes know all real prices.
6. Applicability comes from case inputs, not planner actions. No witness means “No loss found”, not “optimal”.
7. Normalization uses a case-derived scale, so extra consumption cannot dilute a planner's penalty.
8. Unsupported behaviors require explicit inputs and models before receiving scores.

## Policy and limits

The [scoring catalogue](scoring.md) defines the numerical policy. Comfort and known economic misses contribute raw integer points directly. Both components remain visible, as do physical failures.

Search considers hourly source/destination blocks across all three days, with fractional battery/car transfers and quarter-based pool moves. Replay checks COP, thermal losses, power, storage and grid limits. Finite trial and transfer budgets bound runtime. This finds a conservative lower bound on avoidable cost, not a globally optimal plan. Strict endpoint preservation deliberately misses some pure waste-removal opportunities.

## UI and verification

Three groups show bench feasibility, comfort and energy timing. Threshold bands explain comfort; short flow diagrams and paired time strips explain energy rules. A selected witness shows solid recorded versus dashed alternative trajectories, energy moved, net SEK and known/hindsight status. Advanced controls and measurement details are expandable. Buttons focus the relevant quarter in the existing plan chart.

Verification covers service, physical invalidity, losses and wear, negative/flat/high-export prices, future solar, terminal inventory, deterministic attribution, stale evidence, all-lane rescoring, keyboard use and narrow layouts. Rescoring is explicitly independent of historical planner Git availability: `--shas none` uses stored decisions and verifies the saved versions afterward.
