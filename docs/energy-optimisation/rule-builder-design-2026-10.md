# Rule-driven builder — 7 October 2026

> **Objective changed 9 October 2026 (owner's decision, ABI 6, policy `kronor-score-v6`).** The builder no longer maximises rule points with kronor as a tie-break. It maximises one number, a point a krona: what the deduction rules take, less the net bill (grid cost, battery wear on discharge, less the energy left in the stores up to their targets). That is the bench's score ([scoring](../planner-bench/scoring.md)).
>
> - The problem carries `end_credit` terms, made by the producers from the prices the planner is told (`planner-wasm/end-credit.ts`); the solver applies them and seeds its continuation tables with them at the horizon end.
> - Only the deduction rules are sent (`resolveRulePolicy`): the price rules are evidence on the bench and the builder never sees them. The 500 W "thin" grid charge, which existed to reach the cheap-quarter reward's floor, is gone; so is the demand ceiling on charging, since a charge left at the end is credited.
> - An economic certificate no longer takes points: what it proves is on the bill. Its repair is ranked by the kronor it saves, forecast prices and published ones alike, and each ledger's latest repair holds all its accepted edits.
> - A short pool pause is charged once, at its restart.
>
> **Search changed later the same day (recipe `rule-forecast-opportunity-v4`, policy `kronor-score-v7`).** A candidate is scored from one projection of its commands. Since no economic certificate takes points, the audit of every family is no part of a score: it runs on the incumbent, as a source of proposals, and once more for the selected plan's report. Each proposal, a span edit or a certificate's repair, is scored exactly and adopted when it improves the score; the other improving proposals of the same pass are carried onto the new incumbent and re-scored. Only a rule that scores by certificate is audited per candidate (`witnesses::Scope::Scored`), and with the restart rule on none has anything to certify. The car-charging gap rule (`ev_short_gap`) is removed from the bench and the builder. See [move and resize](move-resize-search.md).
>
> On the eleven bench cases (real-price lane) the score went from −1,183 to −783, the grid bill from 1,494 to 1,346 kr, and the bench's proven avoidable cost from 207 to 73 kr. The text below describes the builder as first built; where it says points rank before cash, read the above.

## Problem

Replace the diagnostic profile/pair-swap solver with a rule-driven builder. The
independent frozen card remains the specification: 19 stacked quarter rules and
11 economic opportunity families, including configured signs, thresholds, tier
exclusions and service eligibility. Starting baseline: 569; requested threshold: 769; preceding prototype: 281.
The completed diagnostic builder scores 1,110; see the checkpoint for scope and
tradeoffs.
The ready-input, pure device-model and single Rust/Wasm invocation boundaries stay.
No historical queries, source fetches or forecast regeneration are added to solve.
The accepted next hour remains exact, including a partially elapsed first quarter.

## Usage (caller's view)

```ts
// Existing diagnostic adapter and hosted handler; no public phase choreography.
const p = readyProblem(frozenCase, household, criteria);
const { record, outcome } = candidate.plan(p);
const report = evaluate(frozenCase, record, criteria); // independent, unchanged

// Existing Wasm wrapper: one prepared problem, one private instance, one call.
const { outcome, wasm_memory_bytes } = core.solve(p);
// ABI2 rejects obsolete inputs explicitly; there is no old-engine fallback.
```

```rust
pub fn solve(p: &Problem) -> Outcome { /* implementation replaces old engine */ }
// Selection owns commands, exact physical quarters, signed quarter/economic
// contributions, witness coverage, run purposes, and counted work/termination.
```

## Shape

- `models`: pure native electrical/thermal transitions, unchanged ownership.
- `solver/physics.rs`: the single coupled step, projection, source attribution,
  native saturation and accepted-command enforcement.
- `solver/policy.rs`: rules, precision, eligibility, strict price ranks/day means,
  direct account and construction guidance; thresholds have one policy owner.
- `solver/witnesses.rs`: bounded causal feasible gap/overlap/economic proofs and
  the concrete schedule edits those proofs produce.
- `solver/builder.rs`: reverse opportunity index, forward bounded joint labels,
  purpose-bearing run choices and a bounded span-repair batch.
- `solver/lib.rs`: domain/wire types, explicit validation, work meter and ABI.

ABI2 carries raw ready forecast slots, typed device models, initial state, targets,
permissions, all enabled quarter-rule metadata and independent service-guard
thresholds. Ranks/day comparisons move inside policy: the producer passes facts.
Rules absent from the implemented catalogue fail preparation instead of silently
being dropped. Economic family mapping is explicit in the versioned manifest.

Concrete private sketches (implemented against these ownership boundaries):

```rust
struct Index { due: [usize;4], cheap: Vec<f64>, dear: Vec<f64>,
               buffer: Vec<Option<bool>>, future: Vec<FutureNeeds> }
struct Label { state: State, parent: usize, direct_points: i32,
               cash: f64, wear: f64, prepared: bool, last_charge: f64 }
struct FutureNeeds { pool_goal: f64, ev_goal: f64, battery_value_curve: Vec<(f64,f64)>,
                     useful_pool_quarters: f64, next_cheaper: usize }
struct WitnessAudit { gaps: Vec<[bool;2]>, overlap: Vec<bool>,
                      economic: Vec<EconomicHit>, repairs: Vec<Repair>,
                      coverage: Vec<WitnessCoverage> }
struct Repair { commands: Vec<Command>, family: String, expected_points: i32 }
struct EconomicHit { rule: EconomicKey, quarters: Vec<usize>, saving_sek: f64, published: bool }
fn construct(p: &Problem, index: &Index, work: &mut Work) -> Result<Vec<Vec<Command>>, String>;
fn audit(p: &Problem, commands: &[Command], quarters: &[Quarter],
         index: &Index, work: &mut Work, quota: usize) -> WitnessAudit;
```

A reverse sweep indexes useful future service/buffer/solar/dear-sale opportunities.
A forward sweep expands a small versioned number of coupled native choices per
label. Exact state is retained; guidance ranks incomplete candidates but is never
reported as earned score. Keep diversity in useful pool/EV/battery inventory and
run state. Store parent links, not complete copied histories per branch.

Pool choices carry service, thermal-buffer or retained-use justification derived
from rule thresholds and model transitions. In particular, the buffer proposal
must cross the stored measurement threshold; the old target+2.2 minus0.5 threshold
is removed. No target-derived value becomes a hardware ceiling. Discretionary
last-day heating/charging requires an in-horizon use or an existing service goal;
there is no new terminal monetary credit. Above-target measured state remains valid.

Audit only a small complete finalist set. A proved causal witness both contributes
its signed rule score and supplies a whole-run/energy-transfer repair. Proposals
may insert/remove/resize commands and use equal-price/solar windows. Repairs are
bounded and distributed across families and horizon days. The final selected
trajectory is projected afresh and its direct account rebuilt; witnessed edits are
confirmed against it within the reserved work. No unlimited loop to convergence.

Two sweeps describes construction, not total simulations. Preparation, branching,
explicit witness trials, repairs and final certification all consume the meter.
Recipe limits and the total grant are versioned; reserve final certification before
search. A bounded witness search reports trials and quota exhaustion. No finding
means no proof found, never proof of optimality or of an unavoidable interruption.

## Full causal rule mapping

| Rules | Construction and measurement |
| --- | --- |
| pool_low/pool_cold, ev_low/ev_short | Independent mild/severe forecast-state predicates with unchanged reachability/grace and exact stacked signs; model-derived service proposals. |
| pool_hot/pool_buffer | Strict temperature threshold and complete-day forecast price/solar comparison; justified thermal storage rather than a hardware cap. |
| cheap/cheapest_buy, dear/dearest_load | Strict forecast price tiers, actual projected flexible draw/source attribution, configured exclusions. |
| base_load_dear/dearest_import | Imported base attribution and remaining battery power/energy; preserve energy for useful dear demand. |
| missed_cheap_quarter | Exact any-store-below/no-flexible-draw predicate; useful charge/heat choices rather than purposeless cycles. |
| arbitrage_no_export/not_full | Permitted useful export and exact first-sale/last-preceding-charge preparation. |
| ev_from_home_battery | Exact post-household source attribution; joint choices rather than a blanket discharge prohibition. |
| pool_short_gap | A legal equal-energy joining alternative at the stated price tolerance, with each store's service and closing inventory preserved. |
| large_load_overlap | Proved EV/battery moves to distinct cheaper quarters with pool fixed; raw overlap is not a penalty. |
| export_before_import, battery_headroom_solar | Useful storage of surplus and making room before solar. |
| import_avoidable_by_storage, battery_price_spread, battery_preserve | Fund or retime useful charge/discharge pairs after losses/wear. |
| high_value_export, uneconomic_cycling | Permitted profitable sale or removal of a losing matched cycle. |
| pool_solar_preheat, pool_wait_for_sun, pool_cheaper_heating | Retained heat/run transfers after cooling/startup and independent service checks. |
| ev_timing | Native-quantized charging transfers with unchanged service and closing stock. |

Economic hits earn penalties only on wholly published-price changes. Separate
known-price and forecast working ledgers prevent known proofs from depending on
prior forecast edits. Forecast-only savings still produce candidate repairs and
are reported with published=false. There is primary
family assignment and unique changed-quarter accounting; forecast opportunities
can guide construction and are distinguished in evidence. Recorded future prices,
actual PV/load and hindsight never enter solve. The bench's existing perfect
outdoor-temperature convention is retained and labelled in fixture preparation.

## Synthesis decision

Base: GPT-6 Astra high's bounded joint-label builder. It represents competing
allocations through coupled physics, avoiding a hidden pool/EV/battery priority.
From Claude Opus high: purpose-bearing useful runs, fact-only prepared slots and
explicit full-catalogue mapping. Reject its necessary-condition gap/overlap mirrors
as scored penalties, unconditional device ordering/derating, new terminal credit,
and new approval checkpoints for priorities already authorized by the user.
Both independent candidates are retained as temporary artifacts outside the repo.

## Tradeoffs accepted

- We accept bounded pruning and approximate guidance in exchange for fast coupled
  construction; final physics and earned contributions remain exact.
- We accept bounded causal witness discovery in exchange for explicit predictable
  work and independent benchmark judgment.
- We accept a second rule implementation in Rust in exchange for an independent
  referee, protected by catalogue and synthetic parity tests.
- We accept no global-optimality or two-total-pass claim in exchange for measured
  quality/runtime rather than invented guarantees.

## Alternatives considered

Opus's run ledger is naturally continuous but fixes device allocation order and
scores necessary conditions as witnessed preferences. Those choices can suppress
valid shared-grid alternatives or invent penalties. More scalar swaps retain the
command-multiset restriction. Full joint DP/MILP expands state and runtime cost
before the bounded builder has been measured.

## Open questions and risks

The numerical frozen-subset 769 target is exceeded; full rollout qualification is
unproved. Future-price errors remain unavoidable causal/observed
score differences. Witness coverage and guidance can change winners; report their
sensitivity, bills/wear, service, and closing stores. Reject gains from needless
cycles or end heat. Historical cases lack pool hardware settings, so no universal
28/34 limit is inferred. Production episode anchors, model registry/background
publishers, delivery/refresh and UI removal remain separately gated by the approved
migration design. Hosted elapsed time does not establish whole-handler CPU, peak
memory or click-to-HA-to-browser completion.

## Next implementation step

Replace the old builder with ABI2 joint construction, then causal gap/block repairs
and economic transfers. Verify exact partial-quarter commands/physics, tiny native
choice cases, stacked/excluded rules, witness infeasible near-matches, catalogue
coverage and forecast-leak canaries. Rescore all11×288quarters under the unchanged
card, iterate structural defects, then deploy the identified candidate to the
already authorized private TEST lane and repeat hosted parity/timing. No customer
command is published by this qualification slice.

## Implementation refinements

Pruning uses model-based EV catch-up slack until each rule becomes eligible;
there is no horizon-wide early-progress reward. Battery inventory is valued
against chronological household demand before the next cheaper refill/solar
window, rather than assigning every stored kWh the peak future price. A 500 W
charging alternative spreads useful energy across genuine cheap opportunities;
it is still subject to future demand, capacity and exact coupled projection.
Self-consumption with EV off retains the physical discharge power limit, so an
ordinary base-load forecast error does not become a controller power ceiling.

Pool continuation can store heat against model-derived future cooling beyond
local comfort/buffer goals. Nonconflicting independent gap edits form one extra
batch candidate, which is reprojected and audited before adoption. They are not
assumed to compose. Rank values are cached and metered once per expansion;
parent history retains only the selected beam at each quarter. Every candidate
must have enough work reserved for the same complete bounded audit. A rejected
physical candidate is distinguished from a candidate declined for work, so
termination reports remain truthful.
