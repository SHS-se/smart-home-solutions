# Replan reuse: implemented and measured

The offline prototype now seeds a new solve from the previous selected solve. It retains current home preference, model and resource ownership, and distinguishes a new replan from resuming the same solve. Production code is unchanged.

## What is reused

- Align selected-solve estimates with overlapping canonical quarter starts and equal physical durations. New/partial quarters use current initialization.
- Preserve the prior price estimate's relative position between import and export prices, adjusted to current tariffs, plus its separate resource premium. A change from forecast surplus to deficit must not turn the former tariff spread into artificial scarcity. Equal prior tariffs leave no inferred position; the new initial guess uses the middle of the current spread.
- Copy only value rows with matching model, service economics and lattice identities. Changed home preferences refresh that device's rows and the household's coordinating prices. Changes in models or resource limits also refresh coordinating prices.
- Always compute the current terminal boundary and current physical trajectories. A full backward pass replaces every copied value row.
- Estimates are copied from the selected result, independently owned by the new solve; no old commands, measurements, objective rewards or physical permissions are inherited.

Malformed stored estimates and cross-home/unsupported-algorithm use fail explicitly. There is one search algorithm, with current-input initialization; no old-planner fallback.

## Results

Five deterministic synthetic replans, with the same frozen evaluator for fresh and reused starts in each case. Fixed utility is taken from the fixture's current resolved stores, not claimed as the completed replacement preference policy. Scores below are whole-model objectives in SEK (cash costs less valued service/terminal inventory), **not cash savings or real-home results**. Lower is better.

| Replan | Fresh, 8 rounds | Reused, 8 rounds | Reused, 10 rounds | Best tested at 40 rounds |
| --- | ---: | ---: | ---: | ---: |
| unchanged | 101.29 | 101.29 | 101.29 | 101.29 |
| shifted-quarter | 102.36 | 101.41 | 101.41 | 101.36 |
| price-change | 116.28 | 115.30 | 115.30 | 115.30 |
| forecast-change | 208.12 | 208.09 | 208.09 | 196.39 |
| comfort-change | 84.18 | 84.18 | 84.18 | 82.14 |

Within eight/ten rounds, reuse matched or improved the fresh start in these cases. Eight rounds used 7,598,592 Bellman cell-actions plus approximately 100,000 joint action combinations; ten used 9,498,240 cell-actions. Fresh and reused starts completed the same round counts: **no reduction in work was demonstrated**. Local eight-round runs took roughly three quarters of a second; these exclude input resolution, serialization, production scenarios, rooms/boiler and non-steady response memory.

A forty-round reference still found a better fresh result after the large PV-forecast reduction. The reused run did not find that result even at forty rounds. The comfort-change case also improved beyond ten rounds. Thus eight–ten rounds are not established as sufficient, and reuse cannot be assumed to improve every replan. The remaining issue is search coverage/coordination; raising the live iteration budget is not an approved remedy.

The first attempt also exposed two initialization errors. A changed comfort target needed a household-level price refresh, not only refreshed pool rows. And import/export market position needed separate treatment from resource scarcity. Both are corrected and covered by tests. The committed `results/replan-results.jsonl` and `results/replan-reference.jsonl` reflect the final implementation.

## Verification and scope

**14 tests passed:** twelve seed-boundary tests and two integrated prototype tests. The integrated tests show that a current backward calculation replaces radically stale old values and that changed preferences produce the same refreshed solve despite prior estimates. The prototype typechecks; the interface sketch remains design pseudocode. Every completed candidate in the experiments passed the existing dispatch physical scorer.

The prototype uses three steady synthetic device models, a 97-node state axis, a four-trajectory beam and a two-state representation of pool start economics. It does not implement the native Bergvärme startup memory, the complete proposed service-utility policy, exact tiny-case oracle validation, hosted worker budgeting or production persistence. These experiments do not alter the production planner. Repository validation passed before committing: `deno task test` (1,443 tests), `npm run lint` (zero errors, 27 existing warnings), `npm run build:test`, and `npm run test:e2e:local` (49 tests). The ported eight/ten-round and forty-round experiments reproduce all recorded scores and work counters exactly, excluding timing. The generated HA fixture is unchanged because planner output and model versions are unchanged.

Reproduce from the repository root:

```sh
deno test --sloppy-imports --allow-read tests/bench-replan-seed.test.ts tests/bench-replan-comparison.test.ts
deno run --sloppy-imports --allow-read bench/experiments/replan-comparison.ts
deno run --sloppy-imports --allow-read bench/experiments/replan-comparison.ts --reference
```
