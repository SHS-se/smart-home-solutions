# Planning within Supabase CPU limits

`energy-optimisation-ingest` stores observations and prepares the snapshot, then
calls the internal `energy-optimisation-plan-step` endpoint sequentially. Each
auction has three stages: bidding and settlement, paired energy transfers, and
cost refinement with diagnostics. Each invocation has its own CPU budget;
network waits do not consume ingest CPU. A call works through stages until it
has spent 1.2 s (`STAGE_BUDGET_MS` in the worker). The transfer and refinement
stages stop part-way at that point, transfers between two transfers and
refinement between two source quarters. Bidding and settlement cannot stop, so
a call starts the next auction only within its first 0.3 s
(`AUCTION_START_MS`). The next call resumes from the checkpoint, and the plan is
identical wherever the calls divide the work.

A call returns only what it added: the auctions it finished, and a checkpoint if
it stopped inside one. Ingest keeps the continuation and, once every auction is
done, assembles all three scenarios itself by replaying the finished auctions.
Assembly never searches: an auction missing from the continuation is a planning
failure. The multi-megabyte plan therefore never crosses the worker boundary,
and each auction result crosses it once.

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
Every call's log carries the original request ID, the auction and stage it
resumed, elapsed time, the auctions it finished and the stage the next call
resumes (`next`). Ingest's completion log adds the number of calls and the
assembly time. Public Home Assistant schemas and planner model versions are
unchanged.

## Deployment and verification

Deploy `energy-optimisation-plan-step` before deploying the updated ingest
function. `scripts/deploy-energy-planning.sh PROJECT_REF` provisions a random
`ENERGY_PLANNING_SECRET` only if missing, then deploys the stage endpoint. CI and
the local deploy script run this first. Existing secrets are preserved across
deployments. Both functions use the same Supabase project; there is no new paid
service or database migration. Deploy both whenever their
shared planning code changes. Incompatible checkpoint/wire changes require a
bump to `ENERGY_PLANNING_PROTOCOL`; a mismatch fails explicitly. Protocol 4
(incremental responses, ingest-side assembly) is one such change: between the
two deployments of a CI run, ingest's pushes fail with a retryable 502. Paused
stages only add optional fields to a checkpoint (`transferred`, `refinement`),
and a checkpoint without them resumes as before, so those did not need a bump.

Run `deno task test` for the full suite. The staged tests serialize every
continuation and compare complete output against the synchronous planner for
288-quarter sunny/dark snapshots, discrete EV alternatives and fixed schedules.
`deno bench --no-check scripts/benchmark-energy-optimisation.ts` reports total
planning time, individual stage time including JSON parsing/serialization, and
ingest's assembly time.

## Traffic

Supabase bills Edge Function egress as data sent to the client, so the
worker's responses to ingest count and ingest's requests to the worker do not. Before protocol 4, every call returned every finished auction again
plus the checkpoint, and the last call returned the plan. On the test home's
288-quarter input of 2026-09-19 that was 12 calls and 11.4 MB of decoded
responses per plan (1.49 MB gzip). With stages chained under the budget,
incremental responses and ingest-side assembly, the same plan took 8 calls and
2.05 MB (0.34 MB gzip), with the call budget scaled to a local machine. Ingest's
assembly took 39 ms locally. The worker's calls are still re-sent the whole
input and continuation, about 8 MB per plan, as request bodies.

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
the time. Refinement, the next largest at about 0.55 s on a local M-series
machine (the worker runs roughly twice as slow), pauses between source
quarters. Its checkpoint carries the cost the search last accepted instead of
rescoring it on resume: the incremental scorer counts a run that starts in the
first quarter from a different noise floor than a full rescore, and a resumed
search must compare trials against the same bar. The auction stage, bidding and
settlement, cannot pause; on that home's input it peaks at about 0.25 s locally.
