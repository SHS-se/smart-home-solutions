# Shared refined stationary-battery physics

User requirement, 28 October 2026: live planning and the annual equipment
simulator must use the refined battery model already used by the controller.
An aggregate AC efficiency is not a replacement for that physical model.

## Captured model and electrical boundaries

Every installed stationary battery carries its required `conversion` record:
its revision, grid-charge, surplus-charge and discharge affine curves, and
installation idle loss. Each curve produces `max(0, gain * input - overhead)`
when active. The existing installation accounting retains the idle floor without
counting directional overhead twice. Unproductive source branches remain zero;
source activation and the mixed-source kink are part of the same law.

`charge_max_w` and `discharge_max_w` are **battery-terminal DC ratings**.
`charge_efficiency` means stored energy gained per terminal DC input;
`discharge_efficiency` means terminal DC output per stored energy spent.
These two ratios no longer combine AC conversion, installation overhead and
storage into one historical average. Their calibration retains the existing
measured/unmeasured evidence semantics. Solar-path identification retains its
existing explicit configured basis when site residuals cannot identify it.

The producer captures these parameters coherently. A missing required model is
an error; the planner does not reconstruct curves from legacy percentages.
Native ABI 14 and snapshot schema 11 identify the new physical basis.

## One planning transition

Rust's battery model owns source-specific conversion, exact AC/DC inverses,
DC power saturation, stored-energy saturation and installation overhead.
Complete projection and conditional search carry call the same transition.
Candidate inventory moves, export reserves, refill proposals and witness
transfers use those inverses rather than multiplying AC energy by a constant.

Commands and stated instructions remain AC watts. Native outputs distinguish
actual AC charge/discharge, terminal DC charge/discharge, installation demand
and the authoritative stored-energy endpoint. A feasible integer command can
have a fractional actual flow after physical saturation; those are different
quantities and are not rounded into one another at publication.

The ROI baseline and SHS replay both call this native engine. Each actor keeps
its own chronological battery, vehicle and thermal state across month boundaries.
Capacity-only equipment trials preserve the captured curves, storage ratios and
DC power ratings. No evidence authorizes scaling installation loss with capacity.
The existing EV supply permissions remain unchanged.

Python continues to own calibration and actual execution. TypeScript's existing
conversion module handles reference recovery and independent bench evaluation.
All bindings execute the same independently synthetic conformance vectors in
`contracts/battery-physics-v1.json`; there is no separate simplified planning
physics and no new native-runtime dependency in Home Assistant.

## Reference and economic accounting

Execution contract v3 retains the stated-instruction/demand partition and adds
an explicit `installation_mwh` electrical term to each interval. Reference
stored endpoints come directly from native projection. Captured terminal/stored
ratios are included in `storage`, so DC meter delivery and stored targets are
compared on the same basis, including historical admissions. Historical records
retain their original interpretation; they are not a source for new physics.

Delegated recovery converts additional AC headroom to **incremental** terminal
DC at the captured source mix, then applies the stored ratio to target delivery.
It cannot create source permissions or search for another charging window.
Control ownership, release behavior, supply scope and shared grid limits retain
their existing contracts.

Terminal inventory credit remains an economic convention: the median import
price values capped inventory using grid refill at rated terminal charging power.
It is not a physical efficiency or an imposed final-SOC target. Electricity-bill
comparisons continue to exclude stored-energy credits and demand fees.

## Verification

Conformance covers directional overhead, idle accounting, unusable solar,
mixed-source charging, AC/DC inverses, physical ratings and stored conservation.
Protected behavioral contracts remain independent requirements. Native and Wasm
results, producer/consumer reference balances, full unit tests, frontend lint,
build and local E2E suites qualify the coordinated change. Private measured
calibration and annual replay inputs/results remain outside this public repository.
