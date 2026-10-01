-- Planner bench tables (docs/planner-bench/README.md).
--
-- TEST project only. This is deliberately not a supabase/migrations file: those
-- run against production too, and the bench holds household replay data that
-- has no business there. The planner-bench workflow applies this file to the
-- test project before every run, so every statement must stay idempotent.

create table if not exists public.bench_scenarios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  captured_at timestamptz not null,
  source_filename text,
  input_hash text,
  -- entrypoint.arguments of the replay: everything the planner reads, nothing else.
  input jsonb not null,
  -- Per-case changes to the default scoring criteria (src/lib/planner-bench/score.ts).
  criteria jsonb not null default '{}'::jsonb,
  notes text,
  archived boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- A scenario is a test case in the bench's own format (src/lib/planner-bench/case.ts):
-- `dataset` is authored (converted from a replay, edited on the page) and
-- `recorded` is what the home recorded for its window, filled by the runner.
-- `input` is the stripped replay older scenarios were uploaded as; the runner
-- converts it once and no longer reads it.
alter table public.bench_scenarios add column if not exists dataset jsonb;
alter table public.bench_scenarios add column if not exists recorded jsonb;
-- Why a case cannot be run yet, in words; null once it can.
alter table public.bench_scenarios add column if not exists pending_reason text;
alter table public.bench_scenarios alter column input drop not null;

create table if not exists public.bench_runs (
  sha text primary key,
  short_sha text not null,
  committed_at timestamptz not null,
  subject text not null default '',
  branch text,
  -- The planner version deployed where plans are currently made.
  is_current boolean not null default false,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  error text,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists bench_runs_one_current on public.bench_runs (is_current) where is_current;
-- What the planner's code does (bench/planner-version.ts). Commits that share a
-- version share one run: the runner folds later ones into the earliest.
alter table public.bench_runs add column if not exists planner_version text;

create table if not exists public.bench_results (
  sha text not null references public.bench_runs (sha) on delete cascade,
  scenario_id uuid not null references public.bench_scenarios (id) on delete cascade,
  status text not null check (status in ('ok', 'error')),
  error text,
  cpu_ms integer,
  series jsonb,
  stats jsonb,
  created_at timestamptz not null default now(),
  primary key (sha, scenario_id)
);
-- Quarter-scoring summary (src/lib/planner-bench/score.ts StoredScore). Written
-- by the runner and recomputed whenever the scorer version or the case's
-- criteria change, so run lists never need the plan series.
alter table public.bench_results add column if not exists score jsonb;
-- What the planner did (PlanRecord: decisions, beliefs, curves) is the stored
-- truth; series, stats, outcome and score are worked out from it by the
-- referee and recomputed when `referee_version` is behind. `input_hash`
-- identifies everything the planner was given: a result with another hash is
-- stale and run again.
alter table public.bench_results add column if not exists record jsonb;
alter table public.bench_results add column if not exists outcome jsonb;
alter table public.bench_results add column if not exists referee_version integer;
alter table public.bench_results add column if not exists input_hash text;

create table if not exists public.bench_verdicts (
  sha text not null references public.bench_runs (sha) on delete cascade,
  scenario_id uuid not null references public.bench_scenarios (id) on delete cascade,
  verdict text not null check (verdict in ('pass', 'fail')),
  note text,
  decided_by uuid default auth.uid(),
  decided_at timestamptz not null default now(),
  primary key (sha, scenario_id)
);

alter table public.bench_scenarios enable row level security;
alter table public.bench_runs enable row level security;
alter table public.bench_results enable row level security;
alter table public.bench_verdicts enable row level security;

-- Staff read everything and curate cases, verdicts and which run is current.
-- Results are written only by the runner, with the service-role key.
do $$
declare
  t text;
begin
  foreach t in array array['bench_scenarios', 'bench_runs', 'bench_results', 'bench_verdicts'] loop
    execute format('drop policy if exists "staff read %1$s" on public.%1$I', t);
    execute format('create policy "staff read %1$s" on public.%1$I for select to authenticated using (public.is_staff(auth.uid()))', t);
  end loop;
  foreach t in array array['bench_scenarios', 'bench_verdicts'] loop
    execute format('drop policy if exists "staff write %1$s" on public.%1$I', t);
    execute format('create policy "staff write %1$s" on public.%1$I for all to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()))', t);
  end loop;
end $$;

-- Marking a run current must clear the previous one in the same statement,
-- which a client update cannot do under the unique index.
create or replace function public.bench_set_current(p_sha text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff(auth.uid()) then
    raise exception 'staff only';
  end if;
  update public.bench_runs set is_current = false where is_current and sha <> p_sha;
  update public.bench_runs set is_current = true where sha = p_sha;
end $$;
revoke all on function public.bench_set_current(text) from public, anon;
grant execute on function public.bench_set_current(text) to authenticated;

-- Totals for every result, without the 30–40 kB plan series behind each.
create or replace view public.bench_result_summaries
with (security_invoker = true) as
select sha, scenario_id, status, error, cpu_ms, stats, score, outcome, referee_version, input_hash
from public.bench_results;
