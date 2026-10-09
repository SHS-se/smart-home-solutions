# Planner bench scoring

The bench measures service and demonstrated opportunities to reduce cost. A cheap export or expensive import is not automatically a mistake: an economic finding needs a feasible alternative schedule that serves the household equally well and preserves its final stores.

The car is deliberately treated as always plugged in. There are no arrival, departure or unplugged-charging penalties. This gives every planner the same opportunity to choose the best charging hours.

## Reading the result

- **Comfort:** how long the pool and car miss their target levels after those levels could have been reached.
- **Cheap and dear quarters:** a reward for running flexible load (pool, battery charging, car) where the price was among the plan's cheapest, and the matching loss for buying it from the grid where the price was among the plan's dearest.
- **Dear base-load imports:** −1 when at least 500 W of base load is grid-supplied in the dearest 25% of quarters and spare battery power and energy could cover all of it; −2 in the dearest 10%, never both.
- **Missed cheap quarters:** −1 when purchase price is below 1 SEK/kWh and a flexible store is below target, but no EV charging, home battery charging or pool heating draws at least 500 W.
- **High-sale arbitrage:** two independent losses per quarter with sale price strictly above 4 SEK/kWh: −1 for no grid export and −1 for missing full-charge preparation before the first opportunity.
- **Large workload overlap:** −1 when two loads each exceed 2 kW in the same quarter and a legal EV or home-battery charging move to a cheaper quarter is demonstrated, keeping pool heating fixed.
- **Short interruptions:** −1 per avoidable 1–4-quarter gap in EV charging or pool heating when each gap price differs from both bordering running quarters by at most the larger of 10 öre/kWh or 10% of its own absolute price.
- **Energy timing:** cost improvements demonstrated by a bounded search, shown in SEK and attributed to the decisions they change.
- **Physical failures:** requested actions the bench household cannot carry out. These fail the automatic verdict independently of the numeric score.
- **Coverage:** which conditions the case exercises, whether a rule found a loss, and which behaviours the bench does not model.

Every point is an integer. A comfort rule loses its configured points in each eligible quarter it fires. A demonstrated economic miss loses one point for each distinct quarter changed by accepted transfers under its primary rule, provided those prices were published when the planner ran. Transfers that change the same quarter under the same rule do not count twice; secondary explanatory labels add no points. A quarter with at least 500 W of flexible load gains 1 point when its real price is among the cheapest 25 % of the plan's quarters or in a stretched valley, or 2 points when among the cheapest 10 % with at least 1 kW of that load; the two never stack. A quarter in which at least 500 W of flexible load is bought from the grid loses 1 point when the price is among the dearest 25 %, or 2 points when among the dearest 10 %, likewise never both. Every point is worth the same: a case score is the plain sum of what every rule gave and took, with no per-quarter cap. The planner score is the sum of its displayed case scores, with no caps, weights, averaging or 100–1000 conversion. SEK savings remain evidence beside the points; they do not set the point value. Physical failures determine pass/fail separately.

Historical scorer versions are not comparable. Refresh the current branch comparisons when the scorer, referee or rules change. Historical results and diagnostic lanes remain excluded until explicitly refreshed or rescored; saving rules also reruns rule-driven planners whose decisions depend on them.

The rules are one set for the whole bench (`bench_rules`, a single row of changes to the defaults): every case and every planner is scored with the same thresholds and points, so their totals can be compared. No rule scores 0.

## Rule catalogue

### Cheap and dear quarters

Prices come in waves, and a fixed share cuts through them: quarters a hair over the line used to split one valley into runs too short to use. Since scorer v27 the cheap share (+1) stretches along a valley by a factor of 1.3, so 25 % reaches at most 32.5 %. A valley is an unbroken run of at least 8 quarters in the share itself. It stretches through every adjoining quarter within the stretched share, so it grows at both ends and joins whatever lies within reach, and every quarter it reaches counts as cheap. A quarter beyond the stretch (a price spike, say) ends it, and a run of fewer than 8 quarters in the share stays as it was. The very cheap share (+2) and the dear shares stay exact. The very cheap reward also needs at least 1 kW of flexible load; between 500 W and 1 kW such a quarter gains the cheap point. The planner kernel applies the same rules to the prices it plans on (`PRICE_BRIDGE_STRETCH`, `PRICE_BRIDGE_MIN_QUARTERS` and the 1 kW floor in `score.ts` and `planner-core/solver/src/policy.rs`).

| Rule | Measurement | Points |
|---|---|---|
| Flexible load in a cheap quarter | Pool + battery charging + car ≥ 500 W, price in the cheapest 25 % of the plan's quarters or in a stretched valley (above), and not earning the very cheap reward | +1 per quarter |
| Flexible load in a very cheap quarter | Pool + battery charging + car ≥ 1 kW, price in the cheapest 10 % | +2 per quarter |
| Flexible load bought in a dear quarter | Flexible load drawn from the grid ≥ 500 W, price in the dearest 25 % of the plan's quarters, and not very dear | −1 per quarter |
| Flexible load bought in a very dear quarter | The same grid draw, price in the dearest 10 % | −2 per quarter |
| Dear base-load import the battery could cover | Imported base load ≥ 500 W, price in the dearest 25% but not very dear, and battery can cover the whole imported base load | −1 per quarter |
| Very dear base-load import the battery could cover | The same battery capability, price in the dearest 10% | −2 per quarter |
| Missed cheap charging or heating quarter | Purchase price < 1 SEK/kWh; battery < 100% SOC, EV below desired range or pool below desired temperature; no EV charging, home battery charging or pool heating draws ≥ 500 W, including devices already at/above target | −1 per quarter |
| No export during a high sale-price quarter | Actual sale price > 4 SEK/kWh and grid export is zero | −1 per quarter |
| Battery not fully charged before arbitrage | Actual sale price > 4 SEK/kWh and the last battery charge before the first qualifying quarter did not finish at 100% SOC | −1 per quarter |
| Large workloads overlap with cheaper capacity available | At least two of pool heating, EV charging and home battery charging each strictly exceed 2 kW; EV or home battery charging has a demonstrated feasible move to a distinct strictly cheaper quarter anywhere in the 72 h, with pool heating fixed | −1 per overlapping source quarter |
| EV supplied by home battery | Positive home-battery power attributed to EV charging after supplying all non-EV household demand and excluding battery exports and simultaneous battery charging | −1 per quarter |
| Short interruption in EV charging | A feasible continuous alternative exists for a bracketed 1–4-quarter charging gap; each gap price differs from both bordering running quarters by at most max(0.10 SEK/kWh, 10% of its own absolute price) | −1 per gap quarter |
| Short interruption in pool heating | The same test, for pool heating | −1 per gap quarter |

These judge where flexible load ran, not that less could have been spent: a plan that consumes more in cheap quarters gains points, whatever supplied it. The dear-quarter loss counts only flexible demand remaining after battery supply, capped by actual grid imports. First subtract battery exports from discharge, then assign the remaining discharge to flexible demand (pool + EV + battery charging) before base load. The scored grid power is `min(grid import, max(0, flexible demand − max(0, battery discharge − grid export)))`, rounded to the stored 0.1 W precision. Only a remainder of at least 500 W can lose points. These flexible-load rules do not penalise base-load imports, while battery energy exported to the grid cannot also cover flexible demand. Solar supply remains accounted for through the actual grid-import cap. A dear-quarter loss needs no proved alternative, so it can fall on the same quarter as an energy-timing finding. Quarters at the same price share a rank, so in a plan with one price throughout every quarter is both very cheap and very dear, and the two cancel.

The base-load rules are independent per-quarter preferences. The −1 and −2 tiers never stack; disabling the −2 tier allows the −1 tier to cover those quarters. Attribute grid imports to flexible demand using the same accounting as the dear-flexible-load rules, then to fixed hot water, then cap the remainder by base load (`load − pool − EV − hot water`). The battery must cover **all** of this imported base load, at least 500 W, using spare discharge power and energy remaining above its physical cut-off after the quarter's existing battery actions, including discharge efficiency. Quarters with battery charging are excluded. Availability is calculated from unrounded referee state, with power rounded down to stored precision, rather than rounded display SOC. This uses actual prices over all 72 hours, including unpublished prices, and the same rank convention as the other dear-price rules. The shared percentile threshold, points and enabled state are configurable.

Each quarter is checked against the original plan independently. Battery energy is not reserved across these hypothetical changes, final battery inventory is not held fixed, and saving the battery for a later peak does not exempt the import. This rule expresses a preference, not demonstrated bill savings, and can stack with flexible-load and economic-audit penalties. Results lacking the new referee evidence must be recomputed before they can have a complete stored score.

The missed-cheap-quarter rule applies to single quarters, including the first quarter and isolated low-price slots. It compares end-of-quarter store levels with the exact comfort targets, without the comfort rules’ shortfall bands or recovery grace period. The home battery target is full (100% SOC). At least one store must be below target; any EV charging, home battery charging or pool heating drawing at least 500 W avoids the penalty, even if its own store is already at or above target. For example, a running pool heater counts throughout its heating cycle while the battery remains below full charge. Several draws below 500 W are not added together. Multiple idle stores still lose only one point per quarter. Actual purchase prices are used across all 72 hours, including unpublished prices, like the percentile rules; zero and negative prices qualify. This is a charging/heating preference with no alternative-schedule search, and can stack with other rules. The price threshold, points and enabled state use the shared bench rule settings.

### High-sale arbitrage

For each rule, a qualifying quarter has an **actual sale price strictly above 4 SEK/kWh** by default. Exactly 4 does not qualify. These use the sale price, not the purchase price, across the whole case, including unpublished prices.

1. **Export participation:** deduct one point in each qualifying quarter with no grid export. Any positive export satisfies the rule, from solar or the battery. There is no minimum energy amount and no requirement to export equally in each quarter, so the best-priced quarter can receive most energy.
2. **Full-charge preparation:** find the first qualifying quarter in the case. Look strictly before it for the last quarter with positive battery charging. Preparation succeeds if the battery ended that charging quarter at 100% SOC. If there was no prior charging, preparation succeeds only if the battery started the case full. An earlier full charge does not count when followed by a later partial recharge before the first opportunity. Discharge after the qualifying full charge is allowed: SOC need not still be 100% when high sale prices begin.

Preparation is assessed once for the whole case. If it failed before the first opportunity, every qualifying quarter loses one point under the preparation rule, even if the battery charges fully during or after that first opportunity. Separated later price spikes do not reset preparation. A qualifying first quarter is assessed against the initial battery SOC. No qualifying quarters means neither rule fires.

The rules are independent and can stack with each other and existing rules. With three qualifying quarters:

| Prepared beforehand | Export in every qualifying quarter | Export penalty | Preparation penalty | Total arbitrage penalty |
|---|---|---|---|---|
| Yes | Yes | 0 | 0 | 0 |
| Yes | No export in any | −3 | 0 | −3 |
| No | Yes | 0 | −3 | −3 |
| No | No export in any | −3 | −3 | −6 |

Each rule has its own shared enabled state, price threshold and points setting. Editing the preparation threshold also changes which quarter is its first opportunity. These are benchmark preferences; they require no alternative-schedule witness, profit calculation or additional physical constraint. The referee stores the initial battery SOC so both stored and browser-preview scores use the same preparation evidence.

### Workload overlap

The overlap rule uses **price order, not a percentile band**. It processes overlapping source quarters chronologically and tries strictly cheaper quarters cheapest first against the last accepted schedule. Pool heating contributes to detecting an overlap, but its cycle stays fixed: only EV or home battery charging may move. Each accepted move reserves a distinct destination quarter across both charging devices, even if that quarter still has spare capacity. Later moves must remain feasible together with every earlier move without worsening service, reducing any final store or exceeding equipment or grid limits. Charger moves stay on whole amps, and battery transfers respect the remaining intervening inventory margin. A partially filled quarter can take a partial legal booking. The source loses one point if a charging witness is found, even with three large loads; the destination loses no overlap point. A lone large load, two loads of exactly 2 kW and equal-price quarters are exempt. Base load, hot water and battery discharge are excluded.

Overlap is evaluated at actual import prices across all 72 hours, including prices unpublished at planning time, like the percentile rules. The witness proves a feasible cheaper-priced booking, not net bill savings after solar opportunity cost. It may stack with other rules. The stored moves form one jointly executable reschedule; forecast limits and delivery of every changed booking in the measured world are checked after each move. The search tests direct quarter-to-quarter charging transfers and reports a conservative set of demonstrated moves, not proof that all other transfers are impossible. The selected-quarter explanation and rule details show the moved device, power, both quarters' full dates and actual prices, with buttons to select the source or destination in the chart. Changing the power or comfort thresholds requires recomputing these witnesses from stored decisions; the browser never runs the search.

The EV supply rule implements the owner's requirement that home-battery energy may serve every household load except the EV. Because sources share one connection, it uses an explicit accounting convention: allocate battery supply to all non-EV consumption first. EV battery supply in W is `min(EV, max(0, discharge − battery charging − grid export − max(0, total household consumption − EV)))`. Total household consumption already includes base load, pool, hot water and other loads; they must not be added again. Grid export is allocated to battery discharge first, so an exporting battery alone does not cause a loss. Solar and grid power may supply the EV while the battery serves other loads. By default any positive EV battery supply loses one point, once per quarter, without a price test, comfort grace period or feasible-alternative requirement. It can stack with the other rules. This is a benchmark preference, not a new planner constraint or physical source meter.

The short-interruption rules implement a preference for continuous operation, not a claim of bill savings. A gap is consecutive zero scheduled device power, bordered by positive power for that same device; leading/trailing idle time, power modulation while running and gaps longer than four quarters are exempt. Every gap quarter is compared with **both** immediate bordering running prices. Its allowed absolute price difference is `max(configured minimum, 0.10 × abs(gap price))`, inclusive at the boundary. The minimum defaults to 0.10 SEK/kWh (10 öre). The percentage uses that individual gap quarter’s own price, not the bordering prices or an average over the gap. Zero prices use the minimum; negative prices use their absolute magnitude for the percentage. For example, a gap price of ±2 SEK/kWh permits a difference of 0.20 SEK/kWh from either bordering price, while a zero price permits 0.10 SEK/kWh. The EV and pool are scored independently, in every quarter of each qualifying gap, and may stack with other rules.

The witness search redistributes the same booked energy within the two adjacent runs and their gap into a single uninterrupted run. It tries reducing running power, then trimming outer edges by up to the gap length, in two donor orders. An outer edge can move into the original gap, allowing the continuous run to finish earlier or start later; it need not fill every originally idle quarter. Every retained quarter stays on a positive legal charger/heater level. The alternative must be executable under the forecast, deliver its changed bookings in the measured world where present, and preserve service and every final store. For example, C-0616 in the prices-known/low lane has a 03:00–04:00 EV gap and only 2.76 kWh in its adjacent runs. Moving the 04:00 restart to 03:00 joins the earlier run and finishes at 03:15 with the same energy. The rule scores all four quarters of the original interruption once this continuous alternative passes the physical, service and final-store checks. The price test alone does not trigger a penalty. Each gap is compared independently with the original plan, so witnesses do not form a jointly executable reschedule. This is a conservative search: no finding means no such tested alternative was established. Actual import prices are used across all 72 hours, like the overlap rule; changing either price tolerance or the service thresholds requires rescoring the stored decisions. The chart explanation names the gap's start and exclusive end, and the rule details show the changed quarter powers.

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

Comfort is scored against the home’s saved targets captured in the case by the planning run, the same targets every planner is given. A cold initial state is not charged against a planner before recovery was possible. The allowance is 24 hours after an independently calculated full-power trajectory first reaches the scored level. This is a benchmark recovery policy, not a new planner constraint or a promise of jointly optimal recovery. A level never reachable in the horizon is N/A, not a successful recovery.

### Energy timing

These labels explain shared evidence. Multiple labels on one opportunity do not multiply its penalty. Eligibility is conservative and identical for every planner on a case: for example, solar rules are N/A without surplus solar, and car timing is N/A when charging is unavailable at its initial charge limit. Flat prices alone do not make a rule inapplicable because losses and the timing of other loads still matter.

| Rule family | What the alternative demonstrates |
|---|---|
| Low-value export before later import | Capture surplus, then use it later, with conversion losses and battery wear included |
| Expensive import with usable storage | Supply the load from storage without sacrificing more valuable later use or final inventory |
| Missed battery price spread | A charge/discharge transaction saves more than its purchase, conversion and wear costs |
| Battery spent too early | Moving discharge to a more valuable time reduces net cost |
| Space for incoming solar | Useful earlier discharge followed by solar capture improves the full schedule |
| Pool preheat before scarce energy | Earlier heat survives thermal loss and replaces more costly later heat |
| Pool wait for sun | Delayed heat is cheaper while the pool coasts without worsening service |
| Better-priced pool heating | Heat moves in whole running quarters of the heat pump, pump power and retained heat counted; the alternative ends no colder than the plan and less than one running quarter warmer, so its saving is a lower bound |
| Car charging timing | Shift charging to better-priced grid energy or solar while preserving service and final range; the charge moves in whole amps, so every alternative is one the charger can carry out |
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

The bench's base lane is **oracle**: every planner is given the real price of all 72 hours, so every energy-timing finding is a knowable mistake and none is hindsight. The diagnostic **told** lane sees only prices published at the case start and estimates later prices itself. Both plans are evaluated at actual prices. A finding involving unpublished prices in the told lane is shown as hindsight savings, not a knowable mistake. Known opportunities are searched before hindsight opportunities so the latter cannot consume the evidence for the primary economic score.

Solar/base-load series and outdoor temperature are shared bench inputs. Where the home measured a case's window, every plan and every replayed alternative is carried through the measured load and solar ([test cases](test-cases.md#measured-windows)); elsewhere through the forecasts. The six existing lanes continue to separate price information from valuation strength; valuation comparisons use raw comfort points so energy timing does not change the service threshold.

## Not modelled

Room heating, hot water, pool season/closure, EV arrivals/departures, manual overrides, actuator failures, subquarter PV spikes, uncertainty/risk reserves, actual demand tariffs, and real controller response need explicit test inputs/models before they can receive scores. Equipment start costs, native heater run protection and charger current quantization are not established by the quarter-average referee. “Feasible” here means feasible in the documented bench model, not a certification of controller execution.

The wider condition matrix in [models and delivery](../energy-optimisation/history/models-and-delivery.md#legacy-section-10.2) remains a source of scenarios. The [planner score-card redesign](../energy-optimisation/planner-scorecard-redesign-2026-10.md) (6–7 October 2026) and [constraint requirements](../energy-optimisation/constraint-requirements.md) take precedence over superseded historical assumptions. The cost-less-service-value objective in the earlier [server planner](../energy-optimisation/planner.md) is superseded.

## Rescoring

`bench/run.ts --shas none` recomputes evaluations from stored decisions. It does not rerun planners, rewrite decisions, or require their old git commits. It pages through the result store, processes all lanes, verifies versions after writing and reports incomplete coverage explicitly. Failed planner runs remain failed; a waiting case remains waiting. Missing decisions in an otherwise successful result are an error, not a perfect score.

The normal local validation commands are `npm run lint`, `npm run typecheck`, `npm run build:test`, `npm run test:e2e:local`, and `deno task test`. Tests cover prices of both signs, losses, future solar, physical limits, service preservation, terminal inventory, deterministic attribution and all-lane rescoring.
