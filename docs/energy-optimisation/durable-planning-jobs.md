# Household planning receipts

Current implementation: 6 October 2026, commit `0db98cc`.
The website request, frozen snapshot and admitted job have distinct identities.
`PlanningJobs` owns snapshot/hash idempotency, home-scoped execution claims,
checkpoint commits, publication construction and exact receipt recovery.

Ingest prepares input and admits a job without solving in that initial request.
HA's existing receipt polls call `advanceForHome`, which claims a bounded batch,
loads ordered progress, calls the secret-only plan-step worker, and appends new
results once. Frozen input and completed results use order-preserving JSON.
The active auction/ranking cursor is saved separately from completed ledger parts.
Completion moves the job to assembling; a fresh request assembles and publishes.

Head revision orders received work. Home identity, fence, expected successful
step count, fixed-plan revision and observed manual request guard writes under
consistent locks. Lease expiry allows takeover without making elapsed time a
terminal failure. Stale owners cannot commit, fail or publish after takeover.
Duplicate commits cannot append the same results twice.

Current plan, run summary and terminal publication receipt commit atomically.
Lost checkpoint/publication replies recover the exact stored job, rather than
failing valid work or substituting another household plan. Snapshot recovery
retains the original configuration exchange needed for HA confirmation.

Only matching HA acceptance completes the manual request shown on the website.
Rejection reports the actual error; the previous accepted schedule remains under
HA control. The user prioritised successful completion over the earlier 10/12s
target. Healthy pending jobs have no overall lifetime/call cap; permanent worker
or invalid-input failures remain explicit failures. The cron sweep prunes terminal
history and never starts work. HA connectivity currently determines progress.

See [execution and remaining limits](supabase-planning-stages.md) and the
[improvements and scaling handoff](replanning-handoff-2026-10.md). Durability does
not remove repeated completed-ledger downloads or inter-function transport.
