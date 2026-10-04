# Planner curve evidence — 4 October 2026

Read-only architecture investigation of dev after de73891. These are local synthetic-fixture measurements, not the user's recorded home case and not production Supabase timings.

## Current behaviour

The bench copies actual reported curve points. Battery generation constructs a descending merit-order curve, then clips every point to a scalar terminal-replacement estimate. On `realisticWorld()` (100 published price quarters, 288 total quarters), the unclipped 23-point curve had twelve distinct values from 1.891 to 2.551 SEK/kWh. After the cap, all 23 points were 1.237 SEK/kWh. This directly reproduces information loss in the generator; it does not establish that simply removing the cap gives a correctly accounted objective.

EV supply offers are constructed after the pool's estimated need has claimed PV via `surplusTakenW`. This embeds pool-first allocation into the curve seeds before the joint solver. EV targets may also exceed the reachable charge ceiling; the curve is clipped to that ceiling. A flat reachable segment is possible even when values fall later on the full curve.

The bench's low/nominal/high lanes scale all three curves together. They measure sensitivity to joint value scaling, not convergence of per-device curve shape optimization. Oracle lanes receive future actual prices and must remain evaluation evidence, never runtime training inputs.

## Runtime

| Operation | Measured local time |
| --- | ---: |
| Flat-price synthetic case: priority solve | 451 ms |
| Varied synthetic case: priority solve | 8,840 ms |
| Same varied case, instrumented priority solve | 8,637 ms, 15 auctions |
| Same varied case, full planner | 8,520 ms, 15 auctions |
| Capture unsolved inputs, varied case | 3.7 ms |
| One conditional Bellman sweep, all 3 stores | 72 ms |
| Eight repeated conditional sweeps, all 3 stores | 499 ms |
| Ten repeated conditional sweeps, all 3 stores | 609 ms |

The Bellman probe has 129 state samples per store and 288 quarters. Commands: pool 2, EV 13, battery 17. It uses the same sweep for each device and device-specific transitions. It holds other-device context fixed, uses existing fixture utility, and omits shadow-price coordination, joint feasibility/repair, complete response memory, new comfort accounting, and serialization. Repeating unchanged conditional sweeps measures computation only; it does not measure convergence or optimization quality. Its plots must never be represented as selected production-plan curves.

The existing production worker chain has a 20-second deadline, 64-call ceiling, 1.2-second per-call CPU budget, and starts a non-pausable auction only during its first 0.3 seconds. Repeating 25–30 complete planner evaluations conflicts with that budget on the measured varied fixture. Pausing distributes CPU among calls; it does not reduce total computation.

Raw evidence is in `results/`: `measure.jsonl`, `auctions.jsonl`, `battery-cap.json`, `bellman-kernel.jsonl`. The recorded Bellman-kernel timings came from an isolated conditional sweep probe, before the coupled replan prototype. They are historical evidence, not timings of the committed joint search; use the replan report to reproduce the latter.
