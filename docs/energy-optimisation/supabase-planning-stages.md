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
