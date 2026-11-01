-- Independent weather truth and TEST-only automatic quality evaluations.
ALTER TABLE public.energy_market_collection_batches DROP CONSTRAINT energy_market_collection_batches_kind_check,
 ADD CONSTRAINT energy_market_collection_batches_kind_check CHECK(kind IN ('day_ahead','generation','market_context','weather_truth'));
ALTER TABLE public.energy_market_forecast_observations DROP CONSTRAINT energy_market_observation_product,
 ADD CONSTRAINT energy_market_observation_product CHECK(
  (zone='SE3' AND dataset IN ('wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range','generation_actual',
   'sweden_hydrology','production_outages','generation_outages','installed_generation_units','load_actual','smhi_wind_10m_observed','smhi_temperature_2m_observed')) OR
  (zone IN ('SE2','SE4','NO1','FI','DK1') AND dataset IN ('neighbour_load_day_ahead','neighbour_wind_day_ahead')) OR
  (zone='NORDIC_CCR' AND dataset IN ('jao_max_net_positions','jao_max_exchanges')));
CREATE INDEX energy_market_batches_latest ON public.energy_market_collection_batches(kind,requested_at DESC);
CREATE INDEX energy_market_assessment_station ON public.energy_market_observation_assessments((facts->>'station_id'),observation_id);
CREATE FUNCTION private.validate_market_truth_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NEW.dataset IN ('smhi_wind_10m_observed','smhi_temperature_2m_observed') THEN
  IF NOT EXISTS(SELECT 1 FROM public.energy_market_collection_batches b CROSS JOIN LATERAL jsonb_array_elements(b.plan) r
   WHERE b.id=NEW.batch_id AND r->>'key'=NEW.request_key AND r->>'station_id'=NEW.result->'request'->>'station_id'
    AND NEW.result->'request'->>'dataset'=NEW.dataset
    AND (NEW.result->>'status'<>'data' OR (NEW.result->'document'->>'station_id'=r->>'station_id'
      AND NEW.result->'document'->>'parameter'=CASE NEW.dataset WHEN 'smhi_wind_10m_observed' THEN '4' ELSE '1' END))) THEN
   RAISE EXCEPTION 'Weather measurement does not match station intent';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER validate_market_truth_identity BEFORE INSERT ON public.energy_market_forecast_observations
 FOR EACH ROW EXECUTE FUNCTION private.validate_market_truth_identity();
REVOKE ALL ON FUNCTION private.validate_market_truth_identity() FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.energy_market_quality_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('collection_health','weather_accuracy','demand_accuracy')),
 slot timestamptz NOT NULL,
 evaluator_version text NOT NULL CHECK(evaluator_version='market-monitor-v1'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(kind,slot,evaluator_version)
);
CREATE TABLE public.energy_market_quality_evaluations (
 id uuid PRIMARY KEY REFERENCES public.energy_market_quality_intents(id),
 summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.energy_market_quality_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 evaluation_id uuid NOT NULL REFERENCES public.energy_market_quality_evaluations(id),
 owner_kind text NOT NULL,
 problem_key text NOT NULL,
 event text NOT NULL CHECK(event IN ('opened','changed','recovered')),
 severity text NOT NULL CHECK(severity IN ('info','problem')),
 fingerprint jsonb NOT NULL,
 detail jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(evaluation_id,problem_key)
);
CREATE INDEX energy_market_quality_event_heads ON public.energy_market_quality_events(problem_key,sequence DESC);
ALTER TABLE public.energy_market_quality_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_market_quality_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_market_quality_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_market_quality_intents,public.energy_market_quality_evaluations,public.energy_market_quality_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.energy_market_quality_intents,public.energy_market_quality_evaluations,public.energy_market_quality_events TO service_role;

CREATE FUNCTION private.open_test_market_quality(p_kind text,p_slot timestamptz,p_manifest jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE identifier uuid;
BEGIN
 INSERT INTO public.energy_market_quality_intents(kind,slot,evaluator_version,manifest)
 VALUES(p_kind,p_slot,'market-monitor-v1',p_manifest) ON CONFLICT(kind,slot,evaluator_version) DO NOTHING RETURNING id INTO identifier;
 IF identifier IS NULL THEN SELECT id INTO STRICT identifier FROM public.energy_market_quality_intents
  WHERE kind=p_kind AND slot=p_slot AND evaluator_version='market-monitor-v1'; END IF;
 RETURN identifier;
END; $$;
CREATE FUNCTION private.complete_test_market_quality(p_id uuid,p_summary jsonb,p_problems jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE intent public.energy_market_quality_intents%ROWTYPE; problem jsonb; prior record;
BEGIN
 -- One writer owns transition ordering. This lock is independent of the household price ledger.
 PERFORM pg_advisory_xact_lock(hashtext('test-market-quality-transitions'));
 SELECT * INTO STRICT intent FROM public.energy_market_quality_intents WHERE id=p_id;
 IF jsonb_typeof(p_problems) IS DISTINCT FROM 'array' OR jsonb_array_length(p_problems)>200 OR
  (SELECT count(*) FROM jsonb_array_elements(p_problems))<>(SELECT count(DISTINCT p->>'key') FROM jsonb_array_elements(p_problems) p) THEN
  RAISE EXCEPTION 'Malformed quality problems'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_problems) p WHERE jsonb_typeof(p) IS DISTINCT FROM 'object' OR
  p->>'key' IS NULL OR p->>'severity' IS NULL OR p->>'severity' NOT IN ('info','problem') OR
  jsonb_typeof(p->'fingerprint') IS DISTINCT FROM 'object' OR jsonb_typeof(p->'detail') IS DISTINCT FROM 'object') THEN
  RAISE EXCEPTION 'Malformed quality problem'; END IF;
 INSERT INTO public.energy_market_quality_evaluations(id,summary) VALUES(p_id,p_summary) ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN
  IF (SELECT summary FROM public.energy_market_quality_evaluations WHERE id=p_id) IS DISTINCT FROM p_summary THEN
   RAISE EXCEPTION 'Quality result identity already has different evidence'; END IF;
  RETURN;
 END IF;
 -- Late completion may retain evidence but cannot replace the state of a newer monitor execution.
 IF EXISTS(SELECT 1 FROM public.energy_market_quality_evaluations e JOIN public.energy_market_quality_intents i USING(id)
  WHERE i.kind=intent.kind AND i.slot>intent.slot) THEN RETURN; END IF;
 FOR prior IN SELECT * FROM (SELECT DISTINCT ON(problem_key) * FROM public.energy_market_quality_events
  WHERE owner_kind=intent.kind ORDER BY problem_key,sequence DESC) latest WHERE event<>'recovered' LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_problems) p WHERE p->>'key'=prior.problem_key) THEN
   INSERT INTO public.energy_market_quality_events(evaluation_id,owner_kind,problem_key,event,severity,fingerprint,detail)
    VALUES(p_id,intent.kind,prior.problem_key,'recovered',prior.severity,prior.fingerprint,prior.detail);
  END IF;
 END LOOP;
 FOR problem IN SELECT * FROM jsonb_array_elements(p_problems) LOOP
  SELECT * INTO prior FROM public.energy_market_quality_events WHERE problem_key=problem->>'key' AND owner_kind=intent.kind ORDER BY sequence DESC LIMIT 1;
  IF NOT FOUND OR prior.event='recovered' THEN
   INSERT INTO public.energy_market_quality_events(evaluation_id,owner_kind,problem_key,event,severity,fingerprint,detail)
    VALUES(p_id,intent.kind,problem->>'key','opened',problem->>'severity',problem->'fingerprint',problem->'detail');
  ELSIF prior.fingerprint IS DISTINCT FROM problem->'fingerprint' OR prior.severity IS DISTINCT FROM problem->>'severity' THEN
   INSERT INTO public.energy_market_quality_events(evaluation_id,owner_kind,problem_key,event,severity,fingerprint,detail)
    VALUES(p_id,intent.kind,problem->>'key','changed',problem->>'severity',problem->'fingerprint',problem->'detail');
  END IF;
 END LOOP;
END; $$;

CREATE FUNCTION public.begin_test_market_accuracy(p_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE from_at timestamptz; to_at timestamptz; identifier uuid; manifest jsonb;
BEGIN
 IF p_kind NOT IN ('weather_accuracy','demand_accuracy') THEN RAISE EXCEPTION 'Unknown accuracy evaluation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RAISE EXCEPTION 'TEST archive is not enabled'; END IF;
 to_at:=((clock_timestamp() AT TIME ZONE 'Europe/Stockholm')::date)::timestamp AT TIME ZONE 'Europe/Stockholm';
 from_at:=((clock_timestamp() AT TIME ZONE 'Europe/Stockholm')::date-27)::timestamp AT TIME ZONE 'Europe/Stockholm';
 SELECT jsonb_build_object('snapshot_at',statement_timestamp(),'from',from_at,'to',to_at,
  'forecast_ids',coalesce((SELECT jsonb_agg(id ORDER BY sequence) FROM (
   SELECT DISTINCT ON(o.dataset,(o.recorded_at AT TIME ZONE 'Europe/Stockholm')::date) o.id,o.sequence
   FROM public.energy_market_forecast_observations o JOIN public.energy_market_observation_assessments a ON a.observation_id=o.id AND a.assessor_version='market-quality-v1'
   WHERE o.zone='SE3' AND a.status='data' AND o.recorded_at>=from_at-interval '9 days' AND o.recorded_at<to_at
    AND ((p_kind='weather_accuracy' AND o.dataset='weather_medium_range') OR
     (p_kind='demand_accuracy' AND o.dataset IN ('load_day_ahead','load_week_ahead')))
   ORDER BY o.dataset,(o.recorded_at AT TIME ZONE 'Europe/Stockholm')::date,o.sequence DESC) f),'[]'::jsonb),
  'truth_ids',coalesce((SELECT jsonb_agg(id ORDER BY sequence) FROM (
   SELECT DISTINCT ON(o.dataset,coalesce(a.facts->>'station_id','')) o.id,o.sequence
   FROM public.energy_market_forecast_observations o JOIN public.energy_market_observation_assessments a ON a.observation_id=o.id AND a.assessor_version='market-quality-v1'
   WHERE o.zone='SE3' AND a.status='data' AND o.requested_to>from_at AND o.requested_from<to_at
    AND ((p_kind='weather_accuracy' AND o.dataset IN ('smhi_wind_10m_observed','smhi_temperature_2m_observed')) OR
     (p_kind='demand_accuracy' AND o.dataset='load_actual'))
   ORDER BY o.dataset,coalesce(a.facts->>'station_id',''),o.sequence DESC) t),'[]'::jsonb)) INTO manifest;
 identifier:=private.open_test_market_quality(p_kind,date_trunc('day',clock_timestamp()),manifest);
 RETURN (SELECT to_jsonb(i)||jsonb_build_object('complete',EXISTS(SELECT 1 FROM public.energy_market_quality_evaluations e WHERE e.id=i.id))
  FROM public.energy_market_quality_intents i WHERE id=identifier);
END; $$;
CREATE FUNCTION public.complete_test_market_accuracy(p_id uuid,p_summary jsonb,p_problems jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.energy_market_quality_intents WHERE id=p_id AND kind IN ('weather_accuracy','demand_accuracy')) THEN
  RAISE EXCEPTION 'Unknown accuracy intent'; END IF;
 PERFORM private.complete_test_market_quality(p_id,p_summary,p_problems);
END; $$;

CREATE FUNCTION private.evaluate_test_market_health()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE at_time timestamptz:=clock_timestamp(); identifier uuid; problems jsonb:='[]'; batches jsonb; heads jsonb;
 batch record; source record; cell jsonb; site jsonb; lead jsonb; last_good timestamptz; cadence interval; code text; detail jsonb; checks integer:=0;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RETURN NULL; END IF;
 -- Skip a completed slot before consulting changing evidence.
 SELECT i.id INTO identifier FROM public.energy_market_quality_intents i JOIN public.energy_market_quality_evaluations e USING(id)
  WHERE i.kind='collection_health' AND i.slot=date_trunc('hour',at_time) AND i.evaluator_version='market-monitor-v1';
 IF FOUND THEN RETURN identifier; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]') INTO batches FROM (SELECT DISTINCT ON(kind) id,kind,requested_at,plan FROM public.energy_market_collection_batches ORDER BY kind,requested_at DESC,id DESC) b;
 FOR batch IN SELECT k.kind,k.hours,b.* FROM (VALUES('day_ahead',1),('generation',6),('market_context',6),('weather_truth',6)) k(kind,hours)
  LEFT JOIN LATERAL(SELECT id,requested_at,plan FROM public.energy_market_collection_batches WHERE kind=k.kind ORDER BY requested_at DESC,id DESC LIMIT 1) b ON true LOOP
  checks:=checks+1;
  IF batch.id IS NULL OR at_time-batch.requested_at > make_interval(hours=>2*batch.hours,mins=>15) THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('key','collection/'||batch.kind||'/stale','severity','problem','fingerprint',jsonb_build_object('rule','stale'),
    'detail',jsonb_build_object('kind',batch.kind,'last_batch',batch.requested_at,'cadence_hours',batch.hours)));
  END IF;
  IF batch.id IS NOT NULL AND at_time-batch.requested_at>interval '15 minutes' AND
   (SELECT count(*) FROM public.energy_market_forecast_observations WHERE batch_id=batch.id)<jsonb_array_length(batch.plan) THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('key','collection/'||batch.kind||'/interrupted','severity','problem','fingerprint',jsonb_build_object('rule','interrupted'),
    'detail',jsonb_build_object('batch_id',batch.id,'expected',jsonb_array_length(batch.plan),'saved',(SELECT count(*) FROM public.energy_market_forecast_observations WHERE batch_id=batch.id))));
  END IF;
 END LOOP;
 -- Assessment projections carry outcomes without reading large raw result JSON.
 SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO heads FROM (
  SELECT DISTINCT ON(o.dataset,o.zone,coalesce(a.facts->>'station_id','')) o.dataset,o.zone,o.id,o.sequence,o.requested_at,o.requested_from,o.requested_to,
   a.status,a.error_code,a.facts,coalesce(a.facts->>'station_id','') station_id
  FROM public.energy_market_forecast_observations o JOIN public.energy_market_observation_assessments a ON a.observation_id=o.id AND a.assessor_version='market-quality-v1'
  ORDER BY o.dataset,o.zone,coalesce(a.facts->>'station_id',''),o.sequence DESC) s;
 FOR source IN SELECT * FROM jsonb_to_recordset(heads) AS s(dataset text,zone text,id uuid,sequence bigint,requested_at timestamptz,requested_from timestamptz,requested_to timestamptz,status text,error_code text,facts jsonb,station_id text) LOOP
  checks:=checks+1;
  code:=NULL;
  cadence:=CASE WHEN source.dataset IN ('wind_day_ahead','load_day_ahead','jao_max_net_positions','jao_max_exchanges') THEN interval '1 hour' ELSE interval '6 hours' END;
  SELECT max(o.requested_at) INTO last_good FROM public.energy_market_forecast_observations o JOIN public.energy_market_observation_assessments a ON a.observation_id=o.id AND a.assessor_version='market-quality-v1'
   WHERE o.dataset=source.dataset AND o.zone=source.zone AND a.status='data' AND coalesce(a.facts->>'station_id','')=source.station_id;
  IF source.status='parse_error' THEN code:='parse_error';
  ELSIF last_good IS NULL OR at_time-last_good>2*cadence+interval '15 minutes' THEN code:='stale_success';
  ELSIF coalesce(jsonb_array_length(source.facts->'issues'),0)>0 OR coalesce(jsonb_array_length(source.facts->'missing_se3_labels'),0)>0 THEN code:='semantic_issues';
  END IF;
  IF code IS NOT NULL THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('key','source/'||source.dataset||'/'||source.zone||'/'||source.station_id,
    'severity','problem','fingerprint',jsonb_build_object('rule',code,'error',source.error_code,'issues',source.facts->'issues','missing_labels',source.facts->'missing_se3_labels'),
    'detail',jsonb_build_object('dataset',source.dataset,'zone',source.zone,'station_id',source.station_id,'last_success',last_good,'latest_attempt',source.requested_at,'status',source.status)));
  END IF;
  IF source.facts->>'kind'='station_hourly_truth' AND (source.facts->'previous_day'->>'approved')::integer<(source.facts->'previous_day'->>'expected')::integer THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('key','truth/'||source.station_id||'/'||source.dataset||'/coverage','severity','problem',
    'fingerprint',jsonb_build_object('rule','incomplete_approved_day'),'detail',source.facts->'previous_day'));
  END IF;
  IF source.facts->>'kind'='weather_sites' THEN
   FOR lead IN SELECT * FROM jsonb_array_elements(source.facts->'lead_coverage') LOOP
    FOR site IN SELECT * FROM jsonb_array_elements(lead->'sites') LOOP
     IF EXISTS(SELECT 1 FROM jsonb_each_text(site->'non_null_samples') v WHERE v.value::integer<(lead->>'expected_samples')::integer) THEN
      problems:=problems||jsonb_build_array(jsonb_build_object('key','weather/'||(site->>'station_id')||'/D+'||(lead->>'lead_days'),
       'severity','problem','fingerprint',jsonb_build_object('rule','incomplete_forecast_day'),'detail',jsonb_build_object('day',lead->>'day','site',site)));
     END IF;
    END LOOP;
   END LOOP;
  END IF;
  IF source.facts->>'kind' IN ('native_intervals','daily_extrema','network_bounds') THEN
   FOR cell IN SELECT * FROM jsonb_array_elements(source.facts->'series') LOOP
    IF (cell->>'conflictMs')::numeric>0 THEN code:='conflicting_intervals';
    ELSIF cell ? 'first' AND greatest(0,extract(epoch FROM (least(source.requested_to,(cell->>'last')::timestamptz)-greatest(source.requested_from,(cell->>'first')::timestamptz)))*1000)>
      (cell->>'coveredMs')::numeric+(cell->>'conflictMs')::numeric THEN code:='internal_gap'; ELSE code:=NULL; END IF;
    IF code IS NOT NULL THEN
     problems:=problems||jsonb_build_array(jsonb_build_object('key','coverage/'||source.dataset||'/'||source.zone||'/'||coalesce(cell->>'key',cell->>'label'),
      'severity','problem','fingerprint',jsonb_build_object('rule',code),'detail',cell));
    END IF;
   END LOOP;
  END IF;
 END LOOP;
 FOR code IN SELECT unnest(ARRAY['weather_accuracy','demand_accuracy']) LOOP
  SELECT max(e.recorded_at) INTO last_good FROM public.energy_market_quality_evaluations e JOIN public.energy_market_quality_intents i USING(id) WHERE i.kind=code;
  IF last_good IS NULL OR at_time-last_good>interval '36 hours' THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('key','monitor/'||code||'/stale','severity','problem',
    'fingerprint',jsonb_build_object('rule','stale_evaluation'),'detail',jsonb_build_object('last_completed',last_good)));
  END IF;
 END LOOP;
 identifier:=private.open_test_market_quality('collection_health',date_trunc('hour',at_time),jsonb_build_object('snapshot_at',at_time,'batches',batches,'source_heads',heads));
 PERFORM private.complete_test_market_quality(identifier,jsonb_build_object('checks',checks,'problems',jsonb_array_length(problems)),problems);
 RETURN identifier;
END; $$;

CREATE FUNCTION public.read_test_market_quality_status(p_since bigint DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH page AS (SELECT * FROM public.energy_market_quality_events WHERE sequence>greatest(p_since,0) ORDER BY sequence LIMIT 200),
 latest AS (SELECT DISTINCT ON(i.kind) i.kind,i.id,i.slot,i.manifest,e.recorded_at,e.summary FROM public.energy_market_quality_evaluations e JOIN public.energy_market_quality_intents i USING(id) ORDER BY i.kind,i.slot DESC),
 heads AS (SELECT DISTINCT ON(owner_kind,problem_key) * FROM public.energy_market_quality_events ORDER BY owner_kind,problem_key,sequence DESC)
 SELECT jsonb_build_object('at',statement_timestamp(),'events',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY sequence) FROM page p),'[]'::jsonb),
  'cursor',coalesce((SELECT max(sequence) FROM page),greatest(p_since,0)),
  'open_problems',coalesce((SELECT jsonb_agg(to_jsonb(h)) FROM heads h WHERE event<>'recovered'),'[]'::jsonb),
  'latest',coalesce((SELECT jsonb_object_agg(kind,jsonb_build_object('id',id,'slot',slot,'completed_at',recorded_at,'summary',summary-ARRAY['days','samples','provenance'])) FROM latest),'{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.begin_test_market_accuracy(text),public.complete_test_market_accuracy(uuid,jsonb,jsonb),public.read_test_market_quality_status(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_test_market_accuracy(text),public.complete_test_market_accuracy(uuid,jsonb,jsonb),public.read_test_market_quality_status(bigint) TO service_role;
REVOKE ALL ON FUNCTION private.open_test_market_quality(text,timestamptz,jsonb),private.complete_test_market_quality(uuid,jsonb,jsonb),private.evaluate_test_market_health() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.request_test_weather_truth()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
 SELECT * INTO config FROM private.test_market_archive_config WHERE singleton; IF NOT FOUND THEN RETURN; END IF;
 PERFORM net.http_post(url:=config.function_url,headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),body:='{"truth":true}'::jsonb,timeout_milliseconds:=180000);
END; $$;
CREATE FUNCTION private.request_test_market_accuracy(p_kind text)
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
 IF p_kind NOT IN ('weather_accuracy','demand_accuracy') THEN RAISE EXCEPTION 'Unknown accuracy kind'; END IF;
 SELECT * INTO config FROM private.test_market_archive_config WHERE singleton; IF NOT FOUND THEN RETURN; END IF;
 PERFORM net.http_post(url:='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-quality',
  headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
  body:=jsonb_build_object('kind',p_kind),timeout_milliseconds:=180000);
END; $$;
CREATE FUNCTION private.enable_test_market_quality()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RAISE EXCEPTION 'Enable TEST archive first'; END IF;
 PERFORM cron.schedule('test-energy-weather-truth','37 */6 * * *','SELECT private.request_test_weather_truth()');
 PERFORM cron.schedule('test-energy-market-health','55 * * * *','SELECT private.evaluate_test_market_health()');
 PERFORM cron.schedule('test-energy-weather-accuracy','45 9 * * *',$job$SELECT private.request_test_market_accuracy('weather_accuracy')$job$);
 PERFORM cron.schedule('test-energy-demand-accuracy','50 9 * * *',$job$SELECT private.request_test_market_accuracy('demand_accuracy')$job$);
END; $$;
REVOKE ALL ON FUNCTION private.request_test_weather_truth(),private.request_test_market_accuracy(text),private.enable_test_market_quality() FROM PUBLIC,anon,authenticated,service_role;
