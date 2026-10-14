# Hot-water price selection

```ts
const native = core.solve(prepared.problem);
const selected = refineHotWater(core, prepared, native.selection);
// selected owns the problem, native trajectory and water policy together.
const priority = scenario(selected.input, selected.commands, selected.quarters);
```

The user requires price optimisation alongside measured high/low house-load
control, using selected pool, car and battery loads. There is no maximum pause.
The earlier pre-solve historical-device thresholds are superseded.

## Ownership and types

`hot-water-demand.ts` owns empirical electrical work: an economic eligibility
mask withholds work into its existing causal queue, then eligible low-load
quarters absorb it within each original service window. It derives thresholds
only over eligible quarters. Locked watts, permission and complete commands
remain exact. Outstanding forecast work remains visible.

`rules-hot-water-selection.ts` owns complete candidates containing a prepared problem,
water trajectory, native commands, quarters and economic account. Pool and EV
draw come from native transitions. Battery charging, discharge, grid purchases,
wear and final stored-energy credit come from exact native projection, never
historical forecasts. Thresholds retain the existing gross-house meter frame,
which excludes battery charging. Site-load levels include actual battery
charging minus discharge and are translated back to this meter frame. Each
candidate retains its site level while projecting and checking the corresponding
water permission against its actual battery flow. Unsettled proposals are declined.

Each candidate is projected before acceptance. Fixed pool/EV commands preserve
their states and rule points. Cash and wear are summed from the projection;
`endCredit()` supplies the same terminal valuation as Rust. Search may not
increase unresolved work in any service window to claim savings. This is a comparison of equivalent
electrical service, not a new hard delivery or temperature requirement.

Economic pauses publish the existing `permit_inhibit: false` command. Eligible
quarters publish `house_demand_permission`, which still reacts to measured load.
The published watts, commands, charts and battery contract share one candidate.

## Synthesis and tradeoffs

Use Claude's coordinated exact-projection candidate as the base and Codex's
complete-candidate ownership and terminal-credit accounting. Reuse existing
command types rather than adding another transport field. Reject full native
water state/actions for this change: they expand beam branching, native ABI,
opportunity estimation and work accounting before empirical electrical timing
has been validated. No thermal storage or hygiene assumptions are introduced.

Native admission uses an all-eligible causal water trajectory, with the load
level at the window maximum. This preserves its watts when thresholds are
rebased onto selected loads, providing a feasible coherent starting candidate.
A coherent valley policy establishes the load-control reference work when
available; its legitimate outstanding work remains visible. Valley and maximum
levels are ordinary policy candidates for each price mask. Permission changes
are fixed in causal prefix order and checked against their own battery flows.
A negative gross admission level publishes explicit inhibition.

Search shares 64 native projections across prefix certification, both policy
variants and both passes. The first pass may spend 32, leaving the remaining
projections for coordination. The counter never resets between passes.
Search is bounded coordinate refinement: remove/release runs of eligible
quarters, expensive starts first, accepting only exact economic improvements.
One subsequent native solve can respond to selected water timing, followed by
another complete water evaluation. Choose only candidates serving at least the
same empirical work. This trades global optimality for bounded work and native
physical accounting. CPU and replay regressions must validate that tradeoff.

The design is disproved if fixed native commands change pool/EV states when
water moves, accounting parity fails, useful cheaper timing cannot be found,
or the projection budget is too costly. Tests cover causal energy preservation,
selected-device thresholds, price pauses, stored-energy costs and commitments.

## Replay evidence

The supplied 288-quarter October replay now publishes explicit hot-water
inhibition at 08:30 Stockholm on 15 October: expected water draw falls from
1,226 W to zero and projected battery discharge there falls from 1,684.61 W to
458.61 W. Pool and car draw remain zero in that quarter. Across the new horizon,
5.603788 kWh is forecast served and 0.1009125 kWh remains visibly outstanding
under load control. Economic search cannot increase that per-window backlog to
claim savings. The old replay's issue-clock treatment also differs in its first
partial quarter, so these are diagnostic trajectories, not matched savings.

Native-account parity, a zero-import morning supplied by stored battery energy,
negative threshold translation, failed search proposals, historical pool/EV
invariance and first-hour commitments have regression coverage. The generated
producer/consumer fixture includes both economic inhibition at low household
load and the measured-load policy. The HA controller test executes inhibition
at zero house load, then checks permission and shedding after the price pause.

Local elapsed measurements are diagnostics, not hosted CPU or tank-temperature
availability guarantees. The native ABI and HA command contract are unchanged.

## Complete-worker CPU regression

The original mask counter did not bound complete refinement work. On the
288-quarter October input, one water device with four service windows caused
405 native projections plus two full solves. The complete cold handler used
2,068 ms of local process CPU, despite a 1,560 ms elapsed measurement. A native
solve's deterministic work bound and the old native-only hosted probe did not
cover this JavaScript refinement and materialization work.

The shared projection budget reduces that input to 64 projections and two
solves. The complete cold handler used 971 ms local process CPU; the selected
score differs by approximately 0.0022 SEK across the 72-hour horizon. Every
published candidate still has an exact native projection and preserves the
per-service electrical-work comparison.

`deno task test:planner-handler-cpu` runs the complete cold handler, including
Wasm initialization, hot-water search, baseline, materialization and JSON,
with a 1,500 ms process-CPU gate. CI runs it separately from parallel unit
tests. A deterministic regression also counts projections and coordination
solves on the anonymized full-horizon input, independently of machine speed.
The private TEST probe's handler mode executes this same complete path without
database, publication or HA access. `deno task probe:planner-handler` checks
three hosted executions and exact output-digest parity. TEST planner deployments
run this qualification before deploying planning executors and callers.

Original implementation validation: 1,805 Deno tests passed; 1,144 HA tests passed; the frontend
build and all four mocked-backend E2E suites passed (70 passed, one existing
skip). Root lint passed with zero errors and 27 existing warnings. A final local
replay with the other suites stopped took 1.529 seconds of elapsed time. That
measurement did not bound complete-handler process CPU.

CPU-budget change validation: 1,807 Deno tests passed; the complete cold-handler
CPU gate passed at 971 ms; frontend build and typecheck passed; all four local
Playwright suites passed (70 tests, one existing skip). Root lint reports zero
errors and 27 existing warnings. Hosted qualification requires deployment of
the updated private TEST probe; these local figures are not hosted CPU readings.
