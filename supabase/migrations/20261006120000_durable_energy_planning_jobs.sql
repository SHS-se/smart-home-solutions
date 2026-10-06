-- Planning progress belongs to the database, not an ingest HTTP connection.
-- JSON (rather than JSONB) is intentional: planner device iteration order is
-- numeric input, and must survive every frozen-input/checkpoint round trip.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE private.energy_planning_heads (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0,
  active_job_id uuid
);
CREATE TABLE private.energy_planning_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL,
  source_hash text NOT NULL,
  revision bigint NOT NULL,
  protocol integer NOT NULL CHECK (protocol > 0),
  input json NOT NULL,
  context json NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','published','superseded','failed')),
  phase text NOT NULL DEFAULT 'solving' CHECK (phase IN ('solving','assembling')),
  step bigint NOT NULL DEFAULT 0,
  continuation json,
  fence bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  expiry_count integer NOT NULL DEFAULT 0,
  wake_after timestamptz NOT NULL DEFAULT now(),
  plan_id uuid,
  code text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (home_id,snapshot_id),
  CONSTRAINT energy_planning_job_customer CHECK (public.energy_home_matches_customer(home_id,customer_id))
);
CREATE INDEX energy_planning_jobs_due ON private.energy_planning_jobs(wake_after) WHERE state='pending';
CREATE INDEX energy_planning_jobs_retention ON private.energy_planning_jobs(finished_at) WHERE state<>'pending';
CREATE TABLE private.energy_planning_parts (
  job_id uuid NOT NULL REFERENCES private.energy_planning_jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('completed','rankings')),
  ordinal bigint NOT NULL,
  value json NOT NULL,
  PRIMARY KEY (job_id,kind,ordinal)
);
CREATE TABLE private.energy_planning_credentials (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  token text NOT NULL CHECK (token ~ '^[0-9a-f]{64}$'),
  function_url text CHECK (function_url ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/energy-optimisation-planning-worker$')
);
INSERT INTO private.energy_planning_credentials(singleton,token)
  VALUES(true,encode(extensions.gen_random_bytes(32),'hex'));
-- Search ledgers can be large. Use the same faster compressor as current-plan
-- storage; compression preserves the JSON bytes and their object key order.
ALTER TABLE private.energy_planning_jobs ALTER COLUMN input SET COMPRESSION lz4;
ALTER TABLE private.energy_planning_jobs ALTER COLUMN context SET COMPRESSION lz4;
ALTER TABLE private.energy_planning_jobs ALTER COLUMN continuation SET COMPRESSION lz4;
ALTER TABLE private.energy_planning_parts ALTER COLUMN value SET COMPRESSION lz4;
ALTER TABLE private.energy_planning_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_planning_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_planning_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_planning_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_planning_heads, private.energy_planning_jobs,
  private.energy_planning_parts, private.energy_planning_credentials FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.energy_planning_receipt(p_job private.energy_planning_jobs,p_include_plan boolean DEFAULT true)
RETURNS json LANGUAGE plpgsql STABLE SET search_path=public,private AS $$
DECLARE v_plan jsonb;
BEGIN
  IF p_job.state='published' THEN
    SELECT CASE WHEN p_include_plan THEN plan ELSE NULL END INTO v_plan FROM public.energy_optimisation_current
      WHERE home_id=p_job.home_id AND plan_id=p_job.plan_id AND snapshot_id=p_job.snapshot_id;
    IF FOUND THEN
      IF NOT p_include_plan THEN
        RETURN json_build_object('job_id',p_job.id,'state','published','pending',false,
          'snapshot_id',p_job.snapshot_id,'plan_id',p_job.plan_id,'source_hash',p_job.source_hash);
      END IF;
      RETURN json_build_object('job_id',p_job.id,'state','published','pending',false,
        'snapshot_id',p_job.snapshot_id,'plan_id',p_job.plan_id,'plan',v_plan,'source_hash',p_job.source_hash);
    END IF;
    RETURN json_build_object('job_id',p_job.id,'state','superseded','pending',false,
      'snapshot_id',p_job.snapshot_id,'source_hash',p_job.source_hash);
  ELSIF p_job.state='failed' THEN
    RETURN json_build_object('job_id',p_job.id,'state',p_job.state,'pending',false,
      'snapshot_id',p_job.snapshot_id,'code',p_job.code,'detail',p_job.detail,'source_hash',p_job.source_hash);
  ELSIF p_job.state='pending' THEN
    RETURN json_build_object('job_id',p_job.id,'state',p_job.state,'pending',true,
      'snapshot_id',p_job.snapshot_id,'retry_after_ms',1000,'source_hash',p_job.source_hash);
  END IF;
  RETURN json_build_object('job_id',p_job.id,'state',p_job.state,'pending',false,
    'snapshot_id',p_job.snapshot_id,'source_hash',p_job.source_hash);
END; $$;

CREATE FUNCTION private.wake_energy_planning_job(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE c private.energy_planning_credentials%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM private.energy_planning_credentials WHERE singleton;
  IF c.function_url IS NULL THEN RAISE EXCEPTION 'Energy planning worker endpoint is not configured'; END IF;
  PERFORM net.http_post(url:=c.function_url,
    headers:=jsonb_build_object('Content-Type','application/json','x-energy-planning-token',c.token),
    body:=jsonb_build_object('job_id',p_job_id),timeout_milliseconds:=30000);
END; $$;

-- Callers lock head -> current -> job consistently. This checks received-order
-- ownership and explicit manual/fixed identities, never device-time ordering.
CREATE FUNCTION private.energy_planning_is_current(p_job private.energy_planning_jobs)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,private AS $$
  SELECT COALESCE((SELECT h.active_job_id=p_job.id AND h.revision=p_job.revision
    AND COALESCE(c.fixed_plan_revision,0)=(p_job.context->>'fixed_revision')::integer
    AND c.replan_request_id IS NOT DISTINCT FROM (p_job.context->>'observed_replan_request_id')::uuid
    FROM private.energy_planning_heads h LEFT JOIN public.energy_optimisation_current c USING(home_id)
    WHERE h.home_id=p_job.home_id),false);
$$;

CREATE FUNCTION private.lock_energy_planning_job(p_job_id uuid)
RETURNS private.energy_planning_jobs LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; v_home uuid;
BEGIN
  SELECT home_id INTO v_home FROM private.energy_planning_jobs WHERE id=p_job_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM private.energy_planning_heads WHERE home_id=v_home FOR UPDATE;
  PERFORM 1 FROM public.energy_optimisation_current WHERE home_id=v_home FOR UPDATE;
  SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id FOR UPDATE;
  IF j.state='pending' AND NOT private.energy_planning_is_current(j) THEN
    UPDATE private.energy_planning_jobs SET state='superseded',lease_until=NULL,finished_at=now()
      WHERE id=j.id RETURNING * INTO j;
  END IF;
  RETURN j;
END; $$;

CREATE FUNCTION public.verify_energy_planning_token(p_token text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT COALESCE((SELECT token=p_token FROM private.energy_planning_credentials WHERE singleton),false);
$$;

CREATE FUNCTION public.read_energy_planning_job(p_home_id uuid,p_job_id uuid DEFAULT NULL,p_snapshot_id uuid DEFAULT NULL)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; v_receipt json;
BEGIN
  IF (p_job_id IS NULL)=(p_snapshot_id IS NULL) THEN RAISE EXCEPTION 'Specify one planning job or snapshot'; END IF;
  SELECT * INTO j FROM private.energy_planning_jobs WHERE home_id=p_home_id
    AND ((p_job_id IS NOT NULL AND id=p_job_id) OR (p_snapshot_id IS NOT NULL AND snapshot_id=p_snapshot_id));
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_receipt:=private.energy_planning_receipt(j);
  IF p_snapshot_id IS NOT NULL THEN
    -- Build JSON directly; converting the frozen context through JSONB would
    -- reorder nested planning/configuration maps.
    RETURN json_build_object('job_id',j.id,'state',v_receipt->>'state',
      'pending',(v_receipt->>'pending')::boolean,
      'retry_after_ms',v_receipt->'retry_after_ms',
      'snapshot_id',j.snapshot_id,'source_hash',j.source_hash,
      'plan_id',v_receipt->'plan_id','plan',v_receipt->'plan',
      'code',j.code,'detail',j.detail,'exchange',j.context->'exchange');
  END IF;
  RETURN v_receipt;
END; $$;

CREATE FUNCTION public.accept_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; c public.energy_optimisation_current%ROWTYPE;
  v_home uuid:=($1->>'home_id')::uuid; v_revision bigint;
BEGIN
  IF json_typeof($1->'input') IS DISTINCT FROM 'object' OR json_typeof($1->'context') IS DISTINCT FROM 'object'
    OR $1->>'source_hash' IS NULL OR $1->'context'->>'fixed_revision' IS NULL THEN
    RAISE EXCEPTION 'Incomplete planning job' USING ERRCODE='22023';
  END IF;
  INSERT INTO private.energy_planning_heads(home_id) VALUES(v_home) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM private.energy_planning_heads WHERE home_id=v_home FOR UPDATE;
  SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=v_home FOR UPDATE;
  SELECT * INTO j FROM private.energy_planning_jobs WHERE home_id=v_home AND snapshot_id=($1->>'snapshot_id')::uuid FOR UPDATE;
  IF FOUND THEN
    IF j.source_hash IS DISTINCT FROM $1->>'source_hash' THEN
      RAISE EXCEPTION 'Planning snapshot identity reused with different input' USING ERRCODE='22023';
    END IF;
    RETURN private.energy_planning_receipt(j);
  END IF;
  IF COALESCE(c.fixed_plan_revision,0)<>($1->'context'->>'fixed_revision')::integer
    OR c.replan_request_id IS DISTINCT FROM ($1->'context'->>'observed_replan_request_id')::uuid
    OR ($1->'context'->>'replan_request_id' IS NOT NULL
      AND c.replan_request_id IS DISTINCT FROM ($1->'context'->>'replan_request_id')::uuid) THEN
    RAISE EXCEPTION 'Planning request changed during preparation' USING ERRCODE='22023';
  END IF;
  UPDATE private.energy_planning_jobs SET state='superseded',lease_until=NULL,finished_at=now()
    WHERE id=(SELECT active_job_id FROM private.energy_planning_heads WHERE home_id=v_home) AND state='pending';
  UPDATE private.energy_planning_heads SET revision=revision+1 WHERE home_id=v_home RETURNING revision INTO v_revision;
  INSERT INTO private.energy_planning_jobs(home_id,customer_id,snapshot_id,source_hash,revision,protocol,input,context,wake_after)
    VALUES(v_home,($1->>'customer_id')::uuid,($1->>'snapshot_id')::uuid,$1->>'source_hash',v_revision,
      ($1->>'protocol')::integer,$1->'input',$1->'context',now()+interval '10 seconds') RETURNING * INTO j;
  UPDATE private.energy_planning_heads SET active_job_id=j.id WHERE home_id=v_home;
  PERFORM private.wake_energy_planning_job(j.id);
  RETURN private.energy_planning_receipt(j);
END; $$;

CREATE FUNCTION public.claim_energy_planning_step(p_job_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  j:=private.lock_energy_planning_job(p_job_id);
  IF j.id IS NULL OR j.state<>'pending' OR j.lease_until>now() THEN RETURN NULL; END IF;
  IF j.lease_until IS NOT NULL THEN
    j.expiry_count:=j.expiry_count+1;
    IF j.expiry_count>=4 THEN
      UPDATE private.energy_planning_jobs SET state='failed',lease_until=NULL,expiry_count=j.expiry_count,
        finished_at=now(),code='worker_lease_expired',detail='Planning worker repeatedly stopped before saving progress.' WHERE id=j.id;
      UPDATE public.energy_optimisation_current SET replan_error='Planning worker repeatedly stopped before saving progress.'
        WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
        AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
      RETURN NULL;
    END IF;
  END IF;
  UPDATE private.energy_planning_jobs SET fence=fence+1,lease_until=now()+interval '30 seconds',
    wake_after=now()+interval '30 seconds',expiry_count=j.expiry_count WHERE id=j.id RETURNING * INTO j;
  RETURN json_build_object('id',j.id,'home_id',j.home_id,'customer_id',j.customer_id,'snapshot_id',j.snapshot_id,
    'protocol',j.protocol,'fence',j.fence,'step',j.step,'phase',j.phase,'input',j.input,'context',j.context,
    'continuation',j.continuation,
    'completed',COALESCE((SELECT json_agg(value ORDER BY ordinal) FROM private.energy_planning_parts WHERE job_id=j.id AND kind='completed'),'[]'::json),
    'rankings',COALESCE((SELECT json_agg(value ORDER BY ordinal) FROM private.energy_planning_parts WHERE job_id=j.id AND kind='rankings'),'[]'::json));
END; $$;

CREATE FUNCTION public.commit_energy_planning_step(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; v_kind text; v_count bigint;
BEGIN
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint OR j.step IS DISTINCT FROM ($1->>'step')::bigint
    OR j.lease_until IS NULL OR j.lease_until<=now() THEN RETURN NULL; END IF;
  IF $1->>'phase' NOT IN ('solving','assembling') OR json_typeof($1->'completed') IS DISTINCT FROM 'array'
    OR json_typeof($1->'rankings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid planning checkpoint'; END IF;
  FOREACH v_kind IN ARRAY ARRAY['completed','rankings'] LOOP
    SELECT count(*) INTO v_count FROM private.energy_planning_parts WHERE job_id=j.id AND kind=v_kind;
    INSERT INTO private.energy_planning_parts(job_id,kind,ordinal,value)
      SELECT j.id,v_kind,v_count+ordinal,value FROM json_array_elements($1->v_kind) WITH ORDINALITY AS parts(value,ordinal);
  END LOOP;
  UPDATE private.energy_planning_jobs SET continuation=$1->'continuation',phase=$1->>'phase',step=step+1,
    lease_until=NULL,expiry_count=0,wake_after=now()+interval '10 seconds' WHERE id=j.id RETURNING * INTO j;
  PERFORM private.wake_energy_planning_job(j.id);
  RETURN private.energy_planning_receipt(j);
END; $$;

CREATE FUNCTION public.publish_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='30s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r public.energy_optimisation_plan_runs%ROWTYPE; v_current jsonb:=$1->'current';
BEGIN
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.id IS NULL OR j.state<>'pending' OR j.phase<>'assembling' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint
    OR j.step IS DISTINCT FROM ($1->>'step')::bigint OR j.lease_until IS NULL OR j.lease_until<=now() THEN RETURN NULL; END IF;
  r:=jsonb_populate_record(NULL::public.energy_optimisation_plan_runs,($1->'run')::jsonb);
  IF (v_current->>'home_id')::uuid IS DISTINCT FROM j.home_id
    OR (v_current->>'customer_id')::uuid IS DISTINCT FROM j.customer_id
    OR (v_current->>'snapshot_id')::uuid IS DISTINCT FROM j.snapshot_id
    OR (v_current->>'fixed_plan_generation_revision')::integer IS DISTINCT FROM (j.context->>'fixed_revision')::integer
    OR v_current->>'generation_request_id' IS DISTINCT FROM j.context->>'request_id'
    OR r.id IS DISTINCT FROM (v_current->>'plan_id')::uuid OR r.home_id IS DISTINCT FROM j.home_id
    OR r.customer_id IS DISTINCT FROM j.customer_id OR r.snapshot_id IS DISTINCT FROM j.snapshot_id
    OR r.generation_request_id IS DISTINCT FROM j.context->>'request_id'
    OR r.plan_schema_version IS DISTINCT FROM (v_current->>'plan_schema_version')::smallint
    OR r.input_hash IS DISTINCT FROM v_current->>'input_hash' THEN
    RAISE EXCEPTION 'Planning publication identity mismatch';
  END IF;
  PERFORM public.store_energy_optimisation_current(v_current);
  INSERT INTO public.energy_optimisation_plan_runs(id,customer_id,home_id,snapshot_id,generation_request_id,
    plan_schema_version,ha_ack_status,ha_acknowledged_at,ha_integration_version,ha_ack_request_id,ha_ack_error,
    input_hash,issued_at,status,model_version,summary,validation_errors)
  VALUES(r.id,r.customer_id,r.home_id,r.snapshot_id,r.generation_request_id,r.plan_schema_version,
    r.ha_ack_status,r.ha_acknowledged_at,r.ha_integration_version,r.ha_ack_request_id,r.ha_ack_error,
    r.input_hash,r.issued_at,r.status,r.model_version,r.summary,COALESCE(r.validation_errors,'{}'))
  ON CONFLICT(home_id,snapshot_id) DO UPDATE SET id=EXCLUDED.id,generation_request_id=EXCLUDED.generation_request_id,
    plan_schema_version=EXCLUDED.plan_schema_version,ha_ack_status=EXCLUDED.ha_ack_status,
    ha_acknowledged_at=EXCLUDED.ha_acknowledged_at,ha_integration_version=EXCLUDED.ha_integration_version,
    ha_ack_request_id=EXCLUDED.ha_ack_request_id,ha_ack_error=EXCLUDED.ha_ack_error,input_hash=EXCLUDED.input_hash,
    issued_at=EXCLUDED.issued_at,status=EXCLUDED.status,model_version=EXCLUDED.model_version,
    summary=EXCLUDED.summary,validation_errors=EXCLUDED.validation_errors;
  -- Preparation bound this job to the observed request, and the guard still
  -- holds that identity. Finish exactly that request without using source time
  -- to infer whether a different/newer request was answered.
  UPDATE public.energy_optimisation_current SET replan_completed_request_id=replan_request_id,replan_error=NULL
    WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
  UPDATE private.energy_planning_jobs SET state='published',plan_id=r.id,lease_until=NULL,finished_at=now()
    WHERE id=j.id RETURNING * INTO j;
  RETURN private.energy_planning_receipt(j,false);
END; $$;

CREATE FUNCTION public.fail_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint OR j.step IS DISTINCT FROM ($1->>'step')::bigint
    OR j.lease_until IS NULL OR j.lease_until<=now() THEN RETURN NULL; END IF;
  IF NULLIF($1->>'code','') IS NULL OR NULLIF($1->>'detail','') IS NULL THEN RAISE EXCEPTION 'Missing planning failure'; END IF;
  UPDATE private.energy_planning_jobs SET state='failed',code=$1->>'code',detail=$1->>'detail',
    lease_until=NULL,finished_at=now() WHERE id=j.id RETURNING * INTO j;
  UPDATE public.energy_optimisation_current SET replan_error=j.detail
    WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
  RETURN private.energy_planning_receipt(j);
END; $$;

-- Cron is the durable liveness owner. Immediate pg_net wakes reduce latency;
-- missed wakes and terminated invocations are recovered from committed state.
CREATE FUNCTION private.sweep_energy_planning_jobs()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM private.energy_planning_jobs WHERE state='pending' AND wake_after<=now()
    ORDER BY wake_after LIMIT 20 LOOP
    UPDATE private.energy_planning_jobs SET wake_after=now()+interval '10 seconds' WHERE id=v_id AND state='pending';
    PERFORM private.wake_energy_planning_job(v_id);
  END LOOP;
  DELETE FROM private.energy_planning_jobs WHERE id IN (
    SELECT id FROM private.energy_planning_jobs WHERE state<>'pending'
      AND finished_at<now()-CASE WHEN state='failed' THEN interval '14 days' ELSE interval '7 days' END
    ORDER BY finished_at LIMIT 100);
END; $$;

REVOKE ALL ON FUNCTION private.energy_planning_receipt(private.energy_planning_jobs,boolean),
  private.wake_energy_planning_job(uuid),private.energy_planning_is_current(private.energy_planning_jobs),
  private.lock_energy_planning_job(uuid),private.sweep_energy_planning_jobs() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.accept_energy_planning_job(json),public.read_energy_planning_job(uuid,uuid,uuid),
  public.claim_energy_planning_step(uuid),public.commit_energy_planning_step(json),public.publish_energy_planning_job(json),
  public.fail_energy_planning_job(json),public.verify_energy_planning_token(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accept_energy_planning_job(json),public.read_energy_planning_job(uuid,uuid,uuid),
  public.claim_energy_planning_step(uuid),public.commit_energy_planning_step(json),public.publish_energy_planning_job(json),
  public.fail_energy_planning_job(json),public.verify_energy_planning_token(text) TO service_role;
SELECT cron.schedule('advance-energy-planning-jobs','10 seconds',$job$SELECT private.sweep_energy_planning_jobs()$job$);
