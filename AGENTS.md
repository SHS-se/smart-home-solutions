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
