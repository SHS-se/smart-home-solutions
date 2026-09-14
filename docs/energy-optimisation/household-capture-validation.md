# Captured household plan validation

14 September 2026 — step 2 continuation. The offline household scorer still
requires a fully resolved problem. The existing portal captures provide a useful,
narrower check of shipping forecast accounting before constructing those cases.

## Reproduce

```sh
deno run --allow-read scripts/audit-quarter-replay.ts /absolute/path/to/plan-replay.json
```

Multiple paths produce one JSON report per file. Exit status is nonzero if any
capture is invalid or any accounting check fails. This command accepts the current
`shs-energy-optimisation-quarter-replay` format version 2 with snapshot/plan schema
8 and a battery. Other versions and batteryless captures reject explicitly.
It only reads JSON; it never executes the capsule's entrypoint, contacts HA or
regenerates the plan using today's planner implementation.

`scripts/lib/quarter-replay-audit.ts` owns the validated projection and pure audit;
the CLI only handles files and exit status. Known accounting fields are required;
unrelated history, entity bindings and diagnostics are ignored. The report is
not a complete schema-8 contract validator. No production planner or scorer
ownership changes are involved.

## What a pass establishes

For every captured scenario and interval, the audit checks:

- Snapshot identity, battery/grid inputs and plan invocation time agree.
- Quarters are contiguous and the first interval uses the time remaining after
  plan issue, not an assumed full 15 minutes.
- PV, battery, grid, curtailment and served load balance. Unserved forecast demand
  fails even when the electrical equation balances.
- Device inventory and base/device/service load accounting agree, without adding
  service consumption twice when a device already represents it.
- Battery evolution agrees both between adjacent reported states and cumulatively
  from the initial state. This catches clamping and accumulated rounding drift.
  States, power limits, direction and battery export allocation are checked.
- Published interval purchases and export revenue agree with power × duration ×
  price, including negative prices. Nonbinding intervals have no billable costs.
- Reported energy, priced energy, bill and battery state summaries reconcile.

Tolerances propagate the shipping serialization precision: power to two decimal
places, SOC to six, interval costs to five and aggregate energy/cost to three.
They are not a percentage allowance for unexplained errors. Reconstructed bill
uses published prices only; shadow prices do not become a bill.

Passing does **not** establish that the captured forecast is accurate, the
battery command is executable or source permissions are obeyed, thermal service
is achieved, or the new whole-household objective prefers that candidate. Native
response, command semantics, wear, utility, shaping and terminal value are outside
this audit. The report has no rankable household objective.

## Captured evidence

Five existing local replay files issued on 14 September were checked. Each has
288 intervals in three scenarios: **15 scenario traces and 4,320 intervals passed**.
These are captured predictions, not measured device traces or 15 independent
physical experiments. Raw household captures remain outside the repository.
The regression tests use clearly synthetic inputs.

| Plan issue time (UTC) | Captured model | Accounting result |
| --- | --- | --- |
| 06:33:08.255 | marginal-value-planner-v31 | All three scenarios passed |
| 09:49:02.892 | marginal-value-planner-v32 | All three scenarios passed |
| 10:47:06.876 | marginal-value-planner-v32 | All three scenarios passed |
| 12:20:42.430 | marginal-value-planner-v32 | All three scenarios passed |
| 13:34:40.294 | marginal-value-planner-v33 | All three scenarios passed |

In the latest capture, the cost scenario reconstructs 97.513 kWh demand,
43.563 kWh import and 1.019 kWh export over 71.922 hours. The reported 31.076 SEK
bill covers only the 32.422 hours with published prices: 25.094 kWh of that import
is priced. It is not a priced 72-hour bill. In this capture the three scenario
flow traces coincide; their agreement does not prove an optimisation benefit.

## What remains before a resolved captured case can be scored

The sampled snapshots have no resolved pool model and no thermal-zone models.
This says what these captures contain, not whether the house has other heating
systems. Device load forecasts alone do not supply thermal states or utility.

The next modelling slice must explicitly resolve:

1. Thermal state, capacity, losses, withdrawals, COP and service utility on one
   common horizon, with model identity and calibration evidence.
2. Shared heat-source routes and native transitions, including the response when
   demand switches between services. Manufacturer capability and installation
   topology remain separate from an individual household's configuration.
3. Source allocations, equipment wear, dated service events and terminal coverage
   for the scorer's economic ledger.
4. A reconciled actuals watermark and provenance. A snapshot capture timestamp is
   not automatically that watermark.

Do not fabricate those inputs from predicted watts, the house's 60/20-minute
priority periods or a missing-model default. General model work can continue
with explicit synthetic cases; a captured whole-household score remains pending
until the corresponding resolved inputs exist. Battery remains the first live
controller delivery, followed by pool and EV.

See [offline scorer](household-scorer.md) and
[separate household notes](reference-installations/phils-house.md).
