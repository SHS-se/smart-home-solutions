# Replanning improvements and future scaling considerations

Status: 6 October 2026. This is a handoff and investigation priority list, not
an approved replacement architecture. No redesign is implemented by this document.

The latest user direction prioritises successful completion and withdraws the
earlier 10/12-second target for this remediation. Future latency requirements must
be agreed explicitly. Completion still means a fresh plan accepted by HA and
reported as complete by the website, rather than a queued job or cloud publication.

## What the incident established

The current execution design has a structural scaling problem. One logical solve
is divided into many HTTP calls that repeatedly transmit the frozen input and
growing completed-auction ledger, parse that state and reconstruct planner context.
The canonical solver also performs substantial candidate search. Making jobs
durable fixes lost progress and premature failure; it does not remove either cost.

This is evidence for revisiting execution and data ownership. It is not evidence
that the physical model, economic objective, every controller component or the
entire application must be discarded. A future rewrite should have explicit
boundaries and acceptance evidence before replacing working contracts.

## Improvements already made

| Area | Improvement | Remaining exposure |
|---|---|---|
| Preparation | Independent evidence/settings reads overlap; unused write responses are omitted; the complete price archive is read through one scalar RPC instead of serial REST pages. | Input preparation still shares ingest with telemetry and other work. |
| HA history | Planning energy evidence is read once, unused SOC history was removed, and Recorder queue/read/wire timing was added. | Profile representative homes and hardware; one-house timings do not establish fleet capacity. |
| Solver work | Unchanged valuations and response projections are reused; transfer pricing is cached; a slice traverses planner stages without needless early stops. Ordinary slices use elapsed time instead of prematurely exhausting an operation counter. | The underlying candidate and transfer search remains expensive. |
| Durable execution | Ingest admits one immutable job and returns promptly. HA's existing receipt polls advance at most eight worker calls within a 25-second exchange budget. Results append once per batch; assembly/publication get a fresh request. | Every batch downloads accumulated results, and every worker call still receives accumulated state. |
| Ownership and recovery | Home-scoped claims, received-order revisions, fences and expected step counts reject obsolete or duplicate writes. Lease expiry permits takeover without discarding valid progress. Lost storage replies recover the authoritative receipt. | Progress currently depends on HA polling. Permanent worker/input failures remain explicit failures. |
| Publication and delivery | Current plan, run summary and terminal job publication are atomic. Exact snapshot/job recovery preserves configuration confirmation. Only matching HA acceptance completes the website request. | Large plan publication/delivery still costs data, parsing and database work. |
| Control continuity | HA retains the existing executable plan during pending/failed replanning. The portal distinguishes a rejected cloud plan from the plan actually running in HA. Durable results are accepted within their valid horizon without the former arbitrary issuance-age rejection. | A future implementation must preserve ownership and reconciliation through outages. |
| Database contention | Benchmark work was paced, cheap coverage metadata replaced unnecessary artifact reads, derived writes were narrowed, and lifecycle locking/fencing was corrected. | Benchmark/maintenance work still needs explicit resource isolation from customer traffic. |
| Measurement | Compact batch timings and streamed byte counters identify reads, worker calls, writes and final assembly without copying payloads for diagnostics. | Fleet metrics need CPU, queue delay, memory, cost and tail latency as well as request elapsed time. |

Automatic replanning for newly published prices is enabled. The existing gate
detects an extended published-price horizon or changed overlapping import/export
prices. An unchanged price refresh must not become another full solve. Manual
replanning remains supported.

The final remediation is commit `0db98cc`; related optimisations include
`e0f746f`, `7823c9e`, `54ecc3d`, `b507761` and `14ee92e`. The HA changes are recorded
in `shs-ha-integration`, including `10c04b4`, `340cdc5`, `f556920` and `0c5dd54`.

## Measured successful live run

The website click was at **20:31:55.479 Europe/Stockholm**. Cloud publication
committed at **20:38:49.526** and HA accepted the exact plan at **20:38:53.179**:
approximately **6 minutes 58 seconds from click to HA acceptance**. The website
subsequently showed matching plan IDs and an enabled replan button. Its exact
completion-render timestamp was not captured, so it is not included in that timing.

Plan: `2b5dd471-a3a0-4e81-a77d-0ad6194abaa0`.
Job: `2c9006a6-db85-4c3a-ae8f-b393275f5f6b`.
The canonical 288-quarter run completed **282 worker calls, 22 auctions and one
responsive ranking**, with 36 checkpoint commits and one assembly/publication pass.
HA subsequently reported ready, with no pending job/submission or planning error.

| Component | Approximate elapsed time |
|---|---:|
| Click through capture/preparation and job admission | 9.6 seconds |
| Worker calls, including network, parsing and computation | 317.2 seconds |
| Job receipt/claim/load/checkpoint operations | 34.3 seconds |
| Assembly | 0.18 seconds |
| Publication RPC | 2.56 seconds |
| Remaining transport, authentication, polling gaps and HA acknowledgement | 53.9 seconds |

The final row is the uninstrumented remainder, not a separately measured waiting
phase. Worker request duration is **not CPU time**. Do not size a fleet using it as
CPU consumption, or claim all of it is useful solver work.

Measured payload counters for this attempt:

- Approximately **997 MB** of request bodies sent from ingest to plan-step, and
  **48.9 MB** returned by plan-step.
- Approximately **133 MB** downloaded through 37 batch-load RPCs.
- Approximately **11.2 MB** sent through 36 checkpoint commits.
- Approximately **2.21 MB** in the final publication request.
- The completed auction/ranking ledger itself was approximately **5.87 MB**.

These are application body counts before wire compression, not billed traffic.
They make the amplification visible: a modest frozen input and a roughly 6 MB
result ledger generated almost 1 GB of repeated worker requests for one home.
Database CPU saturation can worsen delays, but a bigger database does not remove
that repetition. The infrastructure resource screenshot alone does not establish
which query or component caused its historical CPU peak.

Validation for the final code: 1,627 Deno tests, 60 local mocked-backend browser
tests, test frontend build, migration-version test and ingest typecheck passed.
Full repository lint passed with zero errors and 27 warnings. Astra's second
review found no remaining blocker. Migration and ingest were deployed directly
to TEST; GitHub CI did not start because of its account billing/spending block.
One successful live run establishes recovery for that case, not a fleet SLO.

## Scaling assumptions and the price-publication burst

Plan for hundreds of customer homes and approximately **1,000 controlled devices
across the fleet**. This is an explicit interpretation of the requested scale;
1,000 devices in one home would be a materially different solver problem and
must be tested separately if required. Device count alone is insufficient: the
number of coupled controllable loads, response alternatives, stores, horizon
quarters and solver iterations determines planning cost. Sensor-only devices
must not all become optimisation participants.

Keep unrelated homes independent. Within a home, battery, grid capacity and
shared physical equipment couple device decisions: blindly solving each device
in isolation can allocate the same headroom twice. Device/entity IDs are not
necessarily physical-owner boundaries. Benchmark both many small homes and a
few unusually complex homes; the expensive tail can dominate queue occupancy.

Daily price publication creates correlated demand. A job per affected home can
arrive in a short interval even when average traffic is low. Manual jobs will
arrive during that burst. Price region, tariff and customer configuration determine
which homes are affected; refreshing an unchanged catalog is not new publication.

For illustration only, replicating this observed run once across 300 homes would
produce **84,600 worker calls**, approximately **299 GB of worker request bodies**
and **40 GB of batch-load response bodies**. This is a linear scenario, not a
capacity forecast: different homes may cost more or less, and concurrency changes
latency and contention. It demonstrates why current transport costs should not be
carried unchanged into a larger deployment.

## Priorities if work continues

### 1. Remove amplification before choosing a language

Investigate keeping one job's immutable input and mutable solver state together
through a solve, rather than transporting the entire completed ledger on every
slice. Download input once, avoid repeated reconstruction, publish once, and keep
restart checkpoints proportional to genuinely new progress. Persist enough for
recovery without treating PostgreSQL as the scratchpad for every inner solver loop.

Measure network bytes, serialization, replay, useful search and CPU separately.
Rust/WASM may improve measured hot loops and memory use. A direct translation of
the current request topology and search would preserve its data amplification and
burst scheduling problem. No language/runtime/hosting decision is made here.

### 2. Establish the solver's cost and termination behaviour

Profile bid generation, charge/load pair scans, transfer/refinement iterations,
responsive ranking and full candidate re-solves. Identify where work repeats,
which dimensions grow combinatorially and which caches actually hit on live homes.
Compare an uninterrupted canonical solve with the distributed version on the same
frozen input, keeping private household data within authorised systems.

Avoid declaring a redesign successful from a small sunny fixture or a single
microbenchmark. Include dark days, negative prices, many response alternatives,
shared physical owners, batteries, EVs, thermal loads and competing constraints.
Any changed search/approximation must expose its quality and failure behaviour and
be evaluated against the economic objective. Do not silently shorten the horizon,
discard supported options or restore an arbitrary iteration/validity cutoff to
manufacture a latency result.

### 3. Design admission, fairness and supersession for a fleet

Specify global and per-home concurrency, resource limits, queue backpressure,
automatic/manual fairness and the state shown when admission is delayed. Manual
priority must not starve automatic work, and simultaneous price jobs must not
consume all capacity. Required CPU/memory and acceptable latency distributions
must be measured before choosing worker counts or infrastructure tiers.

Use one ownership model for automatic and manual jobs. Define when overlapping
requests can share work, when a new input supersedes a job, how obsolete compute
stops, and what happens after a worker crash. Sharing must respect the requested
freshness and configuration revisions. Do not return a different retained plan
as completion of a manual request. Prefer durable event identity and compatible
coalescing over running the same new-price solve repeatedly.

Current HA polling is an implementation fact, not a required future scheduling
model. Decide whether jobs should progress while a home is offline, how delivery
resumes, and how long paused work and artifacts are retained. Absence of a whole-job
deadline protects progress today; it is not a substitute for detecting stuck work,
fair scheduling and an explicit operational failure policy.

### 4. Separate executable data, explanatory artifacts and status

The small scheduling/job/acknowledgement path should not materialize multi-MB
plans. Investigate immutable artifacts with a small current identity and status,
and separate device commands from alternative candidates, histories and explanatory
series. Fetch detail only for the views that need it; preserve diagnostic evidence.

Avoid duplicated plan representations and the growing full-ledger checkpoint
pattern. Account for PostgreSQL JSON processing, compression, WAL, retention,
indexes and lock duration, not just stored row size. Keep mutation guards and
ownership commits short. Benchmark rescoring, training, retention and backfills
must have their own resource budgets and must not crowd out customer replanning.

Share immutable supplier/weather data where applicable, with identities that
include relevant location/region/tariff/model versions. Keep household history and
private state scoped to the home. Incorrect reuse is worse than a cache miss.

### 5. Keep real-time control independent of cloud planning

Scaling to 1,000 devices is also an execution/observation/adapter problem. Track
control-loop latency, HA event-loop delay, native command throughput, shared-owner
groups and device acknowledgements separately from planning duration. One slow
actuator or expensive solve must not block unrelated control operations.

Preserve local control of the accepted schedule while the cloud is slow or
unavailable. Publication, HA plan acceptance and actual device effects are distinct
states. Plan acceptance proves HA accepted the plan; it does not prove every device
command executed. Respect participation/authority, physical limits, reservations,
ambiguous delivery and reconciliation. Do not create an unrelated fallback
controller as part of an execution rewrite.

### 6. Make capacity and correctness gates explicit

Load-test a correlated new-price burst while manual requests, telemetry, portal
reads and ordinary device control continue. Include HA offline/slow acceptance,
storage timeouts, process death, lost replies, duplicate events, supersession and
restarts. Require isolation between homes, eventual progress, exact acknowledgement
and preservation of existing controls.

Measure p50/p95/p99 and the distribution of expensive homes: queue time,
capture/preparation, CPU, memory, calls/bytes, publication, HA delivery and website
observation. Record versions and identities without logging household payloads.
Define per-home/per-publication cost and retention estimates at target scale.
Keep UI status reads cheap and poll only while needed; do not turn customer count
into permanent one-second full-plan downloads.

## Requirements to carry forward

- Preserve the canonical physical/economic requirements unless a separately
  reviewed change explicitly modifies them. See [constraint requirements](constraint-requirements.md).
- Order work by receipt and locally generated revisions, not source timestamps.
  Do not restore arbitrary forecast bounds or issuance-age rejection gates.
- Preserve home isolation, idempotent admission, exclusive ownership, stale-owner
  fencing, atomic publication and exact HA acknowledgement completion.
- Keep prior control continuity through failures. Never announce success because
  a queue accepted work or a timeout returned quickly.
- Coordinate any plan/HA/frontend contract migration and generate the HA fixture
  from the real planner; maintain differential and failure/recovery validation.
- Establish the current baseline and migration/roll-forward plan before replacing
  components. More infrastructure or a language rewrite alone is not acceptance
  evidence for performance or fleet capacity.

## Source entry points

- [Ingest](../../supabase/functions/energy-optimisation-ingest/index.ts): telemetry,
  evidence preparation, new-price admission and receipt advancement.
- [Job lifecycle](../../supabase/functions/_shared/energy-planning-jobs.ts) and
  [batch migration](../../supabase/migrations/20261006203500_resume_planning_across_bounded_exchanges.sql):
  ownership, ordered checkpoint persistence, atomic publication and recovery.
- [Remote client](../../supabase/functions/_shared/energy-planning-client.ts) and
  [step/replay](../../supabase/functions/_shared/energy-planning-step.ts): repeated
  transport/reconstruction, household batches and synchronous fixed-plan preflight.
- [Dispatch solver](../../supabase/functions/_shared/planner/dispatch-plan.ts) and
  [pair pricing](../../supabase/functions/_shared/planner/pair-pricing-book.ts):
  candidate search, settlement/refinement and transfer-price reuse.
- [New-price policy](../../supabase/functions/_shared/replan-policy.ts): distinguish
  relevant price changes from unchanged catalog refreshes.
- [Control reconciliation](control-reconciliation.md) and
  [authoritative contract](authoritative-plan-contract.md): requirements a future
  execution or solver rewrite must preserve.

Current implementation details: [planning stages](supabase-planning-stages.md) and
[durable jobs](durable-planning-jobs.md). The [timeout audit](replan-timeout-audit.md)
retains historical investigations; its older execution inventories and latency
targets are superseded by this status.
