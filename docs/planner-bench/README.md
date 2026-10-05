# Planner bench

The bench decides whether a planner change is better by showing it, not by a
gate table. Every planner version plans the same set of test cases, for the
same household, and is scored the same way at what electricity really cost.
You can look at each plan beside the planner that is running now and score it with
points you control.

Page: **Planner bench** in the staff menu, on the test site
(`https://test.smarthomesolutions.se/portal/planner-bench`).

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Test cases, runs, results, verdicts | `bench_*` tables in the **TEST** Supabase project | Schema in `bench/schema.sql` (idempotent). Deliberately not a migration, so household data never reaches production. |
| Runner | `bench/run.ts`, `bench/adapter.ts`, `bench/history.ts`, `bench/store.ts`, `bench/planner-version.ts` | Converts and completes test cases, then checks each planner commit out as a git worktree and plans every case whose result is missing or stale, in a fresh Deno process. Stores what the planner decided and the referee's account of it. |
| Shared logic | `src/lib/planner-bench/` | Test case format, replay conversion, household, referee, totals, scoring. Used by both the runner and the page. |
| CI | `.github/workflows/planner-bench.yml` | On push to `dev` that touches the planner or the bench's own input and judgement: benches the pushed commit and every stale result, and marks the pushed planner version current. On manual dispatch: runs any commits, usually `all`. |
| Rerun button | `supabase/functions/planner-bench-dispatch` | Lets the page start the workflow. Needs the `PLANNER_BENCH_GITHUB_TOKEN` secret (below). |
| Page | `src/pages/portal/PlannerBench.tsx` | Run picker, totals, case chips, plan charts, rule list, upload. |

## Test cases

A test case is a 72-hour scenario in the bench's own format, not a replay:
what a planner is told at the start, plus what was recorded for the window
afterwards. The household, the adapter that builds each planner's input, and
the referee that scores every plan at real prices are described in
[test-cases.md](test-cases.md).

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

The score combines comfort with demonstrated opportunities to reduce cost. Physical
violations fail the automatic verdict independently. The rule list shows one row per
rule that fired in the period the chart shows (72 h or one day), with its points per
quarter and the quarters it fired in for each planner; a row opens its explanation,
replayed alternatives and, for quarter rules, its settings. Rules are saved once for
the whole bench, not per case. See the [complete scoring rules](scoring.md) and
[architecture decision](scoring-design.md). Costs remain visible in SEK at real
prices; the six lanes separate price information from valuation strength.
The next bench run, or **Recompute scores**, re-evaluates every stored result
from its stored decisions when a rule or the referee changes; no planner runs.

## Running it

**Add a case:** upload a replay file on the page. It is converted to a test case, and once its 72 hours are recorded every commit
on the bench is run for it. From the command line:

```bash
deno run -A --sloppy-imports --config deno.json bench/seed.ts NAME=path/to/plan-replay.json
```

`bench/cases/C-1005.json` preserves the converted 5 October 2026 replay beginning
at 10:15 UTC, with 47 published-price quarters, pool water at 30.01 °C, battery
at 13.9 % and EV at 66 %. The SHS test bench case is
`ef654356-5b2b-453b-8cb2-649dadcf1e6b`. Its measured 72-hour window and saved
comfort preferences are completed by the database runner; no actual results
have been invented for its future quarters. The raw replay and its old plan
are excluded from the case.

A window from before the home's quarter tables (12 August 2026) is made into a
case from Home Assistant's hourly statistics, then added the same way
([where test cases come from](test-cases.md#where-test-cases-come-from)):

```bash
deno run -A --sloppy-imports --config deno.json bench/seed-history.ts --market market.json --out cases NAME=path/to/history.json
deno run -A --sloppy-imports --config deno.json bench/seed.ts NAME=cases/NAME.json
```

**Run commits by hand:** use the workflow's *Run workflow* button in GitHub
Actions (`shas`: `all`, comma-separated SHAs, or `none` to only rescore), or
locally:

After the home's quarter tables have been corrected, run it with `rerecord`
(`--rerecord`, together with `shas` `all`): every case not made from an hourly
history file reads what the house drew and the days before it again, replacing
what is stored. Only cases whose input changed are planned again.

```bash
deno run -A --no-check --sloppy-imports --config deno.json bench/run.ts --shas all
```

Database mode needs `BENCH_SUPABASE_URL` and `BENCH_SERVICE_ROLE_KEY`. Without
a database, `--local <dir-of-case-files> --out <file.json>` (each file `{ dataset, recorded }`) writes the same
records to a file. Local cases must supply both `comfort.pool_c` and `comfort.ev_km`;
there are no internal bench defaults. Database planning runs capture the history
home’s current saved comfort preferences into each selected case before planning,
and changed preferences invalidate the input hash. `--shas none` keeps those
captured targets while rescoring existing decisions.

CI can only run commits that are pushed. A local-only branch has to be run
locally.

## State-value experiments

The [shared state-value design](state-values/design.md) and
[replan reuse results](state-values/replan-report.md) investigate one Bellman
engine for battery, EV and pool, with device-specific physics and shared energy
coordination. The executable prototypes live in `bench/experiments/` and do not
replace the live planner. Tests are part of `deno task test`. Reproduction
commands and measured limitations are in the report; eight to ten rounds have
not yet demonstrated sufficient search quality.

## One-time setup

1. In GitHub, create a fine-grained personal access token for
   `SHS-se/smart-home-solutions` with **Actions: Read and write**.
2. Add it to the TEST Supabase project as the edge function secret
   `PLANNER_BENCH_GITHUB_TOKEN`.

Without the token, everything except the page's rerun button works; start runs
from GitHub Actions instead. The workflow uses the existing
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD_TEST` secrets.
