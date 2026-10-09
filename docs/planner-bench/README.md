# Planner bench

Benchmark history starts at `4cc6718cecdcc6b06fbc48216c504e6022fd659d`
(`2026-10-07T16:37:53Z`). Earlier runs and their results are deleted from TEST.
The runner excludes earlier commits before inspecting or solving their planner,
including explicit selections and `all`; the TEST database rejects their reinsertion.
Cases, measured history and scoring rules are retained.

The bench decides whether a planner change is better by showing it, not by a
gate table. Every planner version plans the same set of test cases, for the
same household, and is scored the same way at what electricity really cost.
You can look at each plan beside the planner that is running now and score it with
points you control.

Page: **Planner bench** in the staff menu, on the test site
(`https://test.smarthomesolutions.se/portal/planner-bench`).

## The page's two tabs

`/portal/planner-bench` has two tabs, kept in the URL (`?tab=prices`):

- **Planner bench**: the cases, scores and plans described below. Every planner
  is given the real prices of a case's 72 hours (the oracle lane), so the bench
  judges planning alone and its charts draw no price estimate.
- **Price estimate accuracy**: how well unpublished prices are estimated, from
  the live homes' kept estimates (`energy_price_estimate_days`,
  `get_price_estimate_series`). One estimate at a time: a chart of the estimate
  against the real prices, a table of the same days, and how it was produced;
  previous/next step through the days estimates were made on. The figures are
  worked out in `src/lib/planner-bench/price-estimates.ts` from the quarters
  the chart draws: level error is the gap between a day's estimated and real
  mean, quarter error the mean gap per quarter-hour.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Test cases, runs, results, verdicts | `bench_*` tables in the **TEST** Supabase project | Schema in `bench/schema.sql` (idempotent). Deliberately not a migration, so household data never reaches production. |
| Runner | `bench/run.ts`, `bench/adapter.ts`, `bench/history.ts`, `bench/store.ts`, `bench/planner-version.ts` | Converts and completes test cases, then checks each planner commit out as a git worktree and plans every case whose result is missing or stale, in a fresh Deno process. Stores what the planner decided and the referee's account of it. |
| Shared logic | `src/lib/planner-bench/` | Test case format, replay conversion, household, referee, totals, scoring. Used by both the runner and the page. |
| CI | `.github/workflows/planner-bench.yml` | After successful main/dev deployments, benches the current branch heads and stale results, marking main as current and dev as test. Manual planning runs also refresh branch heads; rescore-only runs preserve identity. |
| Rerun button | `supabase/functions/planner-bench-dispatch` | Lets the page start the workflow. Needs the `PLANNER_BENCH_GITHUB_TOKEN` secret (below). |
| Page | `src/pages/portal/PlannerBench.tsx` | Run picker, totals, case chips, plan charts, rule list, upload. |

## Test cases

A test case is a 72-hour scenario in the bench's own format, not a replay:
what a planner is told at the start, plus what was recorded for the window
afterwards. The household, the adapter that builds each planner's input, and
the referee that scores every plan at real prices are described in
[test-cases.md](test-cases.md).

## Planner versions

Every requested commit keeps its own run and results. The planner is its own
folder, `supabase/functions/_shared/planner/`, which imports nothing from outside
itself (`tests/planner-boundary.test.ts`). A commit's planner version is a hash
of the code that folder's entry points reach, with types, comments and
formatting stripped by esbuild (`bench/planner-version.ts`). That hash describes
code equivalence; it never replaces a commit's SHA or moves its environment marks.

Commits selecting `rule-wasm` in `bench/planner-engine.json` run the Rust/Wasm
rule planner in the TEST bench. This selection is scoped to the bench; production
replanning still uses the TypeScript planner. The Wasm version hashes the verified
binary, its source manifest and the explicit engine selection. Missing, stale or
unsupported configured artifacts fail the run. Historical commits without this
selection retain their original TypeScript entry point and version.

The rule planner receives the bench's saved rules when it builds each plan.
Changing rules and running the bench regenerates these plans because the rules
are part of their input identity. **Recompute scores** still only rescores stored
decisions; use **Rerun** to build new decisions under the updated rules. The
independent referee continues to judge every plan on the original case.
The low/nominal/high valuation lanes remain available for comparison, but their
decisions are identical for this planner because it has no cost-value curves;
its valuation metadata reports `none`. Told and oracle price lanes still differ
in the price information supplied; the page shows and scores the oracle lane,
where the planner is given the real prices.

The dropdown keeps the newest commit in each consecutive group with equal,
complete scores. Unscored, running and failed commits stay visible, as do the
main head, dev head and currently selected historical commit. Stored runs,
results and verdicts remain attached to their original commits.
When a run is no longer eligible for today's comparison, the picker still
shows its stored points, with the scorer version and number of saved cases.
Selecting it also shows that saved total beside the current coverage message.
Saved totals describe the executed cases and do not enter a current comparison.
The picker uses a bounded scrolling viewport with a scrollbar instead of
hover-triggered scroll arrows.

Commits from before the planner existed retain their SHA and environment marks
but are labelled **no planner** (`unavailable`). The runner checks for the planner
entry point before hashing code or launching a worker. These commits have no
score and do not count toward executable benchmark coverage. Missing imports
or runtime errors in an existing planner still fail the benchmark normally.

## Current and test planner

- **Current:** the exact `main` branch-head commit, marked `is_current` by CI.
- **Test:** defaults to the exact `dev` branch-head commit, marked `is_test` by CI. The dropdown also allows historical comparisons.

Both marks belong to the same run only when main and dev point to the same SHA.
The workflow fetches and marks both branch heads before each planning run.
Routine refreshes run dev first, then main, once per measured case. Explicit
historical selections run only those commits. `--shas none` only
rescores and does not change these marks. Environment marks cannot be changed
from the page.

The totals table compares only the cases both runs have results for.

## Scoring

The score combines comfort with demonstrated opportunities to reduce cost. Physical
violations fail the automatic verdict independently. The rule list shows one row per
rule that fired in the period the chart shows (72 h or one day), with its points per
quarter and the quarters it fired in for each planner; a row opens its explanation,
replayed alternatives and, for quarter rules, its settings. Rules are saved once for
the whole bench, not per case. See the [complete scoring rules](scoring.md) and
[architecture decision](scoring-design.md). Costs remain visible in SEK at real
prices; six optional diagnostic lanes separate price information from valuation
strength. Normal refreshes use only the nominal lane with prices known at start.
Saving rules refreshes the branch heads, including new solves when rules affect
planner decisions. **Recompute scores** re-evaluates stored decisions without
running planners; this does not make old rule-driven decisions newly optimized.
Routine refreshes verify their requested results; stale history stays excluded
from current comparisons until explicitly refreshed. Its saved points remain visible.

The benchmark store serializes its requests and leaves idle time of at least
250 ms, or the preceding request's duration if longer, between them. This limits
benchmark pressure on the TEST database shared with the household portal and
planning workers. Coverage reads use artifact-presence metadata; current results
do not download their source decisions. Scorer changes write only the score when
the audit and criteria are unchanged; audit changes update audit and score
together, and referee changes replace the complete evaluation. Each write checks
the observed source identity and score, and fails if another run replaced them.
Updating an audit inside JSONB still rewrites that series, so pacing remains
necessary. Missing JSON artifacts use SQL NULL and stored artifacts must be objects.
The storage constraint validates existing artifacts on row updates, so smaller
writes reduce rewrites and network traffic without eliminating all JSON reads.

## Running it

**Add a case:** upload a replay file on the page. It is converted to a test case,
and once its 72 hours are recorded the current dev/main heads run for it. Saved
historical planners can be selected explicitly. From the command line:

```bash
deno run -A --sloppy-imports --config deno.json bench/seed.ts NAME=path/to/plan-replay.json
```

C-1005 preserves the converted 5 October replay in the TEST database, starting
at 10:15 UTC with 47 published-price quarters, pool water at 30.01 °C, battery
at 13.9 % and EV at 66 %. Its former synthetic outcome has been removed. Like
all replay cases, it waits for complete measured prices, temperature, load and
solar over its 72 hours (ending 8 October at 10:15 UTC). Re-running the bench
completes it once those observations exist. Household case data belongs in the
TEST database, not a bespoke repository fixture.

A window from before the home's quarter tables (12 August 2026) is made into a
case from Home Assistant's hourly statistics, then added the same way
([where test cases come from](test-cases.md#where-test-cases-come-from)):

```bash
deno run -A --sloppy-imports --config deno.json bench/seed-history.ts --market market.json --out cases NAME=path/to/history.json
deno run -A --sloppy-imports --config deno.json bench/seed.ts NAME=cases/NAME.json
```

**Run commits by hand:** use the workflow's *Run workflow* button in GitHub
Actions (`shas`: `heads`, `all`, comma-separated SHAs, or `none` to only rescore;
`scope`: `base` by default or `diagnostics` for all six lanes), or
locally:

After the home's quarter tables have been corrected, run it with `rerecord`
(`--rerecord`, together with `shas` `all`): every case not made from an hourly
history file reads its complete measured prices, weather, load, solar and
pre-case history again, replacing what is stored. An incomplete window becomes
pending; its previous outcome is not reused. Only cases whose input changed are planned again.

```bash
deno run -A --no-check --sloppy-imports --config deno.json bench/run.ts --shas heads --current origin/main --test origin/dev
# Explicit history and diagnostic expansion:
deno run -A --no-check --sloppy-imports --config deno.json bench/run.ts --shas all --scope diagnostics
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

Result lists use paginated, deterministic reads. Suite scores require every
ready case; pending cases are excluded on both sides. A database-generated
case revision marks changed inputs stale, separately from the planner-specific
input hash. Existing results can acquire a revision only after the runner
reproduces their full input hash. Rescoring never applies old decisions to a
changed case. A full bench run fails if any ready planner/case/lane is missing,
stale or failed; rescore-only reports such gaps without recreating decisions.
