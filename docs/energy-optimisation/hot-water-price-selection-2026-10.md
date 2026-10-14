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

Search uses 64 mask proposals per pass and bounded prefix certification.
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

Final validation: 1,805 Deno tests passed; 1,144 HA tests passed; the frontend
build and all four mocked-backend E2E suites passed (70 passed, one existing
skip). Root lint passed with zero errors and 27 existing warnings. A final local
replay with the other suites stopped took 1.529 seconds.
