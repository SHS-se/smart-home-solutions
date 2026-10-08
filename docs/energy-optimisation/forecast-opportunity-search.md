# Forecast opportunity search — 8 October 2026

The planner compares loading now with what can be achieved in later forecast
quarters before pruning its construction beam. The objective remains total
additive rule points, then grid cost plus declared wear. Scoring rules, comfort
grace, physical models and the independent benchmark referee are unchanged.
Recipe `rule-forecast-opportunity-v3` retains the 900-million work grant, beam
width 32, action limit 32, four finalists and existing witness/repair quotas.

## Search shape

```rust
let index = policy::index(problem, work)?;
let opportunity = Opportunity::prepare(problem, &index, work)?;
let proposals = construct(problem, &index, &opportunity, work)?;
// Existing full witness audits, repairs, move/resize and final certification.
```

`opportunity.rs` owns immutable backward continuation tables for each present
device. A table indexes quarter, inventory and heater startup/rest phase, storing
estimated remaining points and cash plus wear. It uses the existing native
`physics::step` and the same direct rule predicates as the final account. Zero
terminal values introduce no inventory credit. Prices, solar after base demand,
EV availability, initial SOC/temperature, loss, thermostat settings and startup
response affect the continuation value.

Inventory axes include initial readings and rule boundaries. Interpolation and
bounded heater-age samples are proposal guidance; actual beam states retain
exact readings, temperatures, SOC, startup ages and policy histories. Measurements
outside targets remain usable. No new validity constraint, forecast gate or
first-quarter prohibition is introduced. The table owner reduces accepted
commands to each device; joint construction and certification still preserve
all accepted commands exactly, including the partial first quarter.

Tables relax shared power and solar competition and can count future tariff
potential separately for devices. These estimates never earn final points.
Coupled native projection decides whether the joint commands fit one grid limit
and one solar surplus, and final accounting rewards each quarter once. Buffer
and last-charge preparation histories are not represented as inventory-only
credit: existing episode-aware buffer guidance and actual direct scoring retain
those responsibilities. Economic and avoidable-overlap findings remain full
bounded witness audits.

Construction ranks accrued points plus continuation points, followed by accrued
cash/wear plus continuation cost. It no longer values pool warmth in proportion
to an arbitrary share of all future comfort points, or prices battery inventory
through a separate chronological curve. Joint inventory/startup cells keep
proposal diversity without asserting physical equivalence. Whole pool/current
action groups survive action limiting, so battery variants cannot erase maximum
EV current. Finalist selection prefers distinct device run profiles before
siblings. Cheap pool heating below the scoring reserve can be proposed above the
comfort target; the existing overheating predicate and complete score decide
whether it wins.

Table allocation and transition work enter the grant precheck and deterministic
meter. Existing certification reservations and complete audit allocations remain
in force. The search stays bounded, not globally optimal.

## Architecture decision

Read-only Codex and Claude Opus High reviews compared complete forecast-first
seed allocation with backward device value tables. The tables are the base:
they replace the defective time-independent inventory value while retaining the
existing joint action generator and physical/scoring owners. Codex's emphasis
on waiting alternatives, urgency and distinct complete comparisons informs beam
retention and tests. A separate merit-order allocator was rejected because heat
loss/startup would require another command-construction policy. Full suffix
rollouts for every expanded label exceed the existing work budget. A recovery-
debt-only heuristic is smaller but cannot directly compare future price and
solar opportunities.

## Fresh same-input benchmark

Baseline: kernel at `c31f09e`, not older stored bench scores. Both runs use the
same eleven locally captured cases, unchanged default criteria, current household
startup response and work grant. The local case copies receive the already
specified case-v2 `off_unobserved` conversion from `bench/schema.sql`; no forecasts,
comfort settings or recorded outcomes are changed between runs. The independent
referee scores the recorded world, while search receives causal forecasts only.

| Case | Baseline | Forecast search | Change |
| --- | ---: | ---: | ---: |
| C-0616 | 56 | 75 | +19 |
| C-0627 | 26 | 86 | +60 |
| C-0717 | 7 | 46 | +39 |
| C-0905 | 11 | 6 | -5 |
| C-0919 | 88 | 89 | +1 |
| C-0920 | 76 | 82 | +6 |
| C-0924 | 42 | 70 | +28 |
| C-0927 | 85 | 75 | -10 |
| C-0928a | 14 | 57 | +43 |
| C-0928b | 63 | 42 | -21 |
| C-1005 | 76 | 83 | +7 |
| Total | 544 | 711 | +167 |

Eight cases improve; three regress. The aggregate gain is 30.7%, not a claim that
every case improves. All eleven have zero physical violations and zero required
rule failures. Pool starts in quarter zero fall from ten cases to two; both
remaining openings score as cheap. Grid battery charging starts in quarter zero
fall from seven to five. The opening pool/EV stack disappears. Summed net grid
cost falls from 1,675.62 to 1,323.75 SEK; this is the benchmark's net-cost
measurement, not a promise about real bills or equal terminal inventory.

In the controlled 72-hour expensive-opening fixture, the pool can safely coast
into later cheap electricity and solar. Heating moves from quarter zero to
quarter 34 (8.5 hours), and native points improve from 70 to 105. A cheap-opening
control still charges the car immediately. An exhaustive 12-quarter pool oracle
checks all 4,096 command schedules with complete native audits for expensive,
cheap, urgent and accepted-prefix variants; search matches the best points and
cash in each. Separate regressions cover retained maximum EV current, surplus
solar after base consumption, shared grid/solar competition and single quarter
credit. The larger regression is also included in native/Wasm parity.

Local solve median rises from about 186 to 324 ms; the observed maximum rises
from 236 to 406 ms. Peak Wasm instance memory rises from 9.0 to 13.3 MiB. These
are local elapsed time and instance high-water diagnostics, not hosted CPU,
whole-handler memory or end-to-end qualification. All eleven still report grant
exhaustion; forecast guidance improves bounded search, not proof of optimality.
Private full reports remain outside the repository.

## Validation

- Rust formatting and strict Clippy passed; 24 Rust tests passed.
- Exact native/Wasm parity passed, including the forecast regression.
- Independent-checkout Wasm/source-manifest reproducibility passed.
- Generated HA fixtures are included; full Deno suite passed 1,671 tests.
- Repository lint passed with zero errors and 27 existing warnings.
- Typecheck and `npm run build:test` passed; the build retains its chunk-size warning.
- `npm run test:e2e:local` passed all 62 tests across the four mocked-backend suites.
- A final isolated eleven-case replay reproduced exactly the same commands,
  work diagnostics and scores, with no physical or required-rule failures.

These are local qualification results; no deployment or live-device test is
claimed by this change.
