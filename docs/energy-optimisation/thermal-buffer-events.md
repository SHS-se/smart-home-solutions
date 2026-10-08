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
qualifying episode is available at the start of a plan. A quarter that starts
below this level may heat through it and earn credit.
That crossing quarter can overshoot slightly because commands are quarter-hour
relay bookings. Subsequent points require the heater to be off: the pool coasts
naturally above the threshold, through the frozen modeled need. Heating in a
quarter whose starting temperature has already reached the buffer threshold
spends the episode immediately. Stopping later cannot restore that episode's
credit; extra heating cannot buy a longer paid warm interval.
A restart with known OFF duration shorter than `pool_restart.threshold` closes
an active episode, even if water never fell below the buffer threshold.

A new start after at least the configured OFF interval (default 12 h) opens a new
cycle. It can earn points for a different event, never one already claimed in
this plan. Unknown OFF duration does not restore spent credit. The cycle
threshold remains effective when the restart deduction is disabled. Buffer
points and restart deductions remain independent rules. The `pool_hot` rule now
also deducts its configured points for heating when the quarter starts at or
above `target + pool_hot.threshold`, including the final day and adverse future
events. Its existing next-day comparison remains for warm water held without
an adverse day. Coasting during a supported future event does not incur the new
heating deduction.

The cheap-load rules omit only pool consumption already at or above the enabled
`pool_hot` threshold from their rewarded flexible watts. Concurrent EV or battery
charging can still earn those points. Physical supply attribution and dear-load
penalties retain all consumption. This prevents cheap heating from paying for
heat beyond the reserve. Disabling `pool_hot` also disables this cheap-credit
exclusion. Buffer and overheating thresholds remain independently configurable;
both defaults are +2°C. No weights have changed and no temperature validity
ceiling has been introduced.

These are plan-local claims: captured heater history determines OFF durations,
but the system does not invent an award history before the plan begins or
persist future planned awards as measured historical facts.

## Ownership and verification

ABI 5 producers supply local month and the effective cycle interval. The native
solver precomputes modeled needs with metered work; every builder label owns its
credit state, and final accounting replays the same transitions. Search guidance
values at most one crossing quarter and its modeled unheated coast, capped
by the frozen event and season; it no longer values an indefinitely heated warm
interval. Actual points still come only from replayed rule firings.

The referee stores model, weather, local months and actual heater starts. The
bench independently recomputes event eligibility and credit from those facts.
Older results without that evidence require rescoring, rather than fabricated
no-event evidence. Scorer 26 and referee 14 invalidate old stored evaluations.

The initial event refinement credited C-0717's original commands July 17
16:00–19:00 and July 18 07:15–08:45 (including the label 08:30). Under the subsequent
stop-and-coast refinement, those original commands continue heating after
crossing +2°C, so each episode receives only its crossing quarter before being
spent. Later July 18 bursts earn no buffer points.

The refined solver's C-0717 replay stops its initial run July 17 16:15, at a peak
of 32.519°C against a 30.5°C target. It earns two buffer points July 17 16:00–16:30
for the July 18 low-solar event, with no overheating points deducted. Its measured
bench score is 7 and grid cost 116.5971 kr. The model cools immediately after stopping;
in this trajectory it supplies only one further warm quarter, not a guaranteed
six or eight. Those counts must follow the thermal model rather than an invented
minimum reward duration. A synthetic model trajectory with seven subsequent warm
coasting quarters earns eight points in both native and independent scoring.

The former move-and-resize candidate reached 39.343°C and earned 121 buffer points;
it cost 338.4175 kr. Rescoring that same plan under the refined rules gives
−244 points, compared with +7 for the new plan. C-0905 still uses September 7 22:15–September 8 00:15 instead of
the late morning burst; under this rule version its measured score is 11 and cost
222.1875 kr.
