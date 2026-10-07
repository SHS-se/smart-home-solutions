# Rule builder checkpoint — 7 October 2026

The new Rust/Wasm rule builder scores **1,110 versus 569 (+541)** on the same 11
frozen cases and unchanged independent planner-bench rules. All 3,168 quarters
were scored; 267 have multiple triggers and 116 net-zero quarters retain their
opposing rule contributions. There are no physical violations or required-rule
failures. This is the pool/EV/battery diagnostic lane, not a production switch.

## What changed

The old profile constructor and scalar pair swaps have been replaced by a reverse
opportunity index, bounded forward joint-command construction, feasible witness
audits and whole-span repairs. All 19 quarter rules and 11 economic families have
explicit mappings. Input carries facts and rule metadata; ranks, day comparisons,
service eligibility and complete contributions belong to policy. Pure native
device models remain independent. There are no cost-value curves in this engine.

The design combines GPT-6 Astra at high effort with an independent Claude Opus
high-effort candidate. The selected shape and refinements are documented in
[the design](rule-builder-design-2026-10.md).

The exact accepted next hour survives every solve, including an intersecting
partial quarter. Fresh state is projected only from capture onward. Missing or
partial commitments fail explicitly. The solver has no database/history/source
fetch or forecast-fitting dependencies and no old-engine fallback. The prepared
price forecast uses only causal prehistory/published prices outside solve. Recorded
future prices and actual load/PV never reach it; the bench's shared perfect-weather
convention remains explicit.

## Frozen comparison

| Case | Baseline | Builder | Change |
| --- | ---: | ---: | ---: |
| C-0616 | 57 | 109 | +52 |
| C-0627 | 65 | 105 | +40 |
| C-0717 | -9 | 113 | +122 |
| C-0905 | -35 | -69 | -34 |
| C-0919 | 64 | 194 | +130 |
| C-0920 | 87 | 212 | +125 |
| C-0924 | 40 | 16 | -24 |
| C-0927 | 77 | 97 | +20 |
| C-0928a | 85 | 87 | +2 |
| C-0928b | 71 | 76 | +5 |
| C-1005 | 67 | 170 | +103 |
| Total |569 |1,110 |+541 |

Observed quarter rules contribute 1,260 and published economic findings subtract 150.
The internal causal account is 1,631; forecast and recorded-world accounts are
reported separately, not asserted equal. The independent referee, thresholds,
weights, opportunity quota and historical fixtures were not changed.

## Runtime and reproducibility

The deployed private TEST endpoint ran each approved fixture twice. **All 22 cold
runs match the local selection exactly**: commands, physical quarters, additive
accounts, economic evidence, run records and work usage. Native Rust and Wasm
also agree on both synthetic/committed-prefix reference cases.

| Measurement | Result |
| --- | --- |
| Local solve, per case |32–134 ms |
| Local solve, all 11 |771 ms, versus 110.918 s for baseline |
| Hosted solve,22 samples |93–292 ms |
| Client request, including response decode |282–1,575 ms |
| Hosted cold module initialization |34–58 ms |
| Hosted handler before response encoding |134–359 ms |
| Wasm instance high-water memory |2.38–3.31 MiB |
| Binary |412,475 bytes |
| Input/output JSON |49–52 KB /126–129 KB |

CPU and total isolate memory remain unmeasured; these are elapsed-time and Wasm
heap observations. Fleet contention,20–30 active model owners and full
click-to-HA-to-browser completion are not qualified by these sequential calls.
The private endpoint cannot publish a plan or issue a device command.

The frozen recipe is width 32, at most 32 retained joint actions per label,
4 finalists,96 witness trials per audit and8 individual repair proposals plus
one nonconflicting gap batch, under 900 million counted work units. Maximum
observed work is 458,690,074; all cases report bounded_complete. Rank calculations,
action generation, model transitions, audit enumeration and proof trials are
metered. Every admitted candidate gets the same audit allocation, and final
projection/account certification is reserved before construction. Bounded witness
coverage reports exhaustion; no finding is not a proof of optimality.

Binary SHA-256: `5315d7a60cde33069c72a8ff80285053b2087a169d211222dcac8021cb1ae7a0`.
Candidate: `wasm-v2:8aa3dc89eec8fc07de3afbeedfa0a9793712ca1443c8b34ffac7d6a07d235c55`.
Private household reports remain ignored local files:
`reports/planner-wasm/rule-builder-final.json` and
`reports/planner-wasm/rule-builder-hosted.json`.

## Actual tradeoffs and outstanding qualification

Electricity cost rises from 1,586.72 to 1,911.09 SEK, **20.4%**. Pool electrical
energy rises 811.14→944.76kWh as more thermal buffering earns its configured
rewards; battery charging rises 480.88→561.27kWh. EV charging falls 66.41→28.29kWh.
Some cars finish near 312 km against a 360 km target because the current card permits
up to 50 km shortfall. Closing pool warmth is generally higher and battery inventory
is often lower. The score gain is not a claim of cheaper electricity or identical
service. C-0905 and C-0924 regress individually despite the aggregate gain.

The independent economic audit reaches its existing 2,500-trial limit on five
cases. Those cards retain their existing result and limitReached evidence; zero
findings there do not certify optimal timing. Rust witnesses are also bounded.
Forecast-only profitable repairs are proposed and reported with published=false,
but never earn published-price economic penalties. Known and forecast working
ledgers are distinct, with a mixed-ledger regression test.

The full production redesign remains gated on supported owners/permissions and
bookings, model/forecast publishing, actual pool hardware settings, no-history
capture, durable HA acceptance, automatic/manual pipeline parity, event refresh,
and the approved curve/editor removal. The numerical diagnostic target is exceeded;
anti-waste/holdout and whole-path qualification are not silently declared complete.
Production `main` and its planning behavior are unchanged.

## Validation

Full `deno task test`: **1,657 passed**. Rust: 7 policy/witness tests plus 1 model
test passed; rustfmt and Clippy with warnings denied passed. Native/Wasm parity,
Deno typechecks and regenerated HA consumer fixture passed; the generated fixture
is unchanged. `npm run lint`:0 errors, 27 pre-existing warnings. `npm run build:test`
passed with the existing bundle-size warning. `npm run test:e2e:local`: **67 passed**
across all four mocked-backend suites.
