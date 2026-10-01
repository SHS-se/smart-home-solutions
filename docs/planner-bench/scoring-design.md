# Planner bench v3: architecture decision

## Problem and caller

Quarter price predicates cannot judge multi-day storage. The previous comfort-only score also ignored physical violations and penalized useful pool preheating. The bench needs independent, reproducible evidence of missed opportunities without changing planner behavior.

The runner calls `evaluate(case, record, criteria, lane)`. It invokes the referee and opportunity audit, stores their evidence in `BenchSeries.audit`, and derives the compact score. The UI reads this stored evidence: changing an explanation or opening a witness never runs an optimizer in the browser. Saving changed comfort criteria triggers rescoring from stored decisions.

## Ownership

| Module | Responsibility |
|---|---|
| `referee.ts` | One independent physical simulation for recorded and alternative decisions; requested-action violations and recovery trajectories |
| `service.ts` | Shared recovery policy and separate pool/car service exposure guards |
| `opportunities.ts` | Rule catalogue, case applicability, deterministic search, cumulative transfers and known/hindsight evidence |
| `score.ts` | Comfort rules, criteria validation, 70/30 score projection, stale-version detection |
| `evaluate.ts` | The single composition point for referee, audit, statistics and stored score |
| `bench/rescore.ts` | All-lane coverage, recomputation from decisions, persisted-version verification and report |
| `BenchRuleCards.tsx` | Grouped visual rules, applicability, threshold bands and one reusable evidence viewer |

`OpportunityAudit` holds its version, lane, service guard, applicability, physical violations, search coverage, known/hindsight money and ordered findings. Each finding owns its saving once, may have several explanatory tags, and stores before/after pool, car and battery trajectories. `StoredScore` carries a compact summary; the existing result-series JSON carries the full evidence. No database schema change is needed.

`CaseScore` retains the quarter comfort breakdown and adds `comfortPoints`, nullable `economicPoints`, `complete`, `physicalFailed`, applicability and audit state. Missing or stale evidence is visibly incomplete; it cannot enter a current-version comparison. Valuation-lane diagnosis uses comfort points independently of the mixed headline.

## Alternatives considered

Independent Claude Opus 5.5 High and Codex candidates were grounded in the current design documents and bench code. The chosen design combines cumulative transfer accounting with strict physical endpoints and stored graphical evidence.

- Reject standalone cheap-export/expensive-import penalties: a better use of that energy must be demonstrated.
- Reject scoring extra consumption merely because its price was low.
- Reject median-price terminal credits as an optimization objective: they can manufacture savings by depleting or overfilling stores.
- Reject fixed sunny/cloudy day thresholds: physics and opportunity cost determine whether moving heat helps.
- Reject a blanket warm-pool penalty: a warm pool can hold useful future heat.
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

The [scoring catalogue](scoring.md) defines the numerical policy. Comfort receives 70% and known economic loss 30%. Both components remain visible, as do physical failures. These weights are benchmark choices, not physical facts.

Search considers hourly source/destination blocks across all three days, with fractional battery/car transfers and quarter-based pool moves. Replay checks COP, thermal losses, power, storage and grid limits. Finite trial and transfer budgets bound runtime. This finds a conservative lower bound on avoidable cost, not a globally optimal plan. Strict endpoint preservation deliberately misses some pure waste-removal opportunities.

## UI and verification

Three groups show bench feasibility, comfort and energy timing. Threshold bands explain comfort; short flow diagrams and paired time strips explain energy rules. A selected witness shows solid recorded versus dashed alternative trajectories, energy moved, net SEK and known/hindsight status. Advanced controls and measurement details are expandable. Buttons focus the relevant quarter in the existing plan chart.

Verification covers service, physical invalidity, losses and wear, negative/flat/high-export prices, future solar, terminal inventory, deterministic attribution, stale evidence, all-lane rescoring, keyboard use and narrow layouts. Rescoring is explicitly independent of historical planner Git availability: `--shas none` uses stored decisions and verifies the saved versions afterward.
