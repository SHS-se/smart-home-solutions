# Measuring energy traffic

Instrumentation measures decoded HTTP response bodies and estimates outgoing
request-body bytes. It is not a Supabase billing meter: compression, headers,
transport and other applications are outside these counters. An unmeasured body
is counted separately, not reported as a measured zero-byte response.

## Browser

Open the energy page, expand **Traffic diagnostics** below the content, then
choose **Download traffic report**. This works even when no plan is available.
The JSON report covers all requests through this tab's Supabase client since
page load. Reloading the page resets it; downloading does not. It does not cover
other tabs, Realtime WebSockets, static website assets or other HTTP clients.

`endpoints` shows requests, HTTP/transport errors, decoded response bytes,
request-body estimates and aggregate request duration. `portal_sync` counts
initial loads, plan/configuration/model downloads, history upserts/removals and
polls with no changed payload. An unchanged payload still includes current
status metadata; it is not a zero-byte response. History counts combine the
electrical, price and device-quarter series and count updates as well as inserts.

## Backend

The following Edge Functions emit one structured `shs_network_traffic` log for
each non-OPTIONS invocation:

- `energy-optimisation-ingest`, `energy-optimisation-plan-step`
- `energy-optimisation-plan-ack`, `energy-optimisation-replan`, `energy-optimisation-fixed-plan`
- `integration-status`, `integration-tariff`, `integration-prices`, `ha-energy-ingest`

Filter their function logs for `shs_network_traffic`. Each report contains:

- `endpoint`, `status` and `response_body_bytes`: this function's outgoing body.
- `upstream.endpoints`: requests made through the instrumented Supabase clients,
  grouped by REST table/RPC or function endpoint. Planning-step calls made by the
  ingest function are included here too.
- `upstream.total`: aggregate counts for that invocation.

Sum `upstream.endpoints` entries starting with `GET /rest/`, `POST /rest/` etc.
by endpoint over a chosen interval to find the largest database responses.
Separately sum top-level `response_body_bytes` by function. `elapsed_ms` includes
body receipt; it is cumulative across concurrent calls and is not CPU time.
Null outgoing sizes/statuses and unmeasured upstream counters indicate incomplete
measurements. Failed and unauthorised invocations are included.

There are no telemetry database writes or additional HTTP requests. Counters
retain no query strings, request/response bodies, credentials, customer IDs or
home IDs. Endpoint cardinality is capped at 64 names plus an overflow bucket.
Instrumentation reads a cloned response before returning it, adding local body
processing/memory overhead but no extra network download. Only finite HTTP
responses are supported; do not attach this wrapper to streaming/SSE clients.

## Comparing with HA and Supabase

HA's integration diagnostics include equivalent session counters; see the
integration repository's `docs/network-traffic.md` for the download path.
**Do not add the reports from different observers together.** HA/browser
incoming bytes overlap the responding function's outgoing bytes. Likewise the
planning-step response appears at both caller and callee.

For an optimisation check, compare equal observation windows and comparable
activity: one with the portal closed and another with one visible tab. Rank
endpoints by `response_body_bytes`, then inspect request counts and mean bytes
per measured response. Allow enough time to include multiple 15-minute HA
exchanges; a short window can miss a large plan generation. Retain downloaded
reports externally if a longer history is wanted; counters are deliberately
in-memory and logs follow the project's existing retention policy.

Use Supabase's usage statistics for the actual billed daily/monthly total.
These reports explain traffic sources within their stated coverage; they cannot
prove a monthly allowance will be met. Direct database clients, other backend
functions and other users/tabs are not all covered by a single report.

## Reductions following the instrumentation

The September 12 follow-up removes redundant work without changing polling
intervals, plan generation, history retention or offline execution:

- Fixed-plan status polling calls `get_energy_fixed_plan_status`, returning only
  status metadata. The full planning snapshot and schedules stay in the database
  for status requests; activation still reads everything it needs. This RPC is
  security-invoker and uses the same current-plan row-level access policy.
- Thermal planning calls `get_energy_latest_room_temperatures`, selecting the
  latest reading per room with the existing six-hour cutoff and index. For six
  hours of complete quarter readings, this returns one row instead of 24 per
  room. The planner receives the same latest temperatures as before.
- Successful HA responses contain only one payload copy for clients declaring
  `X-SHS-API-Version: 1`. Undeclared readers retain their existing rollout aliases;
  error envelopes are unchanged. `Vary` distinguishes the success representations.
  This roughly halves large **decoded payloads**, not necessarily compressed
  wire bytes or the whole project's billed traffic.
- Device authentication reads the customer display-name view only for the status
  endpoint that returns it. Token validity, entitlement and the last-seen marker
  remain fresh on every request.
- Battery-presence updates only touch the row when the reported boolean changes.

Deploy migration `20260912100000_narrow_energy_status_and_temperature_reads.sql`
before deploying the changed Edge Functions. Current HA builds already send the
API-version header; no additional HA release is needed for this follow-up. The
existing traffic reports can compare these endpoints over equivalent activity
windows after deployment.

The September 19 follow-up addresses the largest remaining source, the planning
chain between `energy-optimisation-ingest` and `energy-optimisation-plan-step`.
The worker now returns each finished auction once and never the plan, which
ingest assembles from the auctions, and each call runs as many stages as its
CPU budget allows. On the test home's input this cut the worker's decoded
responses per plan from 11.4 MB to about 2 MB. See
[planning within Supabase CPU limits](energy-optimisation/supabase-planning-stages.md#traffic).
The full plan still goes to Home Assistant in every planned ingest response.
