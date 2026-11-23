-- One shared room response fitted across every outdoor temperature replaces
-- the per-5 °C-band responses. Bands remain only as sampling strata: each
-- band window's newest runs are harvested once into a private run pool, and
-- the shared fit merges that pool. The response is published in the existing
-- heating_bands.reference slot with scope "shared"; legacy band revisions are
-- archived by the existing trigger when that publication empties `active`.

CREATE TABLE private.energy_room_run_pool (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL,
 room_key text NOT NULL,
 binding text NOT NULL,
 window_key text NOT NULL,
 band_c integer NOT NULL,
 from_at timestamptz NOT NULL,
 capture bytea NOT NULL,
 sha256 text NOT NULL,
 row_count integer NOT NULL CHECK(row_count>0),
 run_ids jsonb NOT NULL CHECK(jsonb_typeof(run_ids)='array' AND jsonb_array_length(run_ids) BETWEEN 1 AND 24),
 observed_runs integer NOT NULL CHECK(observed_runs>=0),
 rated_power_w double precision,
 source_freshness jsonb,
 job_id uuid NOT NULL,
 generation bigint NOT NULL,
 harvested_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(home_id,room_key,window_key)
);
ALTER TABLE private.energy_room_run_pool ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_room_run_pool FROM PUBLIC,anon,authenticated,service_role;

-- Up to 24 runs, balanced across outdoor strata.
ALTER TABLE private.energy_room_run_ledgers DROP CONSTRAINT IF EXISTS energy_room_run_ledgers_check;
ALTER TABLE private.energy_room_run_ledgers ADD CONSTRAINT energy_room_run_ledgers_runs_check
 CHECK(evidence IS NULL OR (jsonb_typeof(evidence->'runs')='array' AND jsonb_array_length(evidence->'runs')<=24));

-- One band window's harvest, under the job fence. Idempotent: the same fence
-- and entry write the same row. Harvested evidence outlives raw-history
-- retention: an entry is replaced by its band's next harvest and pruned only
-- for another source binding. A band with no complete run holds no entry.
CREATE FUNCTION public.save_energy_room_run_harvest(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_window_key text,p_band_c integer,p_from_at timestamptz,p_capture_base64 text,p_sha256 text,p_row_count integer,
 p_run_ids jsonb,p_observed_runs integer,p_rated_power_w double precision,p_source_freshness jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE owner private.energy_learning_jobs%ROWTYPE; v_binding text; runs integer;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT * INTO owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 SELECT c.binding INTO v_binding FROM private.energy_room_heating_contexts(owner.home_id) c WHERE c.room_key=owner.owner_key;
 IF v_binding IS NULL THEN RETURN false; END IF;
 runs:=CASE WHEN jsonb_typeof(p_run_ids)='array' THEN jsonb_array_length(p_run_ids) END;
 IF coalesce(p_window_key,'')='' OR p_from_at IS NULL OR runs IS NULL OR runs>24 OR p_observed_runs IS NULL OR p_observed_runs<runs
   OR (runs>0 AND (p_capture_base64 IS NULL OR coalesce(p_sha256,'')='' OR coalesce(p_row_count,0)<=0))
   OR (runs=0 AND p_capture_base64 IS NOT NULL) THEN RAISE EXCEPTION 'Invalid room run harvest'; END IF;
 DELETE FROM private.energy_room_run_pool p WHERE p.home_id=owner.home_id AND p.room_key=owner.owner_key
   AND (p.binding<>v_binding OR (runs=0 AND p.window_key=p_window_key));
 IF runs>0 THEN
   INSERT INTO private.energy_room_run_pool(home_id,customer_id,room_key,binding,window_key,band_c,from_at,capture,sha256,
     row_count,run_ids,observed_runs,rated_power_w,source_freshness,job_id,generation)
   VALUES(owner.home_id,owner.customer_id,owner.owner_key,v_binding,p_window_key,p_band_c,p_from_at,
     decode(p_capture_base64,'base64'),p_sha256,p_row_count,p_run_ids,p_observed_runs,p_rated_power_w,
     nullif(p_source_freshness,'null'::jsonb),p_job_id,p_generation)
   ON CONFLICT(home_id,room_key,window_key) DO UPDATE SET customer_id=EXCLUDED.customer_id,binding=EXCLUDED.binding,
     band_c=EXCLUDED.band_c,from_at=EXCLUDED.from_at,capture=EXCLUDED.capture,sha256=EXCLUDED.sha256,
     row_count=EXCLUDED.row_count,run_ids=EXCLUDED.run_ids,observed_runs=EXCLUDED.observed_runs,
     rated_power_w=EXCLUDED.rated_power_w,source_freshness=EXCLUDED.source_freshness,
     job_id=EXCLUDED.job_id,generation=EXCLUDED.generation,harvested_at=now();
 END IF;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.save_energy_room_run_harvest(uuid,bigint,bigint,bigint,text,integer,timestamptz,text,text,integer,jsonb,integer,double precision,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_energy_room_run_harvest(uuid,bigint,bigint,bigint,text,integer,timestamptz,text,text,integer,jsonb,integer,double precision,jsonb) TO service_role;

CREATE FUNCTION public.load_energy_room_run_pool(p_home_id uuid,p_customer_id uuid,p_room_key text,p_binding text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('window_key',p.window_key,'sha256',p.sha256,'band_c',p.band_c,
   'from_at',p.from_at,'harvested_at',p.harvested_at,'capture',replace(encode(p.capture,'base64'),E'\n',''),
   'row_count',p.row_count,'observed_runs',p.observed_runs,'rated_power_w',p.rated_power_w,
   'source_freshness',p.source_freshness) ORDER BY p.window_key),'[]'::jsonb)
   FROM private.energy_room_run_pool p
   WHERE p.home_id=p_home_id AND p.room_key=p_room_key AND p.binding=p_binding);
END; $$;
REVOKE ALL ON FUNCTION public.load_energy_room_run_pool(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_energy_room_run_pool(uuid,uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_model jsonb,p_run_ledger jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE captured jsonb; owner private.energy_learning_jobs%ROWTYPE; fitted integer; retained integer; maximum integer;
 previous_library jsonb; new_summary jsonb; scope text; changed boolean; new_candidates jsonb; pool jsonb; ledger_scope text;
BEGIN
 p_run_ledger:=nullif(p_run_ledger,'null'::jsonb);
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT metadata->'capture' INTO captured FROM private.energy_room_fit_progress
 WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
   AND jsonb_array_length(cells)=p_expected_cursor;
 IF p_expected_cursor IS DISTINCT FROM 36 OR captured IS NULL THEN RETURN false; END IF;
 IF p_run_ledger IS NOT NULL THEN
   maximum:=CASE p_run_ledger->>'policy' WHEN 'seasonal_independent_runs_v1' THEN 24 WHEN 'recent_independent_runs_v1' THEN 10 END;
   IF maximum IS NULL OR jsonb_typeof(p_run_ledger->'runs') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_run_ledger->'runs')>maximum THEN RAISE EXCEPTION 'Invalid run evidence'; END IF;
   SELECT count(*) FILTER(WHERE run->>'disposition'='fitted'),count(*) INTO fitted,retained
   FROM jsonb_array_elements(p_run_ledger->'runs') run;
   IF fitted IS DISTINCT FROM (p_run_ledger->>'fitted_runs')::integer
     OR retained IS DISTINCT FROM (p_run_ledger->>'retained_runs')::integer
     OR (fitted>0 AND fitted<3)
     OR retained<>(SELECT count(DISTINCT run->>'id') FROM jsonb_array_elements(p_run_ledger->'runs') run) THEN
     RAISE EXCEPTION 'Run support must contain three or more distinct events';
   END IF;
 END IF;
 SELECT * INTO owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 scope:=captured#>>'{window,window_key}';
 SELECT heating_bands INTO previous_library FROM public.energy_optimisation_zone_models
 WHERE home_id=owner.home_id AND room_key=owner.owner_key;
 IF scope IN ('general','shared') THEN
   changed:=p_model#>>'{heating_bands,reference_revision}' IS DISTINCT FROM previous_library->>'reference_revision';
   new_summary:=p_model#>'{heating_bands,reference,learning_evidence,run_calibration}';
 ELSE
   SELECT coalesce(jsonb_agg(candidate),'[]'::jsonb) INTO new_candidates
   FROM jsonb_array_elements(coalesce(p_model#>'{heating_bands,active}','[]'::jsonb)) candidate
   WHERE candidate->>'band_c'=scope AND NOT EXISTS (
     SELECT FROM jsonb_array_elements(coalesce(previous_library->'active','[]'::jsonb)) old
     WHERE old->>'revision'=candidate->>'revision');
   IF jsonb_array_length(new_candidates)>1 THEN RAISE EXCEPTION 'Only one response revision may be published per band'; END IF;
   changed:=jsonb_array_length(new_candidates)=1;
   new_summary:=new_candidates#>'{0,learning_evidence,run_calibration}';
   IF p_model#>>ARRAY['heating_bands','diagnostics',scope,'status']='fitted' AND NOT changed THEN
     RAISE EXCEPTION 'Fitted attempt must activate its new response revision';
   END IF;
 END IF;
 IF coalesce(changed,false) AND (p_run_ledger IS NULL OR fitted<3
   OR new_summary IS DISTINCT FROM (p_run_ledger-'runs'-'assessed_against')) THEN
   RAISE EXCEPTION 'Published response must match its fitted run evidence';
 END IF;
 IF scope='shared' THEN
   -- The capture must describe exactly the pool now stored for this binding;
   -- a harvest after capture starts a new attempt instead.
   SELECT coalesce(jsonb_agg(jsonb_build_object('window_key',p.window_key,'sha256',p.sha256)),'[]'::jsonb) INTO pool
   FROM private.energy_room_run_pool p WHERE p.home_id=owner.home_id AND p.room_key=owner.owner_key
     AND p.binding=p_model#>>'{heating_bands,binding}';
   IF jsonb_typeof(p_model#>'{heating_bands,shared_attempt,pool}') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_model#>'{heating_bands,shared_attempt,pool}')<>jsonb_array_length(pool)
     OR NOT ((p_model#>'{heating_bands,shared_attempt,pool}') @> pool AND pool @> (p_model#>'{heating_bands,shared_attempt,pool}')) THEN
     -- Like a reset: discard the stale scratch and hand the job straight back.
     DELETE FROM private.energy_room_fit_progress WHERE job_id=p_job_id;
     PERFORM private.resume_energy_room_fit(p_job_id);
     RETURN false;
   END IF;
   IF coalesce(changed,false) AND (p_model#>>'{heating_bands,reference,scope,kind}' IS DISTINCT FROM 'shared'
     OR jsonb_array_length(coalesce(p_model#>'{heating_bands,active}','[]'::jsonb))<>0
     OR p_run_ledger->>'assessed_against' IS DISTINCT FROM p_model#>>'{heating_bands,reference_revision}') THEN
     RAISE EXCEPTION 'A shared response must replace the bands and carry its own assessment';
   END IF;
 END IF;
 -- Publication retains source, owner and model-revision checks. The detailed
 -- ledger is not placed in heating_bands or sent in every planning capture.
 IF NOT public.publish_energy_device_learning(p_job_id,p_generation,p_fence,p_revision,p_model) THEN RETURN false; END IF;
 ledger_scope:=CASE WHEN scope='shared' AND NOT coalesce(changed,false) THEN 'attempt' ELSE scope END;
 IF scope='shared' AND coalesce(changed,false) THEN
   DELETE FROM private.energy_room_run_ledgers WHERE home_id=owner.home_id AND room_key=owner.owner_key AND scope_key<>'shared';
 END IF;
 INSERT INTO private.energy_room_run_ledgers(home_id,customer_id,room_key,scope_key,model_revision,job_id,generation,evidence)
 VALUES(owner.home_id,owner.customer_id,owner.owner_key,ledger_scope,p_revision+1,p_job_id,p_generation,p_run_ledger)
 ON CONFLICT(home_id,room_key,scope_key) DO UPDATE SET model_revision=EXCLUDED.model_revision,
   job_id=EXCLUDED.job_id,generation=EXCLUDED.generation,evidence=EXCLUDED.evidence,created_at=now();
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.complete_energy_room_fit(uuid,bigint,bigint,bigint,integer,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_energy_room_fit(uuid,bigint,bigint,bigint,integer,jsonb,jsonb) TO service_role;

-- A room is due once whenever its library predates the shared response.
CREATE OR REPLACE FUNCTION public.request_energy_device_learning(p_home_id uuid,p_customer_id uuid,p_owners jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE o jsonb; v_id uuid; n integer:=0; due boolean; heating_bindings jsonb;
BEGIN
  IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
  IF jsonb_typeof(p_owners) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid learning owners'; END IF;
  SELECT COALESCE(jsonb_object_agg(c.room_key,c.binding),'{}'::jsonb) INTO heating_bindings
    FROM private.energy_room_heating_contexts(p_home_id) c;
  -- The capture supplies the complete current ownership set. Removal fences an
  -- in-flight fit too; retained models stay available if a device is remapped.
  UPDATE private.energy_learning_jobs j SET pending=false,generation=generation+1,fence=fence+1,
    lease_until=NULL,finished_at=now(),last_error='Learning owner removed'
  WHERE home_id=p_home_id AND pending AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_owners) AS current_owner(value)
      WHERE current_owner.value->>'kind'=j.owner_kind AND current_owner.value->>'key'=j.owner_key);
  FOR o IN SELECT value FROM jsonb_array_elements(p_owners) LOOP
    IF o->>'kind'='room' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at < now()-CASE
          WHEN trained AND (heating_bands IS NULL OR heating_bands->>'reference_revision' IS NOT NULL)
          THEN interval '24 hours' ELSE interval '1 hour' END
        OR (heating_bindings ? (o->>'key') AND heating_bands->>'calibration_policy' IS DISTINCT FROM 'seasonal_independent_runs_v1')
        OR (heating_bindings ? (o->>'key') AND heating_bands IS NOT NULL
          AND heating_bands->>'binding' IS DISTINCT FROM heating_bindings->>(o->>'key'))
        OR (trained AND (heating_bands->>'reference_revision' IS NULL OR NOT (heating_bindings ? (o->>'key')))
          AND (last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'interval_mean_transition_holdout_v1'
            OR last_fit_attempt->'learning'->>'family' IS DISTINCT FROM 'house_outdoor_solar_v1'))
      INTO due FROM public.energy_optimisation_zone_models WHERE home_id=p_home_id AND room_key=o->>'key';
    ELSIF o->>'kind'='pool' AND o->>'key'='pool' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at<now()-interval '24 hours'
        OR (heat_pump_epoch_start IS NOT NULL AND heat_pump_epoch_start>last_attempted_at)
        OR last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'pool_interval_mean_v1'
      INTO due FROM public.energy_optimisation_pool_model WHERE home_id=p_home_id;
    ELSIF o->>'kind'='device' AND COALESCE(o->>'key','')<>'' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at<now()-interval '24 hours'
        OR last_fit_attempt->'learning'->>'method' IS DISTINCT FROM
          CASE WHEN o->'input'->>'weather_heating_binding' IS NULL
            THEN 'device_operating_points_v1' ELSE 'weather_heating_draw_v1' END
        OR (o->'input'->>'weather_heating_binding' IS NOT NULL AND
          operating_points->>'binding' IS DISTINCT FROM o->'input'->>'weather_heating_binding')
      INTO due FROM public.energy_optimisation_device_operating_points WHERE home_id=p_home_id AND device_key=o->>'key';
    ELSE RAISE EXCEPTION 'Invalid learning owner'; END IF;
    IF COALESCE(due,true) OR (o->>'kind'='device' AND EXISTS (
      SELECT 1 FROM private.energy_learning_jobs j
      WHERE j.home_id=p_home_id AND j.owner_kind='device' AND j.owner_key=o->>'key'
        AND j.pending AND j.input IS DISTINCT FROM o->'input'
    )) THEN
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

-- The room Model tab reads the published shared response together with the
-- run ledger assessed against it, in one snapshot. Legacy ledgers remain
-- readable until a room's shared response publishes.
CREATE FUNCTION public.get_energy_room_response_evidence(p_home_id uuid,p_room_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.homes h WHERE h.id=p_home_id AND public.can_access_energy_billing_customer(h.customer_id)) THEN
   RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object(
   'room',(SELECT jsonb_build_object('trained',m.trained,'rejection_reason',m.rejection_reason,
     'last_attempted_at',m.last_attempted_at,'last_fit_attempt',m.last_fit_attempt,
     'policy',m.heating_bands->>'calibration_policy','shared_attempt',m.heating_bands->'shared_attempt')
     FROM public.energy_optimisation_zone_models m WHERE m.home_id=p_home_id AND m.room_key=p_room_key),
   'response',(SELECT CASE WHEN m.heating_bands#>>'{reference,scope,kind}'='shared' THEN jsonb_build_object(
     'revision',m.heating_bands->>'reference_revision','model',m.heating_bands#>'{reference,model}',
     'training_from',m.heating_bands#>'{reference,training_from}','training_to',m.heating_bands#>'{reference,training_to}',
     'warnings',m.heating_bands#>'{reference,warnings}',
     'run_calibration',m.heating_bands#>'{reference,learning_evidence,run_calibration}') END
     FROM public.energy_optimisation_zone_models m WHERE m.home_id=p_home_id AND m.room_key=p_room_key),
   'ledgers',(SELECT coalesce(jsonb_agg(jsonb_build_object('scope_key',l.scope_key,'model_revision',l.model_revision,
     'created_at',l.created_at,'evidence',l.evidence) ORDER BY l.scope_key),'[]'::jsonb)
     FROM private.energy_room_run_ledgers l WHERE l.home_id=p_home_id AND l.room_key=p_room_key));
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_room_response_evidence(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_energy_room_response_evidence(uuid,text) TO authenticated,service_role;

-- Start the shared response without waiting for each room's daily cadence.
-- The delay lets CI deploy the edge function that follows this migration; a
-- job that still runs the previous learner is due again on its next request
-- because its library keeps the legacy run policy.
UPDATE private.energy_learning_jobs SET pending=true,generation=generation+1,fence=fence+1,
  lease_until=NULL,wake_after=now()+interval '15 minutes',attempts=0,last_error=NULL,finished_at=NULL
WHERE owner_kind='room' AND NOT pending;
