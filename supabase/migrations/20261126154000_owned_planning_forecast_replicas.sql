-- Job-owned execution: compact dispatch, independently addressed posterior pages,
-- and four subordinate numerical writers. Canonical source archives are untouched.
ALTER TABLE private.energy_planning_jobs ADD COLUMN connected_runtime boolean NOT NULL DEFAULT false,
 ADD COLUMN horizon_end timestamptz;
CREATE FUNCTION private.planning_dispatch_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.connected_runtime:=NEW.input#>'{snapshot,room_network_capture}' IS NOT NULL
   OR coalesce(json_array_length(NEW.input#>'{snapshot,room_network,nodes}'),0)>0;
 NEW.horizon_end:=((NEW.input#>'{snapshot,slots}'->-1)->>'start')::timestamptz
   +make_interval(mins=>(NEW.input#>>'{snapshot,slot_minutes}')::integer);
 RETURN NEW;
END; $$;
CREATE TRIGGER planning_dispatch_metadata BEFORE INSERT ON private.energy_planning_jobs
 FOR EACH ROW EXECUTE FUNCTION private.planning_dispatch_metadata();
UPDATE private.energy_planning_jobs SET connected_runtime=input#>'{snapshot,room_network_capture}' IS NOT NULL
 OR coalesce(json_array_length(input#>'{snapshot,room_network,nodes}'),0)>0,
 horizon_end=((input#>'{snapshot,slots}'->-1)->>'start')::timestamptz
 +make_interval(mins=>(input#>>'{snapshot,slot_minutes}')::integer) WHERE state='pending';

CREATE TABLE private.energy_planning_runtime (
 job_id uuid PRIMARY KEY REFERENCES private.energy_planning_jobs(id) ON DELETE CASCADE,
 revision text NOT NULL, runtime text NOT NULL,
 phase text NOT NULL CHECK(phase IN ('capture','prepare','catalog','integrate','qualify','solve','assemble','ready')),
 cursor bigint NOT NULL DEFAULT 0,
 worker_fence bigint NOT NULL DEFAULT 0, worker_parent bigint, worker_until timestamptz,
 identity text, round integer NOT NULL DEFAULT 0, target integer NOT NULL DEFAULT 64 CHECK(target>0),
 replica_count integer NOT NULL DEFAULT 4 CHECK(replica_count IN (1,4)), catalog_next integer NOT NULL DEFAULT 0,
 node_count integer NOT NULL DEFAULT 0,
 context bytea, header bytea, payload bytea
);
CREATE TABLE private.energy_forecast_catalog_nodes (
 job_id uuid NOT NULL REFERENCES private.energy_planning_runtime(job_id) ON DELETE CASCADE,
 node integer NOT NULL CHECK(node>=0), payload bytea NOT NULL, PRIMARY KEY(job_id,node)
);
CREATE TABLE private.energy_forecast_catalog_pages (
 job_id uuid NOT NULL REFERENCES private.energy_planning_runtime(job_id) ON DELETE CASCADE,
 node integer NOT NULL CHECK(node>=0), first_record integer NOT NULL CHECK(first_record>=0),
 count integer NOT NULL CHECK(count>0), offsets integer[] NOT NULL, payload bytea NOT NULL,
 PRIMARY KEY(job_id,node,first_record),
 CHECK(cardinality(offsets)=count+1 AND offsets[1]=0 AND offsets[count+1]=octet_length(payload))
);
-- Each page is independently TOAST-compressed. No selected read decompresses a
-- whole population. Oversized individual records remain intact on their own page.
CREATE TABLE private.energy_forecast_replicas (
 job_id uuid NOT NULL REFERENCES private.energy_planning_runtime(job_id) ON DELETE CASCADE,
 replica integer NOT NULL CHECK(replica BETWEEN 0 AND 3), cursor bigint NOT NULL DEFAULT 0,
 slice_fence bigint NOT NULL DEFAULT 0, parent_fence bigint, lease_until timestamptz,
 round integer NOT NULL DEFAULT 0, completed integer NOT NULL DEFAULT 0, work bytea,
 PRIMARY KEY(job_id,replica)
);
ALTER TABLE private.energy_planning_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_forecast_catalog_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_forecast_catalog_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_forecast_replicas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_planning_runtime,private.energy_forecast_catalog_nodes,
 private.energy_forecast_catalog_pages,private.energy_forecast_replicas FROM PUBLIC,anon,authenticated,service_role;

-- Shared locks retain the existing authority order without serializing siblings.
-- The caller locks its runtime/replica next; no lock survives an RPC transaction.
CREATE FUNCTION private.share_owned_planning_job(p_home uuid,p_job uuid,p_fence bigint)
RETURNS private.energy_planning_jobs LANGUAGE plpgsql SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; accepted bigint;
BEGIN
 PERFORM 1 FROM private.energy_planning_heads WHERE home_id=p_home FOR SHARE;
 SELECT accepted_reference_revision INTO accepted FROM public.energy_optimisation_current WHERE home_id=p_home FOR SHARE;
 SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job AND home_id=p_home FOR SHARE;
 IF NOT FOUND OR j.state<>'pending' OR j.fence<>p_fence OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp()
 OR NOT private.energy_planning_is_current(j)
 OR (j.context->>'accepted_reference_revision')::bigint IS DISTINCT FROM coalesce(accepted,0) THEN RETURN NULL; END IF;
 RETURN j;
END; $$;
CREATE FUNCTION private.owned_planning_dispatch(p_job uuid) RETURNS json LANGUAGE sql STABLE AS $$
 SELECT json_build_object('phase',r.phase,'cursor',r.cursor,'target',r.target,'round',r.round,
  'replicas',CASE WHEN r.phase='integrate' THEN
    (SELECT coalesce(json_agg(p.replica ORDER BY p.replica),'[]'::json) FROM private.energy_forecast_replicas p
      WHERE p.job_id=r.job_id AND p.replica<r.replica_count AND p.completed<r.target/r.replica_count)
   ELSE '[]'::json END)
 FROM private.energy_planning_runtime r WHERE r.job_id=p_job;
$$;
CREATE FUNCTION public.load_energy_planning_metadata(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
 j:=private.share_owned_planning_job(p_home_id,p_job_id,p_fence);
 IF j.id IS NULL THEN RETURN NULL; END IF;
 RETURN json_build_object('connected',j.connected_runtime,'horizon_end',j.horizon_end,'context',j.context);
END; $$;
CREATE FUNCTION public.load_energy_owned_planning_stage(p_home_id uuid,p_job_id uuid,p_fence bigint,p_revision text,p_runtime text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; node_payload bytea;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence<>p_fence OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR UPDATE;
 IF r.job_id IS NOT NULL AND (r.revision<>p_revision OR r.runtime<>p_runtime) THEN
   DELETE FROM private.energy_planning_runtime WHERE job_id=j.id;
   DELETE FROM private.energy_planning_execution WHERE job_id=j.id;
   r:=NULL;
 END IF;
 IF r.job_id IS NULL THEN
   INSERT INTO private.energy_planning_runtime(job_id,revision,runtime,phase) VALUES(j.id,p_revision,p_runtime,'capture') RETURNING * INTO r;
 END IF;
 IF r.phase IN ('integrate','ready') THEN RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id)); END IF;
 IF r.worker_parent=p_fence AND r.worker_until>clock_timestamp() THEN RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id),'busy',true); END IF;
 UPDATE private.energy_planning_runtime SET worker_fence=worker_fence+1,worker_parent=p_fence,
  worker_until=clock_timestamp()+interval '60 seconds' WHERE job_id=j.id RETURNING * INTO r;
 IF r.phase='catalog' THEN SELECT payload INTO node_payload FROM private.energy_forecast_catalog_nodes WHERE job_id=j.id AND node=r.catalog_next; END IF;
 RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id),'slice_fence',r.worker_fence,
  'customer_id',j.customer_id,'identity',r.identity,'catalog_next',r.catalog_next,'node_count',r.node_count,
  'input',CASE WHEN r.phase='capture' THEN j.input WHEN r.phase IN ('prepare','qualify') THEN
    (SELECT input FROM private.energy_planning_execution WHERE job_id=j.id) END,
  'payload',replace(encode(r.payload,'base64'),E'\n',''),
  'context',CASE WHEN r.phase='qualify' THEN replace(encode(r.context,'base64'),E'\n','') END,
  'header',CASE WHEN r.phase IN ('catalog','qualify') THEN replace(encode(r.header,'base64'),E'\n','') END,
  'node',replace(encode(node_payload,'base64'),E'\n',''),
  'replicas',CASE WHEN r.phase='qualify' THEN
    (SELECT json_agg(json_build_object('replica',p.replica,'work',replace(encode(p.work,'base64'),E'\n','')) ORDER BY p.replica)
     FROM private.energy_forecast_replicas p WHERE p.job_id=j.id AND p.replica<r.replica_count) END);
END; $$;

CREATE FUNCTION public.checkpoint_energy_owned_planning_stage(p_home_id uuid,p_job_id uuid,p_fence bigint,
 p_cursor bigint,p_slice_fence bigint,p_update json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; phase text:=p_update->>'phase';
 page json; item json; offsets integer[]; bytes bytea; next_record integer:=0; n integer:=0; e private.energy_planning_execution%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence<>p_fence OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR UPDATE;
 IF r.job_id IS NULL OR r.cursor<>p_cursor OR r.worker_fence<>p_slice_fence OR r.worker_parent<>p_fence
  OR r.worker_until<=clock_timestamp() THEN RETURN NULL; END IF;
 IF NOT(r.phase='capture' AND phase IN ('capture','prepare') OR r.phase='prepare' AND phase IN ('prepare','catalog','solve')
  OR r.phase='catalog' AND phase IN ('catalog','integrate') OR r.phase='qualify' AND phase IN ('integrate','solve')
  OR r.phase='solve' AND phase='assemble' OR r.phase='assemble' AND phase='ready')
 THEN RAISE EXCEPTION 'Invalid owned planning transition' USING ERRCODE='22023'; END IF;
 IF r.phase='catalog' THEN
   IF (p_update->>'node')::integer IS DISTINCT FROM r.catalog_next THEN RAISE EXCEPTION 'Invalid catalog node'; END IF;
   FOR page IN SELECT value FROM json_array_elements(p_update->'pages') LOOP
     bytes:=decode(page->>'bytes','base64');
     SELECT array_agg(value::integer ORDER BY ordinality) INTO offsets FROM json_array_elements_text(page->'offsets') WITH ORDINALITY;
     IF (page->>'first_record')::integer<>next_record OR cardinality(offsets)<>(page->>'count')::integer+1
      OR offsets[1]<>0 OR offsets[cardinality(offsets)]<>octet_length(bytes)
      OR EXISTS(SELECT FROM generate_subscripts(offsets,1) s WHERE s>1 AND offsets[s]<=offsets[s-1])
     THEN RAISE EXCEPTION 'Invalid catalog directory' USING ERRCODE='22023'; END IF;
     INSERT INTO private.energy_forecast_catalog_pages VALUES(j.id,r.catalog_next,next_record,(page->>'count')::integer,offsets,bytes);
     next_record:=next_record+(page->>'count')::integer;
   END LOOP;
   IF next_record IS DISTINCT FROM (p_update->>'count')::integer THEN RAISE EXCEPTION 'Incomplete catalog'; END IF;
   DELETE FROM private.energy_forecast_catalog_nodes WHERE job_id=j.id AND node=r.catalog_next;
   r.catalog_next:=r.catalog_next+1;
   IF (phase='integrate') IS DISTINCT FROM (r.catalog_next=r.node_count) THEN RAISE EXCEPTION 'Incomplete catalog stage'; END IF;
 END IF;
 IF r.phase='prepare' AND phase='catalog' THEN
   FOR item IN SELECT value FROM json_array_elements(p_update->'nodes') LOOP
     INSERT INTO private.energy_forecast_catalog_nodes VALUES(j.id,n,decode(item#>>'{}','base64')); n:=n+1;
   END LOOP;
   IF n<1 OR nullif(p_update->>'identity','') IS NULL THEN RAISE EXCEPTION 'Missing forecast catalog'; END IF;
   r.node_count:=n; r.identity:=p_update->>'identity';
 END IF;
 IF phase='integrate' THEN
   r.replica_count:=(p_update->>'replica_count')::integer; r.target:=(p_update->>'target')::integer;
   IF r.replica_count NOT IN (1,4) OR r.target<1 OR r.target%r.replica_count<>0
    OR (r.phase='qualify' AND (r.replica_count<> (SELECT replica_count FROM private.energy_planning_runtime WHERE job_id=j.id) OR r.target<= (SELECT target FROM private.energy_planning_runtime WHERE job_id=j.id)))
   THEN RAISE EXCEPTION 'Invalid balanced forecast target'; END IF;
   r.round:=r.round+1;
   INSERT INTO private.energy_forecast_replicas(job_id,replica) SELECT j.id,s FROM generate_series(0,r.replica_count-1)s ON CONFLICT DO NOTHING;
 END IF;
 IF p_update->'input' IS NOT NULL THEN
   IF NOT (r.phase='capture' AND phase='prepare' OR phase='solve') THEN RAISE EXCEPTION 'Unexpected execution input'; END IF;
   SELECT * INTO e FROM private.energy_planning_execution WHERE job_id=j.id;
   PERFORM public.checkpoint_energy_planning_execution(p_home_id,p_job_id,p_fence,coalesce(e.cursor,0),p_update->'input',
     json_build_object('revision',r.revision,'runtime',r.runtime,'progress',json_build_object('stage',CASE WHEN phase='solve' THEN 'solve' ELSE 'prepare' END)));
   -- The existing validator owns exact input immutability. Keep this parent's
   -- lease within the same transaction for the bounded dispatch wave.
   UPDATE private.energy_planning_jobs SET lease_until=j.lease_until WHERE id=j.id AND fence=p_fence AND state='pending';
 END IF;
 UPDATE private.energy_planning_runtime SET cursor=r.cursor+1,
  worker_until=NULL,identity=r.identity,node_count=r.node_count,catalog_next=r.catalog_next,round=r.round,target=r.target,replica_count=r.replica_count,
  payload=CASE WHEN p_update::jsonb ? 'payload' THEN decode(p_update->>'payload','base64') ELSE payload END,
  context=CASE WHEN p_update::jsonb ? 'context' THEN decode(p_update->>'context','base64') ELSE context END,
  header=CASE WHEN p_update::jsonb ? 'header' THEN decode(p_update->>'header','base64') ELSE header END
 WHERE job_id=j.id;
 -- Avoid PL/pgSQL identifier ambiguity with the phase column.
 UPDATE private.energy_planning_runtime SET phase=p_update->>'phase' WHERE job_id=j.id;
 RETURN private.owned_planning_dispatch(j.id);
END; $$;

CREATE FUNCTION public.claim_energy_forecast_replica(p_home_id uuid,p_job_id uuid,p_fence bigint,p_replica integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; p private.energy_forecast_replicas%ROWTYPE;
BEGIN
 j:=private.share_owned_planning_job(p_home_id,p_job_id,p_fence); IF j.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR SHARE;
 IF r.phase<>'integrate' OR p_replica<0 OR p_replica>=r.replica_count THEN RETURN NULL; END IF;
 SELECT * INTO p FROM private.energy_forecast_replicas WHERE job_id=j.id AND replica=p_replica FOR UPDATE;
 IF p.job_id IS NULL OR p.completed>=r.target/r.replica_count THEN RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id)); END IF;
 IF p.parent_fence=p_fence AND p.lease_until>clock_timestamp() THEN RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id),'busy',true); END IF;
 UPDATE private.energy_forecast_replicas SET parent_fence=p_fence,slice_fence=slice_fence+1,
  lease_until=clock_timestamp()+interval '60 seconds',round=r.round
 WHERE job_id=j.id AND replica=p_replica RETURNING * INTO p;
 RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id),'cursor',p.cursor,'slice_fence',p.slice_fence,
  'identity',r.identity,'round',r.round,'target_local_draws',r.target/r.replica_count,
  'header',replace(encode(r.header,'base64'),E'\n',''),'work',replace(encode(p.work,'base64'),E'\n',''));
END; $$;

CREATE FUNCTION public.read_energy_forecast_records(p_home_id uuid,p_job_id uuid,p_fence bigint,
 p_replica integer,p_slice_fence bigint,p_identity text,p_records json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; p private.energy_forecast_replicas%ROWTYPE;
 selected json; page private.energy_forecast_catalog_pages%ROWTYPE; result jsonb:='[]'; idx integer; node_index integer;
BEGIN
 j:=private.share_owned_planning_job(p_home_id,p_job_id,p_fence); IF j.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR SHARE;
 SELECT * INTO p FROM private.energy_forecast_replicas WHERE job_id=j.id AND replica=p_replica FOR SHARE;
 IF r.phase<>'integrate' OR r.identity IS DISTINCT FROM p_identity OR p.parent_fence IS DISTINCT FROM p_fence
 OR p.slice_fence IS DISTINCT FROM p_slice_fence OR p.lease_until IS NULL OR p.lease_until<=clock_timestamp() OR p.round<>r.round THEN RETURN NULL; END IF;
 FOR selected IN SELECT DISTINCT value::jsonb FROM json_array_elements(p_records) LOOP
   node_index:=(selected->>'node')::integer; idx:=(selected->>'index')::integer;
   SELECT * INTO page FROM private.energy_forecast_catalog_pages c WHERE c.job_id=j.id AND c.node=node_index
    AND c.first_record<=idx ORDER BY c.first_record DESC LIMIT 1;
   IF NOT FOUND OR idx>=page.first_record+page.count THEN RAISE EXCEPTION 'Missing forecast catalog record' USING ERRCODE='22023'; END IF;
   idx:=idx-page.first_record+1;
   result:=result||jsonb_build_array(jsonb_build_object('node',node_index,'index',(selected->>'index')::integer,
    'json',convert_from(substring(page.payload FROM page.offsets[idx]+1 FOR page.offsets[idx+1]-page.offsets[idx]),'UTF8')));
 END LOOP;
 RETURN result::json;
END; $$;

CREATE FUNCTION public.checkpoint_energy_forecast_replica(p_home_id uuid,p_job_id uuid,p_fence bigint,
 p_replica integer,p_slice_fence bigint,p_cursor bigint,p_identity text,p_round integer,p_next_cursor bigint,p_completed integer,p_work text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; p private.energy_forecast_replicas%ROWTYPE;
BEGIN
 j:=private.share_owned_planning_job(p_home_id,p_job_id,p_fence); IF j.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR SHARE;
 SELECT * INTO p FROM private.energy_forecast_replicas WHERE job_id=j.id AND replica=p_replica FOR UPDATE;
 IF r.phase<>'integrate' OR r.identity IS DISTINCT FROM p_identity OR r.round<>p_round OR p.round<>p_round
  OR p.parent_fence IS DISTINCT FROM p_fence OR p.slice_fence IS DISTINCT FROM p_slice_fence OR p.cursor IS DISTINCT FROM p_cursor
  OR p.lease_until IS NULL OR p.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 IF p_next_cursor<=p_cursor OR p_completed<p.completed OR p_completed>r.target/r.replica_count OR p_work IS NULL
 THEN RAISE EXCEPTION 'Invalid forecast replica progress' USING ERRCODE='22023'; END IF;
 UPDATE private.energy_forecast_replicas SET cursor=p_next_cursor,completed=p_completed,work=decode(p_work,'base64'),lease_until=NULL
 WHERE job_id=j.id AND replica=p_replica;
 -- No sibling or parent lease is updated here. A separate exclusive barrier
 -- observes all four committed counts and freezes their canonical merge.
 RETURN private.owned_planning_dispatch(j.id);
END; $$;
CREATE FUNCTION public.advance_energy_forecast_barrier(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence<>p_fence OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR UPDATE;
 IF r.phase='integrate' AND (SELECT count(*) FROM private.energy_forecast_replicas p
  WHERE p.job_id=j.id AND p.replica<r.replica_count AND p.completed=r.target/r.replica_count)=r.replica_count THEN
  UPDATE private.energy_planning_runtime SET phase='qualify',cursor=cursor+1 WHERE job_id=j.id;
 END IF;
 RETURN private.owned_planning_dispatch(j.id);
END; $$;

-- The same source checkpoint validation, held under the parent's existing lease.
CREATE FUNCTION public.checkpoint_energy_owned_room_capture(p_home_id uuid,p_job_id uuid,p_fence bigint,
 p_expected_cursor integer,p_state jsonb,p_raw jsonb,p_numeric jsonb,p_source_proof jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; result json;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence<>p_fence OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 result:=public.checkpoint_energy_planning_room_capture(p_home_id,p_job_id,p_fence,p_expected_cursor,p_state,p_raw,p_numeric,p_source_proof);
 IF result IS NOT NULL THEN UPDATE private.energy_planning_jobs SET lease_until=j.lease_until WHERE id=j.id AND state='pending' AND fence=p_fence; END IF;
 RETURN result;
END; $$;
CREATE FUNCTION public.release_energy_owned_planning_attempt(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence<>p_fence THEN RETURN NULL; END IF;
 UPDATE private.energy_planning_jobs SET lease_until=NULL,wake_after=clock_timestamp(),code=NULL,detail=NULL WHERE id=j.id RETURNING * INTO j;
 RETURN private.energy_planning_receipt(j);
END; $$;
CREATE FUNCTION public.load_energy_owned_planning_result(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; payload bytea;
BEGIN
 j:=private.share_owned_planning_job(p_home_id,p_job_id,p_fence); IF j.id IS NULL THEN RETURN NULL; END IF;
 SELECT r.payload INTO payload FROM private.energy_planning_runtime r WHERE job_id=j.id AND phase='ready';
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN json_build_object('input',(SELECT input FROM private.energy_planning_execution WHERE job_id=j.id),
  'context',j.context,'identity',(SELECT identity FROM private.energy_planning_runtime WHERE job_id=j.id),
  'result',replace(encode(payload,'base64'),E'\n',''));
END; $$;
CREATE FUNCTION private.clean_owned_planning_scratch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state<>'pending' THEN
  DELETE FROM private.energy_planning_runtime WHERE job_id=NEW.id;
  DELETE FROM private.energy_planning_room_source_blocks WHERE job_id=NEW.id;
  DELETE FROM private.energy_planning_room_capture WHERE job_id=NEW.id;
  IF NEW.state<>'published' THEN DELETE FROM private.energy_planning_execution WHERE job_id=NEW.id; END IF;
 END IF;
 -- Successful execution input survives until the current-input archive validator
 -- checks publication below; failed/superseded executable scratch has no owner.
 RETURN NEW;
END; $$;
CREATE TRIGGER clean_owned_planning_scratch AFTER UPDATE OF state ON private.energy_planning_jobs
 FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION private.clean_owned_planning_scratch();
CREATE FUNCTION private.clean_archived_planning_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM private.energy_planning_execution WHERE job_id=NEW.job_id;
 RETURN NEW;
END; $$;
CREATE TRIGGER clean_archived_planning_execution AFTER INSERT OR UPDATE ON private.energy_planning_current_input
 FOR EACH ROW EXECUTE FUNCTION private.clean_archived_planning_execution();
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('load_energy_planning_metadata','load_energy_owned_planning_stage',
   'checkpoint_energy_owned_planning_stage','claim_energy_forecast_replica','read_energy_forecast_records',
   'checkpoint_energy_forecast_replica','advance_energy_forecast_barrier','checkpoint_energy_owned_room_capture',
   'release_energy_owned_planning_attempt','load_energy_owned_planning_result') LOOP
  EXECUTE format('ALTER FUNCTION %s SET statement_timeout=''8s''',f.name);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.name);
 END LOOP;
END; $$;

-- Hosted Edge fetch may throw RateLimitError rather than returning HTTP429.
-- Retain its explicit retry clock in addition to the established DB backoff.
CREATE OR REPLACE FUNCTION public.retry_energy_planning_attempt(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; retry_ms double precision:=coalesce(($1->>'retry_after_ms')::double precision,0);
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=($1->>'job_id')::uuid AND home_id=($1->>'home_id')::uuid) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
 IF j.state<>'pending' THEN RETURN private.energy_planning_receipt(j); END IF;
 IF j.id IS NULL OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint OR j.lease_until IS NULL THEN RETURN NULL; END IF;
 IF nullif($1->>'code','') IS NULL OR nullif($1->>'detail','') IS NULL OR retry_ms<0 OR retry_ms IN ('Infinity'::float8,'-Infinity'::float8,'NaN'::float8)
 THEN RAISE EXCEPTION 'Invalid planning retry' USING ERRCODE='22023'; END IF;
 UPDATE private.energy_planning_jobs SET retry_count=retry_count+1,code=$1->>'code',detail=$1->>'detail',lease_until=NULL,
  wake_after=clock_timestamp()+make_interval(secs=>greatest(retry_ms/1000,least(60,5*power(2,least(retry_count,4)))::double precision))
 WHERE id=j.id RETURNING * INTO j;
 RETURN private.energy_planning_receipt(j);
END; $$;

-- Only recognized derived codec/directory corruption invokes this repair.
-- Numerical/model errors do not silently discard evidence or select another law.
CREATE FUNCTION public.reset_energy_owned_planning_runtime(p_home_id uuid,p_job_id uuid,p_fence bigint,
 p_cursor bigint,p_identity text,p_phase text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN false; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence<>p_fence OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN false; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR UPDATE;
 IF r.job_id IS NULL OR r.cursor<>p_cursor OR r.identity IS DISTINCT FROM p_identity OR r.phase<>p_phase THEN RETURN false; END IF;
 DELETE FROM private.energy_planning_runtime WHERE job_id=j.id;
 DELETE FROM private.energy_planning_execution WHERE job_id=j.id;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.reset_energy_owned_planning_runtime(uuid,uuid,bigint,bigint,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reset_energy_owned_planning_runtime(uuid,uuid,bigint,bigint,text,text) TO service_role;
