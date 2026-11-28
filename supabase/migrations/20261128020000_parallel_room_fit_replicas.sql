-- Protocol 5 assigns the existing two physical slots to independent numerical
-- replicas when no other owner can use them. Mathematical packets are unchanged.
SET lock_timeout='5s';
ALTER TABLE private.energy_learning_tickets DROP CONSTRAINT energy_learning_tickets_job_id_key,
 ADD COLUMN replica integer CHECK(replica BETWEEN 0 AND 3),
 ADD COLUMN process_epoch uuid,
 ADD CONSTRAINT energy_learning_replica_identity CHECK((replica IS NULL)=(process_epoch IS NULL));
CREATE UNIQUE INDEX energy_learning_exclusive_owner ON private.energy_learning_tickets(job_id) WHERE replica IS NULL;
CREATE UNIQUE INDEX energy_learning_replica_owner ON private.energy_learning_tickets(job_id,generation,process_epoch,replica) WHERE replica IS NOT NULL;
ALTER TABLE private.energy_room_fit_progress ADD COLUMN process_epoch uuid;
ALTER TABLE private.energy_room_fit_replicas ADD COLUMN sequence bigint NOT NULL DEFAULT 0,
 ADD COLUMN wake_after timestamptz NOT NULL DEFAULT now(), ADD COLUMN last_error text;
RESET lock_timeout;

CREATE OR REPLACE FUNCTION public.checkpoint_energy_room_fit_turn(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
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
 IF p_turn ? 'numeric_packet' AND NOT (p.metadata ? 'numeric_packet') THEN
   IF jsonb_typeof(p_turn->'numeric_packet') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid room numerical packet'; END IF;
   p.metadata:=p.metadata||jsonb_build_object('numeric_packet',p_turn->'numeric_packet');
   next_metadata:=p.metadata;
 END IF;
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
     INSERT INTO private.energy_room_fit_replicas(job_id,replica,row_cursor,done,checkpoint) VALUES(p_job_id,(lane->>'index')::integer,next_row,(lane->>'done')::boolean,decode(lane->>'blob','base64'));
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

CREATE OR REPLACE FUNCTION private.recover_energy_learning_delivery(p_delivery uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,private,public AS $$
DECLARE t private.energy_learning_tickets%ROWTYPE; j private.energy_learning_jobs%ROWTYPE;
BEGIN
 SELECT * INTO t FROM private.energy_learning_tickets WHERE delivery_id=p_delivery FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO j FROM private.energy_learning_jobs WHERE id=t.job_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN false; END IF;
 IF t.replica IS NULL AND t.fence IS NOT NULL AND j.pending AND j.generation=t.generation AND j.fence=t.fence THEN
   UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=NULL,wake_after=clock_timestamp()
     WHERE id=j.id;
 END IF;
 DELETE FROM private.energy_learning_tickets WHERE delivery_id=t.delivery_id;
 RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.release_energy_learning_work(p_job_id uuid,p_generation bigint,p_fence bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
BEGIN
 DELETE FROM private.energy_learning_tickets WHERE job_id=p_job_id AND generation=p_generation AND fence=p_fence AND replica IS NULL;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.refill_energy_learning_work();
 RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.prepare_energy_learning_release(p_deployment bigint,p_manifest jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE predecessor bigint; previous jsonb;
BEGIN
 SELECT active INTO predecessor FROM private.energy_learning_dispatch WHERE singleton FOR UPDATE;
 IF p_manifest IS NULL OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
   OR coalesce(p_manifest->'protocol','null'::jsonb) NOT IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb) OR p_manifest->'progress_version' IS DISTINCT FROM '6'::jsonb
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
 IF (old_worker->>'protocol' IN ('3','4','5') AND p_worker->>'protocol'='2')
   OR (old_worker->>'protocol'='5' AND p_worker->>'protocol'<>'5') THEN RETURN false; END IF;
 UPDATE private.energy_learning_releases SET worker=p_worker WHERE deployment=p_deployment;
 UPDATE private.energy_learning_dispatch SET active=p_deployment WHERE singleton;
 IF p_worker->>'protocol' IN ('4','5') AND p_worker->>'protocol' IS DISTINCT FROM old_worker->>'protocol' THEN
   -- Unclaimed old wakes cannot acquire under the new worker capability. Owned
   -- invocations retain their physical ticket until their exact finally/expiry.
   DELETE FROM private.energy_learning_tickets WHERE fence IS NULL;
 END IF;
 UPDATE private.energy_learning_jobs SET generation=generation+1,fence=fence+1,lease_until=NULL,wake_after=now(),
   input=input||jsonb_build_object('learner_version',p_worker->>'learner_version'),attempts=0,last_error=NULL,finished_at=NULL
 WHERE pending AND owner_kind='room' AND (input->>'learner_version' IS DISTINCT FROM p_worker->>'learner_version'
   OR (old_worker IS NOT NULL AND (old_worker-'protocol') IS DISTINCT FROM (p_worker-'protocol')));
 PERFORM private.refill_energy_learning_work();
 RETURN true;
END; $$;

CREATE FUNCTION private.claim_exclusive_energy_learning_work(p_job_id uuid,p_worker jsonb) RETURNS jsonb
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
 SELECT * INTO t FROM private.energy_learning_tickets WHERE job_id=p_job_id AND replica IS NULL AND fence IS NULL AND expires_at>now()
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
   OR (p_worker->>'protocol' IN ('3','4','5') AND (p.metadata->>'runtime' IS DISTINCT FROM p_worker->>'runtime' OR
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
 IF p_worker->>'protocol' IN ('4','5') THEN
   progress:=private.room_fit_work_payload_v4(j,t.work_class='finalization');
 ELSIF p_worker->>'protocol'='3' THEN
   progress:=private.room_fit_work_payload(j,t.work_class='finalization');
 ELSE
 SELECT jsonb_build_object('metadata',p.metadata,'cells',p.cells,
   'cursor',CASE WHEN p.metadata ? 'heat_state' THEN p.adaptive_cursor ELSE jsonb_array_length(p.cells) END,
   'base_revision',p.base_revision) INTO progress FROM private.energy_room_fit_progress p WHERE p.job_id=j.id;
 END IF;
 -- Statement arrival excludes the execution time of this claim RPC.
 RETURN to_jsonb(j)||jsonb_build_object('work_class',t.work_class,'ticket',t.slot,'room_fit_progress',progress,
   'delivery_id',CASE WHEN p_worker->>'protocol'='5' THEN t.delivery_id ELSE NULL END,
   'queue_ms',greatest(0,floor(extract(epoch FROM statement_timestamp()-t.queued_at)*1000))::bigint);
END; $$;

-- Direct legacy claims cannot select a sibling by job ID. Only the combined,
-- authenticated delivery entry point can enter the protocol-5 room path.
CREATE OR REPLACE FUNCTION public.claim_energy_learning_work(p_job_id uuid,p_worker jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
BEGIN
 IF p_worker->>'protocol'='5' AND EXISTS(SELECT FROM private.energy_learning_jobs WHERE id=p_job_id AND owner_kind='room') THEN RETURN NULL; END IF;
 RETURN private.claim_exclusive_energy_learning_work(p_job_id,p_worker);
END; $$;

CREATE OR REPLACE FUNCTION public.claim_energy_learning_dispatch(p_run_fence bigint,p_worker jsonb,p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE d private.energy_learning_dispatch%ROWTYPE; url text;
BEGIN
 IF NOT public.verify_energy_learning_token(p_token) THEN RETURN 'false'::jsonb; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(155367,1) OR NOT pg_try_advisory_xact_lock(155367,2) THEN RETURN NULL; END IF;
 SELECT * INTO d FROM private.energy_learning_dispatch WHERE singleton AND run_fence=p_run_fence
   AND run_state='queued' AND run_until>clock_timestamp() FOR UPDATE SKIP LOCKED;
 IF NOT FOUND OR NOT EXISTS(SELECT FROM private.energy_learning_releases WHERE deployment=d.active AND worker=p_worker AND worker->>'protocol' IN ('4','5')) THEN RETURN NULL; END IF;
 UPDATE private.energy_learning_dispatch SET run_state='active',run_until=clock_timestamp()+interval '60 seconds' WHERE singleton;
 SELECT function_url INTO STRICT url FROM private.energy_learning_credentials WHERE singleton;
 RETURN jsonb_build_object('run_fence',d.run_fence,'worker_url',url);
END; $$;

CREATE OR REPLACE FUNCTION private.refill_energy_learning_work() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,private,public AS $$
DECLARE target record; free_slot integer; available integer; c private.energy_learning_credentials%ROWTYPE;
 dispatch private.energy_learning_dispatch%ROWTYPE; delivery uuid; response record; request bigint; epoch uuid;
BEGIN
 -- A wake can run while its caller holds arbitrary job rows. Never wait on
 -- another allocator, job, ticket or release pointer from this path. The
 -- reservation is a hint revalidated under the actual claim's job lock.
 IF NOT pg_try_advisory_xact_lock(155367,2) THEN RETURN; END IF;
 -- At most two recorded deliveries. An ambiguous network timeout retains its lease.
 FOR response IN SELECT t.delivery_id FROM private.energy_learning_tickets t
   LEFT JOIN net._http_response r ON r.id=t.request_id AND r.created>=now()-interval '2 minutes' WHERE r.status_code=546 OR t.terminal_status=546 LOOP
   PERFORM private.recover_energy_learning_delivery(response.delivery_id);
 END LOOP;
 SELECT * INTO dispatch FROM private.energy_learning_dispatch WHERE singleton FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 IF dispatch.run_request_id IS NOT NULL AND EXISTS(SELECT FROM net._http_response WHERE id=dispatch.run_request_id AND created>=now()-interval '2 minutes'
   AND status_code IS NOT NULL AND NOT coalesce(timed_out,false)) THEN
   UPDATE private.energy_learning_dispatch SET run_fence=run_fence+1,run_state='idle',run_until=NULL,run_request_id=NULL WHERE singleton;
   dispatch.run_state:='idle'; dispatch.run_until:=NULL;
 END IF;
 DELETE FROM private.energy_learning_tickets WHERE slot IN (
   SELECT slot FROM private.energy_learning_tickets WHERE expires_at<=now() FOR UPDATE SKIP LOCKED);
 SELECT d.capacity-(SELECT count(*) FROM private.energy_learning_tickets)
   -(SELECT count(*) FROM private.energy_room_learning_lanes WHERE lease_until>now())
 INTO available FROM private.energy_learning_dispatch d WHERE d.active IS NOT NULL;
 IF available IS NULL THEN RETURN; END IF;
 SELECT * INTO STRICT c FROM private.energy_learning_credentials WHERE singleton;
 FOR free_slot IN SELECT s FROM generate_series(1,2) s
   WHERE NOT EXISTS(SELECT FROM private.energy_learning_tickets t WHERE t.slot=s)
   ORDER BY s LIMIT greatest(0,available) LOOP
   SELECT j.id,j.home_id,j.generation,k.work_class,p.process_epoch,lane.replica INTO target
   FROM private.energy_learning_jobs j
   JOIN private.energy_learning_dispatch d ON d.singleton
   JOIN private.energy_learning_releases r ON r.deployment=d.active
   LEFT JOIN private.energy_room_fit_progress p ON p.job_id=j.id
   CROSS JOIN LATERAL (SELECT private.energy_learning_work_class(p) AS work_class,
     coalesce(r.worker->>'protocol'='5' AND p.adaptive_product->>'kind'='start_process'
       AND p.metadata#>>'{heat_state,stage}'='process_posterior',false) AS parallel) k
   LEFT JOIN LATERAL (SELECT q.replica FROM private.energy_room_fit_replicas q
     WHERE k.parallel AND q.job_id=j.id AND NOT q.done AND q.wake_after<=now()
       AND NOT EXISTS(SELECT FROM private.energy_learning_tickets t WHERE t.job_id=j.id AND t.replica=q.replica)
     ORDER BY q.replica LIMIT 1) lane ON true
   WHERE j.owner_kind='room' AND j.pending AND j.wake_after<=now() AND (j.lease_until IS NULL OR j.lease_until<=now())
     AND j.input->>'learner_version'=r.manifest->>'learner_version'
     AND (NOT k.parallel OR lane.replica IS NOT NULL)
     AND NOT EXISTS(SELECT FROM private.energy_learning_tickets t WHERE
       (t.job_id=j.id AND (NOT k.parallel OR t.replica IS NULL OR t.generation<>j.generation OR t.process_epoch IS DISTINCT FROM p.process_epoch))
       OR (t.home_id=j.home_id AND t.work_class<>'numerical' AND k.work_class<>'numerical'))
     AND NOT EXISTS(SELECT FROM private.energy_room_learning_lanes l WHERE l.home_id=j.home_id AND l.lease_until>now())
   -- Serve distinct eligible owners before donating a second slot to a sibling.
   ORDER BY EXISTS(SELECT FROM private.energy_learning_tickets t WHERE t.job_id=j.id),
     EXISTS(SELECT FROM private.energy_learning_tickets t WHERE t.home_id=j.home_id),
     j.room_last_started_at NULLS FIRST,j.wake_after,j.id
   LIMIT 1 FOR UPDATE OF j SKIP LOCKED;
   IF NOT FOUND THEN EXIT; END IF;
   epoch:=target.process_epoch;
   IF target.replica IS NOT NULL AND epoch IS NULL THEN
     -- No old physical ticket remains. Fence late legacy writers exactly once,
     -- retaining every earned byte, row, random state and model generation.
     epoch:=gen_random_uuid();
     UPDATE private.energy_learning_jobs SET fence=fence+1 WHERE id=target.id;
     UPDATE private.energy_room_fit_progress SET process_epoch=epoch WHERE job_id=target.id;
   END IF;
   INSERT INTO private.energy_learning_tickets(slot,job_id,home_id,generation,work_class,expires_at,replica,process_epoch)
   VALUES(free_slot,target.id,target.home_id,target.generation,target.work_class,now()+interval '60 seconds',target.replica,
     CASE WHEN target.replica IS NOT NULL THEN epoch END)
   RETURNING delivery_id INTO delivery;
   IF c.function_url IS NULL THEN RAISE EXCEPTION 'Learning endpoint is not configured'; END IF;
   IF EXISTS(SELECT FROM private.energy_learning_releases WHERE deployment=dispatch.active AND worker->>'protocol' IN ('4','5')) THEN CONTINUE; END IF;
   request:=net.http_post(url:=c.function_url,
     headers:=jsonb_build_object('Content-Type','application/json','x-energy-learning-token',c.token),
     body:=jsonb_build_object('job_id',target.id),timeout_milliseconds:=30000);
   UPDATE private.energy_learning_tickets SET request_id=request WHERE delivery_id=delivery;
 END LOOP;
 IF EXISTS(SELECT FROM private.energy_learning_releases WHERE deployment=dispatch.active AND worker->>'protocol' IN ('4','5'))
   AND (dispatch.run_until IS NULL OR dispatch.run_until<=clock_timestamp())
   AND EXISTS(SELECT FROM private.energy_learning_tickets WHERE fence IS NULL AND dispatch_fence IS NULL) THEN
   UPDATE private.energy_learning_dispatch SET run_fence=run_fence+1,run_state='queued',
     run_until=clock_timestamp()+interval '60 seconds',run_request_id=NULL WHERE singleton RETURNING * INTO dispatch;
   request:=net.http_post(url:=regexp_replace(c.function_url,'/energy-device-learning$','/energy-learning-dispatch'),
     headers:=jsonb_build_object('Content-Type','application/json','x-energy-learning-token',c.token),
     body:=jsonb_build_object('run_fence',dispatch.run_fence),timeout_milliseconds:=55000);
   UPDATE private.energy_learning_dispatch SET run_request_id=request WHERE singleton AND run_fence=dispatch.run_fence;
 END IF;
END; $$;

-- A replica owns one live physical delivery, never the job-wide lease. All
-- numerical writers take the job row first, so invalidation and the last-done
-- barrier serialize with them. Ticket locks are nonblocking in this order.
CREATE FUNCTION private.owns_energy_room_fit_replica(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_delivery_id uuid,p_process_epoch uuid,p_expected_sequence bigint) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,private,public AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; p private.energy_room_fit_progress%ROWTYPE;
 t private.energy_learning_tickets%ROWTYPE; revision bigint;
BEGIN
 SELECT * INTO j FROM private.energy_learning_jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR NOT j.pending OR j.owner_kind<>'room' OR j.generation<>p_generation OR j.fence<>p_fence
   OR NOT public.energy_home_matches_customer(j.home_id,j.customer_id) THEN RETURN false; END IF;
 SELECT * INTO p FROM private.energy_room_fit_progress WHERE job_id=j.id FOR UPDATE;
 IF NOT FOUND OR p.generation<>p_generation OR p.base_revision<>p_revision OR p.process_epoch IS DISTINCT FROM p_process_epoch
   OR p.adaptive_product->>'kind' IS DISTINCT FROM 'start_process'
   OR p.metadata#>>'{heat_state,stage}' IS DISTINCT FROM 'process_posterior' THEN RETURN false; END IF;
 SELECT model_revision INTO revision FROM public.energy_optimisation_zone_models
   WHERE home_id=j.home_id AND room_key=j.owner_key FOR SHARE;
 IF coalesce(revision,0)<>p_revision OR NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(j.home_id) c
   WHERE c.room_key=j.owner_key AND c.binding=p.metadata#>>'{capture,binding}') THEN RETURN false; END IF;
 SELECT * INTO t FROM private.energy_learning_tickets WHERE delivery_id=p_delivery_id AND job_id=j.id
   AND generation=p_generation AND fence=p_fence AND process_epoch=p_process_epoch AND replica IS NOT NULL
   AND expires_at>clock_timestamp() FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM private.energy_room_fit_replicas WHERE job_id=j.id AND replica=t.replica
   AND sequence=p_expected_sequence AND NOT done FOR UPDATE;
 RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_energy_learning_request(p_job_id uuid,p_worker jsonb,p_token text,p_delivery_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; t private.energy_learning_tickets%ROWTYPE;
 p private.energy_room_fit_progress%ROWTYPE; lane private.energy_room_fit_replicas%ROWTYPE;
 revision bigint; header integer; stride integer; total integer; window_bytes bytea; progress jsonb;
BEGIN
 IF NOT public.verify_energy_learning_token(p_token) THEN RETURN 'false'::jsonb; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(155367,1) THEN RETURN NULL; END IF;
 IF p_worker->>'protocol' NOT IN ('4','5') OR NOT EXISTS(SELECT FROM private.energy_learning_jobs WHERE id=p_job_id AND owner_kind='room') THEN
   RETURN public.claim_energy_learning_work(p_job_id,p_worker);
 END IF;
 IF NOT EXISTS(SELECT FROM private.energy_learning_dispatch d JOIN private.energy_learning_releases r ON r.deployment=d.active
   WHERE r.worker=p_worker) THEN RETURN NULL; END IF;
 SELECT * INTO t FROM private.energy_learning_tickets WHERE job_id=p_job_id AND delivery_id=p_delivery_id
   AND fence IS NULL AND dispatch_fence IS NOT NULL AND expires_at>clock_timestamp() FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF t.replica IS NULL THEN RETURN private.claim_exclusive_energy_learning_work(p_job_id,p_worker); END IF;
 IF p_worker->>'protocol'<>'5' THEN RETURN NULL; END IF;
 -- Siblings can claim together. Wait for their brief shared job-row update;
 -- skipping it would strand this already-assigned delivery for its full lease.
 -- All job -> ticket paths use SKIP LOCKED, so this cannot form a lock cycle.
 SELECT * INTO j FROM private.energy_learning_jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO p FROM private.energy_room_fit_progress WHERE job_id=j.id FOR UPDATE;
 SELECT model_revision INTO revision FROM public.energy_optimisation_zone_models
   WHERE home_id=j.home_id AND room_key=j.owner_key FOR SHARE;
 IF p.job_id IS NOT NULL AND (p.generation<>j.generation OR p.base_revision<>coalesce(revision,0)
   OR p.metadata->>'version' IS DISTINCT FROM '6' OR p.metadata->>'runtime' IS DISTINCT FROM p_worker->>'runtime'
   OR p.metadata->>'learner_version' IS DISTINCT FROM p_worker->>'learner_version'
   OR NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(j.home_id) c WHERE c.room_key=j.owner_key
     AND c.binding=p.metadata#>>'{capture,binding}')) THEN
   DELETE FROM private.energy_room_fit_progress WHERE job_id=j.id;
   p.job_id:=NULL;
 END IF;
 IF NOT j.pending OR j.generation<>t.generation OR j.input->>'learner_version' IS DISTINCT FROM p_worker->>'learner_version'
   OR j.lease_until>now() OR j.wake_after>now() OR p.job_id IS NULL OR p.process_epoch IS DISTINCT FROM t.process_epoch
   OR p.metadata#>>'{heat_state,stage}' IS DISTINCT FROM 'process_posterior'
   OR p.adaptive_product->>'kind' IS DISTINCT FROM 'start_process' THEN
   DELETE FROM private.energy_learning_tickets WHERE delivery_id=t.delivery_id;
   PERFORM private.refill_energy_learning_work(); RETURN NULL;
 END IF;
 SELECT * INTO lane FROM private.energy_room_fit_replicas WHERE job_id=j.id AND replica=t.replica
   AND NOT done AND wake_after<=now() FOR UPDATE;
 IF NOT FOUND THEN
   DELETE FROM private.energy_learning_tickets WHERE delivery_id=t.delivery_id;
   PERFORM private.refill_energy_learning_work(); RETURN NULL;
 END IF;
 UPDATE private.energy_learning_jobs SET attempts=attempts+1,room_last_started_at=now() WHERE id=j.id RETURNING * INTO j;
 UPDATE private.energy_learning_tickets SET fence=j.fence,expires_at=clock_timestamp()+interval '60 seconds' WHERE delivery_id=t.delivery_id;
 header:=(p.metadata->>'header_bytes')::integer; stride:=(p.metadata->>'row_bytes')::integer; total:=(p.metadata->>'row_count')::integer;
 window_bytes:=substring(p.capture FROM 1 FOR header)
   ||substring(p.capture FROM 1+header+lane.row_cursor*stride FOR (private.room_fit_page_end(lane.row_cursor,total)-lane.row_cursor)*stride);
 progress:=jsonb_build_object('cursor',p.adaptive_cursor,'base_revision',p.base_revision,'process',jsonb_build_object('kind','replica',
   'model',p.adaptive_product#>'{shared,result,response}','priors',p.adaptive_product#>'{shared,priors}',
   'replica',private.room_fit_replica_payload(lane),'window',jsonb_build_object(
     'base64',replace(encode(window_bytes,'base64'),E'\n',''),'sha256',encode(sha256(window_bytes),'hex'),
     'from_at',p.metadata#>>'{capture,fromAt}','row_from',lane.row_cursor,'total_rows',total)));
 RETURN to_jsonb(j)||jsonb_build_object('work_class','numerical','ticket',t.slot,'delivery_id',t.delivery_id,
   'replica_delivery',jsonb_build_object('delivery_id',t.delivery_id,'process_epoch',t.process_epoch,'sequence',lane.sequence,'revision',p.base_revision),
   'room_fit_progress',progress,'queue_ms',greatest(0,floor(extract(epoch FROM statement_timestamp()-t.queued_at)*1000))::bigint);
END; $$;

-- Preserve the existing visible job diagnostic while each replica owns its
-- own retry. One successful sibling cannot hide another stream's error.
CREATE FUNCTION private.refresh_energy_room_fit_replica_error(p_job_id uuid) RETURNS void
LANGUAGE sql SET search_path=pg_catalog,private,public AS $$
 UPDATE private.energy_learning_jobs SET last_error=(SELECT string_agg(last_error,E'\n' ORDER BY replica)
   FROM private.energy_room_fit_replicas WHERE job_id=p_job_id AND last_error IS NOT NULL) WHERE id=p_job_id;
$$;
REVOKE ALL ON FUNCTION private.refresh_energy_room_fit_replica_error(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.checkpoint_energy_room_fit_replica(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_delivery_id uuid,p_process_epoch uuid,p_expected_sequence bigint,p_turn jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE t private.energy_learning_tickets%ROWTYPE; lane jsonb:=p_turn->'replica'; total integer; next_row integer;
BEGIN
 IF NOT private.owns_energy_room_fit_replica(p_job_id,p_generation,p_fence,p_revision,p_delivery_id,p_process_epoch,p_expected_sequence) THEN RETURN false; END IF;
 SELECT * INTO STRICT t FROM private.energy_learning_tickets WHERE delivery_id=p_delivery_id;
 SELECT (metadata->>'row_count')::integer INTO STRICT total FROM private.energy_room_fit_progress WHERE job_id=p_job_id;
 next_row:=(lane->>'row')::integer;
 IF p_turn->>'kind' IS DISTINCT FROM 'replica' OR (lane->>'index')::integer IS DISTINCT FROM t.replica
   OR next_row IS NULL OR next_row>total OR jsonb_typeof(lane->'done') IS DISTINCT FROM 'boolean'
   OR (lane->>'done')::boolean IS DISTINCT FROM (next_row=total) THEN RAISE EXCEPTION 'Invalid room fit replica progress'; END IF;
 UPDATE private.energy_room_fit_replicas SET row_cursor=next_row,done=(lane->>'done')::boolean,checkpoint=decode(lane->>'blob','base64'),
   sequence=sequence+1,wake_after=now(),last_error=NULL WHERE job_id=p_job_id AND replica=t.replica
   AND sequence=p_expected_sequence AND row_cursor<=next_row AND next_row<=private.room_fit_page_end(row_cursor,total);
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.refresh_energy_room_fit_replica_error(p_job_id);
 IF NOT EXISTS(SELECT FROM private.energy_room_fit_replicas WHERE job_id=p_job_id AND NOT done) THEN
   UPDATE private.energy_room_fit_progress SET adaptive_cursor=adaptive_cursor+1,
     metadata=jsonb_set(metadata,'{heat_state}',jsonb_build_object('stage','complete')) WHERE job_id=p_job_id;
 END IF;
 RETURN true;
END; $$;

CREATE FUNCTION public.fail_energy_room_fit_replica(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_delivery_id uuid,p_process_epoch uuid,p_expected_sequence bigint,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
BEGIN
 IF NOT private.owns_energy_room_fit_replica(p_job_id,p_generation,p_fence,p_revision,p_delivery_id,p_process_epoch,p_expected_sequence) THEN RETURN false; END IF;
 UPDATE private.energy_room_fit_replicas r SET wake_after=now()+interval '5 minutes',last_error=p_error
   FROM private.energy_learning_tickets t WHERE t.delivery_id=p_delivery_id AND r.job_id=p_job_id AND r.replica=t.replica;
 PERFORM private.refresh_energy_room_fit_replica_error(p_job_id);
 RETURN true;
END; $$;

CREATE FUNCTION public.reset_energy_room_fit_replica(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_delivery_id uuid,p_process_epoch uuid,p_expected_sequence bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
BEGIN
 IF NOT private.owns_energy_room_fit_replica(p_job_id,p_generation,p_fence,p_revision,p_delivery_id,p_process_epoch,p_expected_sequence) THEN RETURN false; END IF;
 -- Genuine unreadable derived state keeps the existing restart policy. Revoke
 -- siblings before deleting scratch; their physical reservations still remain.
 UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=NULL,wake_after=now() WHERE id=p_job_id;
 DELETE FROM private.energy_room_fit_progress WHERE job_id=p_job_id;
 RETURN true;
END; $$;

CREATE FUNCTION public.release_energy_learning_delivery(p_job_id uuid,p_generation bigint,p_fence bigint,p_delivery_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
BEGIN
 DELETE FROM private.energy_learning_tickets WHERE delivery_id=p_delivery_id AND job_id=p_job_id AND generation=p_generation AND fence=p_fence;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.refill_energy_learning_work(); RETURN true;
END; $$;

-- Legacy failure cannot revoke a replica stage. Its fence was also advanced
-- once at handoff, so a delayed protocol-4 request cannot mutate new authority.
CREATE OR REPLACE FUNCTION public.fail_energy_device_learning(p_job_id uuid,p_generation bigint,p_fence bigint,p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
 UPDATE private.energy_learning_jobs SET lease_until=NULL,wake_after=now()+interval '5 minutes',last_error=p_error
 WHERE id=p_job_id AND pending AND generation=p_generation AND fence=p_fence AND NOT EXISTS(
   SELECT FROM private.energy_room_fit_progress p WHERE p.job_id=p_job_id AND p.process_epoch IS NOT NULL
     AND p.metadata#>>'{heat_state,stage}'='process_posterior');
$$;

REVOKE ALL ON FUNCTION private.claim_exclusive_energy_learning_work(uuid,jsonb),
 private.owns_energy_room_fit_replica(uuid,bigint,bigint,bigint,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.checkpoint_energy_room_fit_replica(uuid,bigint,bigint,bigint,uuid,uuid,bigint,jsonb),
 public.fail_energy_room_fit_replica(uuid,bigint,bigint,bigint,uuid,uuid,bigint,text),
 public.reset_energy_room_fit_replica(uuid,bigint,bigint,bigint,uuid,uuid,bigint),
 public.release_energy_learning_delivery(uuid,bigint,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_energy_room_fit_replica(uuid,bigint,bigint,bigint,uuid,uuid,bigint,jsonb),
 public.fail_energy_room_fit_replica(uuid,bigint,bigint,bigint,uuid,uuid,bigint,text),
 public.reset_energy_room_fit_replica(uuid,bigint,bigint,bigint,uuid,uuid,bigint),
 public.release_energy_learning_delivery(uuid,bigint,bigint,uuid) TO service_role;

CREATE OR REPLACE FUNCTION private.owns_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; revision bigint;
BEGIN
 SELECT * INTO j FROM private.energy_learning_jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR j.owner_kind<>'room' OR NOT j.pending
   OR j.generation IS DISTINCT FROM p_generation OR j.fence IS DISTINCT FROM p_fence
   OR j.lease_until IS NULL OR j.lease_until<=now()
   OR NOT public.energy_home_matches_customer(j.home_id,j.customer_id) THEN RETURN false; END IF;
 IF EXISTS(SELECT FROM private.energy_room_fit_progress p WHERE p.job_id=j.id AND p.process_epoch IS NOT NULL
   AND p.metadata#>>'{heat_state,stage}'='process_posterior') THEN RETURN false; END IF;
 SELECT model_revision INTO revision FROM energy_optimisation_zone_models
 WHERE home_id=j.home_id AND room_key=j.owner_key FOR SHARE;
 IF coalesce(revision,0) IS DISTINCT FROM p_revision THEN
   DELETE FROM private.energy_room_fit_progress WHERE job_id=j.id;
   RETURN false;
 END IF;
 RETURN true;
END; $$;
