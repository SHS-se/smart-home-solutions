# Replanning timeout audit — 24 September 2026

## Follow-up — 6 October 2026

The TEST portal RPC `get_energy_portal_delta` and durable worker claim
`claim_energy_planning_step` both hit PostgreSQL statement timeouts while the
planner benchmark was rescoring 960 stored results. Claim cancellation occurred
while building the ordered completed-auction/ranking payload. The benchmark
downloaded source decisions even for current results and rewrote all derived
artifacts when only scorer/audit versions changed. Thermal portal reads already
had covering indexes; several unrelated reads slowed under this load.

Pausing GitHub benchmark run `37461029224` restored the portal RPC to about
879 ms. This supports benchmark contention as the incident's cause; the database
resource graphs were not used to attribute it to a particular resource.

Benchmark requests now serialize and leave idle time between requests. Coverage
uses cheap artifact-presence metadata, and guarded writes update only the derived
fields whose dependencies changed. Claim payload assembly precedes the fresh
30-second lease, with a scoped 15-second claim timeout. Commit, publication and
failure ownership checks use wall-clock time after locks. Planner mathematics,
search budgets and the delivery protocol are unchanged.

The migration and benchmark schema were applied to TEST. Two bounded live
checks each refreshed and verified 12 stale audit/score results through the new
RPC. During the concurrent check, the actual portal RPC completed in 584 ms under
its unchanged 8-second limit. The household job advanced from step 536 to 606
with zero lease expiries; publication was still pending at that observation.
These are bounded samples, not a guarantee against future saturation. Updating
an audit still rewrites its JSONB series, and artifact constraints still read
existing JSON during row updates.

## Follow-up — 25 September 2026

### Failure

A manual replan on SHS test failed with `storage failed [request_id=3c45cf63-8a04-4b6c-9e3f-39fa911d7e81]`.
PostgreSQL logged `57014` at 13:48:16 UTC for the PostgREST call to
`store_energy_optimisation_current(jsonb)`. The solve had already completed. The
log context places the cancellation in `guard_fixed_energy_plan_generation()` at
its first, integer-only comparison.

### What the log context establishes

The following were reproduced on a local PostgreSQL 16 with the same migrations
and PostgREST's statement shape:

- **Not a row-lock wait.** Cancelling during a wait on the home's row reports
  `while locking tuple (…) in relation "energy_optimisation_current"` in the
  context. The failure has no such line, so no lock wait was in progress at 8 s.
  A shorter wait earlier in the statement cannot be ruled out.
- **The budget was already spent before the trigger.** Parsing and
  `jsonb_populate_record` rarely check for interrupts. A body-parsing overrun is
  cancelled with no PL/pgSQL context. An overrun that ends after the conflict
  lookup is first noticed at the trigger's first expression, as reported. The
  cheap comparison did not itself take 8 s.
- **Normal cost is far below the limit.** A PostgREST-shaped store of a 4.2 MB
  body took about 0.2 s median locally: parsing about 0.2 s, population
  0.18 s, and the whole statement 0.21 s, including transport from a local
  client.
- **Memory cost is high.** A fresh backend's peak resident memory rose by
  8 MB just to bind a 2.8 MB text parameter. It rose by 36 MB to parse it as
  JSONB, 41 MB to populate the record, and 64 MB for the complete store. That is
  roughly 23 times the body size, so it scales with plan size.

The failure therefore needed the same work to run about 40 times slower than on
an idle machine. The instance's CPU, memory and I/O metrics at 13:48 UTC were not
available to this investigation. Contention from other load is the leading
explanation but is unconfirmed. Check the database's resource graphs for that
minute before assuming a specific cause.

### Duplicate schedule in stored plans

Since `087a49f` (23 September), a schema 9 plan is
`{...execution.plan, schema_version: 9, operating_scope, battery_execution?, execution_plan: execution.plan}`.
`execution_plan` is an exact copy of the top level apart from those keys and the
ingest-added `thermal_projection`. In the contract fixture it is exactly half of
the plan's JSON. The 3.56 MB test plan measured on 18 September already
included a 952 kB `execution_plan`, from an earlier projection.

Home Assistant receives plans only from the ingest response, which is generated
in memory. No SQL function, edge function or portal view reads `execution_plan`
from `energy_optimisation_current`; the portal only validated its presence.

### Changes

- `store_energy_optimisation_current(jsonb)` has a function-level
  `statement_timeout = 30s`. PostgREST hoists function settings named in
  `db-hoisted-tx-settings` into the call's transaction. Its default list
  includes `statement_timeout`. Supabase honours this for RPCs. A
  `SET LOCAL` inside the function body would not re-arm the running timer. All
  other API calls keep the 8 s role default.
- Ingest stores `storedPlan(generated)` (`_shared/stored-plan.ts`). It omits
  `execution_plan` only when that copy serializes identically to the top level
  after removing `schema_version`, `operating_scope`, `battery_execution`,
  `execution_plan` and `thermal_projection` (then `schema_version: 8`). Any
  divergence is stored as generated. `expandStoredPlan` restores the copy
  exactly. Home Assistant continues to receive the complete generated plan. The
  portal validator accepts a schema 9 plan without the copy and still rejects an
  invalid copy.
- `snapshot` and `battery_projection` use LZ4, like `plan`. Existing values
  stay pglz until their next publication.
- The portal's replan failure is a full-width row below the plan heading. It
  previously wrapped the "Replan now" button into a right-aligned block the
  width of the error text.

### Verification

- A local PostgREST 12.2.12 had its authenticator `statement_timeout` set to
  1 s, and another session held the home's row for 2.5 s.
  - With the function setting, the RPC returned 204 after 2.3 s.
  - After `RESET statement_timeout` on the function, the same call returned
    `57014` after 1.0 s. This is the production failure.
- Omitting the copy halves the schema 9 contract fixture's plan. The full
  execution plan round-trips exactly.
- Lint had no errors and 26 existing warnings. Typecheck and the test build
  passed. All 1,292 Deno tests passed.
  - `deno.land` and `esm.sh` are blocked in the sandbox, so the Deno run used a
    temporary import map to equivalent JSR/npm packages.
  - The mocked-backend Playwright suites did not run: the sandbox's Chromium
    build did not match the project's Playwright. CI runs them.

### Remaining

- Home Assistant still receives the duplicated plan, because the schema 9
  contract (`contracts/ha-api/openapi.json`, `PlanV9`) requires
  `execution_plan`. Dropping it from delivery needs a coordinated
  `shs-ha-integration` change. It would halve ingest response size and HA
  parsing.
- The 30 s limit is headroom, not a guarantee. The structural alternatives
  below remain: durable jobs, a dedicated worker, or artifact separation.
- The `current plan storage` ingest log records each write's duration. A
  duration approaching 30 s means the headroom is being consumed.

## Confirmed failure and immediate changes

Request `a8eee7a9-da13-4c67-8e92-04a6f0b46729` failed at
14:28:04 UTC with PostgreSQL error `57014`. The database log identifies the INSERT inside
`store_energy_optimisation_current(jsonb)`, called by PostgREST. This is a database
statement timeout, not evidence that the price search or the main solver failed.
The exact blocking/CPU state at cancellation was not captured.

The previous named-parameter RPC still caused PostgREST to invoke
`json_to_record` on the whole HTTP body. The outer record and the inner
set-returning record conversion each materialized the multi-megabyte plan and
could spill to temporary storage. The replacement accepts one unnamed JSONB
argument and populates a local composite record once, then inserts its explicit
publication-field allowlist. This is the documented
[PostgREST raw JSONB argument API](https://postgrest.org/en/latest/references/api/functions.html#functions-with-a-single-unnamed-json-parameter).
There is no legacy-body compatibility path. Deploy migration and ingest together.

Rolled-back profiling on the linked test database, using its existing roughly 5 MB
plan and service-role execution, measured the raw-body replacement at 195 ms for
planning plus execution; a changed-plan-ID case including publication triggers
measured 486 ms. The named-body path measured 1.5 seconds in a controlled sample;
recorded successful API calls averaged 4.67 seconds and reached 5.50 seconds. These
are samples, not worst-case guarantees. Multi-write profiling batches themselves
also reached the 8-second statement limit, so timings must be assessed per execution
unit rather than by placing an entire benchmark loop inside one API statement.

Actual post-deployment HTTP writes took 3.97 seconds with the previous compressor
and 3.67 seconds with LZ4. Both replans completed. These live numbers override any
expectation suggested by the isolated benchmark: the storage path is improved,
but a multi-megabyte atomic write still has limited headroom under the 8-second
statement limit. Artifact separation is the structural way to bound that work.

Other implemented changes:

- New plan writes use LZ4 compression. Existing rows are not rewritten. The two
  live samples stored approximately 452 KB and 512 KB respectively; faster
  compression trades some disk space for reduced write work.
- Runtime, acknowledgement and recommendation updates no longer trigger a deep
  plan comparison. Replacement still enforces the existing fixed-plan revision.
- Narrow replan projections visit requested JSON keys instead of materializing
  all diagnostic fields. Missing keys, JSON null and non-object inputs retain
  their previous semantics.
- Traffic counters measure the consumer's stream. They no longer clone and fully
  read every worker response or the final plan before delivery. Failure and
  cancellation remain distinguishable from a complete measured response.
- Edge upstream calls have a 30 second network deadline, combined with caller
  cancellation; weather providers have 10 second deadlines through body consumption.
  These are transport budgets, not new planning-validity constraints. Existing
  provider failure handling is unchanged.
- Replan delivery skips retention maintenance. Ordinary telemetry exchanges delete
  at most 1000 expired rows per table per call, using existing retention periods and
  skipping locked rows. The next exchange continues any backlog.
- Separate current-plan and run-summary storage timings identify future failures.

## Complete path inventory

| Path | Current bound or remaining exposure |
|---|---|
| Portal button and replan queue | No planner work. Authentication, request RPC and current-row lock remain dependencies. Narrowed trigger reduces lock work. |
| HA snapshot preparation | Recorder reads and snapshot capture precede the cloud request. The push lock serializes preparation, continuation and acknowledgement; manual requests can wait behind a normal exchange. |
| Telemetry ingestion | Request/slot/device caps already exist. Writes and preparation repeat on each cost-curve 202 continuation. Individual network waits are now bounded; their cumulative lifetime is not a durable job. |
| Weather preparation | Provider/cache waits are bounded. Provider failure keeps existing behavior. |
| Thermal and pool training | Daily fitting and irradiance backfill run in ingest. Backfill has a 250-quarter batch, but fitting CPU and aggregate preparation are not independently checkpointed. |
| Battery price curve | Completed result is reused when published prices and algorithm identity are unchanged. A search advances at most 8 worker calls or 8-seconds between checkpoints per request. One call can run up to its 20-second network deadline. |
| Main remote planner | Still up to 512 worker calls and 120-seconds within one ingest invocation. Its accumulated continuation is in memory and lost if that invocation fails. |
| Individual planner worker | Cooperative 1200 ms budget leaves room under the 2 second CPU limit. Initial auction bidding/settlement and individual transfer/refinement scans cannot all pause internally. Larger valid inputs can exceed the limit. |
| Worker payload/replay | Input and all completed auctions are resent, parsed and replayed across steps. More steps therefore increase repeated work. Removing traffic clones reduces additional copies but does not remove this protocol cost. |
| Assembly | Final replay, thermal projection, hashing and serialization run in ingest. These synchronous sections have no separate CPU checkpoint. |
| Publication | Raw JSONB storage avoids intermediate materializations. Current-plan upsert, run-summary upsert and request completion are still separate transactions. A later failure can leave a stored pending plan that HA has not received. |
| Forecast archival | Small fixed-horizon arrays are archived after publication. Still part of the request and needs moving into job publication/maintenance in a redesign. |
| Retention | Excluded from generated-plan delivery; bounded on ordinary telemetry calls. |
| Delivery and HA acknowledgement | Streaming counters no longer delay delivery. HA permits 150 seconds for ingest and 30 seconds for acknowledgement; pending acknowledgement is retained for retry. A request-level deadline still does not preserve unfinished planning work. |

Sources: `energy-optimisation-ingest/index.ts`, `_shared/energy-planning-client.ts`,
`_shared/energy-planning-worker.ts`, `_shared/energy-planning-step.ts`,
`_shared/planner/dispatch-plan.ts`, `_shared/battery-cost-selection.ts`, and the integration's
`api.py` and `coordinator.py`.

## Redesign required for bounded end-to-end work

The fundamental mismatch is a resumable CPU algorithm orchestrated inside an
otherwise non-resumable HTTP request. Cost-curve continuation addresses just one
phase. Raising deadlines cannot fix Edge CPU termination, nested invocation limits,
repeated payload processing, lost progress or partial publication.

### Alternative 1: Durable bounded jobs on the existing Edge infrastructure

Accept and prepare input once; persist frozen input, completed auction records,
active checkpoint and a locally generated job revision. Each request advances a
small amount of work and returns 202 with job identity/progress, or the published
result. CAS protects each transition. Store completed auctions once, rather than
rewriting an ever-growing checkpoint blob. Make assembly an independent phase and
publish the current pointer, run summary and replan completion atomically.

```ts
const job = await planning.accept({ homeId, snapshot, replanRequestId });
const result = await planning.advance(job.id, executionBudget);
// pending 202, published 200, or an explicit terminal failure

type Progress =
  | { phase: 'curve'; curveKey: string }
  | { phase: 'solve'; auctionIndex: number; checkpointId?: string }
  | { phase: 'assemble' }
  | { phase: 'publish'; artifactId: string }
  | { phase: 'published'; planId: string }
  | { phase: 'failed'; error: string };
```

This reuses existing checkpoints and HA pending responses, but requires a job
schema, restart/concurrency rules and finer checkpoints inside currently
uninterruptible CPU sections. Simply putting the existing 120-second loop behind a
job ID would not solve those sections. No source timestamps or shorter valid
horizons should be introduced as workarounds.

### Alternative 2: Queue and dedicated planner worker

Ingest accepts a job; a worker with an appropriate CPU/memory budget prepares,
solves and assembles it, then publishes atomically. HA reads job status/result.
This directly removes the restrictive Edge CPU and recursive-call boundaries and
avoids repeated auction transport. It needs a worker deployment, durable queue,
leases, cancellation/supersession and operational monitoring. For a planner whose
valid input size can grow, this is the strongest long-term execution design.

### Alternative 3: Split executable plan from explanatory artifacts

Publish a small executable plan and immutable artifact identity. Keep large
comparison/diagnostic data in separate records or object storage and fetch it only
for views that use it. This reduces database locking, transfer, HA parsing and
assembly pressure, and complements either execution alternative. It requires a
coordinated HA/frontend contract migration and generated-fixture verification.
It must preserve diagnostics rather than silently dropping them.

Recommendation: combine durable job ownership and atomic publication with a
dedicated planner worker if deployment overhead is acceptable; otherwise complete
Alternative 1 including fine-grained CPU checkpoints. Consider artifact separation
once measured payload growth justifies the contract migration. The immediate
changes above reduce observed overhead but do not establish an end-to-end
worst-case timeout guarantee.

## Verification

The paired storage migration and ingest were deployed to SHS test. The first
replan published `aa3d2711-f7e9-4838-af57-8160ce9067f0` and HA accepted it at
14:54:19 UTC. The subsequent LZ4 write published
`38b725bd-2071-4eb4-89d5-540f600a1258`, accepted by HA at 14:56:43 UTC.
No generated planner output or model version
was changed by this remediation.

All 1,268 Deno tests pass. Validation covers multi-megabyte publication, service-only access, fixed-plan
concurrency, preservation of runtime/recommendation state, raw RPC signature,
projection semantics, bounded retention, streaming first-byte delivery,
cancellation and body deadlines. Full repository lint has zero errors and 26
existing warnings. Typecheck and test build pass; the browser suite contains 40
passing tests.
