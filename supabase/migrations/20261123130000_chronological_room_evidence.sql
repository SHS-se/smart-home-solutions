-- The learning worker owns source qualification and fitting. Uploads only
-- journal changed physical intervals. Serialize a home's revision allocation
-- with its block saves/publications so commit order, including concurrent
-- first uploads, cannot hide a correction behind an older watermark.
CREATE TABLE private.energy_room_evidence_clocks (
 home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
 revision bigint NOT NULL CHECK(revision>=0)
);
CREATE TABLE private.energy_room_evidence_changes (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 revision bigint NOT NULL,
 room_key text NOT NULL, -- empty indicates an input shared by the home
 affected tstzmultirange NOT NULL,
 PRIMARY KEY(home_id,revision,room_key)
);
CREATE INDEX energy_room_changes_affected ON private.energy_room_evidence_changes USING gist(affected);
CREATE TABLE private.energy_room_evidence_blocks (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL,
 room_key text NOT NULL,
 binding text NOT NULL,
 implementation text NOT NULL,
 from_at timestamptz NOT NULL,
 to_at timestamptz NOT NULL,
 source_revision bigint NOT NULL CHECK(source_revision>=0),
 capture bytea NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 row_count integer NOT NULL CHECK(row_count>=0),
 solar_retry_at timestamptz,
 solar_after timestamptz,
 PRIMARY KEY(home_id,room_key,binding,implementation,from_at),
 CHECK(isfinite(from_at) AND isfinite(to_at) AND from_at<to_at AND to_at<=from_at+interval '240 hours')
);
CREATE TABLE private.energy_room_run_assessments (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 room_key text NOT NULL,
 response_revision text NOT NULL,
 position integer NOT NULL,
 run jsonb NOT NULL,
 PRIMARY KEY(home_id,room_key,response_revision,position)
);
CREATE UNIQUE INDEX energy_room_assessment_run_id ON private.energy_room_run_assessments(home_id,room_key,response_revision,(run->>'id'));
ALTER TABLE private.energy_room_evidence_clocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_room_evidence_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_room_evidence_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_room_run_assessments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_room_evidence_clocks,private.energy_room_evidence_changes,
 private.energy_room_evidence_blocks,private.energy_room_run_assessments FROM PUBLIC,anon,authenticated,service_role;

-- Transition relations give a bulk upload one journal entry per owner per
-- statement. EXCEPT compares the material projection in both directions, so
-- overlapping replays, receipt times and unrelated device settings are free.
CREATE FUNCTION private.journal_room_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public SET jit=off AS $$
DECLARE projection text:=TG_ARGV[0]; prior text; incoming text; delta text;
BEGIN
 IF TG_OP='DELETE' AND current_setting('shs.room_evidence_retention',true)='on' THEN RETURN NULL; END IF;
 prior:=format(projection,'old_source'); incoming:=format(projection,'new_source');
 delta:=CASE TG_OP WHEN 'INSERT' THEN incoming WHEN 'DELETE' THEN prior
   ELSE format('(%s EXCEPT %s) UNION ALL (%s EXCEPT %s)',prior,incoming,incoming,prior) END;
 EXECUTE format('WITH affected AS MATERIALIZED (
     SELECT d.home_id,d.room_key,range_agg(d.span) AS spans FROM (%s) d
     JOIN public.homes h ON h.id=d.home_id
     WHERE EXISTS(SELECT FROM private.energy_learning_jobs j WHERE j.home_id=d.home_id AND j.owner_kind=''room'')
       OR EXISTS(SELECT FROM private.energy_room_evidence_clocks c WHERE c.home_id=d.home_id)
     GROUP BY d.home_id,d.room_key
   ), clocks AS (
     INSERT INTO private.energy_room_evidence_clocks AS c(home_id,revision)
     SELECT DISTINCT home_id,1 FROM affected ORDER BY home_id
     ON CONFLICT(home_id) DO UPDATE SET revision=c.revision+1 RETURNING home_id,revision
   ) INSERT INTO private.energy_room_evidence_changes(home_id,revision,room_key,affected)
     SELECT a.home_id,c.revision,a.room_key,a.spans FROM affected a JOIN clocks c USING(home_id)', delta);
 RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION private.journal_room_evidence() FROM PUBLIC,anon,authenticated,service_role;

-- The projection includes source identity as well as selected values. A
-- device move, old-key update or review spanning multiple blocks dirties both
-- sides. Native inputs are already fingerprinted at ingestion.
DO $$
DECLARE src record; projection text; operation text; transition_tables text;
BEGIN
 FOR src IN SELECT * FROM (VALUES
 ('public.energy_heating_observations','s.room_key','s.start_ts','s.start_ts+make_interval(secs=>s.duration_s)',
  's.source_revision,s.customer_id,s.source_key,s.device_statistics,s.room_temperature_c,s.outdoor_temperature_c,s.house_temperature_c,s.solar_w_per_m2,s.device_energy_kwh,s.heater_energy_limits_w,s.cooling,s.source',''),
 ('public.energy_heating_probe_observations','''''::text','s.start_ts','s.start_ts+make_interval(secs=>s.duration_s)',
  's.customer_id,s.probe_fingerprint',''),
 ('public.energy_optimisation_thermal_slots','s.room_key','s.start_ts','s.start_ts+interval ''15 minutes''',
  's.customer_id,s.room_temperature_c,s.cooling_duty',''),
 ('public.energy_optimisation_outdoor_slots','''''::text','s.start_ts','s.start_ts+interval ''15 minutes''',
  's.customer_id,s.temperature_c,s.solar_w_per_m2',''),
 ('public.energy_optimisation_house_slots','''''::text','s.start_ts','s.start_ts+interval ''15 minutes''',
  's.customer_id,s.temperature_c',''),
 ('public.energy_optimisation_device_slots','d.mapping_summary->>''room_key''','s.start_ts','s.start_ts+interval ''15 minutes''',
  's.customer_id,s.device_id,s.energy_kwh','JOIN public.energy_optimisation_devices d ON d.id=s.device_id AND d.retired_at IS NULL AND d.planning_role_override=''controllable'' AND d.control_type_override IN (''setpoint'',''switch_schedule'') AND d.mapping_summary->>''room_key'' IS NOT NULL'),
 ('private.energy_room_operation_facts','s.room_key','s.from_at','s.to_at','s.binding,s.kind,s.basis,s.id',''),
 ('private.energy_heating_meter_exclusions','d.mapping_summary->>''room_key''','s.valid_from','s.valid_to','s.device_key,s.statistic_id',
  'JOIN public.energy_optimisation_devices d ON d.home_id=s.home_id AND d.device_key=s.device_key AND d.retired_at IS NULL AND d.category=''heating'' AND d.mapping_summary->>''room_key'' IS NOT NULL'),
 ('private.energy_heating_history_sources','''''::text','s.valid_from','s.valid_to','to_jsonb(s)-''basis''',''),
 ('public.energy_room_profiles','''''::text','NULL::timestamptz','NULL::timestamptz','(SELECT jsonb_object_agg(r.key,r.value->''source_key'') FROM jsonb_each(s.rooms) r),s.connections',''),
 ('public.energy_optimisation_devices','''''::text','NULL::timestamptz','NULL::timestamptz',
  's.id,s.device_key,s.statistic_id,s.category,s.active_power_w,s.first_seen_at,s.mapping_summary->>''room_key'' AS mapped_room,s.mapping_summary->>''room_name'' AS mapped_name,s.control_type_override,s.mapping_status,s.mapped_control_type',
  'WHERE s.retired_at IS NULL AND s.planning_role_override=''controllable'' AND s.control_type_override IN (''setpoint'',''switch_schedule'')'),
 -- A mismatched legacy thermometer sets the *lower bound* for admitting
 -- observations. Its influence extends back from the end of that quarter.
 ('public.energy_room_probe_slots','s.room_key','NULL::timestamptz','s.start_ts+interval ''15 minutes''',
  's.source_key','JOIN public.energy_room_profiles p ON p.home_id=s.home_id WHERE s.source_key IS DISTINCT FROM p.rooms->s.room_key->>''source_key''')
 ) AS sources(relation,room,start_at,end_at,material,joins)
 LOOP
   projection:=format('SELECT s.home_id,%s AS room_key,tstzrange(%s,%s,''[)'') AS span,%s FROM %%I s %s',
     src.room,src.start_at,src.end_at,src.material,src.joins);
   FOREACH operation IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
     transition_tables:=CASE operation WHEN 'INSERT' THEN 'NEW TABLE AS new_source'
       WHEN 'DELETE' THEN 'OLD TABLE AS old_source' ELSE 'OLD TABLE AS old_source NEW TABLE AS new_source' END;
     EXECUTE format('CREATE TRIGGER %I AFTER %s ON %s REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION private.journal_room_evidence(%L)',
       'room_evidence_'||lower(operation),operation,src.relation,transition_tables,projection);
   END LOOP;
 END LOOP;
END; $$;

-- Retention may cut through an extent while a room is idle or working on
-- a pinned horizon. Keep the source side of that seam reconstructible: an
-- unrelated correction in the still-eligible half must not erase its other
-- rows. Existing prune helpers use discovery_at for native/legacy inputs
-- and keep the last different thermometer establishing the legacy cutoff.
CREATE OR REPLACE FUNCTION private.room_fit_retention_holds(p_home_id uuid)
RETURNS TABLE(customer_id uuid,room_key text,discovery_at tstzrange,fit_at tstzrange,reference jsonb)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,private AS $$
 WITH horizons AS (
   SELECT j.customer_id,j.owner_key AS room_key,
     CASE WHEN j.pending THEN least(now(),j.room_history_to) ELSE now() END - interval '9600 hours' AS floor_at
   FROM private.energy_learning_jobs j WHERE j.home_id=p_home_id AND j.owner_kind='room'
 ), owned AS (
   SELECT h.*,least(h.floor_at,(SELECT min(b.from_at) FROM private.energy_room_evidence_blocks b
     WHERE b.home_id=p_home_id AND b.room_key=h.room_key AND b.from_at<h.floor_at AND b.to_at>=h.floor_at)) AS keep_from
   FROM horizons h
 )
 SELECT customer_id,room_key,tstzrange(keep_from-interval '1 hour',now()+interval '1 hour','[)'),
   'empty'::tstzrange,NULL::jsonb FROM owned;
$$;

-- Function-scoped flags follow the actual deletion path, never a guess from
-- the age of the row. Explicit retraction of an equally old row stays dirty.
ALTER FUNCTION private.prune_native_room_fit_history(uuid,timestamptz,boolean) SET shs.room_evidence_retention='on';
ALTER FUNCTION private.prune_room_fit_device_history(uuid,timestamptz) SET shs.room_evidence_retention='on';
ALTER FUNCTION private.prune_room_fit_doorway_history(uuid,timestamptz) SET shs.room_evidence_retention='on';

CREATE FUNCTION private.room_evidence_changed(p_home uuid,p_room text,p_revision bigint,p_from timestamptz,p_to timestamptz)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,private AS $$
 SELECT EXISTS(SELECT FROM private.energy_room_evidence_changes
   WHERE home_id=p_home AND room_key IN ('',p_room) AND revision>p_revision
     AND affected && tstzrange(p_from,p_to,'[)'));
$$;

CREATE FUNCTION private.lock_room_evidence(p_home uuid)
RETURNS bigint LANGUAGE plpgsql SET search_path=pg_catalog,private AS $$
DECLARE current_revision bigint;
BEGIN
 INSERT INTO private.energy_room_evidence_clocks(home_id,revision) VALUES(p_home,0) ON CONFLICT DO NOTHING;
 SELECT revision INTO STRICT current_revision FROM private.energy_room_evidence_clocks WHERE home_id=p_home FOR SHARE;
 RETURN current_revision;
END; $$;
REVOKE ALL ON FUNCTION private.room_evidence_changed(uuid,text,bigint,timestamptz,timestamptz),
 private.lock_room_evidence(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.get_energy_room_evidence_work(p_home_id uuid,p_customer_id uuid,p_room_key text,p_binding text,
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
   WHERE home_id=p_home_id),0),'next',next_work);
END; $$;

CREATE FUNCTION public.save_energy_room_evidence_block(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_binding text,p_source_revision bigint,p_from_at timestamptz,p_to_at timestamptz,p_implementation text,
 p_capture_base64 text,p_sha256 text,p_row_count integer,p_solar_retry_at timestamptz DEFAULT NULL,p_solar_after timestamptz DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE owner private.energy_learning_jobs%ROWTYPE; current_revision bigint; bytes bytea;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT * INTO STRICT owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 current_revision:=private.lock_room_evidence(owner.home_id);
 IF p_source_revision IS NULL OR p_source_revision<0 OR p_source_revision>current_revision OR
   NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(owner.home_id) WHERE room_key=owner.owner_key AND binding=p_binding)
   OR private.room_evidence_changed(owner.home_id,owner.owner_key,p_source_revision,p_from_at-interval '1 hour',p_to_at+interval '1 hour')
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

CREATE FUNCTION public.load_energy_room_evidence_blocks(p_home_id uuid,p_customer_id uuid,p_room_key text,p_binding text,
 p_from_at timestamptz,p_to_at timestamptz,p_implementation text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
BEGIN
 IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) OR
   NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(p_home_id) WHERE room_key=p_room_key AND binding=p_binding)
 THEN RAISE EXCEPTION 'Home or room binding mismatch'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('from_at',from_at,'to_at',to_at,'sha256',sha256,
   'row_count',row_count,'capture',replace(encode(capture,'base64'),E'\n','')) ORDER BY from_at),'[]'::jsonb)
   FROM private.energy_room_evidence_blocks WHERE home_id=p_home_id AND customer_id=p_customer_id
     AND room_key=p_room_key AND binding=p_binding AND implementation=p_implementation AND from_at<p_to_at AND to_at>p_from_at);
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_room_evidence_work(uuid,uuid,text,text,timestamptz,timestamptz,text),
 public.save_energy_room_evidence_block(uuid,bigint,bigint,bigint,text,bigint,timestamptz,timestamptz,text,text,text,integer,timestamptz,timestamptz),
 public.load_energy_room_evidence_blocks(uuid,uuid,text,text,timestamptz,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_evidence_work(uuid,uuid,text,text,timestamptz,timestamptz,text),
 public.save_energy_room_evidence_block(uuid,bigint,bigint,bigint,text,bigint,timestamptz,timestamptz,text,text,text,integer,timestamptz,timestamptz),
 public.load_energy_room_evidence_blocks(uuid,uuid,text,text,timestamptz,timestamptz,text) TO service_role;

-- A reviewed operating fact schedules idle owners immediately. For active
-- owners its dated journal entry already provides a precise publication
-- fence. Keep their pinned horizon even when a corrected fit must restart.
CREATE OR REPLACE FUNCTION private.review_room_operation_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE fact private.energy_room_operation_facts%ROWTYPE; job_id uuid;
BEGIN
 fact:=CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
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

CREATE OR REPLACE FUNCTION private.review_heating_meter_exclusion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE home uuid; meter text; first_at timestamptz; last_at timestamptz; room text; general_bad boolean;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 home:=CASE WHEN TG_OP='DELETE' THEN OLD.home_id ELSE NEW.home_id END;
 meter:=CASE WHEN TG_OP='DELETE' THEN OLD.device_key ELSE NEW.device_key END;
 IF TG_OP='UPDATE' AND (NEW.home_id,NEW.device_key,NEW.statistic_id) IS DISTINCT FROM (OLD.home_id,OLD.device_key,OLD.statistic_id)
 THEN RAISE EXCEPTION 'Replace a reviewed meter identity by deleting and inserting its policy'; END IF;
 first_at:=CASE WHEN TG_OP='DELETE' THEN OLD.valid_from WHEN TG_OP='UPDATE' THEN least(OLD.valid_from,NEW.valid_from) ELSE NEW.valid_from END;
 last_at:=CASE WHEN TG_OP='DELETE' THEN OLD.valid_to WHEN TG_OP='UPDATE' THEN greatest(OLD.valid_to,NEW.valid_to) ELSE NEW.valid_to END;
 SELECT d.mapping_summary->>'room_key' INTO room FROM energy_optimisation_devices d
 WHERE d.home_id=home AND d.device_key=meter AND d.retired_at IS NULL AND d.category='heating';
 -- Publication owns the job before its calibration. Match that order so a
 -- source review cannot deadlock with a completed learner publishing its fit.
 PERFORM j.id FROM private.energy_learning_jobs j WHERE j.home_id=home
   AND ((j.owner_kind='room' AND j.owner_key=room) OR (j.owner_kind='device' AND j.owner_key=meter))
   ORDER BY j.id FOR UPDATE;
 IF room IS NOT NULL THEN
   SELECT private.heating_calibration_overlaps(jsonb_build_object('training_from',m.training_from,'training_to',m.training_to),first_at,last_at)
     INTO general_bad FROM energy_optimisation_zone_models m WHERE m.home_id=home AND m.room_key=room;
   UPDATE energy_optimisation_zone_models m SET
     heating_bands=(coalesce(m.heating_bands,'{}'::jsonb)-CASE WHEN general_bad THEN ARRAY['reference','reference_revision','general_attempt'] ELSE ARRAY[]::text[] END)
       ||jsonb_build_object(
         'active',(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM jsonb_array_elements(coalesce(m.heating_bands->'active','[]'::jsonb)) b
           WHERE NOT private.heating_calibration_overlaps(b,first_at,last_at)),
         'candidates',(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM jsonb_array_elements(coalesce(m.heating_bands->'candidates','[]'::jsonb)) b
           WHERE NOT private.heating_calibration_overlaps(b,first_at,last_at)),
         'window_attempts','{}'::jsonb,'window_evidence_updated_at','{}'::jsonb,'attempted','{}'::jsonb,'pending_windows',1)
       ||CASE WHEN general_bad THEN jsonb_build_object('reference_revision',NULL) ELSE '{}'::jsonb END,
     trained=CASE WHEN general_bad THEN false ELSE m.trained END,
     rejection_reason=CASE WHEN general_bad THEN 'insufficient_samples' ELSE m.rejection_reason END,
     gain_c_per_wh=CASE WHEN general_bad THEN NULL ELSE m.gain_c_per_wh END,
     cooling_constant_per_h=CASE WHEN general_bad THEN NULL ELSE m.cooling_constant_per_h END,
     last_attempted_at=NULL,
     last_fit_attempt=jsonb_build_object('status','withdrawn','issues',jsonb_build_array('unreliable_meter_history'),
       'reviewed_device_key',meter,'from',first_at,'to',last_at)
   WHERE m.home_id=home AND m.room_key=room AND (
     (general_bad AND (m.trained OR m.heating_bands->>'reference_revision' IS NOT NULL))
     OR EXISTS(SELECT FROM jsonb_array_elements(coalesce(m.heating_bands->'active','[]'::jsonb)
       ||coalesce(m.heating_bands->'candidates','[]'::jsonb)) b
       WHERE private.heating_calibration_overlaps(b,first_at,last_at))
   );
 END IF;
 UPDATE energy_optimisation_device_operating_points m SET
   operating_points=(coalesce(m.operating_points,'{}'::jsonb)-CASE
     WHEN private.heating_calibration_overlaps(m.operating_points->'reference',first_at,last_at)
       THEN ARRAY['reference'] ELSE ARRAY[]::text[] END)||jsonb_build_object(
     'points',(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM jsonb_array_elements(coalesce(m.operating_points->'points','[]'::jsonb)) b
       WHERE NOT private.heating_calibration_overlaps(b,first_at,last_at)),
     'versioned',coalesce(m.operating_points->'versioned','{}'::jsonb)||jsonb_build_object(
       'candidates',(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM jsonb_array_elements(coalesce(m.operating_points#>'{versioned,candidates}','[]'::jsonb)) b
         WHERE NOT private.heating_calibration_overlaps(b,first_at,last_at)),
       'attempted','{}'::jsonb,'evidence_updated_at','{}'::jsonb,'pending_bands',1)),
   last_attempted_at=NULL,last_fit_attempt=jsonb_build_object('status','withdrawn','issues',jsonb_build_array('unreliable_meter_history'))
 WHERE m.home_id=home AND m.device_key=meter;
 -- An active room either lost an accepted model (its base revision changed)
 -- or has a dated source-journal fence. Preserve its pinned generation in
 -- both cases. Idle rooms and the independent electrical learner are due.
 UPDATE private.energy_learning_jobs j SET pending=true,generation=j.generation+1,fence=j.fence+1,
   wake_after=now(),lease_until=NULL,last_error=NULL,finished_at=NULL,attempts=0
 WHERE j.home_id=home AND ((j.owner_kind='room' AND j.owner_key=room AND NOT j.pending)
   OR (j.owner_kind='device' AND j.owner_key=meter));
 PERFORM private.wake_energy_learning_job(j.id) FROM private.energy_learning_jobs j
 WHERE j.home_id=home AND j.pending AND ((j.owner_kind='room' AND j.owner_key=room)
   OR (j.owner_kind='device' AND j.owner_key=meter));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
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
 captured_revision bigint; live_revision bigint; complete_scope boolean; changed boolean;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT * INTO STRICT owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 SELECT metadata INTO envelope FROM private.energy_room_fit_progress WHERE job_id=p_job_id AND generation=p_generation
   AND base_revision=p_revision AND jsonb_array_length(cells)=p_expected_cursor;
 IF p_expected_cursor IS DISTINCT FROM 18 OR envelope->>'version' IS DISTINCT FROM '4' THEN RETURN false; END IF;
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
 SELECT COALESCE(range_agg(tstzrange(b.from_at,b.to_at,'[)')),'{}'::tstzmultirange) @> tstzrange(start_at,finish_at,'[)')
   AND NOT coalesce(bool_or(EXISTS(SELECT FROM private.energy_room_evidence_changes d WHERE d.home_id=b.home_id
     AND d.room_key IN ('',b.room_key) AND d.revision>b.source_revision AND d.revision<=captured_revision
     AND d.affected && tstzrange(greatest(start_at,b.from_at-interval '1 hour'),least(finish_at,b.to_at+interval '1 hour'),'[)'))),false)
 INTO complete_scope FROM private.energy_room_evidence_blocks b WHERE b.home_id=owner.home_id AND b.room_key=owner.owner_key
   AND b.customer_id=owner.customer_id AND b.binding=v_binding AND b.implementation=evidence->>'implementation'
   AND b.from_at<finish_at AND b.to_at>start_at;
 IF NOT complete_scope OR captured_revision>live_revision OR private.room_evidence_changed(owner.home_id,owner.owner_key,
   captured_revision,start_at,finish_at) OR NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(owner.home_id) c
   WHERE c.room_key=owner.owner_key AND c.binding=captured->>'binding') THEN
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
     OR training IS DISTINCT FROM p_model#>'{last_fit_attempt,learning}'
     OR p_run_ledger->>'assessed_against' IS DISTINCT FROM response_revision OR p_run_ledger->>'policy' IS DISTINCT FROM policy
     OR jsonb_typeof(p_run_ledger->'runs') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid shared transition support'; END IF;
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

CREATE FUNCTION public.get_energy_room_run_assessments(p_home_id uuid,p_room_key text,p_revision text,p_offset integer,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.homes h WHERE h.id=p_home_id AND public.can_access_energy_billing_customer(h.customer_id))
 THEN RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid assessment page'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(r.run ORDER BY r.position),'[]'::jsonb) FROM (
   SELECT a.position,a.run FROM private.energy_room_run_assessments a WHERE a.home_id=p_home_id AND a.room_key=p_room_key
   AND a.response_revision=p_revision AND a.position>p_offset ORDER BY a.position LIMIT p_limit
 ) r);
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_room_run_assessments(uuid,text,text,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_energy_room_run_assessments(uuid,text,text,integer,integer) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_energy_room_response_evidence(p_home_id uuid,p_room_key text)
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
     'transition_calibration',m.heating_bands#>'{reference,learning_evidence,transition_calibration}',
     'run_calibration',m.heating_bands#>'{reference,learning_evidence,run_calibration}') END
     FROM public.energy_optimisation_zone_models m WHERE m.home_id=p_home_id AND m.room_key=p_room_key),
   'ledgers',(SELECT coalesce(jsonb_agg(jsonb_build_object('scope_key',l.scope_key,'model_revision',l.model_revision,
     'created_at',l.created_at,'evidence',CASE WHEN l.evidence->>'policy'='shared_interval_transitions_v1' THEN
       l.evidence||jsonb_build_object('runs',public.get_energy_room_run_assessments(p_home_id,p_room_key,l.evidence->>'assessed_against',0,50))
       ELSE l.evidence END) ORDER BY l.scope_key),'[]'::jsonb)
     FROM private.energy_room_run_ledgers l WHERE l.home_id=p_home_id AND l.room_key=p_room_key));
END; $$;

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
        OR (heating_bindings ? (o->>'key') AND heating_bands->>'calibration_policy' IS DISTINCT FROM 'shared_interval_transitions_v1')
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


-- Replace old disposable numerical scratch on the next claim.
UPDATE private.energy_learning_jobs SET pending=true,generation=generation+1,fence=fence+1,
  lease_until=NULL,wake_after=now()+interval '15 minutes',attempts=0,last_error=NULL,finished_at=NULL WHERE owner_kind='room';

ALTER TABLE private.energy_room_fit_progress DROP CONSTRAINT energy_room_fit_progress_cells_check;
ALTER TABLE private.energy_room_fit_progress ADD CONSTRAINT energy_room_fit_progress_cells_check
 CHECK(jsonb_typeof(cells)='array' AND jsonb_array_length(cells)<=18);
CREATE OR REPLACE FUNCTION public.checkpoint_energy_room_fit_cells(
 p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_expected_state jsonb,p_cells jsonb,p_heat_state jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE added integer; next_cursor integer;
BEGIN
 p_expected_state:=nullif(p_expected_state,'null'::jsonb);
 p_heat_state:=nullif(p_heat_state,'null'::jsonb);
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF jsonb_typeof(p_cells) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid room fit cells'; END IF;
 added:=jsonb_array_length(p_cells);
 next_cursor:=p_expected_cursor+added;
 IF p_expected_cursor IS NULL OR p_expected_cursor<0 OR next_cursor>18
   OR (added=0 AND p_heat_state IS NULL)
   OR EXISTS(SELECT FROM jsonb_array_elements(p_cells) cell WHERE jsonb_typeof(cell)<>'object') THEN
   RAISE EXCEPTION 'Invalid room fit cells';
 END IF;
 IF p_heat_state IS NOT NULL AND (next_cursor>=18 OR jsonb_typeof(p_heat_state)<>'object'
   OR p_heat_state->>'version' IS DISTINCT FROM '2'
   OR (p_heat_state->>'index')::integer IS DISTINCT FROM next_cursor) THEN
   RAISE EXCEPTION 'Invalid room response iteration';
 END IF;
 -- Compare the authoritative prefix and partial state the batch started from.
 -- A lost reply or stale claimant can therefore never append cells twice or
 -- apply an iteration twice.
 UPDATE private.energy_room_fit_progress SET cells=cells||p_cells,
   metadata=CASE WHEN p_heat_state IS NULL THEN metadata-'heat_state'
     ELSE jsonb_set(metadata,'{heat_state}',p_heat_state) END
 WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
   AND jsonb_array_length(cells)=p_expected_cursor
   AND nullif(metadata->'heat_state','null'::jsonb) IS NOT DISTINCT FROM p_expected_state;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;
