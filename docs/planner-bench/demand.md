# Demand: levelling the base-load forecast, and the margin above it

Why the battery ran flat going into autumn, what was built for it, and what the
bench said. 3 October 2026.

## The problem, measured

The home's base load (everything but the pool, hot water and the car) is
forecast by Home Assistant as the average of the last ten days. From 26
September the house drew 26 to 38 kWh a day against forecasts of 23 to 26. The
planner charges the battery for exactly the forecast, so it ran flat: 61
quarters at the floor on 27 and on 30 September, 45 on 1 October.

The September redesign's answer (planner-redesign-2026-09.md §5.8) was to fit
base load to heating degree-days. On this home's data that does not work:
temperature explains a quarter of the day-to-day variation over 37 clean days,
and a one-day-ahead backtest did no better than the ten-day average. The rise
is a change of level (30 to 33 kWh a day at 15.6 °C on 1 and 2 October; 20 to
25 at the same temperature in mid-September), not a response to temperature.
The solar forecast was not the cause: with the home's own correction it is
within a tenth on sunny days.

## What was built

Evidence, kept by the server (`energy_optimisation_demand_days`): for each of
the last 28 days, what the forecast issued the day before said the base load
would be, and what it was. Given to the planner as `snapshot.demand_outlook`.

From it (`planner/demand-outlook.ts`):

1. **Level.** Recent draw over recent forecast, the last days counting most
   (half as much every five days), shrunk towards 1 and kept between 0.75 and
   1.6. The base-load forecast is multiplied by it. Nothing names a season: the
   factor is above 1 while the house draws more each week and below it when it
   draws less.
2. **Margin.** How far above the levelled forecast to plan, from what each
   mistake costs: short is the dear tenth of the horizon against energy bought
   in the cheap tenth and carried through the pack; over is a kWh that waits a
   day, or, when the sun would have filled the pack anyway, sun that is sold
   instead. The point of the day-to-day spread planned for is
   `short / (short + over)`, never past the day exceeded three in ten. **Worked
   out and reported with every plan (`plan.demand_outlook`), not applied**
   (`PLAN_FOR_DEMAND_MARGIN` in `planner/energy-optimisation.ts`).

## What the bench had to learn first

The referee used to carry the household through the forecasts the planner was
told, so a plan charged for exactly the forecast could never run short. It now
carries it through the load and solar the home measured (`recorded.actual`),
with the battery doing what it does in the house: following the house within
the limits the plan set, taking surplus that was not forecast, and keeping a
grid charge as planned (test-cases.md, "Measured windows"). Planners get the
days before a case (`recorded.history.demand_days`).

When the table below was made, five of the seven cases were measured in full.
C-0905 and C-0919 were not: the home had recorded its car charging twice, so
the device meters added up to more than the house drew for hours at a time,
and they were refereed on their forecasts. Since the recording was corrected
and the cases read again on 4 October 2026 (test-cases.md, "Measured windows"),
every case from the home's tables is measured, C-0905 and C-0919 included, and
the days before each case no longer take the car out twice. The table has not
been redone since.

## What the bench said

Net cost is grid cost at real prices less the value of what is left in the
stores, told/nominal lane, 72 hours a case, kr. Lower is better.

| Planner | All 7 cases | The 5 measured | Score |
|---|---:|---:|---:|
| Forecast as given (6715b9e) | 1099.2 | 1009.4 | 407 |
| Level | 1080.3 | 985.4 | 505 |
| Margin alone, up to the day exceeded 3 in 10 | 1084.1 | 992.4 | 521 |
| Margin alone, up to 1 in 20 | 1086.5 | 993.1 | 511 |
| Level and margin, up to 1 in 3 | 1082.0 | 984.8 | 503 |
| Level and margin, up to 3 in 10 | 1089.4 | 990.9 | 506 |
| Level and margin, up to 1 in 5 | 1091.3 | 992.0 | 469 |
| Level and margin, up to 1 in 20 | 1094.9 | 995.0 | 478 |

- Either change alone takes 16 to 24 kr off the five measured cases, about 2 %,
  and raises the score by about 100.
- Together they do not add up. Each raises the demand planned for, and past
  about 1.2 to 1.3 times the forecast the plan buys energy it does not use.
- The level is the one switched on: it is the simpler of the two, and the
  better on cost.

Why the margin does not show more, in descending order of confidence:

- **The bench plans once for 72 hours.** A plan that believes the margin was
  drawn on day one buys it again on days two and three. Live, the plan is made
  again every day from the battery's real level, and that over-buying does not
  happen. The bench overstates what a margin costs.
- **Bought energy is only as cheap as the price estimate.** On C-0924 the
  margin was bought on a night the planner believed cheap (2.4 kr) the day
  before prices fell to 1.0 to 1.5.
- **Five cases.** The demand ran 0 to 35 % over forecast in them; the margin
  can only pay in the two where it ran well over.

To judge the margin fairly the bench needs to replan a case each day, or more
measured cases. Until then it is reported, not applied.
