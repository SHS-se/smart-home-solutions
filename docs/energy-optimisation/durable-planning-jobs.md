# Durable household planning jobs

## Problem
Move actual automatic/manual household solves out of ingest lifetime, preserve completed work through killed workers, and publish current plan/run/manual completion transactionally without changing planner economics. Use existing Supabase pg_net/pg_cron, no extra host.

## Usage (caller first)
Ingest authenticates and validates, handles job-id or submitted-snapshot status before telemetry/preparation, looks up submitted snapshot id/source hash, prepares only new captures, then calls jobs.accept({homeId,customerId,snapshotId,sourceHash,input,context}) and returns 202 receipt alongside exchange watermarks/configuration.
Worker authenticates database-owned wake token, then calls jobs.advance(jobId). That method claims, loads frozen input and append-only results, advances bounded search OR assembles/publishes in a separate invocation, and atomically commits the continuation.
HA journals a tentative submission identity before its push. A confirmed receipt replaces the accepted job identity; telemetry-only replies clear only the tentative submission. Household saves the confirmed job identity with local configuration revision, host-owned poll task loads only job_id, and common plan acceptance logic validates/applies/acks terminal published result. Restart resumes saved receipt; waiting never owns push lock. Before acceptance the app journals capture identity so a snapshot-only lookup can recover a lost acceptance reply.

## Shape and signatures
One deep _shared/energy-planning-jobs.ts owner hides RPCs, leases, continuation storage, publication building, thermal projection, archives, and receipt interpretation. Pure planner/step own exact numeric cursors. Thin worker owns authentication. Ingest owns enrichment/telemetry. Existing fixed-plan preflight client/plan-step remain actual callers sharing the bounded solver. Search slices use the shared900ms/two-million-boundary budget.

RPC agreement (all service-only, payloads raw unnamed json arguments where shown):
accept_energy_planning_job(json): {home_id,customer_id,snapshot_id,source_hash,input,context,protocol} -> receipt
read_energy_planning_job(p_home_id uuid,p_job_id uuid DEFAULT NULL,p_snapshot_id uuid DEFAULT NULL): receipt|null (includes source_hash on snapshot lookup)
claim_energy_planning_step(p_job_id uuid): {id,home_id,customer_id,snapshot_id,protocol,fence,step,phase,input,context,continuation,completed,rankings}|null
commit_energy_planning_step(json): {job_id,fence,step,completed,rankings,continuation,phase:'solving'|'assembling'} -> receipt|null for stale fence
publish_energy_planning_job(json): {job_id,fence,step,current,run} -> receipt|null
fail_energy_planning_job(json): {job_id,fence,step,code,detail} -> receipt|null
verify_energy_planning_token(p_token text): boolean

Context fields: request_id, integration_version, thermal_zones, fixed_revision, observed_replan_request_id, replan_request_id (capture's explicit reply identity).
Receipt: {job_id,state:'pending'|'published'|'superseded'|'failed',pending:boolean,retry_after_ms:1000 when pending,plan/plan_id/snapshot_id when published,code/detail when failed}. Status includes exact stored current plan only if identity remains current; TS expands storage-form schema9 before delivery. Never substitutes a newer plan.

Private heads(home_id PK,revision,active_job_id) allocate local receive order. Private jobs unique(home_id,snapshot_id), frozen input/context/protocol/source_hash; mutable phase/step/continuation/fence/lease_until/expiry_count/wake_after/error. Private parts PK(job_id,kind,ordinal), append-only auction/ranking. Payloads json preserve ordering; publication existing jsonb preserves current storage contract. Consistent head -> current -> job locking, service-only RPCs own state. Job claims exclusive30s, fenced by fence+step; repeated expiry at same cursor terminal after4. No adaptive fallback, no reliance on beforeunload.
Acceptance compares current fixed/manual identity against frozen context and supersedes older active job. Idempotent identical snapshot/source_hash returns prior receipt; conflicting reuse errors. Commit guarded by head/current identities, inserts only new results, replaces active continuation, resets lease expiry counter, schedules next wake transactionally. Publication same guards and writes current/run/manual completion/job terminal in one transaction; existing store allowlist/ack/recommendation behavior preserved. Replan ordering by request identity and database received revision; no source timestamp event-order gate added. Noncritical archives outside mandatory publication.
Private credential/wake helper patterned on weather cron. Acceptance/commit net wake within transaction; cron10seconds sweeps bounded due pending/expired leases and bounded terminal retention. Failed worker survives only at last committed cursor. Published input/results retained7days, failed14days; no age rejection of active work.

## Synthesis decision
Codex aggregate/ledger base won on compact caller interface and scoped migration. Graft Claude's json payload order preservation, host-owned delivery polling, explicit acceptance protocol and separate measured assembly. Reject Claude's asynchronous fixed-plan portal migration as unrelated scope; reject shutdown-hook checkpoint reliance and adaptive budgets as unnecessary uncertain mechanisms. Reject timestamp ordering interpretation: durable acceptance binds the observed pending request by identity; publication completes that exact identity without source-time ordering.

## Tradeoffs accepted
- Accept more DB reads/wakes for worker-independent lifetime and recoverable progress.
- Accept numeric cursor complexity for exact search equivalence through serialization.
- Accept coordinated cloud/app protocol deployment for one explicit durable household exchange.
- Accept hosted resource verification after local tests; no promise every546 disappears.

## Alternatives considered
Client-driven continuations lose liveness on disconnect. Full checkpoint blobs rewrite all completed work. New worker host removes limits but is deferred by user. Merely durable preparation leaves long uninterruptible search unchanged.

## Risks and falsifiers
Exact JSON-roundtrip checkpoint equality is required. Bid ledgers and accepted floating-point costs must survive, not approximate reconstruction. Single primitives/replay/serialization must fit hosted CPU/memory, with stage-start logs and attempt identity. Assembly benchmark currently22–24ms locally for288slots. No hosted deployment requested. First implementation units: bounded solver equivalence and transactional SQL concurrency/rollback tests, then integrate callers.
