# Replanning timeout audit — 24 September 2026

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
`_shared/dispatch-plan.ts`, `_shared/battery-cost-selection.ts`, and the integration's
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
