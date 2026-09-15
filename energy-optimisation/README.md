# Load-shifting plan — hourly prototype

## Later design decision — 15 September 2026

Preserve the historical behaviour and evidence below. The agreed participation ownership, metadata exclusion, chart partition and explicit battery supply scope supersede conflicting target requirements; this record is not current replacement rollout guidance.

See the [agreed participation and battery supply specification](../docs/energy-optimisation/device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

> **Superseded.** This folder is the original **hourly** prototype, kept for the
> findings written up below. The live version is 15-minute and lives in the
> portal:
>
> - `src/lib/energy-shift/inputs.ts` — 15-min snapshot, 288 slots
> - `src/lib/energy-shift/model.ts` — same model at the canonical 900 s timestep
> - `src/components/portal/energy/LoadShiftTab.tsx` — the page
> - Portal → Energy Modeling → **Load Shifting**
>
> Everything in "The headline finding" and "Two bugs found while building this"
> still applies; the numbers there are from the hourly 2026-08-09 snapshot.

## Original notes


A 72-hour view of how the deferrable loads can be moved onto forecast solar,
ranked by the summer priority stack.

```
node build.mjs > load-shift-plan.html    # regenerate the graph
node check.mjs                            # model checks + invariants
```

No dependencies, no network, no build step. Open the HTML straight from disk.

## Files

| File | Role |
|---|---|
| `inputs.mjs` | Every measured and forecast value, with provenance. Nothing invented. |
| `model.mjs` | `planBaseline` / `planOptimised` decide *when*; `simulate` enforces physics; `verify` asserts invariants. |
| `build.mjs` | Renders the self-contained HTML. |
| `check.mjs` | Console harness: balance, invariants, unmet requirement, schedule dump. |

The planner and the simulator are deliberately separate. The planner may propose
anything; the simulator clamps to SOC bounds, power limits and the grid envelope
and is the only source of truth for the reported numbers.

## What the graph shows

Two stacked panels sharing an axis — baseline above, shifted below:

- PV forecast as a filled area, from the 15-minute `watts` attribute
- Deferrable load stacked on base load
- Battery SOC on the right axis, with the 5% floor marked
- Hatched region beyond `binding_until` where no price is published

## The headline finding

**The summer priority list has two readings and they disagree, on real data.**

Reading "house battery >80% SOC by end of solar day" as a *hard reservation* —
sun held back from the pool until the battery is satisfied — is plan B. Reading
it as *first claim on whatever surplus exists* is plan C. On 2026-08-10 they
diverge sharply, and plan C wins on nearly everything:

| Plan | Import kWh | Net SEK | Hours at 5% floor | SOC end of 08-10 |
|---|---|---|---|---|
| A · baseline | 7.2 | 6.73 | 10 | 63% |
| B · stack, literal | 11.2 | 9.93 | 5 | **70%** |
| C · cost-led | **3.1** | **1.89** | **2** | 25% |

B costs 8 SEK more and produces *more* floor hours than C, because the energy it
imported went into the pool rather than the pack. The only thing it wins is the
literal target.

The cause is physical: 08-10 forecasts 36.6 kWh of PV against 18.2 kWh of base
load, leaving ~24.8 kWh of surplus, while battery + pool + hot water + car want
~33 kWh. Something must give. **Which one gives is the decision in architecture
§8.2 that has not been made yet** — this is that question with numbers attached.

## Findings worth carrying forward

**The daily-target helpers over-state reality.** Measured over 17 days,
the pool needs a median 15.3 kWh/day against `input_number.emhass_pool_daily_target`
= 22.0, and hot water 4.1 against a configured 9.0. Feeding the configured values
into a requirement-based optimiser schedules work that does not exist — the same
class of failure as `ENERGY_OPTIMISATION_NOTES.md` §6.3.2, from the other
direction. Requirements here are derived from measurement and live state.

**Summer has almost no price signal.** The Ellevio tariff is flat at 0.71 across
all 26 published slots; the whole spread is spot. Import ~0.92 versus export
~0.24 is a 3.8× gap, so the value is self-consumption and battery resilience,
not arbitrage. Judging this plan on the money it saves over these particular 72
hours would be a mistake — the arbitrage case is a winter case.

**The real win here is the battery floor.** Baseline drains to 5% (exactly what
happened on 2026-08-01, 05:00–07:00); the shifted plan holds 33.7%.

## Two bugs found while building this, both worth remembering

1. **Ranking against post-battery residual surplus.** The battery is rank 1 and
   charges greedily, so in a first pass it consumed the entire forecast surplus.
   Every solar hour then looked like it had none, and the pool was scheduled into
   cheap *night* hours on grid import — the exact opposite of the intent. Rank
   against raw PV-minus-base instead; the simulator already enforces the priority
   because scheduled loads are subtracted before the battery sees the surplus.

2. **Filling a solar hour at full device power.** Packing a 3.66 kW pool into an
   hour holding 176 W of surplus is a battery raid dressed up as solar heating.
   The allocator now caps each placement by the surplus actually available and
   spills the remainder to the next-best hour, then to the cheapest *priced*
   import hour. Unpriced advisory hours never receive grid work.

## Not yet modelled

- Pool has no thermal model, so it cannot overshoot the setpoint to store heat
  before a cloudy day — the case in notes §12e. Needs pool volume and a loss
  coefficient.
- Spring and autumn/winter stacks are recorded in `inputs.mjs` but not simulated;
  there is no PV or battery history before 2026-05-01 to validate them against.
- Car is never scheduled: `binary_sensor.tesla_charge_cable` is `unknown` and SOC
  is unavailable, so the requirement stays 0 rather than being guessed.
- Thermal zones, aircon COP and the resistive-versus-heat-pump choice.
