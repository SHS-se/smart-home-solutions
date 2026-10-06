# Household planning receipts

The website request, frozen snapshot and accepted job have distinct identities.
`PlanningJobs` owns snapshot/hash idempotency, exclusive execution claim,
publication construction and exact receipt delivery. Ingest prepares input and
runs the older caller-memory Edge planning chain. Jobs persist input and final
state, never intermediate solver results.

The head revision orders received work. Publication checks head/fence,
fixed-plan revision and the observed manual request under consistent locks.
An operational deadline spans preparation and execution; expiry is terminal
and cannot restart work. A publication crossing its deadline rolls back its
current/run writes. The metadata-only cron expires lost owners and retains
bounded terminal history. A lost reply is recovered by reading the exact job,
not by returning another household plan or repeating the computation.

HA accepts the published plan through its existing authenticated acknowledgement.
Only this matching acceptance completes the manual request shown by the website.
The end-to-end ten-second requirement includes this delivery and the website's
confirmation. See [execution and remaining performance limits](supabase-planning-stages.md).
