-- Numerical fits publish the observation snapshot they actually consumed.
-- Reviewed policy remains a hard fence; material observation corrections
-- remain journaled for the room's next regular learning request.
-- The usable portion of a physical meter exclusion changes across reviewed
-- meter epochs. Hash the same exclusions that the in-service auditor checks.
CREATE OR REPLACE FUNCTION private.room_evidence_policy_exclusions(p_home uuid,p_room text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(device_key text,statistic_id text,valid_from timestamptz,valid_to timestamptz,affected tstzmultirange)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,private AS $$
 WITH sources AS MATERIALIZED (
   SELECT source_key,device_statistics FROM private.energy_heating_observation_sources(p_home) WHERE room_key=p_room
 ), assignments AS MATERIALIZED (
   SELECT h.observed_device_statistics,s.device_statistics AS target_meters,
     tstzrange(greatest(h.valid_from,p_from),least(h.valid_to,p_to),'[)') AS span
   FROM private.energy_heating_history_sources h JOIN sources s
     ON h.target_source_key=s.source_key AND h.target_device_statistics=s.device_statistics
   WHERE h.home_id=p_home AND h.room_key=p_room AND h.valid_from<p_to AND h.valid_to>p_from
 ), meters AS (
   SELECT e.key,e.value AS statistic_id,
     tstzmultirange(tstzrange(p_from,p_to,'[)'))-coalesce((SELECT range_agg(span) FROM assignments),'{}'::tstzmultirange) AS spans
   FROM sources s CROSS JOIN LATERAL jsonb_each_text(s.device_statistics) e
   UNION ALL
   SELECT e.key,e.value,tstzmultirange(a.span) FROM assignments a
   CROSS JOIN LATERAL jsonb_each_text(a.observed_device_statistics) e WHERE a.target_meters ? e.key
 )
 SELECT x.device_key,x.statistic_id,x.valid_from,x.valid_to,range_agg(owned.span) AS affected
 FROM private.energy_heating_meter_exclusions x JOIN meters m ON m.key=x.device_key AND m.statistic_id=x.statistic_id
 CROSS JOIN LATERAL unnest(m.spans*tstzmultirange(tstzrange(x.valid_from,x.valid_to,'[)'))) owned(span)
 WHERE x.home_id=p_home GROUP BY x.device_key,x.statistic_id,x.valid_from,x.valid_to;
$$;
REVOKE ALL ON FUNCTION private.room_evidence_policy_exclusions(uuid,text,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.room_evidence_policy_fingerprint(
 p_home uuid,p_room text,p_binding text,p_from timestamptz,p_to timestamptz)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,private SET timezone='UTC' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(
   private.energy_heating_source_fingerprint(p_home),
   (SELECT coalesce(jsonb_agg(jsonb_build_array(x.device_key,x.statistic_id,x.valid_from,x.valid_to)
      ORDER BY x.device_key,x.statistic_id,x.valid_from,x.valid_to),'[]'::jsonb)
    FROM private.room_evidence_policy_exclusions(p_home,p_room,p_from,p_to) x),
   (SELECT coalesce(jsonb_agg(jsonb_build_array(f.id,f.kind,f.from_at,f.to_at) ORDER BY f.id),'[]'::jsonb)
    FROM private.energy_room_operation_facts f WHERE f.home_id=p_home AND f.room_key=p_room AND f.binding=p_binding
      AND f.basis='customer_assertion' AND f.from_at<p_to AND f.to_at>p_from)
 )::text,'UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION private.room_evidence_policy_fingerprint(uuid,text,text,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_energy_room_evidence_work(p_home_id uuid,p_customer_id uuid,p_room_key text,p_binding text,
 p_from_at timestamptz,p_to_at timestamptz,p_implementation text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE next_work jsonb;
BEGIN
 IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) OR
   NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(p_home_id) WHERE room_key=p_room_key AND binding=p_binding)
 THEN RAISE EXCEPTION 'Home or room binding mismatch'; END IF;
 IF p_from_at IS NULL OR p_to_at IS NULL OR NOT isfinite(p_from_at) OR NOT isfinite(p_to_at)
   OR p_to_at<p_from_at OR coalesce(p_implementation,'')='' THEN RAISE EXCEPTION 'Invalid evidence scope'; END IF;
 -- Each refit may have appended only a few quarters. Compute the union of
 -- owned starts and test dirt set-wise, without fetching payloads or running
 -- a separate statement for every previously recorded tail.
 WITH blocks AS MATERIALIZED (
   SELECT from_at,to_at,source_revision,solar_retry_at,solar_after FROM private.energy_room_evidence_blocks
   WHERE home_id=p_home_id AND customer_id=p_customer_id AND room_key=p_room_key AND binding=p_binding
     AND implementation=p_implementation AND from_at<p_to_at AND to_at>p_from_at
 ), gaps AS (
   SELECT unnest(tstzmultirange(tstzrange(p_from_at,p_to_at,'[)'))
     -coalesce(range_agg(tstzrange(from_at,to_at,'[)')),'{}'::tstzmultirange)) AS gap FROM blocks
 ), pending AS (
   SELECT lower(gap) AS from_at,least(upper(gap),lower(gap)+interval '240 hours') AS to_at,
     NULL::timestamptz AS solar_retry_at,NULL::timestamptz AS solar_after FROM gaps
   UNION ALL
   SELECT b.from_at,b.to_at,b.solar_retry_at,b.solar_after FROM blocks b
   -- A canonical quarter can supersede an hour spanning an internal seam.
   -- The publication horizon itself is exclusive.
   WHERE b.solar_retry_at<=now() OR (b.solar_after IS NOT NULL AND b.solar_retry_at IS NULL)
     OR EXISTS(SELECT FROM private.energy_room_evidence_changes d WHERE d.home_id=p_home_id AND d.room_key IN ('',p_room_key)
       AND d.revision>b.source_revision AND d.affected && tstzrange(greatest(p_from_at,b.from_at-interval '1 hour'),
         least(p_to_at,b.to_at+interval '1 hour'),'[)'))
 )
 SELECT to_jsonb(p) INTO next_work FROM pending p ORDER BY p.from_at LIMIT 1;
 RETURN jsonb_build_object('source_revision',coalesce((SELECT revision FROM private.energy_room_evidence_clocks
   WHERE home_id=p_home_id),0),'next',next_work,
   'policy_fingerprint',private.room_evidence_policy_fingerprint(p_home_id,p_room_key,p_binding,p_from_at,p_to_at));
END; $$;

CREATE OR REPLACE FUNCTION public.save_energy_room_evidence_block(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_binding text,p_source_revision bigint,p_from_at timestamptz,p_to_at timestamptz,p_implementation text,
 p_capture_base64 text,p_sha256 text,p_row_count integer,p_solar_retry_at timestamptz DEFAULT NULL,p_solar_after timestamptz DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE owner private.energy_learning_jobs%ROWTYPE; current_revision bigint; bytes bytea;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT * INTO STRICT owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 current_revision:=private.lock_room_evidence(owner.home_id);
 IF p_from_at>=owner.room_history_to THEN RETURN false; END IF;
 IF p_source_revision IS NULL OR p_source_revision<0 OR p_source_revision>current_revision OR
   NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(owner.home_id) WHERE room_key=owner.owner_key AND binding=p_binding)
   OR private.room_evidence_changed(owner.home_id,owner.owner_key,p_source_revision,p_from_at-interval '1 hour',
     least(owner.room_history_to,p_to_at+interval '1 hour'))
 THEN RETURN false; END IF;
 bytes:=decode(p_capture_base64,'base64');
 IF coalesce(p_implementation,'')='' OR coalesce(octet_length(bytes),0)=0 OR coalesce(p_row_count,-1)<0
   OR p_sha256 IS DISTINCT FROM encode(sha256(bytes),'hex') THEN RAISE EXCEPTION 'Invalid room evidence block'; END IF;
 -- Job ownership serializes block writes for this room; immutable extents
 -- cannot acquire a second owner for an interval start.
 IF EXISTS(SELECT FROM private.energy_room_evidence_blocks b WHERE b.home_id=owner.home_id AND b.room_key=owner.owner_key
   AND b.binding=p_binding AND b.implementation=p_implementation AND b.from_at<p_to_at AND b.to_at>p_from_at
   AND (b.from_at<>p_from_at OR b.to_at<>p_to_at OR b.source_revision>p_source_revision)) THEN RETURN false; END IF;
 INSERT INTO private.energy_room_evidence_blocks(home_id,customer_id,room_key,binding,implementation,from_at,to_at,source_revision,
   capture,sha256,row_count,solar_retry_at,solar_after)
 VALUES(owner.home_id,owner.customer_id,owner.owner_key,p_binding,p_implementation,p_from_at,p_to_at,p_source_revision,
   bytes,p_sha256,p_row_count,p_solar_retry_at,p_solar_after)
 ON CONFLICT(home_id,room_key,binding,implementation,from_at) DO UPDATE SET source_revision=EXCLUDED.source_revision,
   capture=EXCLUDED.capture,sha256=EXCLUDED.sha256,row_count=EXCLUDED.row_count,
   solar_retry_at=EXCLUDED.solar_retry_at,solar_after=EXCLUDED.solar_after
 WHERE (energy_room_evidence_blocks.source_revision,energy_room_evidence_blocks.sha256,energy_room_evidence_blocks.row_count,
   energy_room_evidence_blocks.solar_retry_at,energy_room_evidence_blocks.solar_after) IS DISTINCT FROM
   (EXCLUDED.source_revision,EXCLUDED.sha256,EXCLUDED.row_count,EXCLUDED.solar_retry_at,EXCLUDED.solar_after);
 -- The saved evidence and the next wake commit together under the same
 -- generation. A lost reply can resume from this block immediately.
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION private.review_room_operation_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE fact private.energy_room_operation_facts%ROWTYPE; job_id uuid;
BEGIN
 fact:=CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 IF fact.basis<>'customer_assertion' THEN RETURN NULL; END IF;
 IF EXISTS(SELECT FROM public.homes WHERE id=fact.home_id) AND EXISTS(
   SELECT FROM private.energy_room_heating_contexts(fact.home_id) WHERE room_key=fact.room_key AND binding=fact.binding) THEN
   INSERT INTO private.energy_learning_jobs AS j(home_id,customer_id,owner_kind,owner_key,input)
   VALUES(fact.home_id,fact.customer_id,'room',fact.room_key,'{}')
   ON CONFLICT(home_id,owner_kind,owner_key) DO UPDATE SET pending=true,generation=j.generation+1,fence=j.fence+1,
     wake_after=now(),lease_until=NULL,attempts=0,last_error=NULL,finished_at=NULL WHERE NOT j.pending
   RETURNING id INTO job_id;
   IF FOUND THEN PERFORM private.wake_energy_learning_job(job_id); END IF;
 END IF;
 RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION private.track_heating_source_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE home uuid; signature text; owner_id uuid;
BEGIN
 FOR home IN SELECT DISTINCT id FROM unnest(ARRAY[
   CASE WHEN TG_OP<>'INSERT' THEN OLD.home_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.home_id END]) id
   WHERE id IS NOT NULL LOOP
  IF NOT EXISTS(SELECT FROM homes WHERE id=home) THEN CONTINUE; END IF;
  signature:=private.energy_heating_source_fingerprint(home);
  INSERT INTO private.energy_heating_source_revisions AS prior(home_id,fingerprint)
   VALUES(home,signature)
  ON CONFLICT(home_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,learning_updated_at=greatest(prior.learning_updated_at,statement_timestamp())
   WHERE prior.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint;
  -- A household probe assignment can affect every room. Lock current jobs
  -- before the statement's evidence journal takes the home clock. A review
  -- racing publication either vetoes its capture or wakes the newly idle job.
  IF FOUND AND TG_TABLE_NAME='energy_heating_history_sources' THEN
    FOR owner_id IN SELECT j.id FROM private.energy_learning_jobs j
      JOIN private.energy_room_heating_contexts(home) c ON c.room_key=j.owner_key
      WHERE j.home_id=home AND j.owner_kind='room' ORDER BY j.id FOR UPDATE OF j LOOP
      UPDATE private.energy_learning_jobs SET pending=true,generation=generation+1,fence=fence+1,
        wake_after=now(),lease_until=NULL,attempts=0,last_error=NULL,finished_at=NULL
      WHERE id=owner_id AND NOT pending;
      IF FOUND THEN PERFORM private.wake_energy_learning_job(owner_id); END IF;
    END LOOP;
  END IF;
 END LOOP;
 RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_energy_device_learning(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; owner record;
 lane private.energy_room_learning_lanes%ROWTYPE; progress jsonb; revision bigint;
BEGIN
 SELECT home_id,owner_kind INTO owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF owner.owner_kind='room' THEN
   INSERT INTO private.energy_room_learning_lanes(home_id) VALUES(owner.home_id) ON CONFLICT DO NOTHING;
   -- Claim locks lane then job. Release only locks the lane; ordinary request,
   -- publication and checkpoint never lock it, so there is no reverse order.
   SELECT * INTO lane FROM private.energy_room_learning_lanes
     WHERE home_id=owner.home_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND OR lane.lease_until>now() THEN RETURN NULL; END IF;
   IF private.next_energy_room_learning_job(owner.home_id) IS DISTINCT FROM p_job_id THEN
     PERFORM private.wake_energy_learning_job(p_job_id);
     RETURN NULL;
   END IF;
   SELECT * INTO j FROM private.energy_learning_jobs
     WHERE id=p_job_id AND home_id=owner.home_id AND owner_kind='room' AND pending
       AND wake_after<=now() AND (lease_until IS NULL OR lease_until<=now())
     FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN RETURN NULL; END IF;
   UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=now()+interval '60 seconds',
     wake_after=now()+interval '60 seconds',attempts=attempts+1,room_last_started_at=now()
     WHERE id=p_job_id RETURNING * INTO j;
   UPDATE private.energy_room_learning_lanes SET job_id=j.id,generation=j.generation,
     fence=j.fence,lease_until=j.lease_until WHERE home_id=j.home_id;
   SELECT model_revision INTO revision FROM energy_optimisation_zone_models
     WHERE home_id=j.home_id AND room_key=j.owner_key FOR SHARE;
   DELETE FROM private.energy_room_fit_progress
     WHERE job_id=j.id AND (generation<>j.generation OR base_revision<>coalesce(revision,0)
       OR NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(j.home_id) c
          WHERE c.room_key=j.owner_key AND c.binding=metadata#>>'{capture,binding}'));
   SELECT jsonb_build_object('metadata',p.metadata,'cells',p.cells,'cursor',jsonb_array_length(p.cells),
     'base_revision',p.base_revision) INTO progress FROM private.energy_room_fit_progress p WHERE p.job_id=j.id;
 ELSE
   -- Preserve the existing pool/device lease and retry behavior.
   UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=now()+interval '60 seconds',
     wake_after=now()+interval '60 seconds',attempts=attempts+1
   WHERE id=p_job_id AND owner_kind<>'room' AND pending AND (lease_until IS NULL OR lease_until<=now())
   RETURNING * INTO j;
   IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 RETURN to_jsonb(j)||jsonb_build_object('room_fit_progress',progress);
END; $$;

CREATE OR REPLACE FUNCTION public.checkpoint_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_metadata jsonb,p_capture_base64 text,p_cell jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE owner private.energy_learning_jobs%ROWTYPE; cap jsonb; evidence jsonb;
 start_at timestamptz; finish_at timestamptz; current_policy text;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF p_expected_cursor=-1 THEN
   IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' OR p_capture_base64 IS NULL
     OR p_cell IS NOT NULL THEN RAISE EXCEPTION 'Invalid initial room fit capture'; END IF;
   SELECT * INTO STRICT owner FROM private.energy_learning_jobs WHERE id=p_job_id;
   cap:=p_metadata->'capture'; evidence:=cap->'evidence';
   start_at:=(evidence->>'fromAt')::timestamptz; finish_at:=(evidence->>'toAt')::timestamptz;
   IF start_at IS NULL OR finish_at IS NULL OR NOT isfinite(start_at) OR NOT isfinite(finish_at) OR finish_at<start_at
     OR cap->>'homeId' IS DISTINCT FROM owner.home_id::text OR cap->>'customerId' IS DISTINCT FROM owner.customer_id::text
     OR cap->>'roomKey' IS DISTINCT FROM owner.owner_key OR (cap->>'baseRevision')::bigint IS DISTINCT FROM p_revision
   THEN RAISE EXCEPTION 'Invalid room capture ownership or scope'; END IF;
   PERFORM private.lock_room_evidence(owner.home_id);
   -- Read current eligibility in a fresh READ COMMITTED statement after a
   -- concurrent source-policy writer has released the evidence clock lock.
   SELECT private.room_evidence_policy_fingerprint(owner.home_id,owner.owner_key,c.binding,start_at,finish_at)
     INTO current_policy FROM private.energy_room_heating_contexts(owner.home_id) c
     WHERE c.room_key=owner.owner_key AND c.binding=cap->>'binding';
   IF current_policy IS NULL OR p_metadata->>'policy_fingerprint' IS DISTINCT FROM current_policy THEN
     PERFORM private.resume_energy_room_fit(p_job_id);
     RETURN false;
   END IF;
   INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture)
   VALUES(p_job_id,p_generation,p_revision,p_metadata,decode(p_capture_base64,'base64'))
   ON CONFLICT(job_id) DO NOTHING;
 ELSE
   IF p_expected_cursor IS NULL OR p_expected_cursor<0 OR p_expected_cursor>=18
     OR p_metadata IS NOT NULL OR p_capture_base64 IS NOT NULL
     OR jsonb_typeof(p_cell) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid room fit cell'; END IF;
   UPDATE private.energy_room_fit_progress SET cells=cells||jsonb_build_array(p_cell),metadata=metadata-'heat_state'
   WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
     AND jsonb_array_length(cells)=p_expected_cursor;
 END IF;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.complete_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_model jsonb,p_run_ledger jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE
 owner private.energy_learning_jobs%ROWTYPE; envelope jsonb; captured jsonb; evidence jsonb; prior jsonb;
 bands jsonb:=p_model->'heating_bands'; response jsonb:=bands->'reference';
 response_revision text:=bands->>'reference_revision'; v_binding text:=bands->>'binding';
 policy constant text:='shared_interval_transitions_v1'; training jsonb; support jsonb;
 fitted integer; freedom integer; n integer; start_at timestamptz; finish_at timestamptz;
 captured_revision bigint; live_revision bigint; current_policy text; complete_scope boolean; changed boolean;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT * INTO STRICT owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 SELECT metadata INTO envelope FROM private.energy_room_fit_progress WHERE job_id=p_job_id AND generation=p_generation
   AND base_revision=p_revision AND jsonb_array_length(cells)=p_expected_cursor;
 IF p_expected_cursor IS DISTINCT FROM 18 OR envelope->>'version' IS DISTINCT FROM '4' THEN RETURN false; END IF;
 -- A previous worker may finish during rollout. Leave its earned cells and
 -- immutable bytes for the new worker's in-service certification or reset.
 IF NOT (envelope ? 'policy_fingerprint') THEN RETURN false; END IF;
 captured:=envelope->'capture'; evidence:=captured->'evidence';
 start_at:=(evidence->>'fromAt')::timestamptz; finish_at:=(evidence->>'toAt')::timestamptz;
 captured_revision:=(evidence->>'sourceRevision')::bigint;
 IF captured->>'homeId' IS DISTINCT FROM owner.home_id::text OR captured->>'customerId' IS DISTINCT FROM owner.customer_id::text
   OR captured->>'roomKey' IS DISTINCT FROM owner.owner_key OR captured->>'binding' IS DISTINCT FROM v_binding OR v_binding IS NULL
   OR (captured->>'baseRevision')::bigint IS DISTINCT FROM p_revision
   OR start_at IS NULL OR finish_at IS NULL OR NOT isfinite(start_at) OR NOT isfinite(finish_at) OR start_at>finish_at
   OR captured_revision IS NULL OR captured_revision<0 OR coalesce(evidence->>'implementation','')=''
   OR coalesce(captured->>'implementation','')='' OR captured->>'implementation' IS DISTINCT FROM bands#>>'{shared_attempt,implementation}'
   OR bands#>'{shared_attempt,evidence}' IS DISTINCT FROM evidence OR bands->>'calibration_policy' IS DISTINCT FROM policy
 THEN RAISE EXCEPTION 'Invalid chronological room capture'; END IF;
 live_revision:=private.lock_room_evidence(owner.home_id);
 -- Policy reads have their own statement snapshot after the clock lock.
 SELECT private.room_evidence_policy_fingerprint(owner.home_id,owner.owner_key,c.binding,start_at,finish_at)
   INTO current_policy FROM private.energy_room_heating_contexts(owner.home_id) c
   WHERE c.room_key=owner.owner_key AND c.binding=v_binding;
 SELECT COALESCE(range_agg(tstzrange(b.from_at,b.to_at,'[)')),'{}'::tstzmultirange) @> tstzrange(start_at,finish_at,'[)')
   AND NOT coalesce(bool_or(EXISTS(SELECT FROM private.energy_room_evidence_changes d WHERE d.home_id=b.home_id
     AND d.room_key IN ('',b.room_key) AND d.revision>b.source_revision AND d.revision<=captured_revision
     AND d.affected && tstzrange(greatest(start_at,b.from_at-interval '1 hour'),least(finish_at,b.to_at+interval '1 hour'),'[)'))),false)
 INTO complete_scope FROM private.energy_room_evidence_blocks b WHERE b.home_id=owner.home_id AND b.room_key=owner.owner_key
   AND b.customer_id=owner.customer_id AND b.binding=v_binding AND b.implementation=evidence->>'implementation'
   AND b.from_at<finish_at AND b.to_at>start_at;
 IF NOT complete_scope OR captured_revision>live_revision OR current_policy IS NULL
   OR envelope->>'policy_fingerprint' IS DISTINCT FROM current_policy THEN
   DELETE FROM private.energy_room_fit_progress WHERE job_id=p_job_id;
   PERFORM private.resume_energy_room_fit(p_job_id);
   RETURN false;
 END IF;
 SELECT heating_bands INTO prior FROM public.energy_optimisation_zone_models WHERE home_id=owner.home_id AND room_key=owner.owner_key;
 IF prior->>'binding' IS DISTINCT FROM v_binding THEN prior:=NULL; END IF;
 changed:=response_revision IS DISTINCT FROM prior->>'reference_revision';
 p_run_ledger:=nullif(p_run_ledger,'null'::jsonb);
 IF changed THEN
   training:=response->'learning_evidence'; support:=training->'transition_calibration';
   fitted:=(support->>'fitted_transitions')::integer; freedom:=(training->>'residual_degrees_of_freedom')::integer;
   IF response_revision IS NULL OR response#>>'{scope,kind}' IS DISTINCT FROM 'shared' OR bands->'active' IS DISTINCT FROM '[]'::jsonb
     OR bands#>>'{shared_attempt,status}' IS DISTINCT FROM 'fitted'
     OR support->>'policy' IS DISTINCT FROM policy OR fitted IS NULL OR freedom IS NULL OR freedom<=0 OR freedom>=fitted
     OR fitted IS DISTINCT FROM (response#>>'{model,sample_count}')::integer OR fitted IS DISTINCT FROM (p_model->>'sample_count')::integer
     OR (training-'source_evidence') IS DISTINCT FROM ((p_model#>'{last_fit_attempt,learning}')-'source_evidence')
     OR (training ? 'source_evidence' AND training->'source_evidence' IS DISTINCT FROM evidence)
     OR ((p_model#>'{last_fit_attempt,learning}') ? 'source_evidence'
       AND p_model#>'{last_fit_attempt,learning,source_evidence}' IS DISTINCT FROM evidence)
     OR p_run_ledger->>'assessed_against' IS DISTINCT FROM response_revision OR p_run_ledger->>'policy' IS DISTINCT FROM policy
     OR jsonb_typeof(p_run_ledger->'runs') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid shared transition support'; END IF;
   -- Persist the accepted basis even for an already sealed pre-cutover fit.
   -- Its reference survives a later unidentified attempt with newer evidence.
   p_model:=jsonb_set(p_model,'{heating_bands,reference,learning_evidence,source_evidence}',evidence);
   n:=jsonb_array_length(p_run_ledger->'runs');
   IF n IS DISTINCT FROM (p_run_ledger->>'observed_runs')::integer OR
     n<>(SELECT count(DISTINCT run->>'id') FROM jsonb_array_elements(p_run_ledger->'runs') run)
     OR EXISTS(SELECT FROM jsonb_array_elements(p_run_ledger->'runs') run WHERE coalesce(run->>'id','')=''
       OR coalesce(run->>'disposition','') NOT IN ('assessed','suspect_change','uninformative'))
     THEN RAISE EXCEPTION 'Invalid room run assessments'; END IF;
 ELSIF p_run_ledger IS NOT NULL OR bands#>>'{shared_attempt,status}' IS DISTINCT FROM 'unidentified'
   OR response IS DISTINCT FROM prior->'reference' THEN RAISE EXCEPTION 'Failed fit must retain its accepted response'; END IF;
 IF NOT public.publish_energy_device_learning(p_job_id,p_generation,p_fence,p_revision,p_model) THEN RETURN false; END IF;
 IF changed THEN
   INSERT INTO private.energy_room_run_assessments(home_id,room_key,response_revision,position,run)
   SELECT owner.home_id,owner.owner_key,response_revision,
     row_number() OVER (ORDER BY (run->>'from_ms')::numeric DESC,run->>'id'),run
   FROM jsonb_array_elements(p_run_ledger->'runs') run;
   -- Keep only the compact summary in the current-room pointer. Past revision
   -- pages remain queryable by their revision even after a subsequent fit.
   DELETE FROM private.energy_room_run_ledgers WHERE home_id=owner.home_id AND room_key=owner.owner_key;
   INSERT INTO private.energy_room_run_ledgers(home_id,customer_id,room_key,scope_key,model_revision,job_id,generation,evidence)
   VALUES(owner.home_id,owner.customer_id,owner.owner_key,'shared',p_revision+1,p_job_id,p_generation,
     (p_run_ledger-'runs')||jsonb_build_object('runs','[]'::jsonb));
 END IF;
 RETURN true;
END; $$;

-- Roll-forward of already-earned numerical cells. Only the learning service
-- can read the policy facts. All numerical observations stay in its existing
-- private capture. This path is ineligible once a fingerprint is attached.
CREATE OR REPLACE FUNCTION public.get_energy_room_fit_policy_audit(p_job_id uuid,p_generation bigint,p_fence bigint,
 p_revision bigint,p_expected_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET timezone='UTC' AS $$
DECLARE owner private.energy_learning_jobs%ROWTYPE; cap jsonb; evidence jsonb; v_binding text;
 start_at timestamptz; finish_at timestamptz; result jsonb;
BEGIN
 IF p_expected_sha IS NULL OR p_expected_sha !~ '^[0-9a-f]{64}$'
   OR NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN NULL; END IF;
 SELECT * INTO STRICT owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 SELECT p.metadata->'capture' INTO cap FROM private.energy_room_fit_progress p
 WHERE p.job_id=p_job_id AND p.generation=p_generation AND p.base_revision=p_revision
   AND p.metadata->>'version'='4' AND NOT (p.metadata ? 'policy_fingerprint')
   AND p.metadata->>'sha256'=p_expected_sha AND encode(sha256(p.capture),'hex')=p_expected_sha;
 IF NOT FOUND THEN RETURN NULL; END IF;
 v_binding:=cap->>'binding'; evidence:=cap->'evidence';
 start_at:=(evidence->>'fromAt')::timestamptz; finish_at:=(evidence->>'toAt')::timestamptz;
 IF cap->>'homeId' IS DISTINCT FROM owner.home_id::text OR cap->>'customerId' IS DISTINCT FROM owner.customer_id::text
   OR cap->>'roomKey' IS DISTINCT FROM owner.owner_key OR (cap->>'baseRevision')::bigint IS DISTINCT FROM p_revision
   OR start_at IS NULL OR finish_at IS NULL OR NOT isfinite(start_at) OR NOT isfinite(finish_at) OR finish_at<start_at
   THEN RETURN NULL; END IF;
 PERFORM private.lock_room_evidence(owner.home_id);
 SELECT jsonb_build_object(
   'policy_fingerprint',private.room_evidence_policy_fingerprint(owner.home_id,owner.owner_key,c.binding,start_at,finish_at),
   'source_policy_at',(SELECT r.learning_updated_at FROM private.energy_heating_source_revisions r WHERE r.home_id=owner.home_id),
   'operation_facts',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'home_id',f.home_id,
       'customer_id',f.customer_id,'room_key',f.room_key,'binding',f.binding,'basis',f.basis,'kind',f.kind,
       'from_at',f.from_at,'to_at',f.to_at,'created_at',f.created_at) ORDER BY f.id),'[]'::jsonb)
     FROM private.energy_room_operation_facts f WHERE f.home_id=owner.home_id AND f.customer_id=owner.customer_id
       AND f.room_key=owner.owner_key AND f.binding=c.binding AND f.from_at<finish_at AND f.to_at>start_at),
   'exclusions',(SELECT coalesce(jsonb_agg(jsonb_build_object('from_at',lower(x.span),'to_at',upper(x.span))
       ORDER BY lower(x.span),upper(x.span)),'[]'::jsonb) FROM (
       SELECT unnest(range_agg(part)) AS span FROM private.room_evidence_policy_exclusions(owner.home_id,owner.owner_key,start_at,finish_at) e
       CROSS JOIN LATERAL unnest(e.affected) part
     ) x)
 ) INTO result FROM private.energy_room_heating_contexts(owner.home_id) c
 WHERE c.room_key=owner.owner_key AND c.binding=v_binding;
 RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.certify_energy_room_fit_policy(p_job_id uuid,p_generation bigint,p_fence bigint,
 p_revision bigint,p_expected_sha text,p_policy_fingerprint text,p_operation_witnesses jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE audit jsonb;
BEGIN
 IF p_policy_fingerprint IS NULL OR p_policy_fingerprint !~ '^[0-9a-f]{64}$'
   OR jsonb_typeof(p_operation_witnesses) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 -- Reacquire the owner/model/clock locks and verify immutable bytes. Policy
 -- cannot change between this fresh read and the CAS. The worker validated
 -- operation UUIDs and heater intervals against these exact captured bytes.
 audit:=public.get_energy_room_fit_policy_audit(p_job_id,p_generation,p_fence,p_revision,p_expected_sha);
 IF audit IS NULL OR audit->>'policy_fingerprint' IS DISTINCT FROM p_policy_fingerprint THEN RETURN false; END IF;
 -- Only UUIDs used by the immutable capture are witnesses. A deletion or
 -- replacement of one invalidates the proof. Additional automatic facts
 -- are ordinary observations and impose no condition on this certificate.
 IF jsonb_array_length(p_operation_witnesses)<>(SELECT count(DISTINCT w->>'id') FROM jsonb_array_elements(p_operation_witnesses) w)
   OR EXISTS(SELECT value FROM jsonb_array_elements(p_operation_witnesses)
             EXCEPT SELECT value FROM jsonb_array_elements(audit->'operation_facts')) THEN RETURN false; END IF;
 UPDATE private.energy_room_fit_progress p SET metadata=jsonb_set(p.metadata,'{policy_fingerprint}',to_jsonb(p_policy_fingerprint))
 WHERE p.job_id=p_job_id AND p.generation=p_generation AND p.base_revision=p_revision
   AND p.metadata->>'sha256'=p_expected_sha AND NOT (p.metadata ? 'policy_fingerprint')
   AND (audit->>'source_policy_at')::timestamptz<=(p.metadata#>>'{capture,attemptedAt}')::timestamptz
   AND NOT EXISTS(SELECT FROM jsonb_array_elements(audit->'operation_facts') f WHERE f->>'basis'='customer_assertion'
     AND (f->>'created_at')::timestamptz>(p.metadata#>>'{capture,attemptedAt}')::timestamptz);
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;

REVOKE ALL ON FUNCTION public.get_energy_room_fit_policy_audit(uuid,bigint,bigint,bigint,text),
 public.certify_energy_room_fit_policy(uuid,bigint,bigint,bigint,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_fit_policy_audit(uuid,bigint,bigint,bigint,text),
 public.certify_energy_room_fit_policy(uuid,bigint,bigint,bigint,text,text,jsonb) TO service_role;

-- The worker uses the new service-only RPC signatures immediately after deploy.
NOTIFY pgrst, 'reload schema';
