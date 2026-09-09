# Planner changes

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
