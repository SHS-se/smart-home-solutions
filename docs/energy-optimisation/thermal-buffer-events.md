# Thermal buffer events

The `pool_buffer` rule rewards one consecutive warm episode per heating cycle
and adverse future reheating event. Points remain the planner's first comparison;
existing cash and wear tie-breaks are unchanged. This rule does not introduce a
scheduler, temperature validity bound, or minimum run/off constraint.

## Evidence and event identity

For each quarter, start the existing thermal model at the owner's normal pool
target, with no heating, and project through future weather. The first quarter
below the existing mild comfort threshold (`target - pool_low.threshold`) is
the next unbuffered reheating need. No need within the horizon earns no buffer.

An event is the fully represented, horizon-relative 24-hour block containing that
need, later than the current block. It qualifies when its duration-weighted mean
import price is more than 10% higher than the current block, or its solar energy
is more than 10% lower. Solar justification requires both the award and modeled
need to fall in May–September in the home's timezone. Price justification works
in any month. Both reasons in the same block identify one event. Intraday peaks
are not separately segmented by this refinement.

The bench explains the cause, the event's inclusive start and exclusive end,
and the modeled reheating time. The event is frozen when the episode starts;
a changing prospective need while the water coasts cannot claim a second event.

## Credit lifecycle

Water must be strictly above `target + pool_buffer.threshold` (default +2°C),
using the same measured temperature rounding as other rules. The first observed
qualifying episode is available at the start of a plan. Credit can continue after
heating stops while the water remains warm, through the frozen modeled need.
A restart with known OFF duration shorter than `pool_restart.threshold` closes
an active episode, even if water never fell below the buffer threshold.

A new start after at least the configured OFF interval (default12h) opens a new
cycle. It can earn points for a different event, never one already claimed in
this plan. Unknown OFF duration does not restore spent credit. The cycle
threshold remains effective when the restart deduction is disabled. Buffer
points, restart deductions, and the existing separate overheating comparison
are independent rules.

These are plan-local claims: captured heater history determines OFF durations,
but the system does not invent an award history before the plan begins or
persist future planned awards as measured historical facts.

## Ownership and verification

ABI5 producers supply local month and the effective cycle interval. The native
solver precomputes modeled needs with metered work; every builder label owns its
credit state, and final accounting replays the same transitions. Search guidance
values the available episode and frozen event, not a sum of repeated rewards.

The referee stores model, weather, local months and actual heater starts. The
bench independently recomputes event eligibility and credit from those facts.
Older results without that evidence require rescoring, rather than fabricated
no-event evidence. Scorer25 and referee14 invalidate old stored evaluations.

Exact replay of C-0717's original commands credits July17 16:00–19:00 and July18
07:15–08:45 (the latter includes the quarter labeled08:30). Later July18 bursts
earn no buffer points. These are low-solar events for July18 and July19.
