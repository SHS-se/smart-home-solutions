# Electricity contract ROI

The Energy Optimisation ROI tab compares stored consumption and supplier cost with an editable alternative contract. It does not run the planner or use the planner's synthetic baseline as measured savings.

## Sources and scope

The page explicitly selects one source at a time; it does not blend bills and estimates:

- Home Assistant: `energy_supplier_daily_costs`, paginated by customer. Import kWh are priced using the integration's hourly consumption and hourly means of supplier prices, including VAT and supplier markup. A day must contain its full local-day hour count, including DST. Incomplete days are excluded. The user supplies the current supplier's monthly fee, which is absent from daily cost records.
- Bills: imported SEK electricity invoices, paginated by customer. Complete months use electricity-invoice consumption and billed supplier costs. Identified net export credits/fees are removed to hold export economics constant. Partial months and months with overlapping invoices are excluded. Multi-month bills follow Energy History's dated-line allocation, or proportional allocation where only whole-period totals exist.

These sources belong to the customer account. They are not attributed to a selected home; multi-home accounts get an explicit scope notice. Grid fees and energy tax are outside this electricity-supply comparison. No data is represented as a zero saving.

## Alternatives

Screenshot examples are editable headline benchmarks at the screenshot's 12,000 kWh/year assumption, not a live tariff feed. The bundled benchmark includes fees, so no separate supplier fee is added. At another consumption level, users should enter the underlying energy rate and monthly fee separately.

- Fixed: a constant rate, optionally plus a supplier monthly fee.
- Monthly variable: time-weighted spot averages for the selected SE1–SE4 area, plus a percentage markup or a monthly SEK charge. No manual monthly rates or screenshot headline prices enter this calculation.
- Quarter-hour variable: a quoted average benchmark, or the HA cost profile plus a user-entered difference in markup and an alternative monthly fee. The latter retains the existing consumption timing and underlying spot-price exposure; it is not an exact quarter-hour re-billing or rescheduling simulation.
- Mixed: a quoted effective rate, or a fixed-share weighted blend of fixed and variable rates, plus the supplier fee.

All entered prices include VAT. The user's actual consumption profile is held constant for every alternative. This does not establish the causal value of the equipment or planner separately from contract choice.

## Calculation

For every included month:

- Covered month fraction = included days / calendar days in that month.
- Actual cost = stored import cost + current supplier fee × covered month fraction (HA only; bills already include this fee).
- Alternative cost = imported kWh × alternative SEK/kWh + alternative fee × covered month fraction. Bundled quotes add no fee.
- Saving = alternative cost − actual cost.
- Net saving = saving − planning subscription × covered month fraction.

Annual net = total net / sum of covered month fractions × 12. Payback = (equipment + installation) / annual net, only when annual net is positive. Otherwise the page reports no payback. The break-even effective alternative rate is (actual cost + subscription) / imported kWh, and is unavailable for zero imports.

Annual results extrapolate the selected period without seasonal adjustment. They do not assume contract renewal prices, financing, maintenance, or equipment depreciation. Inputs persist per customer in the current browser. Initial equipment, installation, and subscription amounts are explicitly labelled examples.

Calculation tests live in `src/lib/contract-roi.test.ts`; browser coverage is part of the existing `plan-workbench.spec.ts` local suite. No planner outputs, contracts, or database schemas change.

## Monthly market average cache and presentation

`roi-monthly-prices` authenticates the caller and reads `energy_monthly_spot_prices`. Missing months are populated from the same public price service used by the integration, elprisetjustnu.se. The existing historical planner prices include grid charges and cannot serve as raw spot prices. The cache stores prices excluding VAT; ROI converts them to VAT-inclusive rates. Historical months cover the entire month; the current month covers through yesterday and refreshes daily. Missing upstream days block the average instead of silently substituting a quote. Hourly and quarter-hour intervals are time-weighted and must be contiguous, including DST boundaries.

The page leads with monthly net savings or extra cost, after subscription. Displayed result amounts are absolute magnitudes with explicit direction labels; calculation values remain signed. The annual projection and monthly breakdown are collapsed. Preset examples remain available for fixed, quarter-hour and mixed benchmarks; monthly contracts use market averages exclusively.

Deployment includes migration `20260925091500_add_monthly_spot_price_cache.sql` and the `roi-monthly-prices` function through the normal CI database/functions jobs.
