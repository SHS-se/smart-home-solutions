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
