# ROI regression audit, 21 October 2026

The reported failures had separate causes. The deployed commit `89d39a5`
contained them, but was not their common introduction.

## Forced battery commands in historical replay

`30586d4` tightened native certification of committed battery allocations and
updated live publication to retain the executable allocation. Historical ROI
replay still retained the command's original power ceiling. After battery state
or available power changed, the next solve could therefore reject its own
committed prefix with `native_battery_power_limit`.

`86d346e` shares allocation sizing between publication and historical replay.
The replay protocol changes so saved results cannot mask the correction. Native
regressions cover forced charging/export, remaining energy and the reported
February timestamp, including the fourth committed quarter.

## Browser workers

The affected TEST tab requested an obsolete hashed worker asset and received a
404 HTML response. The browser exposed no worker error message, so every month
displayed the generic `Default model worker failed`. Reloading loaded the current
asset and exposed a second problem: DevTools paused before a possible
out-of-memory crash while instantiating projection memory.

The original monthly baseline worker (`9e8f3f6`) used the live planner adapter,
which creates a private Wasm instance for every call. A month performs thousands
of synchronous projections, including EV load-balancing trials. Native memory
reclamation then depends on browser GC keeping pace. Short calculations and
small-equipment mocks did not reliably expose this lifetime mismatch.

The replay-specific factory retains one projection instance per monthly worker;
optimizer solves still get fresh instances. Native projection state comes
entirely from each input. Allocation/free, output parsing and coverage checks
remain shared. A thrown projection error permanently invalidates that replay
instance; there is no retry or replacement. Worker termination ends its lifetime.
Empty worker errors now give explicit reload guidance.

Regression coverage includes 10,000 real native projections with changing
battery, EV and delayed pool states; comparison with isolated reference calls;
memory plateau; separate replay ownership; fresh optimizer solves; native failed
outcomes; and trap poisoning. A real browser test runs a 31-day month with normal
equipment sizes under a finite Wasm instance budget. Another test serves a 404
worker asset and checks the reload message without automatic retries.

## Saved totals and environment data

Saved report identity previously included the Wasm digest but omitted its host
source digest. A TypeScript physics/input change could leave the binary unchanged
and reuse stale totals. Report identity now includes both digests.

The scoped environment audit found recovered history, reconstructed solar and a
pool seed in TEST, absent from production. The earlier import work explicitly
targeted TEST. This supports an environment-data difference, not a finding that
production data was deleted. CI promotes code and migrations; it does not promote
per-home imported history or modeling inputs. Before publishing a report in
another environment, verify those inputs and their coverage there. Successful
arithmetic alone does not establish that the modeled inputs are complete.
