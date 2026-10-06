# Planning within Supabase CPU limits

Household planning uses the [durable job owner](durable-planning-jobs.md).
`energy-optimisation-ingest` authenticates the device, stores telemetry and
prepares a frozen snapshot. It accepts a database job and returns HTTP 202 with
its receipt. Both manual requests and automatic price-driven solves use this
path. Telemetry exchanges which keep the existing schedule still return 200.

`energy-optimisation-planning-worker` receives only a job identity from the
database. It claims a 30-second fenced lease, loads frozen input, completed
auction/ranking results and the unfinished cursor, then advances the search.
The shared budget stops at 900 ms or two million inspected boundaries. These
limits change where execution pauses; they do not reduce the economic search.
Bidding, settlement, transfer-pair scans, refinement comparisons and responsive
ranking can all checkpoint. Numeric held-bid caches, exact costs, scan positions
and stable ranking order survive JSON serialization.

Completed results are appended once to a separate ledger. A checkpoint commit
atomically appends additions, advances the job sequence, replaces its cursor
and queues the next authenticated `pg_net` wake. `pg_cron` runs every ten seconds
to recover missed wakes and expired leases. Work continues when the app or
browser disconnects. A terminated worker loses only its uncommitted slice;
four successive lease expirations without progress terminate the job visibly.

Assembly gets a separate invocation after search completes. It replays saved
auctions/rankings without running missing searches, adds descriptive thermal
projection, and publishes the current plan, run summary, matching manual-request
completion and terminal job state in one database transaction. Publication
checks the received-order job head, worker fence/sequence, fixed-plan revision
and observed manual request identity. Source timestamps do not order jobs.
The previous plan remains current until that transaction succeeds.

The app journals the capture identity before submitting it. Once accepted, it
journals the job identity and polls status without retransmitting telemetry or
preparing another snapshot. Delivery has its own host-owned task and releases
the exchange lock while waiting. Restart resumes journalled delivery. Normal
quarter exchanges upload telemetry while an automatic job is pending; explicit
manual requests can supersede it. A snapshot-only status lookup recovers an
acceptance reply lost in transport. Status only delivers the exact job's plan
while it remains current; superseded jobs never return a different plan.

## Fixed-plan activation

`energy-optimisation-fixed-plan` still uses the secret-only
`energy-optimisation-plan-step` endpoint to materialise its activation preflight.
This existing caller shares the improved pure resumable solver, but retains
its bounded request chain (120 seconds, at most 512 calls). It authenticates
with `ENERGY_PLANNING_SECRET`; the household job worker instead verifies the
private database wake token. Fixed-plan activation's portal workflow is unchanged.

## Deployment and verification

The migration creates private job/head/result/credential tables, service-only
RPCs and the recovery cron. CI and `scripts/dev.sh` configure the current
project's worker URL in `private.energy_planning_credentials`. The deployment
script deploys both planning executors before their callers. The wake token
never leaves the private credential row except in server-to-server headers.

Household snapshot submissions require `planning_exchange_version: 2`; old
clients receive an explicit 426. Update the SHS app to the coordinated beta
release. There is no compatibility solve path. Protocol 8 pins numeric cursor
representation; incompatible in-flight jobs fail explicitly rather than restart
under a different planner. The planner model and generated plan contract remain
unchanged.

Run `deno task test`, the migration-version test, frontend lint/typecheck/build
and all local E2E suites. Solver tests round-trip checkpoints and compare full
plans, including sunny/dark, responsive, discrete-EV and fixed-schedule cases.
SQL tests cover roles, key order, leases, fencing, supersession, atomic rollback
and bounded recovery/retention. HA tests cover receipt recovery, restart,
job-only polling, configuration changes and retained controls on failures.

## Resource diagnosis

Each worker start logs job/fence/sequence, original request ID, phase, cursor,
result counts, load time and Deno memory usage. Commit/publication logs separate
compute/assembly time from database time. Match a start without completion to
platform shutdown logs when investigating CPU versus memory termination.

Local equivalence and timing checks are not hosted capacity proof. Replay,
input parsing, primitive scoring, checkpoint encoding, assembly and preparation
still consume CPU and memory. Hosted test-project logs must verify their margin.
Durability preserves committed progress and identifies repeated failure; it does
not promise that every possible input avoids a resource limit.
