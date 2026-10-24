# Authoritative plan and truthful interfaces

User requirement, 24 October 2026: **EV departure time must not exist in the code.**
Do not configure, discover, infer, parse, validate, serialize or schedule against
an EV departure timestamp. There is no optional or null departure field and no
compatibility path for one. EV charging is ongoing household range readiness,
with the vehicle's `charge_limit_soc` as a physical cap. Plan the car as available
throughout the forecast horizon regardless of present cable state. The generic
service window ends at the forecast boundary; it is not a trip deadline. Only
actual inability to execute scheduled charging belongs to execution-failure
handling. Earlier optional, default, learned or future departure-time proposals
are superseded by this requirement.

Delivery is a coordinated roll-forward of the integration/app snapshot producer,
backend planner and portal readers to `charge_limit_soc`. There is no alias for
the retired cap field. Capture fresh vehicle measurements and generate a fresh
plan with the updated planner; historical snapshots remain historical evidence.

User requirement, 23 September 2026. Supersedes contradictory earlier designs.

The website Plan chart and the Home Assistant integration Schedule chart MUST
show the actual selected plan intended for execution, with the same plan identity,
quarters, device requests, energy flows and battery trajectory. An alternative
scenario must never be labelled as the actual plan. Verification simulates the
same requests; controlling permits hardware writes. It must not change bidding.
Historical measurements and controller adjustments are separate evidence, not
substitutes for the selected plan. Any planner/contract change MUST update and
verify both UIs and their shared consumer fixtures in the same delivery.

A UI exists to explain actual system behavior and provide effective controls.
A curve labelled current must be the resolved curve consumed by that plan, not
stored preferences or a reconstruction using newer measurements. Unsaved edits
must be labelled previews. Preserve meaningful controls; remove controls whose
meaning cannot be explained against the actual calculation.

Plans last for their original 72-hour forecast horizon. Routine measurement
exchanges must not rebid or extend that horizon. Automatic bidding happens on a
new published price release, after value curves are regenerated, and MUST also
occur for execution failures under the selective commitment-release requirement
below. Explicit manual replanning remains available on Plan. Other former triggers
retain their recommendation policy; execution-failure replanning is automatic.
A completed replan clears the recommendations it addresses. Verification/control
mode transitions change writer authority only, not the schedule: they request no
plan and recommend no replan, and a plan or battery reference captured under
either mode is accepted and executed under the other.

Realistic state above a desired target is not infeasibility. Invalid measurements
must be isolated to the affected device and explained; they must not discard
otherwise valid household planning. Targets and sensor validity are distinct.

## Replan recommendations

Quarterly telemetry exchanges do not authorize a new solve. Ingest compares the
published price rows with those recorded for the accepted plan; new publication,
an outstanding manual request or a mandatory execution-failure request permits
the next solve. Elapsed quarters simply leave the remaining original horizon
shorter. Forecast padding never identifies
a new price release. The original validity endpoint does not move.

The current row owns recommendation reasons and occurrence times. Both UIs read
that state. Curve/settings and planning configuration writes append a reason;
integration events outside the mandatory execution-failure path submit a
recommendation when the household must act manually.
A successful plan publication clears reasons that predate its solve; an event
that occurred during the solve remains visible. A failed solve clears nothing.

Compare four consecutive completed quarters entirely covered by the accepted
plan. Warn when each quarter differs by more than 50%, or when the absolute
difference of the **rolling four-quarter totals** exceeds 6 kWh. Missing quarters
break the sequence. Pack warnings compare measured energy against the accepted
plan's state at capture time and trigger above 4 kWh. No threshold requests a
solve. Expiry recommends a manual replan and leaves the original endpoint intact.

## Execution-failure replanning and selective commitment release

User requirement, 23 October 2026. This is mandatory design, not an optional
recovery feature. It supersedes price-release/manual-only replanning and blanket
first-hour lock rules specifically for the execution failures described here.
The implementation uses the durable HA execution journal, common planning job
receipts and owner-scoped solver commitments described below. Deployment remains
a separate operation.

### Planning and availability

The planner MUST retain an unplugged car's future charging need and plan charging
opportunities while preserving truthful disconnected cable telemetry. Being away
or unplugged now MUST NOT make the EV unavailable for the entire horizon. Known
away intervals constrain scheduling; where return time is unknown, future
charging is explicitly conditional on connection, not an invented arrival time
or a promise of delivered energy. The executor still requires actual connection
and current permission before charging.

This applies to EV charging, pool heating, battery charging and other scheduled
services: temporary inability to execute does not erase the service objective or
stop otherwise executable household instructions. A satisfied target, thermostat
permission without a demand for heat, or ordinary forecast variance is not by
itself evidence of execution failure.

### Mandatory automatic trigger

When observed absence, equipment unavailability or an evidenced command/response
failure makes a scheduled request unexecutable and requires moving that work or
revising its shared resource allocation, the system MUST request a forced
household replan automatically. It MUST NOT wait for a new price release, a manual
click, four completed quarters of deviation, or a recommendation being accepted.
An unplugged car with only a later conditional charging opportunity does not
trigger merely because it is unplugged now. A car still unavailable when its
scheduled charging becomes due does trigger; local recovery authority does not
make this forced replan optional.

The request MUST name the affected physical owner(s), affected absolute command
intervals, observed cause, current availability/state and relevant outstanding
service. It uses the common capture, solve, publication and exact HA-acceptance
path. Repeated reports of the same unchanged failure MUST NOT create repeated
identical replans; changed availability, failed replacement execution or a lost
remaining opportunity is new relevant evidence. A failed request remains visible
and uses the existing request retry mechanism. Reconnection or equipment recovery
MUST trigger another replan when the remaining accepted schedule needs changing;
otherwise the existing executable schedule resumes under current authority.

### Preserve the next hour for unaffected loads

The normal hold MUST preserve the HA-accepted commands on
`[capture, capture + 60 minutes)`. At a quarter boundary this is four quarters;
with a partial current quarter, preserve its remainder and every future command
slot intersecting that hour. The hold is a command commitment, not a cooldown
between planning requests. Keep its absolute capture anchor through job retries.

For an execution-failure replan, the planner MUST release only the affected
owner's commitments needed to remove or reschedule the unexecutable work. This
includes both the blocked source interval and destination intervals needed to
move that same load inside the held hour, even if it was previously OFF there.
The affected owner's eligible source and destination intervals may be revised
within that hour; publication records the absolute intervals actually changed.
Every unaffected owner's held commands MUST remain exact,
including OFF requests,
charger currents, thermal targets, battery strategy and permissions. Releasing
one load MUST NOT clear the household prefix, release unrelated battery commands,
or introduce new first-hour work for an otherwise unaffected idle owner. Outside
the held hour, ordinary household optimisation may change the remaining schedule.

The released scope MUST be supported by the failure evidence. If a shared physical
equipment failure affects several owners, identify each affected owner and
interval; it is not permission to unlock unrelated equipment. If rescheduling the
affected load cannot meet its objective while the other holds, equipment limits
and permissions remain enforced, publish the best achievable affected service and
its shortfall. Do not silently relax the other holds or cancel explicit user
bookings; report any booking conflict. A cheaper schedule alone does not justify
releasing a held command.

### Accounting, continuity and explanation

Replacement plans MUST use current measured state and delivered service, carry
outstanding objectives and their original deadlines, and explicitly account for
missed service. They MUST NOT count commands as delivery, add an already
incorporated shortfall twice, or move a missed deadline to claim fulfilment.
Pool comfort and other services retain their own outcome measures; electrical
kWh is not a universal substitute for service delivery.

Until a replacement is accepted, unaffected executable instructions continue.
Existing equipment protections, writer authority, pending-effect accounting and
release semantics remain authoritative. A forced replan is not a handback or a
new permission. Both interfaces MUST explain the blocked request, actual outcome,
forced replan status and affected commitment release, separately from the original
plan. An automatic recovery event is not a request for manual user action.

### Implementation boundaries

HA `Household.async_execution_observed` journals current unresolved availability,
pending evidence and planning receipts together. Normal captures also carry
`execution_availability`, so an ordinary price-driven plan cannot forget a fault.
A forced `execution_replan` names its immutable request ID, exact accepted plan ID,
observation time and owner changes with blocked absolute intervals. Admission
requires Controlling authority and accepted scheduled work; a candidate handover
rejection alone grants no release. A recovered, previously suppressed objective
may request a fresh schedule. Repeated unchanged faults survive replacement plan
IDs without creating new jobs; a newly missed conditional EV quarter is new
evidence. Failed or superseded work is retried through the existing exchange.

The prepared input keeps original accepted commands beside per-slot released and
unavailable owner masks. One native commitment module governs construction,
search and final certification. TypeScript room, water and baseline preparation
uses the same filtered commitment view, and publication independently checks
unaffected requests. Fixed user bookings remain exact. An independently owned
pool pump retains its own held draw even when the heater is unavailable.
Unresolved faults preserve current empirical consumption rather than assuming
that an unavailable actuator stopped; unconfirmed heat is not credited as delivery.

Temporary EV absence blocks the evidenced quarter. Later charging remains
conditional with false cable telemetry. Persistent hardware faults suppress new
executable work through the horizon until recovery is observed, while preserving
state, objectives and deadlines. Existing controller continuity still retains the
last device setting; an unavailable plan command is not an OFF write or a release.
Status surfaces expose automatic replanning and unresolved availability without
turning the automatic trigger into a manual action.

### Required acceptance evidence

| Trace | Required result |
| --- | --- |
| Unplugged EV with future charging need | Future charging remains planned, connection telemetry remains false, and execution requires connection. |
| Car absent when charging is due | Forced replan without a price release or manual click; only evidenced affected commitments are released. |
| Pool or battery cannot execute scheduled work | Same automatic path and selective release as the EV; unaffected household execution continues. |
| Affected load moves to a previously OFF slot within the held hour | Its required source and destination commitments can change; unrelated owners' commands remain exact. |
| Other loads held ON or OFF in the next hour | Their exact commands survive the replacement; freed capacity does not unlock them. |
| Mid-quarter capture and request retry | Original absolute held intervals and partial current-quarter coverage survive. |
| Repeated unchanged failure, then recovery | No identical replan loop; changed availability replans when the remaining schedule requires it. |
| Replacement delayed or fails | Unaffected valid commands continue; request status and unresolved service remain visible. |
| Remaining service cannot fit without moving another held load | Preserve that load's hold and report the affected objective's shortfall or explicit booking conflict. |
| Replacement after missed delivery or deadline | Current state and actuals are incorporated once; the original miss and deadline remain accounted for. |

## Measured state and impossible readings

Implemented in `marginal-value-planner-v43`.

A store bound limits what a schedule does to a store, not where the store may
be. A car above its charge limit, a pool warmed past its stop temperature, a
pack below a cut-off raised after it discharged, and configured battery targets
below a live cut-off are planned as they are. Only charge that raises a store
further above its ceiling, or discharge that lowers it further below its floor,
is infeasible; the trajectory carries the measured state rather than moving it to
the bound. This applies equally to the auction, the independent scorer, cost
refinement and replan continuity.

A reading no device can produce isolates that device alone: a state of charge
or charge limit outside 0–100 %, a car capacity outside 1–500 kWh derived from
its usable energy, or a pool water temperature outside −5–60 °C. The device
leaves the plan exactly as a disabled capability does, and its historical load
remains household demand. Home Assistant also leaves out a device whose reading
is unavailable, non-numeric or impossible and reports it in the snapshot's
`measurement_issues`. The plan publishes the complete list in
`measurement_issues`; the website Plan page and the Home Assistant panel both
show it. Configuration errors remain setup failures and are not isolated. When
a left-out device reports usable readings again, ingest recommends a manual
replan (`measurement_recovered_<device>`), because plans are kept between price
releases.
