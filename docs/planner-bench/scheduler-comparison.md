# Scheduler savings experiment

Open **Planner bench → Defaults vs SHS** on the test site. Select a measured
case and run the comparison. Staff can open the identical view from a customer's
ROI tab under **Scheduler savings → Preview using planner bench test cases**.
The comparison uses the bundled dev Wasm artifact and the bench reference
household, not the customer's equipment or a historical planner selected in the
original bench tab. It does not write bench scores, dispatch plans, or publish
customer savings.

## Default controller

Both actors start from the case's captured battery, car, pool and heater state.
Each has its own subsequent state; the default controller never consults SHS's
trajectory or forecasts. Its commands are:

- Battery: maximum self consumption, at the equipment's charge/discharge limits.
  The checkbox explicitly controls whether the default battery can supply the car.
  SHS retains the reference household's own EV battery-supply policy.
- Car: begin at each local midnight, charge at maximum normal current to 80%,
  then stop. It remains connected; no driving consumption is invented. A case
  starting after midnight waits until the next midnight, rather than assuming an
  unobserved charging session from before the case.
- Pool: start at 30°C, stop at 30.5°C, preserving the thermostat latch between
  those temperatures. Both thresholds are editable for an experiment. The native
  heater's physical stop also resets the latch when it occurs inside a quarter.
- Pump: a continuous 60 W floor. While heating, the native auxiliary draw adds
  the difference to the full pump power (764 W in the reference household).
  Both actors receive that same floor and physical stop temperature. Bench base
  load represents the other household loads, with planned pool/car loads removed.

Native `project()` owns startup, heat loss, compressor power, charging taper,
battery efficiency, device limits, curtailment and energy balance. The controller
does not duplicate device physics. Realistic initial readings above a requested
target remain valid. Physical projection failures are surfaced with their cause.

## Forecast planning and recorded execution

`src/lib/scheduler-comparison/comparison.ts` is an isolated input adapter and
accounting layer. It reuses existing forecast/model/rule helpers but leaves
the working planner, its bench adapter, scorer, referee, artifact and generated
HA fixtures unchanged. The separate adapter is needed because the existing bench
adapter also imports CLI-only source-digest/build code; extracting it would alter
the frozen artifact's source identity.

SHS solves once using the case's solar/load forecasts, demand correction,
published prices, price history and existing price outlook. It retains the case's
comfort goals, charger limit and saved bench rules. Then its commands and the
reactive defaults are projected against identical recorded base load, solar,
import/export prices and weather. There is no rolling replan in this experiment.
Cases without complete recorded load/solar cannot supply measured savings and
fail explicitly; forecasts are never substituted for those measurements.

The browser worker verifies the bundled Wasm SHA-256 against its artifact before
executing. A new private worker is used for each request and terminated on cancel.
The result identity hashes the forecast problem, recorded problem, defaults and
common end-energy valuation. Export includes these inputs, the case ID/revision,
rules, reference household, build commit, engine hash, full commands/quarter
outputs and accounting, so a reviewer can reproduce every number.

## Financial accounting

For each actor and quarter:

```
import kWh = max(net W, 0) × hours / 1000
export kWh = max(-net W, 0) × hours / 1000
electricity cost = import kWh × import price − export kWh × export price
bill saving = default electricity cost − SHS electricity cost
net bill saving = bill saving − SHS subscription for the case period
end-adjusted saving = bill saving + SHS end credit − default end credit
```

Signed prices and costs are preserved. End credit uses the existing native
accounting helper with the same recorded price reference and caps for both:
pool stop temperature, 80% car energy and full battery capacity. This is a
valuation adjustment, not an electricity-bill saving. Modelled wear includes
battery discharge and heater starts and is shown separately. Service measures
include pool minimum, quarter-end temperatures below
start, final pool temperature, and ending car/battery SOC. SHS's preferences may
differ from the default thermostat/80% targets; savings must be assessed alongside
those differences. Quarter selection shows forecast versus recorded price/PV
and both cash costs. Charts use the existing bench plan panels.

The ROI tab's contract comparison holds recorded kWh constant and reports gross
contract savings without SHS equipment, installation or subscription. The SHS
subscription is subtracted only in the scheduler comparison. A monthly fee is
allocated by actual covered hours in each local month, including DST and month
boundaries. An invalid subscription leaves the net result unavailable.

Overlapping 72-hour bench cases are neither summed nor annualised. They are a
calculation preview, not annual home ROI. Customer scheduler savings and payback
remain explicitly unavailable until representative home-specific replay periods
can support them. Contract history and reference-household case savings are not
added together.

## Validation

Calculation tests cover forecast retention, thermostat hysteresis and native
stops, midnight/taper/above-target car states, sequential projection parity,
forecast-independent default commands, signed-price ledger reconciliation,
60 W counted once (4.32 kWh in 72 hours), required measurements, identical-operation
zero savings, immutable inputs, result identity, and subscription/DST allocation.
Mocked browser tests exercise the real bundled Wasm worker, chart inspection,
export, input edits, missing measurements, staff ROI preview, subscription
separation and customer unavailability. Run the full repository unit, lint,
typecheck, test build and four local E2E suites before committing.
