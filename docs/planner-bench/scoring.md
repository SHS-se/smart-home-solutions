# Planner bench scoring

The bench measures service and demonstrated opportunities to reduce cost. A cheap export or expensive import is not automatically a mistake: an economic finding needs a feasible alternative schedule that serves the household equally well and preserves its final stores.

The car is deliberately treated as always plugged in. There are no arrival, departure or unplugged-charging penalties. This gives every planner the same opportunity to choose the best charging hours.

## Reading the result

- **Comfort:** how long the pool and car miss their target levels after those levels could have been reached.
- **Cheap and dear quarters:** a reward for running flexible load (pool, battery charging, car) where the price was among the plan's cheapest, and the matching loss for buying it from the grid where the price was among the plan's dearest.
- **Energy timing:** cost improvements demonstrated by a bounded search, shown in SEK and attributed to the decisions they change.
- **Physical failures:** requested actions the bench household cannot carry out. These fail the automatic verdict independently of the numeric score.
- **Coverage:** which conditions the case exercises, whether a rule found a loss, and which behaviours the bench does not model.

Every point is an integer. A comfort rule loses its configured points in each eligible quarter it fires. A demonstrated economic miss loses one point for each distinct quarter changed by accepted transfers under its primary rule, provided those prices were published when the planner ran. Transfers that change the same quarter under the same rule do not count twice; secondary explanatory labels add no points. A quarter with at least 500 W of flexible load gains 1 point when its real price is among the cheapest 25 % of the plan's quarters, or 2 points when among the cheapest 10 %; the two never stack. A quarter in which at least 500 W of flexible load is bought from the grid loses 1 point when the price is among the dearest 25 %, or 2 points when among the dearest 10 %, likewise never both. Every point is worth the same: a case score is the plain sum of what every rule gave and took, with no per-quarter cap. The planner score is the sum of its displayed case scores, with no caps, weights, averaging or 100–1000 conversion. SEK savings remain evidence beside the points; they do not set the point value. Physical failures determine pass/fail separately.

Historical scorer versions are not comparable. Rescore all successful results, including all six price/valuation lanes, whenever the scorer, referee or rules change.

The rules are one set for the whole bench (`bench_rules`, a single row of changes to the defaults): every case and every planner is scored with the same thresholds and points, so their totals can be compared. No rule scores 0.

## Rule catalogue

### Cheap and dear quarters

| Rule | Measurement | Points |
|---|---|---|
| Flexible load in a cheap quarter | Pool + battery charging + car ≥ 500 W, price in the cheapest 25 % of the plan's quarters, and not very cheap | +1 per quarter |
| Flexible load in a very cheap quarter | The same load, price in the cheapest 10 % | +2 per quarter |
| Flexible load bought in a dear quarter | Flexible load drawn from the grid ≥ 500 W, price in the dearest 25 % of the plan's quarters, and not very dear | −1 per quarter |
| Flexible load bought in a very dear quarter | The same grid draw, price in the dearest 10 % | −2 per quarter |

These judge where flexible load ran, not that less could have been spent: a plan that consumes more in cheap quarters gains points, whatever supplied it. The dear-quarter loss counts only what is bought: the flexible load, up to what the quarter imported from the grid. Flexible load is the load there was a choice about, so the quarter's import is counted as its first, and load the sun or the battery carries loses nothing. A dear-quarter loss needs no proved alternative, so it can fall on the same quarter as an energy-timing finding. Quarters at the same price share a rank, so in a plan with one price throughout every quarter is both very cheap and very dear, and the two cancel.

### Comfort and physical limits

| Rule | Measurement | Applicability |
|---|---|---|
| Pool below target | Time more than 1 °C below the case target | After its level was reachable, plus the recovery allowance |
| Pool far below target | Additional severity more than 2 °C below target; automatic service failure | Same reachability policy at this lower level |
| Car short of range | Time more than 50 km short of desired range | Always available to charge; reachability allowance applies |
| Car far short of range | Additional severity more than 100 km short; automatic service failure | Same policy at this lower level |
| Pool overheated | More than 2 °C above target while the plan's next 24 h are neither 10 % dearer nor 10 % less sunny than the 24 h it is in: −1 | Not judged in the plan's last 24 h, which have no next day |
| Warm thermal buffer | More than 2 °C above target while the next 24 h are at least 10 % dearer or have at least 10 % less sun: +1. Never together with “Pool overheated” | Same |
| Device power or storage limit | Requested power or additional charge/discharge that exceeds the configured bench capability | Every requested action; initial state outside a desired target is not itself a failure |
| Grid connection limit | Import or export above the bench site's rated connection | Every quarter |
| Invalid decision data | Missing/nonfinite decisions or negative directional power | Incomplete results cannot claim a valid score |

The default targets are pool 30 °C and car 300 km; a case can override them. A cold initial state is not charged against a planner before recovery was possible. The allowance is 24 hours after an independently calculated full-power trajectory first reaches the scored level. This is a benchmark recovery policy, not a new planner constraint or a promise of jointly optimal recovery. A level never reachable in the horizon is N/A, not a successful recovery.

### Energy timing

These labels explain shared evidence. Multiple labels on one opportunity do not multiply its penalty. Eligibility is conservative and identical for every planner on a case: for example, solar rules are N/A without surplus solar, and car timing is N/A when charging is unavailable at its initial charge limit. Flat prices alone do not make a rule inapplicable because COP, losses and the timing of other loads still matter.

| Rule family | What the alternative demonstrates |
|---|---|
| Low-value export before later import | Capture surplus, then use it later, with conversion losses and battery wear included |
| Expensive import with usable storage | Supply the load from storage without sacrificing more valuable later use or final inventory |
| Missed battery price spread | A charge/discharge transaction saves more than its purchase, conversion and wear costs |
| Battery spent too early | Moving discharge to a more valuable time reduces net cost |
| Space for incoming solar | Useful earlier discharge followed by solar capture improves the full schedule |
| Pool preheat before scarce energy | Earlier heat survives thermal loss and replaces more costly later heat |
| Pool wait for sun | Delayed heat is cheaper while the pool coasts without worsening service |
| Better-priced pool heating | Moving heat accounts for the heat pump's air/water-dependent COP, pump power and retained heat |
| Car charging timing | Shift charging to better-priced grid energy or solar while preserving service and final range |
| High-value export | Move battery discharge to a better export opportunity; pool/car timing also accounts for forgone export |
| Losing battery cycle | Remove or move a cycle whose full cost exceeds its benefit, including wear |

“Low” and “expensive” are relative to a proved alternative, not fixed price percentiles. Solar has the opportunity cost of its forgone export. Negative prices and high export prices therefore need no exceptions to the arithmetic. The energy-timing audit itself gives no reward for consuming in a cheap quarter; those are the separate cheap- and dear-quarter rules above.

No accepted improvement means **No loss found**, not “globally optimal”. Search coverage and its finite budget are part of the evidence. The search uses one-hour source/destination blocks across the full 72 hours, at most 2,500 replays total, and up to 120 accepted transfers per price basis. Small changes below 0.05 SEK or 0.05 kWh are excluded; later transfers are grouped to keep stored evidence compact.

## Tomorrow-dependent rules

For **sunny today, cloudy tomorrow**, the audit can move later heating into today's surplus. It replays pool temperature over the intervening quarters and checks whether the stored heat really avoids later cost after losses. A pool above target is allowed; excess temperature alone does not prove waste.

For **cloudy today, sunny tomorrow**, it can move today's grid-funded heat into tomorrow's solar window. The pool may cool in between if its service is not worse. It must still finish with at least the same physical heat inventory, so postponement cannot look better merely by leaving the pool colder at the end.

The same principle applies to the battery and EV: the audit evaluates a change and its future consequences as a transaction. It does not prescribe “always fill storage first” or a universal device priority.

## What makes economic evidence valid

1. Start from the recorded planner decisions and the bench's independent referee.
2. Search a bounded, deterministic set of transfers, including opportunities across days.
3. Replay each candidate with the same physics, load, solar and prices.
4. Reject new physical violations, more short quarters, deeper worst shortfall or greater degree-hour/km-hour deficits in either store, or lower final battery/EV/pool inventory beyond numerical tolerance.
5. Include the change in discharged-energy battery wear. Accept only a positive net saving.
6. Apply accepted changes cumulatively. Their net savings telescope to the reduction in grid cost and battery wear; overlapping explanations are not separately added.

This is a conservative lower bound on avoidable cost, not a perfect planner. Preserving every physical endpoint deliberately misses some pure waste-removal cases where excess terminal heat might reasonably be worth less. The old median-price terminal credit remains a displayed accounting estimate; it cannot create an economic finding or justify emptying a store.

The economic scale is the sum of absolute quarter cash exposure for passive base load minus solar, using the applicable import/export price, with a minimum of 1 SEK. It remains diagnostic evidence, identical for every planner on that case. It does not normalize points.

## Known prices versus hindsight

The normal **told** lane sees only prices published at the case start and estimates later prices itself. The **oracle** lane is a hypothetical run given every later actual price in advance. Both plans are evaluated at actual prices. A finding involving unpublished prices in the normal lane is shown as hindsight savings, not a knowable mistake. Known opportunities are searched before hindsight opportunities so the latter cannot consume the evidence for the primary economic score.

Solar/base-load series and outdoor temperature are shared bench inputs. Where the home measured a case's window, every plan and every replayed alternative is carried through the measured load and solar ([test cases](test-cases.md#measured-windows)); elsewhere through the forecasts. The six existing lanes continue to separate price information from valuation strength; valuation comparisons use raw comfort points so energy timing does not change the service threshold.

## Not modelled

Room heating, hot water, pool season/closure, EV arrivals/departures, manual overrides, actuator failures, subquarter PV spikes, uncertainty/risk reserves, actual demand tariffs, and real controller response need explicit test inputs/models before they can receive scores. Equipment start costs, native heater run protection and charger current quantization are not established by the quarter-average referee. “Feasible” here means feasible in the documented bench model, not a certification of controller execution.

The wider condition matrix in [models and delivery](../energy-optimisation/history/models-and-delivery.md#legacy-section-10.2) remains a source of scenarios. Current [planner requirements](../energy-optimisation/planner.md) and [constraint requirements](../energy-optimisation/constraint-requirements.md) take precedence over superseded historical assumptions.

## Rescoring

`bench/run.ts --shas none` recomputes evaluations from stored decisions. It does not rerun planners, rewrite decisions, or require their old git commits. It pages through the result store, processes all lanes, verifies versions after writing and reports incomplete coverage explicitly. Failed planner runs remain failed; a waiting case remains waiting. Missing decisions in an otherwise successful result are an error, not a perfect score.

The normal local validation commands are `npm run lint`, `npm run typecheck`, `npm run build:test`, `npm run test:e2e:local`, and `deno task test`. Tests cover prices of both signs, losses, future solar, physical limits, service preservation, terminal inventory, deterministic attribution and all-lane rescoring.
