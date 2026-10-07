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
  -- No longer read: the rules are the same for every case (bench_rules).
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
-- Content identity shared by every planner generation. Authored edits and new
-- observations invalidate results automatically; capture timestamps do not.
alter table public.bench_scenarios add column if not exists revision text generated always as (
  md5(coalesce((dataset - 'origin')::text, '') || '|' || coalesce((recorded - 'recorded_at')::text, ''))
) stored;
alter table public.bench_scenarios alter column input drop not null;

-- The scoring rules, as changes to the defaults in src/lib/planner-bench/score.ts.
-- One row: every case and every planner is scored with the same rules, or
-- their points could not be compared.
create table if not exists public.bench_rules (
  id boolean primary key default true check (id),
  criteria jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.bench_rules (id) values (true) on conflict (id) do nothing;

create table if not exists public.bench_runs (
  sha text primary key,
  short_sha text not null,
  committed_at timestamptz not null,
  subject text not null default '',
  branch text,
  -- The commit at the production/main branch head.
  is_current boolean not null default false,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  error text,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.bench_runs add column if not exists is_test boolean not null default false;
create unique index if not exists bench_runs_one_test on public.bench_runs (is_test) where is_test;
create unique index if not exists bench_runs_one_current on public.bench_runs (is_current) where is_current;
-- What the planner's code does (bench/planner-version.ts). Equal versions
-- still keep separate commit identities, results and environment marks.
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
alter table public.bench_results add column if not exists case_revision text;
-- Each case is planned under several lanes (src/lib/planner-bench/lanes.ts):
-- which prices the planner was told, and how much its value curves were worth.
alter table public.bench_results add column if not exists lane text not null default 'told/nominal';
do $$
begin
  if (select count(*) from information_schema.key_column_usage
      where table_schema = 'public' and table_name = 'bench_results' and constraint_name = 'bench_results_pkey') < 3 then
    alter table public.bench_results drop constraint bench_results_pkey;
    alter table public.bench_results add primary key (sha, scenario_id, lane);
  end if;
end $$;

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
alter table public.bench_rules enable row level security;

-- Staff read everything and curate cases, rules and verdicts.
-- Results are written only by the runner, with the service-role key.
do $$
declare
  t text;
begin
  foreach t in array array['bench_scenarios', 'bench_runs', 'bench_results', 'bench_verdicts', 'bench_rules'] loop
    execute format('drop policy if exists "staff read %1$s" on public.%1$I', t);
    execute format('create policy "staff read %1$s" on public.%1$I for select to authenticated using (public.is_staff(auth.uid()))', t);
  end loop;
  foreach t in array array['bench_scenarios', 'bench_verdicts', 'bench_rules'] loop
    execute format('drop policy if exists "staff write %1$s" on public.%1$I', t);
    execute format('create policy "staff write %1$s" on public.%1$I for all to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()))', t);
  end loop;
end $$;

-- Deployment identity belongs to successful CI deployments, never manual UI edits.
drop function if exists public.bench_set_current(text);
create or replace function public.bench_set_deployed(p_sha text, p_environment text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if p_environment not in ('production', 'test') or p_environment is null then
    raise exception 'Unknown deployment environment';
  end if;
  perform pg_advisory_xact_lock(hashtext('bench deployment identity'));
  if not exists (select 1 from public.bench_runs where sha=p_sha) then
    raise exception 'Unknown deployed planner: %', p_sha;
  end if;
  if p_environment='production' then
    update public.bench_runs set is_current=false where is_current and sha<>p_sha;
    update public.bench_runs set is_current=true where sha=p_sha;
  else
    update public.bench_runs set is_test=false where is_test and sha<>p_sha;
    update public.bench_runs set is_test=true where sha=p_sha;
  end if;
end $$;
revoke all on function public.bench_set_deployed(text,text) from public, anon, authenticated;
grant execute on function public.bench_set_deployed(text,text) to service_role;

-- SQL NULL is the sole representation of absent JSON artifacts. Establish the
-- object/null storage contract once, so coverage presence checks never detoast
-- source decisions or series. JSON null and SQL NULL mean the same absence.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.bench_results'::regclass
    and conname='bench_result_json_objects') then
    update public.bench_results set record=nullif(record,'null'::jsonb),series=nullif(series,'null'::jsonb),
      stats=nullif(stats,'null'::jsonb),outcome=nullif(outcome,'null'::jsonb)
      where record='null'::jsonb or series='null'::jsonb or stats='null'::jsonb or outcome='null'::jsonb;
    alter table public.bench_results add constraint bench_result_json_objects check (
      (record is null or jsonb_typeof(record)='object') and (series is null or jsonb_typeof(series)='object')
      and (stats is null or jsonb_typeof(stats)='object') and (outcome is null or jsonb_typeof(outcome)='object'));
  end if;
end $$;

-- Totals for every result, without the 30–40 kB plan series behind each.
create or replace view public.bench_result_summaries
with (security_invoker = true) as
select sha, scenario_id, status, error, cpu_ms, stats, score, outcome, referee_version, input_hash, lane,
  created_at,
  record is not null as has_record,
  series is not null and stats is not null and outcome is not null as has_evaluation,
  case_revision
from public.bench_results;

-- A legacy result may acquire its case revision only after the runner has
-- reproduced its complete input hash. Neither its decisions nor timestamps change.
create or replace function public.bench_bind_result_revision(p_sha text, p_scenario uuid, p_lane text, p_input_hash text, p_revision text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare n integer;
begin
  update public.bench_results r set case_revision=p_revision
  where r.sha=p_sha and r.scenario_id=p_scenario and r.lane=p_lane
    and r.input_hash=p_input_hash and r.status='ok' and r.record is not null
    and exists (select 1 from public.bench_scenarios s where s.id=p_scenario
      and s.revision=p_revision and s.recorded is not null and not s.archived);
  get diagnostics n=row_count;
  return n=1;
end $$;
revoke all on function public.bench_bind_result_revision(text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.bench_bind_result_revision(text,uuid,text,text,text) to service_role;

-- Derived writes are fenced by the observed source and evaluation. A scorer or
-- audit change does not rewrite unchanged referee output or source decisions.
create or replace function public.bench_save_evaluation(p_update jsonb)
returns boolean language plpgsql security invoker set search_path=public as $$
declare
  g jsonb := p_update->'guard';
  k text := p_update->>'kind';
  n integer;
begin
  if k is null or k not in ('score','audit-score','evaluation')
    or jsonb_typeof(g) is distinct from 'object'
    or (k in ('score','audit-score') and jsonb_typeof(p_update->'score') is distinct from 'object')
    or (k='audit-score' and jsonb_typeof(p_update->'audit') is distinct from 'object')
    or (k='evaluation' and (jsonb_typeof(p_update->'value'->'series') is distinct from 'object'
      or jsonb_typeof(p_update->'value'->'stats') is distinct from 'object'
      or jsonb_typeof(p_update->'value'->'outcome') is distinct from 'object'
      or jsonb_typeof(p_update->'value'->'score') is distinct from 'object'
      or p_update->'value'->>'referee_version' is null)) then
    raise exception 'Invalid benchmark evaluation mutation' using errcode='22023';
  end if;
  update public.bench_results r set
    score=case when k='evaluation' then p_update->'value'->'score' else p_update->'score' end,
    series=case when k='evaluation' then p_update->'value'->'series'
      when k='audit-score' then jsonb_set(r.series,'{audit}',p_update->'audit') else r.series end,
    stats=case when k='evaluation' then p_update->'value'->'stats' else r.stats end,
    outcome=case when k='evaluation' then p_update->'value'->'outcome' else r.outcome end,
    referee_version=case when k='evaluation' then (p_update->'value'->>'referee_version')::integer else r.referee_version end
  where r.sha=g->>'sha' and r.scenario_id=(g->>'scenario_id')::uuid and r.lane=g->>'lane'
    and r.status='ok' and r.record is not null
    and r.input_hash is not distinct from g->>'input_hash'
    and r.created_at=(g->>'created_at')::timestamptz
    and r.referee_version is not distinct from (g->>'referee_version')::integer
    and r.score is not distinct from nullif(g->'score','null'::jsonb)
    and r.case_revision=g->>'case_revision'
    and exists (select 1 from public.bench_scenarios s where s.id=r.scenario_id
      and s.revision=r.case_revision and s.recorded is not null and not s.archived)
    and (k='evaluation' or (r.series is not null and r.stats is not null and r.outcome is not null));
  get diagnostics n=row_count;
  return n=1;
end $$;
revoke all on function public.bench_save_evaluation(jsonb) from public, anon, authenticated;
grant execute on function public.bench_save_evaluation(jsonb) to service_role;
