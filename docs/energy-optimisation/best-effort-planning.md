# Best-effort planning and native ownership

The implementation of the 15 October 2026 continuity requirement uses one
`PlanningWarning` contract (`code`, `scope`, `severity`, `message`, `consequence`,
optional evidence/entity). Plans carry these warnings to the portal; HA merges
local, exchange, plan and battery-accounting warnings into diagnostic attention.
Warnings never become missing configuration fields or a planning admission gate.
They disappear when a new usable observation or plan replaces their evidence.

`actual-upload.ts` accepts usable rows independently. Thermal, pool and price
history follow the same exchange policy: unusable history is ignored and logged,
not allowed to reject an otherwise useful planning request. Statistical fitting
keeps mathematically usable parameters with quality warnings, and failed attempts
cannot overwrite the last successful room or pool parameters. Empirical room and
pool services retain known control intent while disclosing unavailable temperature
projections. An explicit pool permission remains independent of expected watts.

`homes.address_text` owns installation location. `energy_home_locations` caches
only its geocoded coordinates. Prepared forecasts include that location and are
rebuilt after an address edit. Provider coordinates describe received PV evidence;
no code rewrites that evidence or uses it as a competing location authority.

`run-rules-planner.ts` adapts local callers to the production native engine.
The auction implementation and continuation protocol are removed, including the
executable historical TypeScript benchmark path. Independent household scoring,
ROI simulation and physical models remain. Native regression tests cover exact
fixed requests, partial quarters, real commitment coverage, changed control types,
physical balance, absent equipment, empirical services and shared room headroom.

The integration's scheduled device executor no longer executes battery policy.
The durable native battery runtime, gateway and writer fence own it exclusively.
Retired executor tests were replaced by native runtime/gateway/continuity coverage;
shared audit and scheduler tests exercise EV/pool operations. Verification's
handover and no-write guarantees are preserved, including verifying a pool while
a real native battery group remains owned and unchanged.

Configured devices stay in the snapshot before their first measured cycle. Unknown
boiler running power is represented as `null`, not a required setup field or a
fabricated hardware rating. Daily permission scheduling remains active; its
uncertain demand estimate is reported separately. A current power reading supplies
capacity, not an invented all-day duty cycle.

Fresh and cached forecast preparation replace only forecast-owned fields. Current
measurements and resolved website settings stay authoritative across both paths.
Missing economic battery wear metadata uses the shipped cost with a visible
warning; it cannot stop an otherwise usable household plan.
