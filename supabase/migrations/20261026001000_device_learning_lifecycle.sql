-- Each learned plant owns its cadence, lease and publication. No learning runs
-- on the admission request and no forecast product selects a calibration.
ALTER TABLE public.energy_optimisation_zone_models ADD COLUMN model_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE public.energy_optimisation_pool_model ADD COLUMN model_revision bigint NOT NULL DEFAULT 1;
CREATE FUNCTION private.advance_device_model_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.model_revision := OLD.model_revision + 1; RETURN NEW; END; $$;
CREATE TRIGGER zone_model_revision BEFORE UPDATE ON public.energy_optimisation_zone_models
  FOR EACH ROW EXECUTE FUNCTION private.advance_device_model_revision();
CREATE TRIGGER pool_model_revision BEFORE UPDATE ON public.energy_optimisation_pool_model
  FOR EACH ROW EXECUTE FUNCTION private.advance_device_model_revision();

CREATE TABLE private.energy_learning_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK(owner_kind IN ('room','pool')),
  owner_key text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  fence bigint NOT NULL DEFAULT 0,
  pending boolean NOT NULL DEFAULT true,
  input jsonb NOT NULL,
  lease_until timestamptz,
  wake_after timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  finished_at timestamptz,
  UNIQUE(home_id,owner_kind,owner_key),
  CHECK(public.energy_home_matches_customer(home_id,customer_id))
);
ALTER TABLE private.energy_learning_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_learning_jobs FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX energy_learning_jobs_due ON private.energy_learning_jobs(wake_after) WHERE pending;

-- The old planning credentials were retired with the checkpoint protocol.
-- Learning owns its own database-held wake credential and endpoint.
CREATE TABLE private.energy_learning_credentials (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  token text NOT NULL DEFAULT encode(extensions.gen_random_bytes(32),'hex'),
  function_url text CHECK(function_url ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/energy-device-learning$')
);
INSERT INTO private.energy_learning_credentials(singleton) VALUES(true);
ALTER TABLE private.energy_learning_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_learning_credentials FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.configure_energy_device_learning(p_project_url text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  IF p_project_url !~ '^https://[a-z0-9]+\.supabase\.co$' THEN RAISE EXCEPTION 'Invalid project URL'; END IF;
  UPDATE private.energy_learning_credentials SET function_url=p_project_url||'/functions/v1/energy-device-learning' WHERE singleton;
END; $$;
CREATE FUNCTION public.verify_energy_learning_token(p_token text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT COALESCE((SELECT token=p_token FROM private.energy_learning_credentials WHERE singleton),false);
$$;
CREATE FUNCTION private.wake_energy_learning_job(p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE c private.energy_learning_credentials%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM private.energy_learning_credentials WHERE singleton;
  IF c.function_url IS NULL THEN RAISE EXCEPTION 'Learning endpoint is not configured'; END IF;
  PERFORM net.http_post(url:=c.function_url,
    headers:=jsonb_build_object('Content-Type','application/json','x-energy-learning-token',c.token),
    body:=jsonb_build_object('job_id',p_id),timeout_milliseconds:=30000);
END; $$;

CREATE FUNCTION public.request_energy_device_learning(p_home_id uuid,p_customer_id uuid,p_owners jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE o jsonb; v_id uuid; n integer:=0; due boolean;
BEGIN
  IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
  IF jsonb_typeof(p_owners) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid learning owners'; END IF;
  -- The capture supplies the complete current ownership set. Removal fences an
  -- in-flight fit too; retained models stay available if a device is remapped.
  UPDATE private.energy_learning_jobs j SET pending=false,generation=generation+1,fence=fence+1,
    lease_until=NULL,finished_at=now(),last_error='Learning owner removed'
  WHERE home_id=p_home_id AND pending AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_owners) AS current_owner(value)
      WHERE current_owner.value->>'kind'=j.owner_kind AND current_owner.value->>'key'=j.owner_key);
  FOR o IN SELECT value FROM jsonb_array_elements(p_owners) LOOP
    IF o->>'kind'='room' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at < now()-CASE WHEN trained THEN interval '24 hours' ELSE interval '1 hour' END
        OR (trained AND last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'interval_mean_transition_holdout_v1')
      INTO due FROM public.energy_optimisation_zone_models WHERE home_id=p_home_id AND room_key=o->>'key';
    ELSIF o->>'kind'='pool' AND o->>'key'='pool' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at<now()-interval '24 hours'
        OR heat_pump_epoch_start>last_attempted_at
        OR last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'pool_interval_mean_v1'
      INTO due FROM public.energy_optimisation_pool_model WHERE home_id=p_home_id;
    ELSE RAISE EXCEPTION 'Invalid learning owner'; END IF;
    IF COALESCE(due,true) THEN
      INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
        VALUES(p_home_id,p_customer_id,o->>'kind',o->>'key',o->'input')
      ON CONFLICT(home_id,owner_kind,owner_key) DO UPDATE SET
        pending=true,generation=energy_learning_jobs.generation+1,input=EXCLUDED.input,
        fence=energy_learning_jobs.fence+1,lease_until=NULL,wake_after=now(),attempts=0,last_error=NULL,finished_at=NULL
        WHERE NOT energy_learning_jobs.pending OR energy_learning_jobs.input IS DISTINCT FROM EXCLUDED.input RETURNING id INTO v_id;
      IF FOUND THEN PERFORM private.wake_energy_learning_job(v_id); n:=n+1; END IF;
    END IF;
  END LOOP;
  RETURN n;
END; $$;
CREATE FUNCTION public.claim_energy_device_learning(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE;
BEGIN
  UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=now()+interval '60 seconds',
    wake_after=now()+interval '60 seconds',attempts=attempts+1
  WHERE id=p_job_id AND pending AND (lease_until IS NULL OR lease_until<=now())
    RETURNING * INTO j;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(j);
END; $$;

-- Thermal publication cannot touch hardware or equipment capability. Both the
-- owner fence and the model revision must still match the observations' basis.
CREATE FUNCTION public.publish_energy_device_learning(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,p_model jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; previous jsonb; patch jsonb:=p_model;
  model_table text; keys text; columns_sql text; values_sql text; update_sql text; allowed text[];
BEGIN
  SELECT * INTO j FROM private.energy_learning_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR NOT j.pending OR j.generation<>p_generation OR j.fence<>p_fence
    OR j.lease_until IS NULL OR j.lease_until<=now() THEN RETURN false; END IF;
  IF j.owner_kind='room' THEN
    model_table:='energy_optimisation_zone_models'; keys:='home_id,room_key';
    SELECT to_jsonb(m) INTO previous FROM public.energy_optimisation_zone_models m
      WHERE home_id=j.home_id AND room_key=j.owner_key FOR UPDATE;
    allowed:=ARRAY['home_id','customer_id','room_key','room_name','fitted_at','training_from','training_to','sample_count',
      'trained','rejection_reason','last_attempted_at','last_fit_attempt','gain_c_per_wh','cooling_constant_per_h',
      'background_gain_c_per_h','thermal_capacity_wh_per_c','heat_loss_w_per_c','time_constant_h','heating_rate_c_per_h',
      'solar_gain_c_per_h_per_wm2','solar_mean_w_per_m2','r2','residual_std_c','heat_lag_h','house_coupling_per_h','prediction_error_c'];
  ELSE
    model_table:='energy_optimisation_pool_model'; keys:='home_id';
    SELECT to_jsonb(m) INTO previous FROM public.energy_optimisation_pool_model m WHERE home_id=j.home_id FOR UPDATE;
    allowed:=ARRAY['home_id','customer_id','fitted_at','loss_kw_per_k','rated_cop','cop_per_air_c','background_kw','r2',
      'sample_count','heated_sample_count','rejection','idle_loss_kw_per_k','idle_loss_hours','idle_loss_run_count',
      'idle_loss_rejection','response','thermal_dynamics','last_attempted_at','last_fit_attempt'];
  END IF;
  IF COALESCE((previous->>'model_revision')::bigint,0)<>p_revision THEN
    UPDATE private.energy_learning_jobs SET lease_until=NULL,wake_after=now(),last_error='Model changed during fit' WHERE id=j.id;
    RETURN false;
  END IF;
  IF jsonb_typeof(patch)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(patch) k WHERE NOT k=ANY(allowed))
    OR (patch->>'home_id')::uuid IS DISTINCT FROM j.home_id OR (patch->>'customer_id')::uuid IS DISTINCT FROM j.customer_id
    OR (j.owner_kind='room' AND patch->>'room_key' IS DISTINCT FROM j.owner_key) THEN
    RAISE EXCEPTION 'Learning publication crosses owner boundary';
  END IF;
  IF j.owner_kind='room' AND (previous->>'trained')::boolean AND NOT (patch->>'trained')::boolean THEN
    patch:=jsonb_build_object('home_id',j.home_id,'room_key',j.owner_key,
      'last_attempted_at',patch->'last_attempted_at','last_fit_attempt',patch->'last_fit_attempt');
  END IF;
  -- Merge the existing record to satisfy complete-row constraints on conflict;
  -- update only supplied, whitelisted columns. Defaults apply on cold insert.
  SELECT string_agg(format('%I',k),','),string_agg(format('r.%I',k),','),
    string_agg(format('%I=EXCLUDED.%I',k,k),',')
    INTO columns_sql,values_sql,update_sql FROM jsonb_object_keys(COALESCE(previous,'{}')||patch) k
    WHERE k=ANY(allowed);
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) r
    ON CONFLICT(%s) DO UPDATE SET %s',model_table,columns_sql,values_sql,model_table,keys,update_sql)
    USING COALESCE(previous,'{}')||patch;
  UPDATE private.energy_learning_jobs SET pending=false,lease_until=NULL,last_error=NULL,finished_at=now() WHERE id=j.id;
  RETURN true;
END; $$;
CREATE FUNCTION public.fail_energy_device_learning(p_job_id uuid,p_generation bigint,p_fence bigint,p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,private AS $$
  UPDATE private.energy_learning_jobs SET lease_until=NULL,wake_after=now()+interval '5 minutes',last_error=p_error
  WHERE id=p_job_id AND pending AND generation=p_generation AND fence=p_fence;
$$;
CREATE FUNCTION private.sweep_energy_learning_jobs() RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM private.energy_learning_jobs WHERE pending AND wake_after<=now() ORDER BY wake_after LIMIT 6 LOOP
    UPDATE private.energy_learning_jobs SET wake_after=now()+interval '10 seconds' WHERE id=v_id;
    PERFORM private.wake_energy_learning_job(v_id);
  END LOOP;
END; $$;
-- One PostgreSQL statement/MVCC snapshot supplies every calibration revision.
CREATE FUNCTION public.capture_energy_device_models(p_home_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object('rooms',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY room_key)
    FROM energy_optimisation_zone_models m WHERE home_id=p_home_id),'[]'::jsonb),
    'pool',(SELECT to_jsonb(m) FROM energy_optimisation_pool_model m WHERE home_id=p_home_id));
$$;
REVOKE ALL ON FUNCTION private.advance_device_model_revision(),private.wake_energy_learning_job(uuid),private.sweep_energy_learning_jobs()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.request_energy_device_learning(uuid,uuid,jsonb),public.claim_energy_device_learning(uuid),
  public.publish_energy_device_learning(uuid,bigint,bigint,bigint,jsonb),public.fail_energy_device_learning(uuid,bigint,bigint,text),
  public.capture_energy_device_models(uuid),public.configure_energy_device_learning(text),public.verify_energy_learning_token(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_energy_device_learning(uuid,uuid,jsonb),public.claim_energy_device_learning(uuid),
  public.publish_energy_device_learning(uuid,bigint,bigint,bigint,jsonb),public.fail_energy_device_learning(uuid,bigint,bigint,text),
  public.capture_energy_device_models(uuid),public.configure_energy_device_learning(text),public.verify_energy_learning_token(text) TO service_role;
SELECT cron.schedule('advance-energy-learning-jobs','10 seconds',$job$SELECT private.sweep_energy_learning_jobs()$job$);
