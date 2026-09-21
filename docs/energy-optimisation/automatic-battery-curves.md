# Automatic battery curves

The automatic home-battery curve is selected against **published prices only**,
ending at the first missing price.
The selected curve is then used to solve the complete 72-hour plan. Estimated
prices in the remaining horizon do not determine the curve or enter the curve
comparison.

## Selection and comparison

The planner first derives a reference curve from the published-price window's
residual demand, solar, battery efficiency and configured wear. It retains the
existing covering-window construction and replacement-price cap for this
reference. It then tests that curve and twelve descending slopes with different
height and fullness values. Every candidate is dispatched over the published
window using the ordinary planner, including the other stores and equipment
limits.

Candidates are scored under **one unchanged reference objective**: published
import cost minus published export revenue, configured wear and power-shaping
costs, and the value of pool/vehicle service and energy left at the end of that
window. Changing a candidate curve cannot award itself more terminal value.
The search retains its incumbent unless a candidate improves that objective
without introducing additional dispatch infeasibilities. Existing inherited
conditions, such as an EV already above its charge target, are not turned into
new planning rejection rules.

This is a bounded search for the **best tested curve**, not proof of a global
optimum across all possible points or schedules. The search can select a curve
with a higher electricity bill if it delivers sufficiently more heat, vehicle
range or retained energy. Diagnostics keep the objective and electricity bill
separate and expose both before/after values, the reference curve, candidate
count, price window and generating snapshot.

“What would change?” re-solves both alternatives over published-price quarters
only. Import/export energy, running hours, stored energy and net cost all refer
to that same window. Net cost is the electricity bill, without assigning a cash
saving to differences in retained energy. Save and replan applies the chosen
curve to the complete 72-hour plan.

## Daily reuse

The cloud restores automatic results from this home's last published plan,
separately for hypothetical, execution and conditional battery-verification
contexts. The cache matches the
remaining published-price vector and its end, equipment/configuration and
preferences. Rolling past earlier quarters or receiving new SOC, temperature,
solar and demand measurements does not by itself rerun the search. Timestamped
service IDs are not configuration changes.

A new published quarter, a changed remaining price, or changed configuration
invalidates the record. The next fresh snapshot searches again. This responds
to actual price availability rather than a hard-coded publication hour or time
zone. There is no extra daily timer. Ordinary dispatch still replans against
current measurements and all 72 hours of forecasts.

Customer curves are never overwritten. To opt in, select **Use automatic curve**,
save, and replan. Fixed plans keep their explicit authority and do not run the
curve search. Trial solves use the existing staged worker and propagate failures;
they do not run inside ingest's CPU budget. Worker protocol 5 and planner v39
must be deployed together.

## Edge-function computation

The existing worker splits auctions into resumable stages with a 1,200 ms
planning budget. It only starts an additional auction within the first 300 ms
of a call, leaving headroom for bidding/settlement and serialization. These
per-call limits are unchanged. The 120-second chain deadline permits network
waits between calls; it does not increase the CPU budget of an invocation.
Ingest receives completed results and reconstructs the final plan without
running candidate auctions itself.

Local checks on the supplied replay used six worker calls for the initial
search (28 auctions across two planning contexts), and one call on reuse
(two auctions). Additional 72-hour dark/sunny cases with 48 hours of published
prices used eight/five calls. The slowest measured call was 638 ms including
JSON handling, and continuation requests stayed below 3.8 MB. These are local
measurements, not a guarantee of hosted performance. Supabase's published
[limits](https://supabase.com/docs/guides/functions/limits) allow two seconds
of CPU per request; 546 can also indicate memory exhaustion. Worker errors
remain explicit and are never retried as an inline ingest calculation.
