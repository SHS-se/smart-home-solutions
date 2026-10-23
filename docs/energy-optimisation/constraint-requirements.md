# Requirements for planner and controller constraints

User requirement, 17 September 2026. This decision supersedes earlier proposals
for invented validity bounds or timestamp-based event ordering.

Do not invent arbitrary validity constraints. Do not add or restore such a
constraint unless the user explicitly states it as a requirement. Statistical
confidence, forecast error, assumed timing or an implementation convenience is
not authority to introduce a rejection condition. Every new validity constraint
must identify the explicit requirement it implements.

Base-load forecasts estimate future quarter-hour energy demand for economic
planning. They do not specify what instantaneous house consumption is allowed
to be. Base-load confidence bounds have been removed from calculation, snapshot
and plan contracts, validation and forecast storage. Do not reintroduce them,
rename them as another admissibility range, or replace them with a different
prediction-based gate without an explicit user requirement.

The controller uses measured instantaneous consumption, solar production and
battery state to execute the planner's strategy under the
[plan-execution and deviation-accounting specification](https://github.com/SHS-se/shs-ha-integration/blob/main/docs/controller-plan-execution.md).
The planner owns economic decisions and recovery authority. Energy deviations
are accounted for; they are not new forecast-validity gates or grid-use caps.
An ordinary difference between forecast and measurement calls for a different
action when appropriate; it must not cause the controller to give up solely
because the prediction was wrong. Unmodelled appliances remain part of measured
house demand.

Process events in the order received. Our own locally generated revisions may
track that order and identify superseded work. Timestamps from devices or other
sources must not be used to infer event ordering or reject a later received
update as time going backwards.

User requirement, 23 September 2026: realistic measured state beyond a desired
target — a car above its charge limit, a pool warmer than its stop temperature,
a pack below a raised cut-off, an empty car, a departure beyond the horizon — is
neither infeasibility nor invalid input. A reading no device can produce isolates
only its own device and is named for both interfaces; it never discards otherwise
valid household planning. See
[measured state and impossible readings](authoritative-plan-contract.md#measured-state-and-impossible-readings).

Configured equipment limits, user permissions and explicitly required data or
command checks retain their stated purpose. Do not turn them into a general
exception permitting invented checks, or confuse physical capability with
statistical prediction. Prefer removing unnecessary validation and state over
adding compensating mechanisms around it.

User requirement, 15 October 2026: available readings and forecasts are not
invalid merely because their source timestamps are old, future-dated, or differ
from other sources. Source provenance belongs in diagnostics, not configuration
errors or planning admission. Validate actual values and required forecast-slot
data; do not impose reporting cadences or source-age expiry. Plan expiry and
local snapshot/transport validity retain their existing purposes.

User requirement, 15 October 2026: imperfect observations and statistical model
quality must not stop household planning. Ignore unusable upload rows individually
and log counts; retain every usable row. The eight-day actuals window is a storage
window, not an exchange rejection. Sparse quarter profiles retain individual
observations and estimate empty quarters from observed neighbours, or the current
measured residual when no history exists. Label estimates explicitly. Five empty
profile quarters or five ignored items elevate the diagnostic to error severity;
neither severity prevents a best-effort plan.

A failed room or pool refit records its latest attempt independently of the last
usable parameters. Low confidence is a warning. Without identifiable thermal
parameters, retain known comfort intent using empirical electrical demand and
explicit device permissions; do not publish invented temperatures or remove the
household schedule. New room requests share the configured household headroom.
Meter disagreement is logged and displayed while measured battery-eligible demand
is reconciled within the existing supply permissions. No timestamp confirmation
gate or retired battery executor may take over from the durable native owner.

The planner home's installation address is the location authority. Coordinates
are a derived cache invalidated by an address edit. Server weather and irradiance
use that site; provider PV coordinates remain diagnostic source provenance and
cannot override it or reject a plan. An unavailable geocoder is a warning.

The native rules planner is the sole executable planner, including demos, replay,
fixtures and benchmark execution. Retained commands cover only real remaining
intervals; an expired or incomplete old horizon cannot prevent recovery. Current
inventory and control types govern regenerated device commands. Explicit reviewed
bookings use native command constraints throughout their absolute-time interval.
Configured hardware bounds and user permissions still apply.

User requirement, 16 October 2026: a comparison baseline must never block a
valid executable plan. Keep all native equipment and permission checks on the
selected commands. If baseline projection fails, publish that comparison as
infeasible with its reason, no forecast slots and no cost summary. Report the
unavailable comparison without fabricating savings or withholding the selected
schedule and its battery execution contract.

The comparison carries its own battery and EV states. It must load-balance EV
requests through supported charger settings under the same grid limit, rather
than relying on storage that only the selected strategy charged. Booked and
retained commands remain exact. Native projection certifies every resulting
flow; no grid limit is raised and no result is clipped or fabricated. A baseline
that still cannot run is unavailable. Disclose reduced charging and withhold
cost deltas when delivered EV energy differs instead of pricing missing energy.

User requirement, 17 October 2026: normal collection of history, model learning
and limited fit observations do not create warning banners. Keep their evidence
in diagnostics and informational logs. Operational failures, including an
unavailable savings comparison, remain visible. Forecast quality is separate
from device permissions and plan admission.

User requirement, 17 October 2026 (evening): the planner states each quarter's
battery mode — follow demand, cover demand above an import target, or a fixed
figure that also defends the house limit — from the candidate the optimiser
chose, never reconstructed from forecast flows. The plan lists every load it
separated from base load and which of them the battery may supply; HA executes
that law and the plan view describes the same instruction. See
[battery execution contract v2](battery-execution-contract-v2.md).

User requirement, 23 October 2026: an unplugged car retains future charging
planning and truthful cable telemetry. When a scheduled load cannot execute and
its work must move, forced household replanning is mandatory, including for pool
heating, battery charging and other devices. Release only the affected owner's
commitments needed to remove or reschedule the unexecutable work, including its
source and destination slots. All other executable loads retain the normal
next-hour hold (four quarters at a quarter boundary,
including intersecting slots for a partial current quarter). No household-wide
unlock or manual-click requirement is permitted for this case. Preserve actuals,
outstanding service, original deadlines, equipment limits and permissions. See
[execution-failure replanning and selective commitment release](authoritative-plan-contract.md#execution-failure-replanning-and-selective-commitment-release)
for trigger, retry, accounting and acceptance requirements. This is normative
design; implementation and deployment require separate verification.
