# Ingest CPU exhaustion — 22 October 2026

The production ingest log at 15:52:36 UTC reported `WORKER_RESOURCE_LIMIT`,
`CPU Time exceeded` and HTTP 546, immediately after `inputs ready`. The later
`planning_job_not_found` 404 was consistent with HA recovering a submission
that had not reached durable admission.

## Cause and implementation

`prepareRulesPlanningInput` runs the room-heating Bellman search before
`PlanningJobs.accept`. The previous CPU fixture contained no rooms and measured
only the separate household worker. A synthetic 72-hour home with seven modeled
rooms and two empirical rooms consumed about 3.44 seconds of local CPU in
preparation alone. Allocation optimization reduced this to about 1.47 seconds
cold, leaving insufficient margin for the rest of ingest.

Room search now runs through the existing verified Rust/Wasm artifact. The
TypeScript domain API, sequential room ownership of shared household headroom,
grid resolution, action order, thermostat hysteresis, minute integration,
comfort penalties and tie-breaking are preserved. There is one executable room
search; no alternative planner was added.

The native search retains one kernel of exact physical outcomes, with at most
32 MiB of cached payload. Adjacent quarters with bit-identical physics and fixed
commands share it. Each quarter
still recomputes electrical feasibility, comfort, prices and future values.
Changing physics invalidates the kernel. Memo capacity limits stored results,
never admitted inputs or actions. A separate regression check covers native
linear memory, including allocator capacity. Forward reconstruction uses the actual
nongrid state and does not read the kernel. The verified module is shared by
room preparation and household selection; invocation memory remains private.
Binary ABI 12 adds the room entry point. Household problem ABI 11 is unchanged.
Deploy the matching ingest and worker artifacts together.

## Error identity

HA persists the original retryable upload error with its pending snapshot.
A recovery lookup can still find and deliver an admitted job after a lost reply.
If it instead returns `planning_job_not_found`, HA displays and reports the saved
upload error, including its original request ID. This survives restart. Successful
receipt recovery clears the upload failure and removes its saved submission error.

## Regression evidence

The existing cold CPU command now measures admission parsing, preparation,
tracing and RPC encoding for three 72-hour cases: nine rooms; two thermostats
and two relays in one room; and nine rooms with changing house forcing. Each
preparation median must remain below 1,000 reference-machine milliseconds,
independently of the 1,500-ms household-worker budget. It also checks native
linear-memory headroom. These local process measurements do not establish hosted
CPU or whole-process memory consumption for every installation.

Final cold medians on the local machine were 199 ms for nine rooms, 568 ms for
the mixed room and 881 ms for changing forecasts (212/605/939 reference-machine
milliseconds). Peak native linear memory was 4.6/29.8/4.1 MiB respectively.

Frozen original-TypeScript vectors check complete command and physical output,
including changing physics/prices/headroom. Native/Wasm parity also exercises
these vectors. Request-local admission and per-room trace stages identify work
if the hosted runtime terminates another request. Planner identity and generated
HA contracts are rebuilt with the kernel.
