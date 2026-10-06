# Planning within Supabase CPU limits

Household replanning runs in two Edge Functions. `energy-optimisation-ingest`
authenticates the device, writes telemetry and prepares one frozen input. It
accepts a snapshot-scoped job receipt, then drives the secret-only
`energy-optimisation-plan-step` endpoint inline. The caller holds completed
auctions, rankings and the unfinished cursor in memory. Each step uses the
900ms elapsed-time execution budget without reducing the planner's economic
search. An explicit operation limit remains available for deterministic
checkpoint tests; ordinary execution does not pause after two million checks
while time remains in its slice. Progress is exchanged between Edge Functions;
it is never written or repeatedly downloaded as a database result ledger.

The job owner claims the input once and publishes once. The transaction checks
received-order ownership, its fence, fixed-plan revision and manual request
identity. It writes current plan, run summary and terminal publication receipt
atomically. A single operational deadline spans input preparation and solve;
website requests use the server's request receipt time rather than resetting
the budget at ingest, acceptance or each step. A deadline crossed during
publication rolls back the entire new plan. Device/source timestamps never
order submissions or constrain measurement or forecast validity.

Cloud publication does not complete a website request. Only acknowledgement
that HA accepted the matching published plan completes it. Rejection reports
HA's actual error. The website polls content deltas every second while waiting.
The requirement is **ten seconds from website click through HA acceptance to
the website displaying completion**. The attempt deadline is a resource bound,
not evidence that this successful end-to-end requirement has been achieved.

The app retains exchange-version2 journals and exact job/snapshot status
lookup, so a response lost after acceptance or publication can be recovered.
A killed ingest invocation does not restart computation. The ten-second cron
sweep only expires overdue receipts and prunes bounded terminal history; it
never starts a solve. The existing HA schedule and controls remain retained
when planning fails. There are no planning-worker wakes or checkpoint tables.

Fixed-plan activation retains its existing preflight call through the same
remote client and plan-step endpoint. Its separate120-second activation budget
is unchanged. Household/manual attempts supply their explicit remaining budget.

## Validation and limitations

Run `deno task test`, migration-version validation, frontend lint/build and
all local E2E suites before committing. SQL tests cover permissions,
idempotency, exclusive claim, supersession, terminal expiry without retries,
publication rollback, exact receipt recovery, and completion after matching HA
acceptance. Pure solver tests compare full canonical output across serialized
steps, including sunny/dark, responsive, discrete-EV and fixed schedules.

Returning to caller-held progress removes the database amplification observed
in the checkpoint chain. It still resends completed progress between Edge
requests and reconstructs prior planner context. Local canonical288-quarter
fixtures measured roughly5–10seconds of computation alone. Hosted profiling
must establish the full click-to-confirmation target; neither a fast error nor
a quick queued response counts as success.
