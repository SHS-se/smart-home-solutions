# Fix: Supabase egress regression from `energy-battery-policy`

## Summary

The `energy-battery-policy` edge function read the whole
`energy_optimisation_current.plan` column, about 3.56 MB of JSON, twice per
call. Home Assistant builds 0.8.0-beta.98 through 0.9.0-beta.4 called it 60–66
times an hour. From Sep 16 to Sep 18 2026 that took the Supabase org (Free plan,
5 GB egress a month) from ~0.15 GB/day to ~0.5–0.74 GB/day. The current billing
period is at 11.82 GB.

HA 0.9.0-beta.6 (sibling repo `../shs-ha-integration`, commit `c596ec2`) no
longer calls the endpoint. It was installed on Sep 18 at 03:05 UTC, and the
traffic stopped then. **The backend endpoint is still deployed to TEST**, so any
client on an older build would repeat the problem. No current HA build calls it.

This is the third time the same pattern has shipped: a frequently called path
reading the full plan JSON through PostgREST. `8ca6382` (Sep 12) and `bc6b37a`
(Sep 14) fixed the earlier instances.

## Task

1. Remove the `energy-battery-policy` endpoint and the code only it uses.
2. Add a regression test that stops edge functions from reading the whole `plan`
   or `snapshot` column of `energy_optimisation_current`.

Nothing in `../shs-ha-integration` needs to change.

## Evidence

- `supabase/functions/energy-battery-policy/index.ts:36`: `load()` selects
  `plan_id,snapshot_id,ha_ack_status,plan,battery_projection,fixed_plan_revision,fixed_plan_generation_revision`.
- `supabase/functions/_shared/battery-policy-exchange.ts:388` calls `load()`.
  Line 394 calls it again after compiling, only to compare a `canonicalHash` of
  the entire row. Every call therefore made two full reads and hashed ~3.5 MB twice.
- Plan size on TEST (home `9bc2ab59-7832-4530-8a15-e51a09e43a59`): 3,563,752
  bytes of JSON, 216 kB gzipped. The largest keys are `plans` (2.3 MB),
  `execution_plan` (952 kB) and `battery_execution` (184 kB).
- Function logs (`shs_network_traffic`, hourly): from Sep 17 09:00 until the
  03:00 hour on Sep 18, the endpoint ran 60–66 times an hour and read 415–505 MB
  an hour, about 7 MB per call. It stopped after that. It accounts for ≈7.0 GB
  of the ≈8.2 GB decoded traffic in that 24-hour window.
- `pg_stat_statements` since 2026-09-16 21:26 UTC: this SELECT is the top
  PostgREST read, with 2,961 calls.
- Billed egress ≈ decoded bytes ÷ ~15 (gzip). Sep 17 was ~10 GB decoded and
  ~0.74 GB on the usage chart.
- `edge_logs` have no response-size field, so request counts can't rank
  egress. Use the `shs_network_traffic` byte counts.

## 1. Remove the endpoint

Delete:

- `supabase/functions/energy-battery-policy/` (`index.ts`, `deno.json`)
- `supabase/functions/_shared/battery-policy-exchange.ts` and
  `battery-policy-exchange.test.ts`
- `scripts/generate-battery-policy-delivery-fixture.ts` and
  `contracts/ha-api/fixtures/battery-policy-delivery.json`

Edit:

- `supabase/config.toml`: remove the `[functions.energy-battery-policy]` section.
- `scripts/check-edge-function-dependencies.ts`: remove `"energy-battery-policy"`
  from the entrypoint list. CI runs this script, and it fails on a missing
  entrypoint.
- `docs/energy-optimisation/scoped-participation-implementation.md` (~line 99):
  remove or rewrite the paragraph that describes the endpoint.

Keep `supabase/functions/_shared/battery-execution-policy.ts`. Other tests and
scripts still use it: `battery-action-domain.test.ts`,
`scripts/generate-battery-execution-fixtures.ts` and
`scripts/benchmark-battery-execution-cpu.ts`. After the change, grep for
`energy-battery-policy`, `battery-policy-exchange`, `handleBatteryPolicyExchange`
and `buildBatteryPolicyRequest`. They should appear nowhere except documentation
of history.

**Deleting the directory doesn't undeploy the function.** CI's
`supabase functions deploy` only deploys what exists, so the live TEST copy
stays up. Don't run this yourself. List it in your final message for the user:

```bash
supabase functions delete energy-battery-policy --project-ref vxqpgbzseckgceopitpm
```

The function isn't on `main`, so PROD (`oosxndduqzhvrorgogaw`) shouldn't have it.
The user can confirm with
`supabase functions list --project-ref oosxndduqzhvrorgogaw`.

If the user decides to keep the endpoint, narrow it instead of deleting it:

- Replace `load()` with a SQL projection RPC that returns only the fields
  `buildBatteryPolicyRequest` uses. Follow `get_energy_replan_state` in
  `supabase/migrations/20260914220000_narrow_energy_replan_state.sql`.
- Replace the post-compile re-read and whole-row hash with a narrow select of
  identity columns (`plan_id, snapshot_id, fixed_plan_revision,
  fixed_plan_generation_revision`), compared against the first read.

## 2. Regression guard

Add `tests/energy-plan-read-guard.test.ts`. `deno task test` already runs the
`tests/` directory.

- Scan `supabase/functions/**/*.ts` (excluding `*.test.ts`) and
  `src/**/*.{ts,tsx}` for `.from('energy_optimisation_current')` or
  `.from("energy_optimisation_current")`. Take the column list from the
  `.select(...)` in the same chain.
- Fail on a bare `plan` or `snapshot` column, on `*`, or on a `.select()` with
  no arguments. JSON-path selections such as `snapshot->>timezone` are allowed.
- Allowlist only these user-triggered, low-frequency website reads, each with a
  one-line reason in the test:
  - `src/components/portal/energy/PlanWorkbenchTab.tsx` (`snapshot, plan`)
  - `src/components/portal/energy/ValueCurvesTab.tsx` (`snapshot, plan`)
  - `src/components/portal/energy/plan/PlanReplayDownload.tsx`
    (`snapshot, input_hash, plan_id`)
- Never allowlist an edge function. The failure message should point to the
  SQL-projection pattern (`get_energy_replan_state`).
- Add a self-test of the matcher on inline strings so a broken regex can't pass
  silently. `select("plan_id,plan")` and `select("*")` must be caught;
  `select("plan_id")` and `select("snapshot->>timezone")` must pass.
- Before deleting the endpoint, confirm the guard flags it. After deleting it,
  the guard should pass.

Existing tests in the same spirit: `tests/energy-narrow-reads.test.ts` and
`tests/energy-replan-read.test.ts`.

## Constraints

- Work on `dev` (see `CLAUDE.md`). The working tree has unrelated uncommitted
  doc edits from another session, so stage your files explicitly and never use
  `git add -A`.
- Before committing, follow `AGENTS.md`: `npm run lint`, `deno task test`,
  `npm run typecheck`, `npm run build:test` and `npm run test:e2e:local`.
- Use a one-line commit message. Don't push unless the user asks: a push to
  `dev` on the `prod` remote deploys to TEST.
- Out of scope; leave these alone. For context, they make up the remaining
  ~70 MB/day billed:
  - `plan-step` → ingest continuations: ~0.8 MB per step, ~7 steps per plan,
    ~45 MB/day billed.
  - ingest returns the full ~3 MB plan to HA on every exchange, ~22 MB/day billed.
  - the burst of ~27 replans when HA beta.6 was installed.
  - `../shs-ha-integration/tests/fixtures/battery-policy-delivery.json` is now
    unused. Leave it, because any HA commit needs a version bump.

## Verify after deploying to TEST

In the Supabase **Logs Explorer**, which uses ClickHouse SQL, set the range to
Last 24 hours; the Free plan keeps one day of logs. `energy-battery-policy`
should no longer appear:

```sql
select
  toStartOfHour(timestamp) as hour,
  JSONExtractString(msg, 'endpoint') as fn,
  count() as calls,
  round(sum(JSONExtractUInt(msg, 'upstream', 'total', 'response_body_bytes')) / 1e6, 1) as read_mb,
  round(sum(JSONExtractUInt(msg, 'response_body_bytes')) / 1e6, 1) as returned_mb
from (
  select timestamp, substring(event_message, position(event_message, '{')) as msg
  from logs
  where source = 'function_logs'
    and event_message like '%shs_network_traffic%'
)
group by hour, fn
order by hour desc, read_mb desc
limit 500
```

In the Supabase **SQL Editor** (Postgres, not Logs), or with
`supabase db query --linked`, which is linked to TEST: counts are cumulative
since the last reset, so compare two readings a few hours apart. No query that
selects the full `plan` should grow.

```sql
select (select stats_reset from extensions.pg_stat_statements_info) as since,
       s.calls,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 250) as query
from extensions.pg_stat_statements s
where s.query like '%pgrst%'
order by s.calls desc
limit 30;
```
