# Planner bench

The bench decides whether a planner change is better by showing it, not by a
gate table. Every planner version is replayed on the same set of test cases.
You can look at each plan beside the planner that is running now, score it with
points you control, and give your own pass/fail verdict.

Page: **Planner bench** in the staff menu, on the test site
(`https://test.smarthomesolutions.se/portal/planner-bench`).

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Test cases, runs, results, verdicts | `bench_*` tables in the **TEST** Supabase project | Schema in `bench/schema.sql` (idempotent). Deliberately not a migration, so household replays never reach production. |
| Runner | `bench/run.ts`, `bench/planner-adapter.ts`, `bench/store.ts` | Checks each commit out as a git worktree and runs its planner on every case in a fresh Deno process. Stores a compact 72-hour series and totals per case. |
| Shared logic | `src/lib/planner-bench/` | Replay stripping, plan series, totals, scoring. Used by both the runner and the page. |
| CI | `.github/workflows/planner-bench.yml` | On push to `dev`: benches the pushed commit and marks it current. On manual dispatch: runs any commits, usually `all`. |
| Rerun button | `supabase/functions/planner-bench-dispatch` | Lets the page start the workflow. Needs the `PLANNER_BENCH_GITHUB_TOKEN` secret (below). |
| Page | `src/pages/portal/PlannerBench.tsx` | Run picker, totals, case chips, plan charts, criteria editor, verdicts, upload. |

## Test cases

A replay download is about 10 MB. The planner reads only
`entrypoint.arguments`, which is about 90 kB, so that is all a case keeps. The
page strips the file in the browser before saving it.

The bench changes one thing in every case, for every planner version alike.
Captures taken before the pool loss was fitted have no pool model, and the bench
gives them 0.1 kW/K, as the acceptance replays always have.

A planner version that needs its input prepared differently (for example a
planning basis built from price history) owns that step. It exports
`prepare(input, allInputs)` from `bench/prepare.ts` in its own commit, and the
runner uses it when present.

## Current and test planner

- **Current:** the run marked `is_current`. CI marks each commit pushed to
  `dev`, because `dev` is what the test environment runs. **Make current** on
  the page changes it by hand.
- **Test:** whichever run you pick in the dropdown. Runs are listed oldest
  first as `short sha · commit time · score`.

The totals table compares only the cases both runs have results for.

## Scoring

Each case scores between −10 and +10. A met criterion adds its pass points, a
missed one adds its (negative) miss points, and one that does not apply (no
pool, car never unplugged) adds nothing. Your verdict counts too: pass +2,
fail −4.

| Criterion | Default | Pass | Miss |
|---|---|---:|---:|
| Pool never below * | ≥ 28 °C | +1 | −4 |
| Pool at the end of the plan | ≥ 29 °C | +1 | −2 |
| Pool never above | ≤ 32.5 °C | +1 | −2 |
| Pool heat bought in the cheapest published hours (published 25th percentile) | ≥ 30 % | +3 | −4 |
| Pool heat bought at estimated prices | ≤ 50 % | +2 | −4 |
| Import price paid vs time-average price | ≤ 70 %, full penalty at 90 % | +3 | −3 (linear between) |
| Car charging planned while unplugged | ≤ 0.1 kWh | +1 | −4 |

\* A missed required criterion shows the case as failed even when its points
add up. Your verdict overrides the automatic pass/fail.

Run score = 550 + 45 × the mean case score, which maps onto 100–1000. With these
defaults, the planner on `dev` at the time of writing (d737694) scores 264.

Thresholds and points can be changed per case on the page. Scoring reads only
the stored totals, so a change rescores every run at once. Planners are re-run
only for new cases or new commits.

## Running it

**Add a case:** upload a replay file on the page. It is saved and every commit
on the bench is run for it. From the command line:

```bash
deno run -A --sloppy-imports --config deno.json bench/seed.ts NAME=path/to/plan-replay.json
```

**Run commits by hand:** use the workflow's *Run workflow* button in GitHub
Actions (`shas`: `all` or comma-separated SHAs), or locally:

```bash
deno run -A --no-check --sloppy-imports --config deno.json bench/run.ts --shas all
```

Database mode needs `BENCH_SUPABASE_URL` and `BENCH_SERVICE_ROLE_KEY`. Without
a database, `--local <dir-of-replays> --out <file.json>` writes the same
records to a file.

CI can only run commits that are pushed. A local-only branch has to be run
locally.

## One-time setup

1. In GitHub, create a fine-grained personal access token for
   `SHS-se/smart-home-solutions` with **Actions: Read and write**.
2. Add it to the TEST Supabase project as the edge function secret
   `PLANNER_BENCH_GITHUB_TOKEN`.

Without the token, everything except the page's rerun button works; start runs
from GitHub Actions instead. The workflow uses the existing
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD_TEST` secrets.
