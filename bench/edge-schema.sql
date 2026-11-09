-- TEST only. Apply after bench/schema.sql. The queue and executable archive
-- have no staff/anonymous grants; staff use the authenticated dispatcher.
begin;

insert into storage.buckets (id, name, public)
values ('bench-executables', 'bench-executables', false)
on conflict (id) do nothing;

create table if not exists public.bench_edge_artifacts (
  sha text primary key check (sha ~ '^[0-9a-f]{40}$'),
  worker text not null unique check (worker = 'bench-' || sha),
  planner_version text not null,
  generation text not null,
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz not null,
  subject text not null
);
alter table public.bench_edge_artifacts enable row level security;
revoke all on public.bench_edge_artifacts from public, anon, authenticated, service_role;
grant select, insert on public.bench_edge_artifacts to service_role;

create table if not exists public.bench_edge_settings (
  singleton boolean primary key default true check (singleton),
  active boolean not null default false,
  wake_token text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
insert into public.bench_edge_settings (singleton) values (true) on conflict do nothing;
alter table public.bench_edge_settings enable row level security;
revoke all on public.bench_edge_settings from public, anon, authenticated, service_role;

create table if not exists public.bench_edge_parity (
  sha text not null references public.bench_edge_artifacts(sha),
  scenario_id uuid not null references public.bench_scenarios(id) on delete cascade,
  case_revision text not null,
  reference_at timestamptz not null,
  input_hash text not null,
  score_hash text not null,
  bundle_hash text not null,
  criteria jsonb not null,
  primary key (sha, scenario_id)
);
alter table public.bench_edge_parity enable row level security;
revoke all on public.bench_edge_parity from public, anon, authenticated, service_role;

create or replace function public.bench_record_edge_parity(p_sha text, p_case uuid,
  p_revision text, p_reference_at timestamptz, p_hash text, p_rules jsonb, p_bundle text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  insert into public.bench_edge_parity
    select r.sha, s.id, s.revision, r.created_at, r.input_hash, md5(r.score::text), a.bundle_hash, rules.criteria
    from public.bench_results r join public.bench_scenarios s on s.id=r.scenario_id
    join public.bench_edge_artifacts a on a.sha=r.sha cross join public.bench_rules rules
    where r.sha=p_sha and s.id=p_case and not s.archived and r.lane='oracle/nominal' and r.status='ok'
      and s.revision=p_revision and r.case_revision=p_revision and r.created_at=p_reference_at
      and r.input_hash=p_hash and r.score is not null and a.bundle_hash=p_bundle and rules.criteria=p_rules
  on conflict (sha, scenario_id) do update set
    case_revision=excluded.case_revision, reference_at=excluded.reference_at, input_hash=excluded.input_hash,
    score_hash=excluded.score_hash, bundle_hash=excluded.bundle_hash, criteria=excluded.criteria;
  return found;
end;
$$;
create or replace function public.bench_edge_active()
returns boolean language sql stable security definer set search_path='' as $$
  select active from public.bench_edge_settings where singleton;
$$;
create or replace function public.bench_edge_token()
returns text language sql stable security definer set search_path='' as $$
  select wake_token from public.bench_edge_settings where singleton;
$$;

revoke all on function public.bench_record_edge_parity(text,uuid,text,timestamptz,text,jsonb,text),
  public.bench_edge_active(),public.bench_edge_token() from public, anon, authenticated, service_role;
grant execute on function public.bench_record_edge_parity(text,uuid,text,timestamptz,text,jsonb,text),
  public.bench_edge_active(),public.bench_edge_token() to service_role;

create table if not exists public.bench_edge_jobs (
  id bigint generated always as identity primary key,
  shas text[] not null,
  scenario uuid,
  lanes text[] not null,
  criteria jsonb not null,
  preparation jsonb,
  event text not null,
  force boolean not null,
  rerecord boolean not null,
  phase text not null check (phase in ('prepare','solve','rescore','retain')),
  status text not null default 'queued' check (status in ('queued','in_progress','completed')),
  conclusion text check (conclusion in ('success','failure')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.bench_edge_tasks (
  id bigint generated always as identity primary key,
  job_id bigint not null references public.bench_edge_jobs(id) on delete cascade,
  kind text not null check (kind in ('prepare','solve','rescore','retain')),
  scenario uuid,
  revision text,
  sha text,
  lane text,
  attempt int not null default 0,
  wake_after timestamptz not null default now(),
  lease_until timestamptz,
  finished boolean not null default false
);
-- During qualification the queue can already exist with no jobs.
alter table public.bench_edge_jobs drop constraint if exists bench_edge_jobs_phase_check;
alter table public.bench_edge_jobs add constraint bench_edge_jobs_phase_check check (phase in ('prepare','solve','rescore','retain'));
alter table public.bench_edge_tasks alter column scenario drop not null;
alter table public.bench_edge_tasks alter column revision drop not null;
alter table public.bench_edge_tasks drop constraint if exists bench_edge_tasks_kind_check;
alter table public.bench_edge_tasks add constraint bench_edge_tasks_kind_check check (kind in ('prepare','solve','rescore','retain'));
create index if not exists bench_edge_pending on public.bench_edge_tasks(job_id,id) where not finished;
alter table public.bench_edge_jobs enable row level security;
alter table public.bench_edge_tasks enable row level security;
revoke all on public.bench_edge_jobs, public.bench_edge_tasks from public, anon, authenticated, service_role;

create or replace view public.bench_edge_ready_cases as
  select id, revision from public.bench_scenarios
  where not archived and dataset is not null and jsonb_typeof(recorded->'actual')='object'
    and not (recorded ? 'synthetic_quarters');
revoke all on public.bench_edge_ready_cases from public, anon, authenticated, service_role;
grant select on public.bench_edge_ready_cases to service_role;

create or replace function public.bench_enable_edge(p_cases integer, p_historical text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_cases is distinct from 24 or (select count(*) from public.bench_edge_ready_cases) <> p_cases
     or not exists (select 1 from public.bench_runs where is_current)
     or not exists (select 1 from public.bench_runs where is_test)
     or not exists (select 1 from public.bench_edge_artifacts where sha=p_historical)
     or exists (
      select 1 from public.bench_runs runs cross join public.bench_edge_ready_cases cases
      cross join public.bench_rules rules
      where (runs.is_current or runs.is_test or runs.sha=p_historical) and not exists (
        select 1 from public.bench_edge_parity p join public.bench_results r
          on r.sha=p.sha and r.scenario_id=p.scenario_id and r.lane='oracle/nominal'
        join public.bench_edge_artifacts a on a.sha=p.sha
        where p.sha=runs.sha and p.scenario_id=cases.id and p.case_revision=cases.revision
          and r.status='ok' and r.case_revision=cases.revision
          and r.created_at=p.reference_at and r.input_hash=p.input_hash and md5(r.score::text)=p.score_hash
          and rules.criteria=p.criteria and a.bundle_hash=p.bundle_hash and runs.planner_version=a.planner_version
      )
    ) or not exists (select 1 from public.bench_runs where sha=p_historical and not is_current and not is_test) then
    raise exception 'TEST Edge cutover requires all 24 exact case matches on both heads and the historical reference';
  end if;
  update public.bench_edge_settings set active=true where singleton;
end;
$$;

-- Cron and completion use pg_net to begin a fresh request/trace. The job lock
-- admits one live task, so duplicate wakeups do not increase database pressure.
create or replace function public.bench_wake_edge()
returns void language plpgsql security definer set search_path='' as $$
declare j bigint;
begin
  if not public.bench_edge_active() then return; end if;
  select id into j from public.bench_edge_jobs where status<>'completed' order by id limit 1;
  if j is not null and exists (
    select 1 from public.bench_edge_tasks
    where job_id=j and not finished and wake_after<=now() and (lease_until is null or lease_until<=now())
  ) and not exists (
    select 1 from public.bench_edge_tasks where job_id=j and not finished and lease_until>now()
  ) then
    perform net.http_post(
      url:='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/planner-bench-edge',
      headers:=jsonb_build_object('content-type','application/json','x-planner-bench-token',
        (select wake_token from public.bench_edge_settings where singleton)),
      body:='{"action":"advance"}'::jsonb,timeout_milliseconds:=30000);
  end if;
end;
$$;

create or replace function public.bench_edge_finish_phase(p_job bigint)
returns void language plpgsql security definer set search_path='' as $$
declare j public.bench_edge_jobs%rowtype;
begin
  select * into strict j from public.bench_edge_jobs where id=p_job for update;
  if exists (select 1 from public.bench_edge_tasks where job_id=j.id and not finished) then return; end if;
  if j.phase='prepare' then
    update public.bench_edge_jobs set phase='solve',updated_at=now() where id=j.id;
    insert into public.bench_edge_tasks (job_id,kind,scenario,revision,sha,lane)
      select j.id,'solve',s.id,s.revision,sha,lane from public.bench_edge_ready_cases s
      cross join unnest(j.shas) sha cross join unnest(j.lanes) lane
      where j.scenario is null or s.id=j.scenario order by sha,s.id,lane;
    if found then
      update public.bench_runs set status='running',error=null,finished_at=null where sha=any(j.shas);
      return;
    end if;
  end if;
  if j.phase='solve' and j.scenario is null then
    update public.bench_edge_jobs set phase='retain',updated_at=now() where id=j.id;
    insert into public.bench_edge_tasks(job_id,kind) values(j.id,'retain');
    return;
  end if;
  if j.phase<>'rescore' then
    update public.bench_runs set status='done',error=null,finished_at=now() where sha=any(j.shas);
  end if;
  update public.bench_edge_jobs set status='completed',conclusion='success',updated_at=now() where id=j.id;
end;
$$;

create or replace function public.bench_enqueue_edge(p_shas text[],p_scenario uuid,p_lanes text[],
  p_force boolean,p_rerecord boolean,p_rescore boolean,p_event text,p_preparation jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
declare j bigint;
begin
  if not public.bench_edge_active() then raise exception 'TEST Edge bench is awaiting parity qualification'; end if;
  if not p_rescore and (
    coalesce(cardinality(p_shas),0)=0 or exists (
      select 1 from unnest(p_shas) requested(ref) where not exists (select 1 from public.bench_edge_artifacts a where a.sha=requested.ref)
    )
  ) then raise exception 'A selected planner has no registered TEST executable'; end if;
  insert into public.bench_runs(sha,short_sha,committed_at,subject,planner_version,status)
    select sha,left(sha,7),committed_at,subject,planner_version,'pending'
    from public.bench_edge_artifacts where sha=any(p_shas) on conflict (sha) do nothing;
  insert into public.bench_edge_jobs(shas,scenario,lanes,criteria,preparation,event,force,rerecord,phase)
    values(p_shas,p_scenario,p_lanes,(select criteria from public.bench_rules),p_preparation,p_event,p_force,p_rerecord,
      case when p_rescore then 'rescore' else 'prepare' end) returning id into j;
  if p_rescore then
    insert into public.bench_edge_tasks(job_id,kind,scenario,revision,sha,lane)
      select j,'rescore',s.id,s.revision,r.sha,r.lane
      from public.bench_edge_ready_cases s join public.bench_results r on r.scenario_id=s.id
      where (p_scenario is null or s.id=p_scenario) and r.status='ok' and r.case_revision=s.revision
      order by r.sha,s.id,r.lane;
  else
    insert into public.bench_edge_tasks(job_id,kind,scenario,revision)
      select j,'prepare',id,revision from public.bench_scenarios
      where not archived and (p_scenario is null or id=p_scenario) order by captured_at,id;
  end if;
  perform public.bench_edge_finish_phase(j);
  perform public.bench_wake_edge();
  return j;
end;
$$;

create or replace function public.bench_edge_status()
returns jsonb language sql stable security definer set search_path='' as $$
  select to_jsonb(s) from (
    select j.id,j.status,j.conclusion,j.event,j.created_at,j.updated_at,j.error,'edge'::text as executor,
      (select count(*) from public.bench_edge_tasks t where t.job_id=j.id and t.finished) as completed,
      (select count(*) from public.bench_edge_tasks t where t.job_id=j.id) as total
    from public.bench_edge_jobs j order by (j.status='completed'),j.id desc limit 1
  ) s;
$$;

create or replace function public.bench_edge_deployment(p_sha text,p_environment text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if not public.bench_edge_active() then return false; end if;
  insert into public.bench_runs(sha,short_sha,committed_at,subject,planner_version,status)
    select sha,left(sha,7),committed_at,subject,planner_version,'pending'
    from public.bench_edge_artifacts where sha=p_sha on conflict (sha) do nothing;
  perform public.bench_set_deployed(p_sha,p_environment);
  return true;
end;
$$;

create or replace function public.bench_claim_edge_task()
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.bench_edge_jobs%rowtype; t public.bench_edge_tasks%rowtype;
begin
  if not public.bench_edge_active() then return null; end if;
  select * into j from public.bench_edge_jobs where status<>'completed' order by id limit 1 for update;
  if not found or exists (
    select 1 from public.bench_edge_tasks where job_id=j.id and not finished and lease_until>now()
  ) then return null; end if;
  select * into t from public.bench_edge_tasks where job_id=j.id and not finished and wake_after<=now() order by id limit 1;
  if not found then return null; end if;
  if t.attempt>=3 then
    update public.bench_edge_jobs set status='completed',conclusion='failure',error='Edge worker lease repeatedly expired',updated_at=now() where id=j.id;
    update public.bench_runs set status='failed',error='Edge worker lease repeatedly expired',finished_at=now() where sha=any(j.shas) and status='running';
    perform public.bench_wake_edge();
    return null;
  end if;
  update public.bench_edge_tasks set attempt=attempt+1,lease_until=now()+interval '60 seconds'
    where id=t.id returning * into t;
  update public.bench_edge_jobs set status='in_progress',updated_at=now() where id=j.id;
  return to_jsonb(t) || jsonb_build_object('rules',j.criteria,'force',j.force,'rerecord',j.rerecord,'preparation',j.preparation);
end;
$$;

create or replace function public.bench_finish_edge_task(p_task bigint,p_attempt int,p_result jsonb,p_error text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.bench_edge_jobs%rowtype; t public.bench_edge_tasks%rowtype; r public.bench_results%rowtype;
begin
  select * into j from public.bench_edge_jobs where id=(select job_id from public.bench_edge_tasks where id=p_task) for update;
  select * into t from public.bench_edge_tasks where id=p_task;
  if t.id is null or j.status='completed' or t.finished or t.attempt<>p_attempt
     or t.lease_until is null or t.lease_until<=now() then return false; end if;
  perform 1 from public.bench_rules where criteria=j.criteria for share;
  if not found then
    p_error := 'Case or rules changed during this run; start a new run';
    t.attempt := 3;
  end if;
  if t.kind<>'retain' then
    perform 1 from public.bench_scenarios where id=t.scenario and revision=t.revision and not archived for share;
    if not found then
      p_error := 'Case or rules changed during this run; start a new run';
      t.attempt := 3;
    end if;
  end if;
  if p_error is not null then
    if t.attempt<3 then
      update public.bench_edge_tasks set lease_until=null,wake_after=now()+interval '5 seconds' where id=t.id;
    else
      update public.bench_edge_jobs set status='completed',conclusion='failure',error=left(p_error,500),updated_at=now() where id=j.id;
      update public.bench_runs set status='failed',error=left(p_error,500),finished_at=now() where sha=any(j.shas) and status='running';
    end if;
  else
    if t.kind='prepare' then
      update public.bench_scenarios set
        dataset=coalesce(p_result->'dataset',dataset),
        captured_at=coalesce((p_result->'dataset'->>'start')::timestamptz,captured_at),
        recorded=case when p_result ? 'recorded' then nullif(p_result->'recorded'->'value','null'::jsonb) else recorded end,
        pending_reason=case when p_result ? 'recorded' then p_result->'recorded'->>'pendingReason' else pending_reason end
      where id=t.scenario and revision=t.revision and not archived;
      if not found then raise exception 'Case changed during preparation'; end if;
    elsif t.kind='retain' then
      -- Deletion affects display history only. The archived executables and
      -- registrations remain available for rerunning a dropped commit.
      if not exists (
        select 1 from jsonb_to_recordset(p_result->'cases') as observed(id uuid, revision text)
        full join public.bench_edge_ready_cases s on s.id=observed.id
        where s.revision is distinct from observed.revision
      ) then
        delete from public.bench_runs where not is_current and not is_test
          and sha in (select jsonb_array_elements_text(p_result->'drops'));
      end if;
    elsif p_result is not null and t.kind='solve' then
      insert into public.bench_results(sha,scenario_id,lane,status,error,cpu_ms,case_revision,input_hash,record,series,stats,outcome,score,referee_version)
        values(t.sha,t.scenario,t.lane,'ok',null,(p_result->>'cpu_ms')::int,t.revision,p_result->>'input_hash',
          p_result->'record',p_result->'series',p_result->'stats',p_result->'outcome',p_result->'score',(p_result->>'referee_version')::int)
      on conflict (sha,scenario_id,lane) do update set
        status=excluded.status,error=null,cpu_ms=excluded.cpu_ms,case_revision=excluded.case_revision,
        input_hash=excluded.input_hash,record=excluded.record,series=excluded.series,stats=excluded.stats,
        outcome=excluded.outcome,score=excluded.score,referee_version=excluded.referee_version,created_at=now();
    elsif p_result is not null then
      select * into r from public.bench_results where sha=t.sha and scenario_id=t.scenario and lane=t.lane for update;
      if not found or r.created_at<>(p_result->>'created_at')::timestamptz or r.input_hash is distinct from p_result->>'input_hash' then
        raise exception 'Source decisions changed during rescore';
      end if;
      update public.bench_results set series=p_result->'series',stats=p_result->'stats',outcome=p_result->'outcome',
        score=p_result->'score',referee_version=(p_result->>'referee_version')::int
      where sha=t.sha and scenario_id=t.scenario and lane=t.lane;
    end if;
    update public.bench_edge_tasks set finished=true,lease_until=null where id=t.id;
    perform public.bench_edge_finish_phase(j.id);
  end if;
  perform public.bench_wake_edge();
  return true;
end;
$$;

revoke all on function public.bench_wake_edge(),public.bench_edge_finish_phase(bigint),
  public.bench_enable_edge(integer,text),public.bench_enqueue_edge(text[],uuid,text[],boolean,boolean,boolean,text,jsonb),
  public.bench_edge_status(),public.bench_edge_deployment(text,text),public.bench_claim_edge_task(),public.bench_finish_edge_task(bigint,int,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.bench_enable_edge(integer,text),public.bench_enqueue_edge(text[],uuid,text[],boolean,boolean,boolean,text,jsonb),
  public.bench_edge_status(),public.bench_edge_deployment(text,text),public.bench_claim_edge_task(),public.bench_finish_edge_task(bigint,int,jsonb,text) to service_role;

select cron.schedule('wake-test-planner-bench','10 seconds','select public.bench_wake_edge()');
commit;
