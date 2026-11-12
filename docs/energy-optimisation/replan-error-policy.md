# Readiness and automatic replan error policy

Revised 12 November 2026. The app admits execution evidence when accepted work
is materially blocked. The planner owns quarter-hour allocations, and the app
owns live responses within the accepted plan.

## Admission thresholds

Available readings remain current until Home Assistant changes their value or
reports them unavailable.

| Evidence | Automatic replan condition | Local behaviour |
|---|---|---|
| EV disconnected | Accepted charging is due and a usable plug reading says the car is disconnected | Immediate. An idle unplug/replug requires no replan. |
| Command failure | A required scheduled command is rejected, fails or cannot be confirmed | The app records the failure with its cause and holds the last setting. |
| Required observation unavailable | The same source is still unavailable after 15 minutes and prevents due accepted work | Hold the last setting. Show attention after five minutes. Usable readings resume ordinary evaluation. Recovery needs a new plan only if the accepted or pending plan suppresses that work. |
| Live battery energy shortfall | Work actually cannot run in a quarter scheduling at least 100 Wh of battery energy | A shortfall against an otherwise executable battery target is diagnostic. |
| Live car capacity shortfall | The run is being trimmed and the energy it can no longer recover is at least one native current step over one planner quarter | The app adjusts current locally whenever needed. For a one-amp step on three 230 V phases the replan scale is 172.5 Wh. |
| Live room capacity shortfall | Scheduled heat is being trimmed, its comfort outlook is short by at least one 15-minute allocation, and a fresh check confirms it after the 60-second equipment response window | The app can pause and resume locally before then. |
| Small shared-grid forecast conflict | The native planner can keep the held charging run by clipping less than 100 Wh of forecast AC charge in the affected run | Resize only the affected battery charge intervals. Keep other held commands and bookings. Material or otherwise infeasible commitments use the existing native recovery path. |

The former battery residual rule of 0.200 kWh for two minutes was superseded
by the 26 October execution rule. There is currently no live automatic-replan
producer for the historical pool trajectory threshold of 0.5°C for 30 minutes.

The app tracks unavailable sources by owner and source using its local
observation clock. A rollback restarts an affected timer. The five-minute
display threshold is independent of the 15-minute evidence threshold.
Unadmitted observations remain outside planner captures. Equipment can keep
working on its last setting through a reporting gap. On return, the app uses
the recovered values to check the accepted instructions and continues them
whenever they can still run.

## Ownership and grid limits

The household serializes admitted evidence and source gaps with planning receipts
through the existing exchange lock. `shs_core/execution_replan.py` owns the
durable evidence rules. Failed deliveries keep their admitted evidence for the
existing retry path.

The configured aggregate import target is 15 kW for this installation. Forecast
allocations respect it and a small conflict can be absorbed by local sizing.
The app continues to size live commands against measured and reserved import,
including pending starts, and redistributes capacity as equipment responds.
The electrical protection is 25 A per phase. At nominal 230 V, 17.25 kW is the
balanced three-phase equivalent. Individual phases can exceed 25 A at much
lower total power. Raising aggregate admission requires verified per-phase
measurements and reservations for pending controllable loads.

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
