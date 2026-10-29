# Planner bench scoring

Scorer v32, referee v17, opportunity audit v14 (10 October 2026).

## Score and costs

A point is a krona. Higher is better:

```
points = comfort deductions − net bill
net bill = grid cash + battery wear + pool-start wear − capped end-store credit
```

Grid cash is purchases minus export revenue at real prices. Battery wear is
0.05 SEK per discharged kWh. Each actual pool-heater start costs 3 SEK once;
continuing an already-running heater costs no new start. These costs belong to
both planner physics and the independent referee, without extra cycle penalties.

End-store credit values the change from the starting state up to each store's
target, at the nonnegative upper median import price. Battery credit caps at
full charge, pool credit at comfort temperature, and car credit at the requested
range within its charge limit. Shared charging losses and heat-pump electricity
conversion are defined in `planner-wasm/end-credit.ts`. Above-target inventory
earns no extra credit. Scores compare planners on the same case; case scores
add into a run score.

## Six comfort checks

| Check | Default threshold | Deduction per quarter | Automatic case failure |
|---|---|---|---|
| Pool below target | More than 1 °C below | −1 | No |
| Pool far below target | More than 2 °C below | −1 | Yes |
| Pool overheated | Target +2 °C | −1 | No |
| Car short of range | More than 50 km short | −1 | No |
| Car far short of range | More than 100 km short | −1 | Yes |
| Boiler permission shortfall | Fewer than 10 allowed quarters per 24-hour sample period | −1 per missing quarter | No |

The two shortfall tiers stack. A level starts counting only when full power
from the initial state could have reached it, followed by 24 hours to choose
when to supply it. A level already met at the start counts immediately.
Pool overheating counts heating after the threshold has already been reached,
or warmth above it when the next full day is neither over 10% dearer nor over
10% less sunny. This cleanup preserves those service semantics.

Boiler permission shortfall is the referee's own check
(`REFEREE_RULE_DEFAULTS` in `rule-policy.ts`): no kernel planner is given it.
The 72-hour sample is divided into three consecutive 24-hour periods starting
at the sample's first quarter. Each period needs ten allowed quarters (150
minutes). Eight allowed quarters lose two points; ten or more lose none.
Each period's deduction is charged at its final quarter. Extra permissions
in another period do not cover a shortfall. Uncontrolled/free commands count
as allowed; controller overruns do not replace planned permissions. Midnight,
timezone and daylight-saving changes do not introduce extra periods.

This is the only hot-water penalty. It does not require boiler meters, infer
water temperature, or charge for deferred heating. The electrical simulation
can still shift recorded heating between quarters, but its remaining energy
counter is never converted to money or scored. The net bill is grid cost plus
modelled equipment wear minus the battery, pool and EV store credit.

Thresholds, nonzero points and enabled state remain configurable. A required
check firing fails the automatic case verdict; the planner still ranks its
candidates by the stated numerical score. This cleanup does not introduce a
new service-priority hierarchy.

## EV battery supply permission

Battery supply to the EV is a permission boundary, independent of rule points,
prices and grid capacity. The benchmark defaults to disallowing it. Production
publishes the existing selected supply scope: base load plus non-EV device keys.
The native ready problem explicitly carries the permission and any passive EV
forecast included in base load. Every battery mode, including export, obeys it.

On the shared bus, self-consumed PV is allocated proportionally to eligible
gross demand. Battery house supply cannot exceed the remaining eligible load.
If excluded EV demand remains, calling discharge an export cannot bypass that
bound. If PV covers the whole household, separately permitted battery export
may continue. This is accounting permission, not a claim about physical routing.
The existing Home Assistant controller applies the same scope to live measured
demand. The referee clips and reports fixed-power violations as `battery_supply`;
measured demand-following changes are capped by permission rather than scored
as an impossible forecast request.

The benchmark import limit is 17.2 kW. Removing the erroneous 13.2 kW import
restriction and enforcing this permission are separate changes.

## Eleven actionable economic audit families

The audit retains solar exported then bought back, battery headroom for solar,
pool solar preheating, waiting for solar, avoidable imports, battery price spread,
preserving battery energy, high-value export, cheaper pool heating, EV timing,
and uneconomic cycling.

Each finding proves a feasible edit by replaying it through the same physics,
with comfort no worse and final stores preserved within declared tolerances.
Accepted edits accumulate into one improved plan; each saving belongs to one
finding once. Family tags explain it without multiplying its money. Known-price
findings are distinguished from hindsight; known opportunities are searched first.
The Rust planner uses causal economic witnesses to propose and accept improvements
when they improve its score. The benchmark audit reports independently evaluated
savings and never adds a duplicate penalty to the bill.

The search is bounded and greedy. No finding means no demonstrated improvement
in the searched edits, not global optimality. Exhaustion and applicability remain
visible. A physical violation fails the case regardless of score. Missing or
stale bill/audit evidence cannot enter a complete current-version comparison.

## Removed criteria

The twelve obsolete evidence criteria and both cycle deductions are deleted:
`pool_buffer`, `cheap_buy`, `cheapest_buy`, `dear_load`, `dearest_load`,
`base_load_dear_import`, `base_load_dearest_import`, `missed_cheap_quarter`,
`arbitrage_no_export`, `arbitrage_not_full`, `large_load_overlap`,
`early_grid_charge`, `pool_restart`, `pool_short_gap`.
`ev_from_home_battery` is replaced by the permission above. There are no noted
criteria. A one-time SQL migration removes their stored overrides and earlier
retired overrides; runtime validation rejects unknown rule keys.
