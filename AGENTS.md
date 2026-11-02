# Highest priority: planning and execution keep running

Planning on the website and execution in the Home Assistant app are the highest
priority features of this system. Neither may stop unless a critical error makes it
impossible to perform its function, such as the database being unavailable.

- **Planning** must be durable, recover from errors automatically, and tolerate data
  gaps and unavailable sensors. Leaving an individual device out of a plan is
  acceptable if the user is shown a warning. Stopping the whole planner is not.
- **Execution** must be durable, recover from errors automatically, and tolerate data
  gaps and unavailable sensors. Not executing an individual device is acceptable if
  the user is shown a warning. Stopping all execution is not.

A general preference for failing fast does not apply to these two paths.

# Default branch

Make all changes on `dev` unless the user explicitly requests another branch.
Check the current branch before editing files and switch to `dev` if needed.

# Environments and deploys

All changes go to `dev` first so they can be tested before reaching production.
Never commit feature work directly to `main`. Promote tested work with a normal
`dev` → `main` merge once it has been verified on the test deploy.

- `dev` → test: TEST Supabase (`vxqpgbzseckgceopitpm`), Cloudflare Pages project
  `test-smart-home-solutions`, https://test-smart-home-solutions.pages.dev
- `main` → production: prod Supabase (`oosxndduqzhvrorgogaw`), Cloudflare Pages
  project `prod-smart-home-solutions`, https://prod-smart-home-solutions.pages.dev

CI (`.github/workflows/ci-deploy.yml`) runs on push to `main` or `dev` on `origin`
(`SHS-se/smart-home-solutions`). It runs lint, tests and build, applies migrations,
deploys edge functions, deploys the frontend, then prunes old Pages deployments,
keeping a short rollback window. Each job runs only for what changed since the
branch's last successful deploy. No manual edge-function deploy is needed;
`scripts/dev.sh deploy [test|live]` is only for ad-hoc testing.

# Other repository

The Home Assistant code is in the separate `shs-ha-integration` repository,
checked out beside this one. Before changing anything there, read its `AGENTS.md`
and follow it.

# Working in this checkout

Other sessions and the user work in this tree too. Before editing or committing,
check the branch and `git status --porcelain`. If not on `dev` with a clean tree,
switch to `dev`. If not on `dev` with staged or uncommitted changes, stop and tell
the user instead of switching, stashing or committing; they may be mid-merge.

Stage files by name, never with `git add -A` or `git add .`. Account for every
line of `git status` before committing; an untracked file you did not write is not
yours to add. Check `git diff --cached --stat` for changes larger than you made.

Never use `git stash` to compare against `HEAD`; an interrupted command leaves the
work stranded. Read the test, inspect the history or use a temporary worktree.

# Answering questions about the setup

For what a home has, what is configured or whether prerequisites are met, query
the Home Assistant connector and search earlier sessions when those tools are
available. Do not answer from source or vendor documentation alone. Verify entity
IDs, units and current values before recommending anything built on them.

# Lint validation

Before committing code changes, run `npm run lint` from the repository root and
fix all errors. Run the full repository command, including for test-only or
backend changes; focused tests and typechecks do not replace ESLint. Do not
disable rules or exclude files to make the check pass. Report the lint result
and any remaining warnings in the final response.

# End-to-end validation

Before committing code changes, build the frontend (`npm run build:test` on
`dev`, `npm run build` otherwise) and run `npm run test:e2e:local`. This runs all
four mocked-backend Playwright suites against the freshly built bundle and
starts/stops its own preview server on port 4173. Install Chromium with
`npx playwright install chromium` if needed. Fix failures and report the result;
lint, typechecks, unit tests, and a successful build do not replace E2E tests.
Keep this command aligned with `.github/workflows/ci-deploy.yml`. The separate
`test:e2e:migration` suite requires configured live services and test accounts.

# Planner changes

The planner runs in a Supabase Edge Function with a strict CPU limit (2 seconds per
request), and going over it kills the worker. Be careful of the performance impact
of every planner change, and read
[planning within Supabase CPU limits](docs/energy-optimisation/supabase-planning-stages.md)
first. Run `deno task test:planner-handler-cpu` and report the result. Do not raise
its budget to make a change pass. The check is scaled to a baseline machine, so
passing it does not prove the change fits the hosted limit.

Follow [the constraint requirements](docs/energy-optimisation/constraint-requirements.md).
Read [component ownership and behavioral contracts](docs/energy-optimisation/planner-component-boundaries.md)
before changing planner, model, transport or execution code. EV departure concepts
are deliberately absent; cable connection must never gate future EV planning.
Do not add either as part of a fix or refactor.

Behavioral contracts in `tests/planner-contracts` are independent requirements,
not generated snapshots. Run `deno task test:planner-contracts` for planner work.
A failing accepted contract is not permission to rewrite its expectation,
widen its tolerance, alter the historical-contract runner or skip its CI gate.
Identify the explicit user-authorized requirement change before changing one.

Do not invent or restore arbitrary validity constraints, including prediction
bounds or source-timestamp event ordering, unless the user explicitly requires them.

Whenever the planner model version or generated plan output changes, run
`deno task generate:ha-contract-fixture` and include any resulting changes to
`contracts/ha-api/fixtures/schema-6-dispatched-ev-plan.json` in the same commit.
Do not edit the generated fixture manually or weaken the contract assertion.

Run `deno task test` before committing planner changes. The full suite includes
`supabase/functions/_shared/ha-api-contract.test.ts`, which checks that the stored
consumer fixture exactly matches output from the real planner; the focused
planner tests alone do not cover this requirement.

Judge planner changes on the planner bench (`docs/planner-bench/README.md`, the
staff page `/portal/planner-bench` on the test site), not from gate tables. Push
to `dev` or run `bench/run.ts --shas <sha>`, and report the run score against the
current planner.

Keep user preferences and live measurements out of `energy_prepared_forecasts`;
read them at planning time. When a setting does not take effect, check whether it
travels through the prepared product before adding cache invalidation.

The pool model is learned from measured data by the daily refit, never by a
one-off retune, and has no air-temperature terms. Propose changes as learned terms
in `fitPoolDynamics`, backtested out-of-sample with a refit before each run, and
show the measured evidence before proposing a model shape.

# Planner bench

The planner version is the only variable between bench runs. Initial conditions,
forecast data and value curves belong to the test case, with curves derived from
the case's data. Before adding a case or changing the household, adapter or
referee, check what each planner version is given and say where versions get
different information.

In `src/lib/planner-bench/score.ts`, price penalties count only energy drawn from
the grid, never load carried by solar or the battery. Two rules must not take
points from the same quarter for the same mistake. When a scoring rule involves a
choice like these, state it with a recommendation before pushing.

# Interface copy

Do not put informational notes in banners at the top of a page. Put a note beside
what it describes, or behind a control in the status row.

Savings copy says "estimate", never "up to" or a similar hedge. Mark a modelled
figure as an estimate once, such as in its section heading, and leave rows and
repeats unqualified. Measured figures are never labelled as estimates.

# Database migrations

Every SQL migration must have a unique timestamp prefix across the repository.
Supabase records that prefix as its migration-history primary key; different
descriptive filenames do not make a shared timestamp safe. Run
`deno test --allow-read tests/migration-versions.test.ts` when adding or renaming
migrations. Preserve applied migration identities when resolving collisions.

# Public repository privacy

Never commit or push private household replays, measured energy or temperature
histories, captured plans, personal room labels, sensor identifiers, or private
analysis reports. Keep private inputs and measured validation outside this
repository. Public regression inputs must be independently generated synthetic
data, clearly labelled as synthetic; removing names alone is insufficient.
Review staged files and their provenance for private data before every push.
