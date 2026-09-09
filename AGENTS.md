# Planner changes

Whenever the planner model version or generated plan output changes, run
`deno task generate:ha-contract-fixture` and include any resulting changes to
`contracts/ha-api/fixtures/schema-6-dispatched-ev-plan.json` in the same commit.
Do not edit the generated fixture manually or weaken the contract assertion.

Run `deno task test` before committing planner changes. The full suite includes
`supabase/functions/_shared/ha-api-contract.test.ts`, which checks that the stored
consumer fixture exactly matches output from the real planner; the focused
planner tests alone do not cover this requirement.
