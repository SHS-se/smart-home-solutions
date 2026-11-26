-- CI prepares an ordered deployment before deploying the Edge worker and activates
-- its actual capabilities afterwards. Only deployment SQL can move this pointer.
CREATE TABLE private.energy_learning_releases (
 deployment bigint PRIMARY KEY CHECK (deployment > 0),
 predecessor bigint REFERENCES private.energy_learning_releases,
 manifest jsonb NOT NULL,
 worker jsonb
);
CREATE TABLE private.energy_learning_dispatch (
 singleton boolean PRIMARY KEY CHECK (singleton),
 active bigint REFERENCES private.energy_learning_releases,
 capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 2)
);
INSERT INTO private.energy_learning_dispatch VALUES (true,NULL,2);

-- A queued wake occupies the same slot as a running invocation. Physical
-- reservations survive generation changes until finally or expiry.
CREATE TABLE private.energy_learning_tickets (
 slot integer PRIMARY KEY CHECK (slot BETWEEN 1 AND 2),
 job_id uuid NOT NULL UNIQUE,
 home_id uuid NOT NULL REFERENCES public.homes ON DELETE CASCADE,
 generation bigint NOT NULL, fence bigint, work_class text NOT NULL,
 queued_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 CHECK (work_class IN ('source','numerical','finalization'))
);
ALTER TABLE private.energy_learning_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_learning_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_learning_dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_learning_releases,private.energy_learning_dispatch,private.energy_learning_tickets
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.prepare_energy_learning_release(p_deployment bigint,p_manifest jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE predecessor bigint; previous jsonb;
BEGIN
 SELECT active INTO predecessor FROM private.energy_learning_dispatch WHERE singleton FOR UPDATE;
 IF p_manifest IS NULL OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
   OR p_manifest->'protocol' IS DISTINCT FROM '2'::jsonb OR p_manifest->'progress_version' IS DISTINCT FROM '6'::jsonb
   OR coalesce(p_manifest->>'learner_version','') !~ '^room-learner:[0-9a-f]{16}$'
   OR coalesce(p_manifest->>'semantic_digest','') !~ '^[0-9a-f]{64}$'
   OR p_manifest->>'capture_revision' IS DISTINCT FROM 'response_native_peers_v1'
   OR p_manifest - ARRAY['protocol','progress_version','learner_version','semantic_digest','capture_revision'] <> '{}'::jsonb
 THEN RAISE EXCEPTION 'Invalid room learning release manifest'; END IF;
 IF EXISTS(SELECT FROM private.energy_learning_releases WHERE deployment>p_deployment) THEN RETURN false; END IF;
 SELECT manifest INTO previous FROM private.energy_learning_releases WHERE deployment=p_deployment;
 IF FOUND THEN RETURN previous=p_manifest; END IF;
 IF EXISTS(SELECT FROM private.energy_learning_releases WHERE manifest->>'learner_version'=p_manifest->>'learner_version'
   AND manifest->>'semantic_digest'<>p_manifest->>'semantic_digest') THEN
   RAISE EXCEPTION 'Room learner identity already names different semantics';
 END IF;
 INSERT INTO private.energy_learning_releases VALUES(p_deployment,predecessor,p_manifest,NULL);
 RETURN true;
END; $$;

CREATE FUNCTION private.energy_learning_work_class(p private.energy_room_fit_progress) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p.job_id IS NULL THEN 'source'
   WHEN p.metadata#>>'{heat_state,stage}'='complete' OR jsonb_array_length(p.cells)=108 THEN 'finalization'
   ELSE 'numerical' END;
$$;

CREATE FUNCTION private.refill_energy_learning_work() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,private,public AS $$
DECLARE target record; free_slot integer; available integer; c private.energy_learning_credentials%ROWTYPE;
BEGIN
 -- A wake can run while its caller holds arbitrary job rows. Never wait on
 -- another allocator, job, ticket or release pointer from this path. The
 -- reservation is a hint revalidated under the actual claim's job lock.
 IF NOT pg_try_advisory_xact_lock(155367,2) THEN RETURN; END IF;
 DELETE FROM private.energy_learning_tickets WHERE slot IN (
   SELECT slot FROM private.energy_learning_tickets WHERE expires_at<=now() FOR UPDATE SKIP LOCKED);
 SELECT d.capacity-(SELECT count(*) FROM private.energy_learning_tickets)
   -(SELECT count(*) FROM private.energy_room_learning_lanes WHERE lease_until>now())
 INTO available FROM private.energy_learning_dispatch d WHERE d.active IS NOT NULL;
 IF coalesce(available,0)<=0 THEN RETURN; END IF;
 SELECT * INTO STRICT c FROM private.energy_learning_credentials WHERE singleton;
 FOR free_slot IN SELECT s FROM generate_series(1,2) s
   WHERE NOT EXISTS(SELECT FROM private.energy_learning_tickets t WHERE t.slot=s)
   ORDER BY s LIMIT available LOOP
   SELECT j.id,j.home_id,j.generation,k.work_class INTO target
   FROM private.energy_learning_jobs j
   JOIN private.energy_learning_dispatch d ON d.singleton
   JOIN private.energy_learning_releases r ON r.deployment=d.active
   LEFT JOIN private.energy_room_fit_progress p ON p.job_id=j.id
   CROSS JOIN LATERAL (SELECT private.energy_learning_work_class(p) AS work_class) k
   WHERE j.owner_kind='room' AND j.pending AND j.wake_after<=now() AND (j.lease_until IS NULL OR j.lease_until<=now())
     AND j.input->>'learner_version'=r.manifest->>'learner_version'
     AND NOT EXISTS(SELECT FROM private.energy_learning_tickets t WHERE t.job_id=j.id
       OR (t.home_id=j.home_id AND t.work_class<>'numerical' AND k.work_class<>'numerical'))
     AND NOT EXISTS(SELECT FROM private.energy_room_learning_lanes l WHERE l.home_id=j.home_id AND l.lease_until>now())
   ORDER BY EXISTS(SELECT FROM private.energy_learning_tickets t WHERE t.home_id=j.home_id),
     j.room_last_started_at NULLS FIRST,j.wake_after,j.id LIMIT 1;
   IF NOT FOUND THEN RETURN; END IF;
   INSERT INTO private.energy_learning_tickets(slot,job_id,home_id,generation,work_class,expires_at)
   VALUES(free_slot,target.id,target.home_id,target.generation,target.work_class,now()+interval '60 seconds');
   IF c.function_url IS NULL THEN RAISE EXCEPTION 'Learning endpoint is not configured'; END IF;
   PERFORM net.http_post(url:=c.function_url,
     headers:=jsonb_build_object('Content-Type','application/json','x-energy-learning-token',c.token),
     body:=jsonb_build_object('job_id',target.id),timeout_milliseconds:=30000);
 END LOOP;
END; $$;

ALTER FUNCTION private.wake_energy_learning_job(uuid) RENAME TO wake_serial_energy_learning_job;
CREATE FUNCTION private.wake_energy_learning_job(p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,private,public AS $$
BEGIN
 IF EXISTS(SELECT FROM private.energy_learning_dispatch WHERE active IS NOT NULL)
   AND EXISTS(SELECT FROM private.energy_learning_jobs WHERE id=p_id AND owner_kind='room') THEN
   PERFORM private.refill_energy_learning_work();
 ELSE PERFORM private.wake_serial_energy_learning_job(p_id);
 END IF;
END; $$;

CREATE FUNCTION public.activate_energy_learning_release(p_deployment bigint,p_worker jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE current_id bigint; r private.energy_learning_releases%ROWTYPE; old_worker jsonb;
BEGIN
 -- Requests and claims acquire this shared gate BEFORE job locks. Wakes read
 -- the pointer without locking; an activation never holds a ticket lock while
 -- waiting for a job. In-flight work retains its physical slot.
 PERFORM pg_advisory_xact_lock(155367,1);
 SELECT active INTO current_id FROM private.energy_learning_dispatch WHERE singleton FOR UPDATE;
 SELECT * INTO r FROM private.energy_learning_releases WHERE deployment=p_deployment;
 IF NOT FOUND OR EXISTS(SELECT FROM private.energy_learning_releases WHERE deployment>p_deployment)
   OR jsonb_typeof(p_worker->'runtime') IS DISTINCT FROM 'string' OR coalesce(p_worker->>'runtime','')=''
   OR (p_worker-'runtime') IS DISTINCT FROM r.manifest THEN RETURN false; END IF;
 IF current_id=p_deployment THEN RETURN r.worker=p_worker; END IF;
 IF r.predecessor IS DISTINCT FROM current_id THEN RETURN false; END IF;
 SELECT worker INTO old_worker FROM private.energy_learning_releases WHERE deployment=current_id;
 UPDATE private.energy_learning_releases SET worker=p_worker WHERE deployment=p_deployment;
 UPDATE private.energy_learning_dispatch SET active=p_deployment WHERE singleton;
 UPDATE private.energy_learning_jobs SET generation=generation+1,fence=fence+1,lease_until=NULL,wake_after=now(),
   input=input||jsonb_build_object('learner_version',p_worker->>'learner_version'),attempts=0,last_error=NULL,finished_at=NULL
 WHERE pending AND owner_kind='room' AND (input->>'learner_version' IS DISTINCT FROM p_worker->>'learner_version'
   OR (old_worker IS NOT NULL AND old_worker IS DISTINCT FROM p_worker));
 PERFORM private.refill_energy_learning_work();
 RETURN true;
END; $$;

-- Qualify supplied owners separately from the loop variable when discovering observed rooms.
CREATE OR REPLACE FUNCTION public.request_energy_device_learning(p_home_id uuid,p_customer_id uuid,p_owners jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE o jsonb; v_id uuid; n integer:=0; due boolean; heating_bindings jsonb; target_version text;
BEGIN
  IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
  IF jsonb_typeof(p_owners) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid learning owners'; END IF;
  -- Complete durable ownership includes passive observed graph nodes, but does
  -- not change the app's controllable-device roster or planning permissions.
  p_owners:=p_owners||coalesce((SELECT jsonb_agg(jsonb_build_object('kind','room','key',c.room_key,
    'input',coalesce((SELECT supplied.owner->'input' FROM jsonb_array_elements(p_owners) AS supplied(owner) WHERE supplied.owner->>'kind'='room' LIMIT 1),'{}'::jsonb)))
    FROM private.energy_room_observed_contexts(p_home_id,false) c
    WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(p_owners) AS supplied(owner)
      WHERE supplied.owner->>'kind'='room' AND supplied.owner->>'key'=c.room_key)),'[]'::jsonb);
  -- Normalize after discovery so passive-only captures also use the active target.
  PERFORM pg_advisory_xact_lock_shared(155367,1);
  SELECT manifest->>'learner_version' INTO target_version FROM private.energy_learning_releases r
    JOIN private.energy_learning_dispatch d ON d.active=r.deployment;
  IF target_version IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(CASE WHEN value->>'kind'='room' THEN value||jsonb_build_object('input',
      coalesce(value->'input','{}'::jsonb)||jsonb_build_object('learner_version',target_version)) ELSE value END ORDER BY ord),'[]'::jsonb)
    INTO p_owners FROM jsonb_array_elements(p_owners) WITH ORDINALITY AS owners(value,ord);
  END IF;
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
        OR (heating_bindings ? (o->>'key') AND heating_bands->>'calibration_policy' IS DISTINCT FROM 'measured_room_runs_v1')
        OR (heating_bindings ? (o->>'key') AND heating_bands#>>'{shared_attempt,implementation}' IS DISTINCT FROM
          'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1')
        OR (heating_bindings ? (o->>'key') AND heating_bands IS NOT NULL
          AND heating_bands->>'binding' IS DISTINCT FROM heating_bindings->>(o->>'key'))
        -- A fit made by another room learner is refitted on the next upload.
        OR (heating_bindings ? (o->>'key') AND heating_bands IS NOT NULL AND o->'input' ? 'learner_version'
          AND heating_bands#>>'{shared_attempt,learner_version}' IS DISTINCT FROM o->'input'->>'learner_version')
        OR (trained AND NOT (heating_bindings ? (o->>'key'))
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

CREATE OR REPLACE FUNCTION public.request_energy_stale_room_refits(p_home_id uuid,p_learner_version text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE v_id uuid; n integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(155367,1);
  SELECT coalesce((SELECT r.manifest->>'learner_version' FROM private.energy_learning_releases r
    JOIN private.energy_learning_dispatch d ON d.active=r.deployment),p_learner_version) INTO p_learner_version;
  IF coalesce(p_learner_version,'')='' THEN RAISE EXCEPTION 'Invalid room learner version'; END IF;
  FOR v_id IN SELECT j.id FROM private.energy_learning_jobs j
    JOIN public.energy_optimisation_zone_models m ON m.home_id=j.home_id AND m.room_key=j.owner_key
    WHERE j.home_id=p_home_id AND j.owner_kind='room' AND m.heating_bands IS NOT NULL
      AND m.heating_bands#>>'{shared_attempt,learner_version}' IS DISTINCT FROM p_learner_version
      AND NOT (j.pending AND j.input->>'learner_version' IS NOT DISTINCT FROM p_learner_version)
    ORDER BY j.owner_key
  LOOP
    UPDATE private.energy_learning_jobs SET pending=true,generation=generation+1,fence=fence+1,
      input=input||jsonb_build_object('learner_version',p_learner_version),lease_until=NULL,wake_after=now(),
      attempts=0,last_error=NULL,finished_at=NULL
    WHERE id=v_id AND NOT (pending AND input->>'learner_version' IS NOT DISTINCT FROM p_learner_version);
    IF NOT FOUND THEN CONTINUE; END IF;
    PERFORM private.wake_energy_learning_job(v_id);
    n:=n+1;
  END LOOP;
  RETURN n;
END; $$;

ALTER FUNCTION public.claim_energy_device_learning(uuid) SET SCHEMA private;
CREATE FUNCTION public.claim_energy_device_learning(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
BEGIN
 IF EXISTS(SELECT FROM private.energy_learning_jobs WHERE id=p_job_id AND owner_kind='room') THEN
   IF NOT pg_try_advisory_xact_lock_shared(155367,1)
     OR EXISTS(SELECT FROM private.energy_learning_dispatch WHERE active IS NOT NULL) THEN RETURN NULL; END IF;
 END IF;
 RETURN private.claim_energy_device_learning(p_job_id);
END; $$;

CREATE FUNCTION public.claim_energy_learning_work(p_job_id uuid,p_worker jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; t private.energy_learning_tickets%ROWTYPE;
 progress jsonb; revision bigint; current_class text; receipt jsonb;
BEGIN
 IF EXISTS(SELECT FROM private.energy_learning_jobs WHERE id=p_job_id AND owner_kind<>'room') THEN
   receipt:=private.claim_energy_device_learning(p_job_id);
   RETURN receipt||jsonb_build_object('work_class','device','ticket',NULL,'queue_ms',NULL);
 END IF;
 IF NOT pg_try_advisory_xact_lock_shared(155367,1) OR NOT EXISTS(
   SELECT FROM private.energy_learning_dispatch d JOIN private.energy_learning_releases r ON r.deployment=d.active
   WHERE r.worker=p_worker) THEN RETURN NULL; END IF;
 SELECT * INTO t FROM private.energy_learning_tickets WHERE job_id=p_job_id AND fence IS NULL AND expires_at>now()
 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO j FROM private.energy_learning_jobs WHERE id=p_job_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT private.energy_learning_work_class(p) INTO current_class FROM private.energy_room_fit_progress p WHERE job_id=j.id;
 IF NOT j.pending OR j.generation<>t.generation OR j.input->>'learner_version' IS DISTINCT FROM p_worker->>'learner_version'
   OR j.lease_until>now() OR j.wake_after>now() OR coalesce(current_class,'source')<>t.work_class THEN
   DELETE FROM private.energy_learning_tickets WHERE slot=t.slot;
   PERFORM private.refill_energy_learning_work();
   RETURN NULL;
 END IF;
 SELECT model_revision INTO revision FROM public.energy_optimisation_zone_models
 WHERE home_id=j.home_id AND room_key=j.owner_key FOR SHARE;
 DELETE FROM private.energy_room_fit_progress p WHERE p.job_id=j.id
 AND (p.generation<>j.generation OR p.base_revision<>coalesce(revision,0)
   OR p.metadata->>'version' IS DISTINCT FROM '6'
   OR p.metadata#>>'{capture,implementation}' IS DISTINCT FROM
     'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1'
   OR NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(j.home_id) c
      WHERE c.room_key=j.owner_key AND c.binding=p.metadata#>>'{capture,binding}'));
 IF FOUND THEN
   -- This ticket was reserved for a frozen capture. Let source admission own
   -- the next read, even when capacity is otherwise available in this request.
   DELETE FROM private.energy_learning_tickets WHERE slot=t.slot;
   PERFORM private.refill_energy_learning_work();
   RETURN NULL;
 END IF;
 UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=now()+interval '60 seconds',
   wake_after=now()+interval '60 seconds',attempts=attempts+1,room_last_started_at=now()
 WHERE id=j.id RETURNING * INTO j;
 UPDATE private.energy_learning_tickets SET fence=j.fence,expires_at=j.lease_until WHERE slot=t.slot;
 SELECT jsonb_build_object('metadata',p.metadata,'cells',p.cells,
   'cursor',CASE WHEN p.metadata ? 'heat_state' THEN p.adaptive_cursor ELSE jsonb_array_length(p.cells) END,
   'base_revision',p.base_revision) INTO progress FROM private.energy_room_fit_progress p WHERE p.job_id=j.id;
 -- Statement arrival excludes the execution time of this claim RPC.
 RETURN to_jsonb(j)||jsonb_build_object('work_class',t.work_class,'ticket',t.slot,'room_fit_progress',progress,
   'queue_ms',greatest(0,floor(extract(epoch FROM statement_timestamp()-t.queued_at)*1000))::bigint);
END; $$;

CREATE FUNCTION public.release_energy_learning_work(p_job_id uuid,p_generation bigint,p_fence bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
BEGIN
 DELETE FROM private.energy_learning_tickets WHERE job_id=p_job_id AND generation=p_generation AND fence=p_fence;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.refill_energy_learning_work();
 RETURN true;
END; $$;

REVOKE ALL ON FUNCTION private.wake_serial_energy_learning_job(uuid),private.wake_energy_learning_job(uuid),
 private.refill_energy_learning_work(),private.energy_learning_work_class(private.energy_room_fit_progress),
 private.claim_energy_device_learning(uuid),public.prepare_energy_learning_release(bigint,jsonb),
 public.activate_energy_learning_release(bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.claim_energy_device_learning(uuid),public.claim_energy_learning_work(uuid,jsonb),
 public.release_energy_learning_work(uuid,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_energy_learning_release(bigint,jsonb),
 public.activate_energy_learning_release(bigint,jsonb),public.claim_energy_device_learning(uuid),public.claim_energy_learning_work(uuid,jsonb),
 public.release_energy_learning_work(uuid,bigint,bigint) TO service_role;
