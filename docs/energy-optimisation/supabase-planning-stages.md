# Planning within Supabase CPU limits

Current implementation: 6 October 2026, commit `0db98cc`.
See the [measured improvements and scaling handoff](replanning-handoff-2026-10.md)
for evidence and future investigation priorities.

Household replanning uses two Edge Functions. `energy-optimisation-ingest`
authenticates the device, writes telemetry and prepares one frozen input. It
admits a snapshot-scoped durable job and returns a pending receipt. HA's existing
status polls then advance bounded batches through ingest and the secret-only
`energy-optimisation-plan-step` endpoint. No new hosting or HA-hosted solver was
introduced.

Each poll claims a home-scoped 60-second lease and fence, downloads the immutable
input and ordered completed-auction/ranking ledger once, and makes at most eight
worker calls within a 25-second exchange budget. Worker calls use a cooperative
900ms elapsed-time allowance. The batch appends new results and saves its active
cursor atomically, then returns pending. A completed solve records the assembling
phase; a fresh poll reconstructs, assembles and publishes the plan.

The job has no overall 120-second deadline or 512-call limit. Those former
household limits rejected valid work that was still advancing. Per-exchange
budgets and leases bound individual ownership periods; expiry permits takeover
rather than discarding progress. An unchanged fence can save valid progress
after lease expiry if no takeover has occurred. A new owner fences stale writes.
Real worker/protocol/input failures remain explicit failures.

Atomic publication writes the current plan, run summary and terminal job receipt.
It checks home ownership, received-order head revision, fence, successful step
count, fixed-plan revision and manual request identity. Device/source timestamps
do not order submissions or introduce measurement/forecast validity constraints.
A lost storage reply is recovered from the authoritative home-scoped receipt.

Cloud publication does not complete a website request. Only acknowledgement
that HA accepted the matching published plan completes it. The existing plan
and controls remain retained during pending or failed replanning. The website
polls content deltas every second while waiting. The user withdrew the earlier
10/12-second target for this remediation and required successful completion.

The existing cron sweep prunes bounded terminal history; it never solves a job
or expires healthy pending work. HA receipt polling currently drives progress,
so disconnecting HA pauses advancement. Automatic replanning on newly published
prices remains enabled; unchanged price refreshes do not trigger a full solve.

Fixed-plan activation retains its synchronous preflight through the same batch
transport/parser, with its separate 120-second and 512-call bounds. Those are
not household/manual job limits.

## Validation and limitations

The final live test completed 282 worker calls and 22 auctions, published once,
received matching HA acceptance and appeared as the same plan in the portal.
Click to HA acceptance took about 6m58s; exact website render latency was not
captured. Full canonical output and contract tests passed. New lifecycle tests
cover ordered appends, duplicate/lost replies, lease takeover, stale writes,
home isolation, durable assembly and completion only after matching HA acceptance.

This fixes completion across bounded requests, not transport amplification.
Completed state is downloaded once per batch and resent/replayed on every
worker call. The successful live run sent approximately 997 MB of worker request
bodies and downloaded 133 MB through batch-load RPCs. These are uncompressed
application payload counts, not billed traffic or a fleet capacity guarantee.
Final assembly also remains a synchronous Edge CPU section; the measured live
assembly took 184ms, which does not guarantee the same margin for larger homes.

## Where a replan's seconds go

Measured on TEST, 11 November 2026, from `energy_replan_events` and the stored
job and run rows. A manual replan took 11–16 s from the click to publication:

| Segment | Seconds | What it is |
|---|---|---|
| Click to capture | about 2 | The realtime wake of Home Assistant's long poll. |
| Capture to admitted | 6–7.5 | Home Assistant finishes its capture and uploads; ingest stores telemetry and prepares the frozen input. The split between the two is not recorded. |
| Admitted to solving | 1.5–2 | The poll that starts the solve. |
| Solving to published | 3–5.5 | Room preparation, search, assembly (`summary.calculation_ms`, 4–5 s) and publication. |

Two changes shorten this without changing any plan:

- A job that nobody has claimed is ready at once, so its receipt asks for the
  first poll after 100 ms instead of a full second
  (`20261111170000_start_admitted_planning_jobs_at_once.sql`). A leased or
  retried job keeps its paced wait of at least a second.
- The room search computes only the temperature rows a room can reach
  (`reachable_rows` in `planner-core/solver/src/room_heating.rs`): between its
  passive and its fully heated transition carried forward from the start. The
  plan is identical; a read outside those rows recomputes the whole table. On
  the TEST home's floor-heated room this took the preparation request from 843
  to 506 ms locally. Rooms that can reach their whole grid gain nothing.

Ingest reads the comfort targets, value settings, grid limit, device models and
replan state together instead of one after another.

## Room preparation within the hosted CPU limit

The hosted planner prepares one room per request before solving the household.
Each request uses the same frozen capture. It reconstructs the remaining import
headroom and solar surplus by subtracting the completed rooms' forecast demand
in the original planning order. The last preparation request assembles the
household problem. A separate request runs the native search, and a final
request refines and assembles that selection for publication.

The caller checks the snapshot identity and requires the room cursor to advance
by one during proposals. At the final connected-network barrier the room cursor
can remain fixed while the opaque native work cursor advances. Each remote
exchange has a 25-second deadline.
Partial preparation results stay inside the planning attempt. A failed attempt
can retry from the captured input while the accepted plan stays active.

## Minimal room-fit transport (27 November 2026)

A learning request owns one room and advances either its body optimizer, one
exchange-inference replica, or publication. The mathematical learner, four
replicas and 30-day fitting window are unchanged. Worker protocol 3 changes the
transport independently of the accepted learner identity.

Source acquisition reads only the receiving room's model and context. Immutable
qualified observations and publication context are stored once. Numerical claims
omit the previous accepted reference; publication reads that exact reference only
when an unidentified attempt must retain it, under the original model revision
and binding. A successful fit does not download the old posterior.

Each inference replica has its own scratch row. Numerical claims load only the
active replica and a bounded page of native observations. Checkpoints send only
its replacement, with generation, fence, model revision and the scalar cursor;
they do not echo the previous state or rewrite completed sibling replicas.
Lossless packets share repeated regime parameters and clock fields while keeping
all covariance entries, random state, hazards, weights and particle multiplicity.
Publication joins the replicas in their original order once. Reset, supersession
and publication delete the scratch through its existing owner.

Deployment activates this wire protocol only after checking the hosted worker's
capabilities. A compatible rollout preserves the captured observations, progress
and physical lease. In-flight older workers may finish their owned request; they
cannot acquire new work after activation. This does not schedule another fit.

Planning source capture also reuses a certified fitted block that overlaps the
start of the model's history. It retains the original envelope and digest; the
existing qualifier clips native intervals to the requested population. Binding,
policy, graph and correction checks still apply. Heated receivers select their
own source reader before the passive reader scans household evidence.

Room numerical data follows the stage that consumes it:

| Stage | Data crossing into the worker |
| --- | --- |
| Admission | Model headers and their revision/binding identities. The admission transaction freezes the corresponding accepted populations under the new job. |
| Receiving-room qualification | The active room's frozen population and observations. Completed rooms remain in database scratch. |
| Capture completion | Room keys, dependency lists and initial temperatures. SQL restores the selected full nodes into the frozen execution input. |
| Ordered room proposals | Current node geometry, state and exact ordered peer dependencies. |
| Native catalog compilation | One receiving population at a time. The existing catalog pages retain its exact numerical records. |
| Forecast qualification and household solve | The compiled native network, replica results and completed room schedules. |
| Snapshot sealing | Small snapshot fields and one original node at a time for the same JSON snapshot hash. |

The full execution input remains database-owned for replay and publication.
Catalog identity hashes use the exact JavaScript-encoded prefixes and numerical
record bytes in their original order. Transport projections leave the public
snapshot contract, physical model, uncertainty populations and source ownership
unchanged. Compatible deployment readers let already-owned requests finish
under their existing fences.

## Connected-room state capture (26 November 2026)

Hosted room capture freezes the accepted receiving-room models, the app-owned
connection map identity and the current observations under the admitted planning
job. Headers travel in the input; the admission transaction pins the matching
numerical populations alongside it. Connected-state inference uses scratch owned by that same durable
planning job. This preparation finishes before native room scheduling starts;
it does not create a separate actor or a second learning-job kind. Existing
accepted instructions remain active while preparation advances.

Each receipt poll claims the existing home/job lease and drains compact owned
worker actions within the existing 25-second exchange deadline. The authenticated
request contains only job/home/fence and an action; ingestion reads persisted
metadata and imports no inference or fitting kernels. The worker loads and
checkpoints one bounded stage directly. Source completion freezes execution
arguments before native preparation. No source snapshot or posterior population
is returned through ingestion on each action. The source actions are:

1. Freeze valid source blocks from the fitted archive or a prior capture inside
   PostgreSQL. Source policy, graph, binding and correction clocks must match.
   Only missing or dirty extents require a bounded native history read. Existing
   blocks remain immutable for this attempt. The scope runs from the accepted
   model's `basis.history_from` to the frozen planning clock; it has no arbitrary
   recent-history window.
2. Decode and independently qualify the receiving room's complete population.
   Receiver and named peers retain physical source identity and dated assignments.
   Later reporting evidence may reclassify an earlier freeze, even if no old raw
   row changed. Unknown values and native interval boundaries remain explicit.
3. Verify a reusable inference prefix by its exact qualified numeric bytes. The
   accepted fit contains a trained process belief and prefix proof. Later global
   checkpoints retain each ten-day prefix and the latest prefix; a correction
   selects the latest earlier matching checkpoint, or starts from the proper
   prior when none matches. Raw dirt alone never certifies numerical reuse.
4. Advance the accepted learner's per-edge regime belief while holding the
   thermal body, heater and noise parameters fixed. Each particle carries the
   correlated receiving temperature, stored heater heat, incoming log rates and
   unknown regime centers. An edge reset redraws only that edge; the other
   edges' learned state and covariance remain intact. Four independent numerical
   replicas initially contain 256 conceptual particles each. Local continuation
   and reset proposals update each replica's marginal log evidence; that evidence
   weights replicas together. Resampling occurs at effective sample size below
   half the replica population. Exact duplicate states share storage and retain
   their multiplicity. There is no parameter jitter, process floor or recency
   window. Initial edge tags, reset priors, initial hazard prior, random state
   and likelihood weights persist with the belief, including across correction
   replay. Native observation updates are canonical across request partitions.
   Cached beliefs stop at the received prefix; propagation over a late tail,
   including possible resets, is a separate copy, so newly arriving observations
   are not skipped on the next capture.
5. Assemble receiving nodes and check dependencies once after all nodes finish.
   Native proposals and joint trajectory replay then advance under their own
   monotone work cursor in the same planning job. The room index can stay at the
   final proposal barrier while trajectory work advances. Completed trajectory
   counts resolve once; seed, algorithm, model and source inputs stay immutable.

Inference approximates reset timing at the start of each native observation
interval. The finite particle population and conditional Gaussian state updates
are numerical approximations, not an exact Bayesian posterior. Replica effective
sample size, marginal log evidence, conceptual and distinct particle counts, and
numerical failures are retained as diagnostics. A zero edge can acquire a reset
prior only from eligible historical contrast and an identified receiving-rate
scale; topology alone never creates credited heat. Without that scale the edge
stays present with an unresolved-scale diagnostic until body learning supplies it.

Native forecasting replays the connected network jointly under common numerical
paths for competing commands. Conditional no-reset and reset strata represent
rare changes without relying on accidental event hits. The resulting expected
electrical demand enters the existing household capacity policy; the rate mean
alone does not form the final energy ledger. The completed capture freezes the
algorithm, accuracy policy, seed, artifact/runtime identity, outer trajectory
counts, replica counts and actual replayed-path count for exact downloaded replay.

The owned runtime advances through capture, ordered preparation, catalog,
integration, qualification, solve, assembly and ready stages. Native code compiles
probability headers and selects hypothesis indexes. Exact UTF-8 hypothesis records
are stored in independently compressed, approximately 64 KiB pages with explicit
byte offsets; an oversized record gets its own page. Selected reads decompress
only their pages, without pruning hypotheses or rebuilding probability weights
in SQL. Immutable network/context and opaque numerical checkpoints travel as gzip
payloads between the database and worker.

Each native replica invocation starts a 150 ms clock before decoding its input
and has a hard ceiling of 131,072 work units. It checks the clock after a
completed minute or a batch of up to 64 reset events has advanced the cursor.
The clock lives only in the request, so resumption uses the checkpointed physical
state and random sequence. The 1,000 ms CPU gate measures the two complete
concurrent handlers together, including checkpoint serialization.

Integration schedules up to four forecast replicas in groups of at most two
concurrent worker requests. The caller awaits each group and checks the shared
deadline before launching the next. These are distinct from the inference replicas.
An exchange shares a 24-call allowance across every worker stage and replica,
reserving six calls for upstream hops within Supabase's
[30-call per-trace limit](https://supabase.com/docs/guides/functions/recursive-functions).
A complete wave and its barrier must fit before launch. Exhausting the allowance
returns pending; the next external receipt continues the same numerical job.
The runtime also handles a thrown `RateLimitError` and persists its `retryAfterMs`
alongside the existing retry backoff. Trace propagation is not stripped or reset.
Each subordinate writer holds its own lease and cursor under the active parent
fence. Shared home/current/job authority locks avoid serializing sibling work;
no lock spans computation or HTTP. A late child after parent release or takeover
cannot checkpoint. The balanced barrier merges completed replicas in index order.
New forecasts freeze the v3 estimation policy at capture: 64 stochastic
trajectories across four independent replicas, or one exact trajectory for
deterministic physics with zero counts for the other replicas. The native
comfort, cost and electrical comparisons still select the command vector from
those joint physical paths. Publication does not wait for repeated doubling to
stabilize every future temperature or energy mean to a display tolerance.
These are finite-sample estimates; a borderline decision can differ from one
made with more samples. Actual trajectory, conditional-path and replica counts
are archived after evaluation. Completed historical captures retain their
recorded counts; unfinished v2 captures require a fresh capture. There is no
whole-job timeout.

The parent loads the completed execution input and result once for atomic
publication. Publication, supersession and terminal failure delete compiled
catalog and replica scratch immediately. Successful publication moves exact
execution arguments into the existing single current-input record per home and
removes the execution scratch after validation. Historical run summaries do not
acquire full posterior archives. Local downloaded replay uses the same indexed
native engine, canonical merge and frozen completed trajectory counts.

Process and filter work have a cooperative 600 ms allowance. Inference can stop
between conceptual particles within a native row, retaining local proposals,
integer child references, replica progress and random state in attempt scratch.
Only a completed row can become a reusable source-prefix belief. Tail prediction
uses a separate bounded worker action and is never written to that evidence cache.
The numeric loader
sends bounded row slices for process inference, metadata for prefix verification,
and complete rows only where qualification or a bounded initial-state estimate
needs them. Completed nodes are omitted from intermediate numerical payloads and
retained by the database. Consecutive prefix completions may use the same request's
remaining allowance; every checkpoint and native stage retains home, lease, fence
and cursor checks. This is bounded work in the existing receipt-poll path, not a
new actor or an unbounded loop within one Edge invocation.

Ordinary late observations and corrections repair the next capture automatically.
The same body model remains usable; corrected source evidence does not wait for a
daily thermal refit. A source-assignment or graph change fails its source fence.
Numeric scratch carries the learner digest, explicit capture/execution protocol
revision, native artifact identity where applicable, and V8 runtime. Incompatible
scratch restarts within the admitted attempt or uses the existing planner-upgrade
recapture path while accepted controls remain active. Incompatible orchestration
or assembly changes must bump their explicit protocol independently of model
fitting; UI edits do not force a thermal refit.
Recognized compressed-artifact or catalog-directory corruption resets only the
fenced derived runtime and rebuilds it from immutable admission/source state.
A stale repair cannot delete a newer cursor, identity or owner. Numerical/model
errors are not reclassified as storage corruption.

Missing or late quarters are ordinary inputs. They remain unknown, are estimated
conservatively by the room model, and never become measured zero heat or a
persisted sensor value. An unreadable or malformed receiving model/source is
isolated to that room with diagnostics; accepted comfort instructions and
empirical electrical demand remain available. An observed-only room, or a room
whose installed heater has no identified gain, can participate as a passive
thermal node without gaining actuator authority.

The handler CPU gate exercises cold staged source, qualification, process,
filter and assembly calls using synthetic history, including checkpoint
serialization. Its existing budgets remain unchanged. Local scaled measurements
are a regression check, not proof that every hosted request fits Supabase's
strict two-second CPU limit; qualification population size and checkpoint
transport remain explicit scaling costs.

Completed execution arguments are stored atomically with their published run
in `private.energy_planning_current_input`. They contain the final derived network,
process parameters and posterior actually sent to native planning, plus the
planner/runtime identity and snapshot hash. The admitted descriptor remains
immutable. Exactly one completed input per home survives planning-job cleanup;
publication replaces it with the new plan ID. Historical runs remain summary-only.
The current input can be read through a service-only, home-scoped RPC. The portal's lazy replay download uses a
separate customer-authorized RPC pinned to the selected run, rather than
reconstructing arguments from the current snapshot. Its version-3 bundle names
`executeRulesPlanning`, preserves all captured arguments and planner/runtime
identities, and needs no current observations or fitted models to replay.

Per-request CPU is only one acceptance measure. Complete cold and subsequent
captures must also be measured for receipt count, total elapsed work and payload
volume on a long native history. Initial full-history optimization on every plan
was rejected by that measurement; accepted-fit beliefs, exact prefix reuse and
bounded numeric transport remove that repeated work. Hosted SQL/network latency
and receipt pacing still add to local benchmark time.

The current four-replica regime estimator was also measured on an independent
400-day, one-receiver/one-peer synthetic history (38,400 native quarters), with
256 conceptual particles per replica. Cold inference used 837 bounded numerical
calls and 501.8 seconds of local work. Appending four days (384 quarters) to that
trained belief took 4.0–6.2 seconds across stable, abrupt, gradual and frequently
varying histories. These are estimator measurements without database transport
or receipt pacing, not end-to-end plan latency. They confirm that a stable long
prefix need not be replayed to adapt; cold repair remains substantial work and
accepted controls must continue while it runs. The source-capture and complete
joint-forecast measurements must report their separate receipt and payload costs.

A separate synthetic 15-node, 72-hour forecast exercised the production owned
client and worker handlers with four Deno worker isolates, the 24-call exchange
allowance and one-second receipt pacing. It completed 2,048 outer trajectories
(4,096 conditional reset branches) in 64 receipts and 225.5 seconds locally,
using 650.3 seconds of total process CPU. Its 1,335 worker calls transferred
200,379 request bytes and 191,841 response bytes. Exact serialized catalog and
checkpoint RPC payloads totaled 655.3 MB read and 391.5 MB written. This test used
a fetch adapter and in-memory RPC storage, so those figures measure computation,
serialization and call volume; they exclude real network and PostgreSQL latency.
Separate SQL integration tests verify fencing, publication and downloaded replay.
Neither measurement replaces the unchanged per-request CPU gate or hosted
qualification.
