# Planning within Supabase CPU limits

`energy-optimisation-ingest` stores observations and prepares the snapshot, then
calls the internal `energy-optimisation-plan-step` endpoint sequentially. Each
call executes one auction stage: bidding and settlement, paired energy transfers,
or cost refinement and diagnostics. A final call assembles all three scenarios.
Each invocation has its own CPU budget; network waits do not consume ingest CPU.
The transfer stage can also stop between two transfers once its call has spent
1.2 s (`STAGE_BUDGET_MS` in the worker); the next call resumes it from the
checkpoint, and the plan is identical either way.

The stages use the same generator as the synchronous planner. A continuation
contains numeric schedules, trajectories, allocations and completed auction
results. Store callbacks are rebuilt from the unchanged input snapshot. Completed
auctions are reused, including the EV alternative and fixed-plan prefix/suffix
cases; the search is never restarted. The captured planning time remains fixed
across calls, keeping freshness checks and output deterministic.

Ingest holds continuations only for its current request. No partial plan is
stored or sent to Home Assistant. Once every stage succeeds, ingest stores and
returns the finished plan through the existing SHS API envelope. Worker failures,
including HTTP 546, return an explicit retryable `planning_failed` HTTP 502.
Invalid snapshots retain HTTP 400. There is no inline retry or local solve on
worker failure. The stage chain has a 20-second deadline and a 64-call limit,
leaving room inside the integration's existing 30-second request timeout.

The step endpoint requires the project's `ENERGY_PLANNING_SECRET` in the
`x-shs-planning-secret` header; device tokens and user JWTs cannot submit work. It has no database access.
Every stage log carries the original request ID, auction index, stage, elapsed
time and the stage the next call starts (`next`). Public Home Assistant schemas
and planner model versions are unchanged.

## Deployment and verification

Deploy `energy-optimisation-plan-step` before deploying the updated ingest
function. `scripts/deploy-energy-planning.sh PROJECT_REF` provisions a random
`ENERGY_PLANNING_SECRET` only if missing, then deploys the stage endpoint. CI and
the local deploy script run this first. Existing secrets are preserved across
deployments. Both functions use the same Supabase project; there is no new paid
service or database migration. Deploy both whenever their
shared planning code changes. Incompatible checkpoint/wire changes require a
bump to `ENERGY_PLANNING_PROTOCOL`; a mismatch fails explicitly. A paused
transfer stage only adds an optional `transferred` list to its checkpoint, and a
checkpoint without one resumes as before, so it did not need a bump.

Run `deno task test` for the full suite. The staged tests serialize every
continuation and compare complete output against the synchronous planner for
288-quarter sunny/dark snapshots, discrete EV alternatives and fixed schedules.
`deno bench --no-check scripts/benchmark-energy-optimisation.ts` reports total
planning time and individual stage time, including JSON parsing/serialization.

Stage boundaries reduce CPU per invocation rather than total computation. An
individual stage can still reach Supabase's limit as workloads grow. Use the
stage logs to identify which stage needs a finer checkpoint; keep plan semantics
and the HA response contract unchanged when adding one. Thermal preparation and
training remain in ingest and retain their existing bounded work.

The transfer stage was the first to need one. On 2026-09-19 the battery
verification auction of a 288-quarter plan accepted about 90 transfers, each
rescanning every charge/discharge pair, and that stage alone ran 2.1 s on the
worker before Supabase terminated it (546, relayed by ingest as 502). It now
pauses between transfers, and its scan does the same arithmetic in about half
the time. The auction and refinement stages cannot pause. On that home's input
they peak at about 0.25 s and 0.55 s on a local M-series machine, and the worker
runs roughly twice as slow, so refinement is the next candidate for a finer
checkpoint.
