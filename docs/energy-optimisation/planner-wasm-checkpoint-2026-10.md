# First Rust/Wasm qualification checkpoint — 2026-10-07

This is the first nonpublishing prototype from the approved design, not a
production replacement. Rust 1.99.0, Cargo, rustfmt, Clippy and the Wasm target
are installed and pinned. The existing production planner and UI remain active.
The 769-point quality gate and complete replanning-path qualification remain unmet.

## Frozen candidate and independent scorecard

- Candidate: `wasm-v1:f20a65ad2df844e93dafac1938c403eb90d0f81c4da75060166cb905bbd638be`.
- Wasm SHA-256: `324b21f0cb151fbf6485df2600f7e28e117babdac786f44684e91c3055b66017`.
- Source SHA-256: `d3812569d73387ff839b5a58239574b8157c6e58cc8cc7693872fd859d064efb`.
- Input export SHA-256: `43090a02913f61f711cd5c22ad1d53b98368361da943c0a06da428b52081e87d`.
- Independent referee 11, scorer 23, opportunity audit 10; original criterion overrides retained.
- Recipe: coupled-profile-pair-v1, 120,000,000 deterministic work units, eight maximum passes. A work unit is an accounting weight, not a CPU nanosecond.
- All 11 cases × 288 quarters were scored. Their full contribution cards are
  retained in the local report, including 76 zero-score quarters with triggers.
- No physical violations or required-rule failures were reported by this suite.
  This subset does not qualify all future physical owners or production readiness.

| Case | Current baseline | Prototype | Change |
| --- | ---: | ---: | ---: |
| C-0616 | 57 | 28 | -29 |
| C-0627 | 65 | 50 | -15 |
| C-0717 | -9 | -9 | +0 |
| C-0905 | -35 | -35 | +0 |
| C-0919 | 64 | 47 | -17 |
| C-0920 | 87 | 59 | -28 |
| C-0924 | 40 | 0 | -40 |
| C-0927 | 77 | 56 | -21 |
| C-0928a | 85 | 35 | -50 |
| C-0928b | 71 | -9 | -80 |
| C-1005 | 67 | 59 | -8 |
| **Total** | **569** | **281** | **−288** |

The largest search defects are visible in the stacked cards: 199
pool short-gap triggers, 158 missed-cheap-quarter triggers,
49 large-load-overlap triggers and 9
EV short-gap triggers. Sixteen direct rules are mapped into the solver; the three
feasibility-witness rules remain independent referee checks. Closing inventory,
episode repair and coordinated neighborhood search are unfinished. The card is
unchanged; these losses must be fixed in policy/search rather than hidden.

## Architecture review of the quality gap

GPT-6 Astra at high effort reviewed every quarter card and the causal solver
account. Its decomposition explains why more pair-swap work is insufficient:

| Component | Points |
| --- | ---: |
| Internal direct-rule account using ready forecasts | 978 |
| Same 16 rules under observed outcomes | 699 |
| Pool/EV short gaps and avoidable overlap | −257 |
| Independent economic opportunity audit | −161 |
| Final independent score | **281** |

Of the 279-point internal/observed difference, 252 points occur on unpublished-price
quarters and 27 on published quarters. Forecast errors cannot be removed by
feeding recorded future data into the solver. There are 181 quarters with multiple
triggers, including 45 with buffer reward and missed-cheap penalties and 46 with
cheap-load reward and avoidable overlap.

The prototype produces 195 isolated one-quarter pool runs; the baseline has zero
pool-gap penalties. Pair swaps preserve the seed's command multiset, cannot resize
runs and reject equal-price consolidation or solar-covered moves with higher
nominal import prices. Chronological search exhausts the grant before fair repeated
coverage of the horizon. Simply adding individual command changes would expose
more choices, but the current account would still reject many beneficial run repairs.

The next bounded ablations should introduce rule-derived service/buffer profiles,
legal command insertion/removal and fair horizon coverage, then causal feasible
short-gap measurements and joint run/block repairs. Each candidate must retain
whole-plan physical/account acceptance and the exact locked prefix. Continuity is
a scored preference, not an invented hard minimum run. Useful closing inventory
must prevent last-day energy purchases without a service/reserve justification.
The 418 omitted penalty points are diagnostic headroom, not a promised gain; even
eliminating them unchanged would only yield 699, below the 769 gate.

## Hosted TEST measurements

The user authorized deployment and frozen-case uploads to private TEST project
`vxqpgbzseckgceopitpm`. The endpoint has no database, publication or device-command
API and rejects production. Bearer authentication is checked in the handler.

All 22 sequential hosted runs (two per case) exactly matched local
commands, physical trajectories, accounts and work usage at this frozen recipe.
Every response reported cold initialization; a second request did not establish
warm reuse. Hosted observations:

- Solve elapsed: 169.9–256.0 ms.
- Cold decode/hash/compile elapsed: 24.6–38.9 ms.
- Handler elapsed before response encoding: 201.7–304.8 ms.
- Complete client request: 338.2–521.9 ms.
- Wasm instance high-water memory: 1,638,400 bytes in every run. This excludes
  JavaScript, compiler and whole-isolate memory.

These are elapsed measurements, not platform CPU readings. Whole-handler CPU,
whole-isolate peak memory, warm reuse, simultaneous price-release load, additional
device models and click-to-HA-to-browser completion are unmeasured. Local timings
were collected concurrently with repository tests, so they are not a paired speedup
comparison with the old planner. A previous offline 12-million-unit recipe scored
105; raising the grant to 120 million improved it to 281, exposing search sensitivity.

Hosted testing caught Supabase's wrapped public WebAssembly Memory constructor.
The ABI now validates exported memory by its native brand and buffer, and a host
constructor regression test covers this. Review also caught partial-quarter
integration: capture five minutes into a quarter now projects only the remaining
ten minutes while retaining the original native-command interval for locking.
Numerical tests cover heat, charge, startup age and cost, not only command equality.

## Reproduction and artifacts

See [the Rust setup and commands](../../planner-core/README.md) and
[the approved migration sequence](planner-scorecard-redesign-2026-10.md).
Full reports are ignored local artifacts containing household forecasts and
trajectories; they are not committed:

- `reports/planner-wasm/final.json`, SHA-256 `6d156c600b62eed79839292c9a7e387c45f9bdafbe2b30d42f3931c655b97a75`.
- `reports/planner-wasm/hosted.json`, SHA-256 `cf87a8e90b5ae8f85d546cff9248590a3a4aae41093eca9b6322e9cac2ddbd7d`.

The next step is a complete causal mapping of witnesses and episode repair, then
rescore the same frozen cases and remeasure the identified deployed candidate.
No production migration or UI removal is justified by this checkpoint.

## Validation at this checkpoint

- Full `deno task test`: 1,655 passed, zero failed.
- Rust fmt, Clippy with warnings denied, unit tests and exact native/Wasm parity passed.
- Frontend lint passed with zero errors and 27 existing warnings; typecheck passed.
- TEST frontend build passed; all 67 mocked-backend Playwright tests passed.
- HA contract fixture regeneration passed and produced no fixture change.
- Isolated Edge dependency resolution passed, including the new TEST-only probe.

No implementation, test or scoring change replaces the production engine in this
commit. The only existing scorecard edit is a type annotation needed by strict
null checking; its runtime behavior and rule weights are unchanged.
