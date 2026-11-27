-- The existing room job owns exactly one advancing replica at a time. Other
-- replicas, including completed ones, stay in the database until publication.
CREATE TABLE private.energy_room_fit_replicas (
 job_id uuid NOT NULL REFERENCES private.energy_room_fit_progress(job_id) ON DELETE CASCADE,
 replica integer NOT NULL CHECK (replica BETWEEN 0 AND 3),
 row_cursor integer NOT NULL CHECK (row_cursor>=0),
 done boolean NOT NULL,
 checkpoint bytea NOT NULL CHECK (octet_length(checkpoint)>0),
 PRIMARY KEY(job_id,replica)
);
ALTER TABLE private.energy_room_fit_replicas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_room_fit_replicas FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE private.energy_room_fit_progress ADD COLUMN adaptive_product jsonb;
-- Native fixed-width rows can be sliced directly from TOAST, even on very wide
-- or sparse archives. Already captured bytes retain their original encoding.
ALTER TABLE private.energy_room_fit_progress ALTER COLUMN capture SET STORAGE EXTERNAL;

-- A fast, narrow receiver can finish more than 32 rows within one numerical
-- budget. The same exclusive end bounds the read and the owner's checkpoint.
CREATE FUNCTION private.room_fit_page_end(first_row integer,total_rows integer) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT least(first_row+128,total_rows)
$$;

CREATE FUNCTION private.room_fit_replica_payload(r private.energy_room_fit_replicas) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('index',r.replica,'row',r.row_cursor,'done',r.done,
   'blob',replace(encode(r.checkpoint,'base64'),E'\n',''))
$$;

CREATE FUNCTION private.room_fit_work_payload(j private.energy_learning_jobs,p_final boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,private,public AS $$
DECLARE p private.energy_room_fit_progress%ROWTYPE; lane private.energy_room_fit_replicas%ROWTYPE;
 receipt jsonb; envelope jsonb; reference jsonb; process jsonb; window_bytes bytea;
 header integer; stride integer; total integer; connected boolean; has_reference boolean;
BEGIN
 SELECT * INTO p FROM private.energy_room_fit_progress WHERE job_id=j.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 receipt:=jsonb_build_object('cursor',CASE WHEN p.metadata ? 'heat_state' THEN p.adaptive_cursor ELSE jsonb_array_length(p.cells) END,
   'base_revision',p.base_revision);
 IF p.adaptive_product->>'kind'='start_process' AND NOT p_final THEN
   SELECT * INTO STRICT lane FROM private.energy_room_fit_replicas WHERE job_id=j.id AND NOT done ORDER BY replica LIMIT 1;
   header:=(p.metadata->>'header_bytes')::integer; stride:=(p.metadata->>'row_bytes')::integer;
   total:=(p.metadata->>'row_count')::integer;
   window_bytes:=substring(p.capture FROM 1 FOR header)
     ||substring(p.capture FROM 1+header+lane.row_cursor*stride FOR (private.room_fit_page_end(lane.row_cursor,total)-lane.row_cursor)*stride);
   RETURN receipt||jsonb_build_object('process',jsonb_build_object('kind','replica',
     'model',p.adaptive_product#>'{shared,result,response}','priors',p.adaptive_product#>'{shared,priors}',
     'replica',private.room_fit_replica_payload(lane),'window',jsonb_build_object(
       'base64',replace(encode(window_bytes,'base64'),E'\n',''),'sha256',encode(sha256(window_bytes),'hex'),
       'from_at',p.metadata#>>'{capture,fromAt}','row_from',lane.row_cursor,'total_rows',total)));
 END IF;
 envelope:=p.metadata;
 connected:=coalesce((envelope#>>'{capture,connected,observedOnly}')::boolean,false)
   OR coalesce(jsonb_array_length(envelope#>'{capture,connected,peerKeys}'),0)>0;
 IF connected THEN
   -- Older progress stored a normalized reference and the original JSON. The
   -- publication owner already freezes that exact reference by model revision.
   has_reference:=coalesce((envelope->>'has_accepted_reference')::boolean,
     (envelope->'capture') ? 'acceptedReference',false);
   envelope:=envelope#-'{capture,acceptedReference}'#-'{capture,library,reference}';
   IF p_final AND has_reference AND (
     (p.adaptive_product IS NULL AND p.metadata#>'{heat_state,result,response}'='null'::jsonb) OR
     (p.adaptive_product->>'kind'='result' AND p.adaptive_product#>'{result,response}'='null'::jsonb)) THEN
     SELECT heating_bands->'reference' INTO STRICT reference FROM public.energy_optimisation_zone_models
       WHERE home_id=j.home_id AND room_key=j.owner_key AND model_revision=p.base_revision
         AND heating_bands->>'binding'=envelope#>>'{capture,binding}' AND heating_bands ? 'reference';
     envelope:=jsonb_set(envelope,'{capture,library,reference}',reference);
   END IF;
 END IF;
 IF p.adaptive_product->>'kind'='start_process' THEN
   SELECT jsonb_build_object('kind','finish','shared',p.adaptive_product->'shared',
     'replicas',jsonb_agg(private.room_fit_replica_payload(r) ORDER BY r.replica)) INTO process
     FROM private.energy_room_fit_replicas r WHERE r.job_id=j.id HAVING count(*)=4 AND bool_and(done);
   IF process IS NULL THEN RAISE EXCEPTION 'Incomplete connected room replicas'; END IF;
 ELSIF p.adaptive_product->>'kind'='result' THEN
   process:=p.adaptive_product;
 END IF;
 RETURN receipt||jsonb_build_object('metadata',envelope,'cells',p.cells,
   'capture_base64',replace(encode(p.capture,'base64'),E'\n',''))
   ||CASE WHEN process IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('process',process) END;
END; $$;

CREATE FUNCTION public.checkpoint_energy_room_fit_turn(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_turn jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE p private.energy_room_fit_progress%ROWTYPE; kind text:=p_turn->>'kind'; lane jsonb; total integer;
 stage text; active integer; next_row integer; header integer; stride integer; bytes integer;
 next_metadata jsonb; next_product jsonb;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT * INTO p FROM private.energy_room_fit_progress WHERE job_id=p_job_id AND generation=p_generation
   AND base_revision=p_revision AND adaptive_cursor=p_expected_cursor AND metadata->>'version'='6'
   AND jsonb_array_length(cells)=0 FOR UPDATE;
 IF NOT FOUND OR p.metadata#>>'{heat_state,stage}'='complete' THEN RETURN false; END IF;
 total:=(p.metadata->>'row_count')::integer;
 IF NOT (coalesce((p.metadata#>>'{capture,connected,observedOnly}')::boolean,false) OR
   coalesce(jsonb_array_length(p.metadata#>'{capture,connected,peerKeys}'),0)>0) THEN RETURN false; END IF;
 IF kind='replica' THEN
   IF p.adaptive_product->>'kind' IS DISTINCT FROM 'start_process' THEN RETURN false; END IF;
   SELECT replica INTO active FROM private.energy_room_fit_replicas WHERE job_id=p_job_id AND NOT done ORDER BY replica LIMIT 1;
   lane:=p_turn->'replica'; next_row:=(lane->>'row')::integer;
   IF active IS NULL OR active IS DISTINCT FROM (lane->>'index')::integer THEN RETURN false; END IF;
   IF jsonb_typeof(lane->'done') IS DISTINCT FROM 'boolean' OR next_row IS NULL OR next_row>total
     OR ((lane->>'done')::boolean IS DISTINCT FROM (next_row=total)) THEN RAISE EXCEPTION 'Invalid room fit replica progress'; END IF;
   UPDATE private.energy_room_fit_replicas SET row_cursor=next_row,done=(lane->>'done')::boolean,
     checkpoint=decode(lane->>'blob','base64') WHERE job_id=p_job_id AND replica=active AND row_cursor<=next_row
       AND next_row<=private.room_fit_page_end(row_cursor,total);
   IF NOT FOUND THEN RETURN false; END IF;
   IF NOT EXISTS(SELECT FROM private.energy_room_fit_replicas WHERE job_id=p_job_id AND NOT done) THEN stage:='complete'; END IF;
 ELSIF p.adaptive_product IS NOT NULL THEN RETURN false;
 ELSIF kind='optimizer' THEN
   stage:=p_turn#>>'{state,stage}';
   IF p_turn#>>'{state,version}' IS DISTINCT FROM '1' OR stage IS NULL
     OR stage NOT IN ('static','adaptive','validation_static','validation_adaptive','full','posterior')
     THEN RAISE EXCEPTION 'Invalid connected room optimizer'; END IF;
   next_metadata:=jsonb_set(p.metadata,'{heat_state}',p_turn->'state');
   stage:=NULL;
 ELSIF kind='result' THEN
   IF jsonb_typeof(p_turn->'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid connected room result'; END IF;
   next_product:=p_turn;
   stage:='complete';
 ELSIF kind='start_process' THEN
   IF total IS NULL OR total<1 OR jsonb_typeof(p_turn#>'{shared,result,response}') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_turn#>'{shared,priors}') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_turn->'replicas') IS DISTINCT FROM 'array' OR jsonb_array_length(p_turn->'replicas')<>4
     THEN RAISE EXCEPTION 'Invalid connected room process'; END IF;
   -- Certify the immutable full source once before issuing any independent
   -- windows, including a compatible continuation captured by the old worker.
   bytes:=octet_length(p.capture);
   IF bytes<6 OR encode(sha256(p.capture),'hex') IS DISTINCT FROM p.metadata->>'sha256' THEN
     RAISE EXCEPTION 'Invalid connected room source digest'; END IF;
   header:=4+get_byte(p.capture,0)+256*get_byte(p.capture,1)+65536*get_byte(p.capture,2)+16777216*get_byte(p.capture,3);
   IF header<6 OR header>=bytes OR (bytes-header)%total<>0 THEN RAISE EXCEPTION 'Invalid connected room source layout'; END IF;
   stride:=(bytes-header)/total;
   IF (p.metadata ? 'header_bytes' AND (p.metadata->>'header_bytes')::integer IS DISTINCT FROM header)
     OR (p.metadata ? 'row_bytes' AND (p.metadata->>'row_bytes')::integer IS DISTINCT FROM stride)
     THEN RAISE EXCEPTION 'Invalid connected room source layout'; END IF;
   FOR lane IN SELECT value FROM jsonb_array_elements(p_turn->'replicas') LOOP
     next_row:=(lane->>'row')::integer;
     IF jsonb_typeof(lane->'done') IS DISTINCT FROM 'boolean' OR next_row>total OR ((lane->>'done')::boolean IS DISTINCT FROM (next_row=total))
       THEN RAISE EXCEPTION 'Invalid initial room fit replica'; END IF;
     INSERT INTO private.energy_room_fit_replicas VALUES(p_job_id,(lane->>'index')::integer,next_row,(lane->>'done')::boolean,decode(lane->>'blob','base64'));
   END LOOP;
   next_product:=p_turn-'replicas';
   next_metadata:=(p.metadata#-'{capture,acceptedReference}'#-'{capture,library,reference}') ||
       jsonb_build_object('header_bytes',header,'row_bytes',stride,'has_accepted_reference',
         coalesce((p.metadata->>'has_accepted_reference')::boolean,(p.metadata->'capture') ? 'acceptedReference',false));
   stage:=CASE WHEN EXISTS(SELECT FROM private.energy_room_fit_replicas WHERE job_id=p_job_id AND NOT done)
     THEN 'process_posterior' ELSE 'complete' END;
 ELSE RAISE EXCEPTION 'Invalid connected room fit turn'; END IF;
 IF stage IS NOT NULL THEN
   next_metadata:=jsonb_set(coalesce(next_metadata,p.metadata),'{heat_state}',jsonb_build_object('stage',stage));
 END IF;
 UPDATE private.energy_room_fit_progress SET adaptive_cursor=adaptive_cursor+1,
   metadata=coalesce(next_metadata,metadata),adaptive_product=coalesce(next_product,adaptive_product)
   WHERE job_id=p_job_id;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION private.room_fit_page_end(integer,integer),private.room_fit_replica_payload(private.energy_room_fit_replicas),
 private.room_fit_work_payload(private.energy_learning_jobs,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.checkpoint_energy_room_fit_turn(uuid,bigint,bigint,bigint,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_energy_room_fit_turn(uuid,bigint,bigint,bigint,integer,jsonb) TO service_role;

-- The SQL migration is deployed before the Edge function. Old in-flight jobs
-- finish under their existing lease; the new worker claims its new wire only
-- after capability verification and activation. The mathematical model is identical.
CREATE OR REPLACE FUNCTION public.prepare_energy_learning_release(p_deployment bigint,p_manifest jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE predecessor bigint; previous jsonb;
BEGIN
 SELECT active INTO predecessor FROM private.energy_learning_dispatch WHERE singleton FOR UPDATE;
 IF p_manifest IS NULL OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
   OR coalesce(p_manifest->'protocol','null'::jsonb) NOT IN ('2'::jsonb,'3'::jsonb) OR p_manifest->'progress_version' IS DISTINCT FROM '6'::jsonb
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

CREATE OR REPLACE FUNCTION public.activate_energy_learning_release(p_deployment bigint,p_worker jsonb) RETURNS boolean
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
 -- A numeric replica checkpoint written by protocol 3 has no protocol-2 reader.
 IF old_worker->>'protocol'='3' AND p_worker->>'protocol'='2' THEN RETURN false; END IF;
 UPDATE private.energy_learning_releases SET worker=p_worker WHERE deployment=p_deployment;
 UPDATE private.energy_learning_dispatch SET active=p_deployment WHERE singleton;
 UPDATE private.energy_learning_jobs SET generation=generation+1,fence=fence+1,lease_until=NULL,wake_after=now(),
   input=input||jsonb_build_object('learner_version',p_worker->>'learner_version'),attempts=0,last_error=NULL,finished_at=NULL
 WHERE pending AND owner_kind='room' AND (input->>'learner_version' IS DISTINCT FROM p_worker->>'learner_version'
   OR (old_worker IS NOT NULL AND (old_worker-'protocol') IS DISTINCT FROM (p_worker-'protocol')));
 PERFORM private.refill_energy_learning_work();
 RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_energy_learning_work(p_job_id uuid,p_worker jsonb) RETURNS jsonb
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
   OR (p_worker->>'protocol'='3' AND (p.metadata->>'runtime' IS DISTINCT FROM p_worker->>'runtime' OR
       p.metadata->>'learner_version' IS DISTINCT FROM p_worker->>'learner_version' OR
       (NOT (p.metadata ? 'has_accepted_reference') AND p.metadata#>'{capture,library,reference}' IS NOT NULL AND
         p.metadata#>'{capture,library,reference}'<>'null'::jsonb AND NOT ((p.metadata->'capture') ? 'acceptedReference'))))
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
 IF p_worker->>'protocol'='3' THEN
   progress:=private.room_fit_work_payload(j,t.work_class='finalization');
 ELSE
 SELECT jsonb_build_object('metadata',p.metadata,'cells',p.cells,
   'cursor',CASE WHEN p.metadata ? 'heat_state' THEN p.adaptive_cursor ELSE jsonb_array_length(p.cells) END,
   'base_revision',p.base_revision) INTO progress FROM private.energy_room_fit_progress p WHERE p.job_id=j.id;
 END IF;
 -- Statement arrival excludes the execution time of this claim RPC.
 RETURN to_jsonb(j)||jsonb_build_object('work_class',t.work_class,'ticket',t.slot,'room_fit_progress',progress,
   'queue_ms',greatest(0,floor(extract(epoch FROM statement_timestamp()-t.queued_at)*1000))::bigint);
END; $$;

-- Source acquisition needs just this receiver's accepted calibration and
-- history-aware context. Both reads share the same statement snapshot.
CREATE FUNCTION public.capture_energy_room_learning_context(p_home_id uuid,p_room_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 SELECT jsonb_build_object('model',(SELECT jsonb_build_object('model_revision',m.model_revision,
   'room_name',m.room_name,'room_key',m.room_key,'heating_bands',m.heating_bands)
   FROM public.energy_optimisation_zone_models m WHERE m.home_id=p_home_id AND m.room_key=p_room_key),
   'context',public.get_energy_room_heating_context(p_home_id,p_room_key))
$$;
REVOKE ALL ON FUNCTION public.capture_energy_room_learning_context(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.capture_energy_room_learning_context(uuid,text) TO service_role;
