# Readiness and automatic replan error policy

Settled implementation, 24 October 2026. Supersedes any generic “error or recovery means replan” rule.

Superseded in part on 30 October 2026: the car is protected by a safety floor (30 % by default, capped at the car's own charge limit) instead of range bands, and its grace runs from the plug-in time the integration records and keeps across restarts. No replan renews that clock: a new plan reads the same plug-in time. There is still no departure time or trip deadline. The car's own charge limit is the top of what it is charged to, and a physical cap. Energy up to the middle of floor and limit is valued at the plan's 75th-percentile import price, the rest at its 25th (`car-policy.ts`, `end-credit.ts`). The accepted first-hour command lock still applies unless owner-scoped execution evidence permits a correction. The independent bench uses the same rule under scorer version 42, counting the car as plugged in at the start of each case.

## Admission thresholds

All comparisons use current received observations. Available, unchanged readings never expire because of their report timestamp.

| Evidence | Automatic replan condition | Clearing and repeat behavior |
|---|---|---|
| EV disconnected | Accepted charging is due now and the car cannot charge because disconnected | Immediate. Idle unplug/replug creates no episode or replan. |
| Actual actuator or dispatched-command failure | A required actuator is unavailable or an actually dispatched scheduled command fails | Immediate, once per physical episode. Configuration errors and generic exceptions do not count. |
| Required observation unavailable | The specific source has continuously reported unknown/unavailable for 15 minutes and prevents accepted work | Five-minute status attention remains; hold the last setting throughout. Each source has its own clock. Usable recovery only replans service previously suppressed by an admitted physical failure. |
| Battery energy shortfall | At least 0.200 kWh cannot be delivered to an accepted stored-energy objective with its remaining nominal and authorized recovery capacity, continuously for 2 minutes | Clear below 0.100 kWh for 2 minutes. Exact shortfall remains diagnostic below the threshold. |
| Pool model shortfall | Measured water is at least 0.5°C below the accepted water-temperature trajectory at the same instant, continuously for 30 minutes | Clear below 0.25°C for 5 minutes. A pool merely below the desired comfort target is not a model error. |

Battery quantities use integer mWh; pool residuals are rounded to 0.001°C before threshold comparison. Stale reference samples cannot admit a correction against a replacement. Crossings at the stated magnitude and duration count; values below the entry threshold interrupt an unadmitted crossing. Missing evidence interrupts persistence instead of proving either continued error or recovery. A clock rollback cannot mature a timer early. Numeric admission latches once per accepted reference until the clear band is sustained; a replacement reference starts comparison against its own measured trajectory. Source outage episodes survive reference changes and restarts until usable observations return. Failed submissions retain immutable admitted evidence for the existing delivery retry owner.

## Ownership and execution

`shs_core/replan_policy.py` is the single admission-policy owner in both HA and the bundled app. The household serializes its durable signal map under the existing exchange lock. The normal five-second battery observation path and read-only controller observation timer feed it; controller threshold deadlines only request fresh observations.

Exact battery accounting, nominal instructions, authorized recovery recipes and physical admission remain independent of these tolerances. No threshold grants extra energy, makes missing evidence usable, releases control, stops a device or writes a default. The existing control-continuity contract is unchanged.

Actual physical failures use `faulted`/`temporarily_absent` with genuine blocked intervals and can affect `execution_availability`. A model miss uses a separate `plan_deviation` request with affected intervals, numeric magnitude and observed persistence. It releases only that owner's accepted commands for correction. It never enters physical availability, so a healthy heater or battery remains usable in the replacement. Other owners keep their accepted next-hour requests.

Capture producers, backend readers and strict API schemas roll forward together. There is no compatibility parser. Historical observations and old score identities remain evidence, not current instructions.

## Regression evidence

The retained overnight physical problem previously scheduled zero overnight EV energy and its first charge the following evening. Continuous readiness schedules the first charge at 23:45 Stockholm, immediately after the preserved accepted-command hour, and buys 13.8 kWh overnight: projected SOC rises from 48% to approximately 64.1%. That satisfies the existing readiness band; the 80% vehicle cap is not an unconditional completion target.

Tests cover exact magnitude/time boundaries, interrupted crossings, clearing hysteresis, clock rollback, persisted restart state, multiple unavailable sources, a five-second pool blip, small recorded battery errors, sustained battery/pool errors, failed delivery and healthy equipment remaining available during scoped correction. Existing continuity tests remain unchanged.


## Forced-replan audit

Every execution correction and explicit request is recorded separately from its current pending-work journal. Clearing an error, recovery, accepting a request or replacing a plan cannot erase its audit reason. The recent local history retains 100 requests in `forced_replanning`, including immutable owner/cause/interval/magnitude/persistence evidence, reference plan, request identity, snapshot/job/resulting-plan identities, timestamped transitions and error details. It is persisted across restarts, included in controller diagnostic downloads under `current.readiness.forced_replanning`, and written to the app/core log at INFO level. Diagnostic retention never trims operational evidence or pending delivery.

A requested capture is not a completed replan. The history distinguishes capture/submission failures, submission recovery, cloud admission, pending computation, publication, local validation/rejection, and confirmed acknowledgement. The same recovered submission retains its request identity. A later new solve attempt gets its own identity and preserves the original error evidence.

The cloud commits `energy_replan_events` in the same transaction as request/job/acknowledgement changes. It records initial planning and price-release planning separately with `forced=false`; configuration recommendations alone never become forced-replan records. The cloud audit outlives pruning of solver jobs. Subscribers may read their own household's events but cannot write them. The portal's Log tab shows a concise 72-hour projection; plan-run summaries also retain the frozen trigger and job ID.

Explicit requests record their actual origin: portal button and authenticated actor ID, app button, controller-source selection, changed configuration, or a configuration change still pending at startup. App/integration versions and exchange IDs accompany device-origin requests. A startup request must not be described as a human click or inferred to be a deployment. Direct fixed-schedule changes and unattributed database writes are labeled separately. Historical attribution absent before this feature remains explicitly unknown; it cannot be reconstructed from timestamps.

The API's `ManualReplanRequest` requires a nonempty `reason`. App, integration, backend endpoints and the database migration roll forward together; no legacy request alias is retained.


## Readable planning log

The Energy Optimisation **Log** tab is a home-scoped, newest-first event history in the home's timezone. `energy_planning_log` is its 72-hour projection; the durable forced-replan audit and operational controller state retain their own ownership and retention. Its rows are hidden from subscribers immediately at 72 hours and an independent five-minute maintenance job deletes expired rows. No active home or new upload is needed for cleanup.

One row represents a planning run, from request through calculation, publication and acceptance or failure. The original trigger and numeric evidence remain available when expanding the short entry. Repeated phases and worker retries update that row. Calculations lasting at least 30 seconds show their duration; this is a display threshold, never a reason to replan. A plan accepted by HA records the successful outbound handoff; TEST publication never claims HA acceptance.

Successful incoming HA batches are summarized per hour with batch and accepted-row counts. Repeated actionable warnings are grouped by day, scope, code and entity; error severity is always retained. Routine learning estimates, healthy runtime reports and job-status polls do not add rows. Changed HA problems remain distinct, while varying request IDs do not manufacture new problems. This aims for substantially fewer than 100 entries in a normal day without discarding real replans or failures to meet an arbitrary quota.

The UI uses short collapsed rows, date headings and an independently scrollable history with 50-entry pages and a Show older events control. Full reasons, repeated-warning counts and the first/last observation times are available on expansion. Refresh is explicit so incoming activity cannot move the reader while scrolling older entries. The previous Plan-tab disclosure is replaced by this Log tab, avoiding two different histories. Diagnostic uploads and warning recording run outside the receipt response path; they cannot delay sending an executable plan to HA. No controller command, admission threshold or replanning policy changes here.
