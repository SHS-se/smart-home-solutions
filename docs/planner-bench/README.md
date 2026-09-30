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
| Runner | `bench/run.ts`, `bench/planner-adapter.ts`, `bench/store.ts`, `bench/planner-version.ts` | Skips a commit whose planner version is already on the bench. Otherwise checks the commit out as a git worktree and runs its planner on every case in a fresh Deno process. Stores a compact 72-hour series and totals per case. |
| Shared logic | `src/lib/planner-bench/` | Replay stripping, plan series, totals, scoring. Used by both the runner and the page. |
| CI | `.github/workflows/planner-bench.yml` | On push to `dev` that touches the planner folder: benches the pushed commit and marks its planner version current. On manual dispatch: runs any commits, usually `all`. |
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

## Planner versions

The bench lists planner versions, not commits. The planner is its own folder,
`supabase/functions/_shared/planner/`, which imports nothing from outside
itself (`tests/planner-boundary.test.ts`). A commit's planner version is a hash
of the code that folder's entry points reach, with types, comments and
formatting stripped by esbuild (`bench/planner-version.ts`). So a commit that
changes only the website, the bench, tests, docs or types has the same version
as the commit before it, and gets no new entry.

Before each run the runner gives every stored run its version and folds runs
that share one into the earliest: verdicts and the current mark move over, the
duplicate's results go. When the pushed commit's version is already on the
bench, nothing runs and that entry becomes current.

## Current and test planner

- **Current:** the run marked `is_current`. CI marks the planner version of each
  commit pushed to `dev`, because `dev` is what the test environment runs. **Make current** on
  the page changes it by hand.
- **Test:** whichever run you pick in the dropdown. Runs are listed oldest
  first as `short sha · commit time · score`.

The totals table compares only the cases both runs have results for.

## Scoring

Every 15-minute quarter of a plan scores an integer from −2 to +2. The rules
that fire for the quarter add their points, and the sum is clamped. A quarter
where nothing notable happens scores 0.

The plan chart shows these scores as a colour-coded strip above the price
panel: dark red −2, light red −1, grey 0, light green +1, dark green +2. A
single day shows the digits; the three-day view shows coloured cells. Click a
quarter to see which rules fired.

"Flexible load" is pool + battery charging + car of at least 500 W. Price
ranks are over the whole 72-hour plan, as the planner saw it.

| Rule | Default threshold | Points |
|---|---|---:|
| Pool below minimum * | < 28 °C | −2 |
| Pool below comfort band | < 29 °C | −1 |
| Pool above maximum | > 32.5 °C | −1 |
| Flexible load in a cheap quarter | cheapest 25 % | +1 |
| Flexible load in a very cheap quarter | cheapest 10 % | +1 |
| Flexible load in a dear quarter | dearest 25 % | −1 |
| Flexible load in a very dear quarter | dearest 10 % | −1 |
| Flexible load at an estimated price above cheap published ones | > published 25th percentile | −1 |
| Car charging planned while unplugged * | > 50 W | −2 |
| Solar exported while the home battery has room | battery < 95 % | −1 |
| Very dear import while the battery sits idle | battery > 20 %, dearest 10 % | −1 |

\* If this rule fires anywhere, the case shows as failed. Your verdict
overrides the automatic pass/fail but does not change points.

- **Case points:** quarter sum ÷ 10, clamped to −10…+10.
- **Run score:** 550 + 45 × the mean case points, which maps onto 100–1000.

Every rule can be switched off, re-thresholded or re-pointed per case on the
page. The chart and rule counts update as you edit, and saving recomputes that
case's stored scores for every run. To change a rule for all cases, edit
`DEFAULT_RULES` in `src/lib/planner-bench/score.ts` and bump `SCORER_VERSION`.
The next bench run, or **Recompute scores**, rescores every stored result from
its saved plan, without re-running any planner.

## Running it

**Add a case:** upload a replay file on the page. It is saved and every commit
on the bench is run for it. From the command line:

```bash
deno run -A --sloppy-imports --config deno.json bench/seed.ts NAME=path/to/plan-replay.json
```

**Run commits by hand:** use the workflow's *Run workflow* button in GitHub
Actions (`shas`: `all`, comma-separated SHAs, or `none` to only rescore), or
locally:

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
