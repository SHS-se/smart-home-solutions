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
| Required observation unavailable | The same source is still unavailable after 15 minutes and prevents due accepted work | Hold the last setting. Show attention after five minutes. Usable readings resume ordinary evaluation. Recovery needs a new plan when an admitted failure suppressed work that cannot resume from the accepted instructions. A room relay waiting on its temperature reading holds its accepted target locally. |
| Live battery energy shortfall | Work actually cannot run in a quarter scheduling at least 100 Wh of battery energy | A shortfall against an otherwise executable battery target is diagnostic. |
| Live car capacity shortfall | A running car is being trimmed and the energy it can no longer recover is at least one native current step over one planner quarter | The app adjusts current locally whenever needed. For a one-amp step on three 230 V phases the replan scale is 172.5 Wh. A separate gateway capacity episode can report a supported current ceiling for the affected opportunity. |
| Live room capacity shortfall | Scheduled heat is being trimmed, its comfort outlook is short by at least one 15-minute allocation, and a fresh check confirms it after the 60-second equipment response window | The app can pause and resume locally before then. |

A pool temperature differing from its forecast is diagnostic. The automatic
pool path uses evidence of blocked scheduled work.

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

The planner and app use the home's configured aggregate import limit. During
a solve, the planner can resize a retained battery grid-charge run if the
native projection verifies the change and the forecast loss is under 100 Wh AC
in the run. It adjusts only the affected charging intervals and keeps other
held commands and bookings. Material or otherwise infeasible commitments use
the existing native recovery path.

The app sizes live commands against measured and reserved import, including
pending starts, and redistributes capacity as equipment responds. For a
connection rated 25 A per phase at nominal 230 V, 17.25 kW is the balanced
three-phase equivalent. A phase can exceed 25 A below a 15 kW aggregate
operating limit. Raising aggregate admission requires verified per-phase
measurements and reservations for pending controllable loads.

## Regression evidence

The synthetic planner continuity case raises one quarter's load forecast by
17 W. The planner trims 4.25 Wh of battery charge in that quarter and keeps
the other held commands. The app regressions cover short gap recovery,
independent source clocks, the 15-minute admission boundary, and material live
capacity shortfalls.


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
