-- Verified NUCS border publications. Preserve native NTC and outage semantics; no summed capacity.
ALTER TABLE public.energy_market_collection_batches DROP CONSTRAINT energy_market_collection_batches_kind_check,
 ADD CONSTRAINT energy_market_collection_batches_kind_check CHECK(kind IN ('day_ahead','generation','market_context','weather_truth','regional_context'));
ALTER TABLE public.energy_market_forecast_observations DROP CONSTRAINT energy_market_observation_product,
 ADD CONSTRAINT energy_market_observation_product CHECK(
  (zone='SE3' AND dataset IN ('wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range','generation_actual',
   'sweden_hydrology','production_outages','generation_outages','installed_generation_units','load_actual','smhi_wind_10m_observed','smhi_temperature_2m_observed',
   'nucs_week_ahead_ntc','nucs_transmission_outages')) OR
  (zone IN ('SE2','SE4','NO1','FI','DK1') AND dataset IN ('neighbour_load_day_ahead','neighbour_wind_day_ahead')) OR
  (zone='NORDIC_CCR' AND dataset IN ('jao_max_net_positions','jao_max_exchanges')));
CREATE FUNCTION private.validate_market_border_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NEW.dataset IN ('nucs_week_ahead_ntc','nucs_transmission_outages') AND NOT EXISTS(
  SELECT 1 FROM public.energy_market_collection_batches b CROSS JOIN LATERAL jsonb_array_elements(b.plan) r
  WHERE b.id=NEW.batch_id AND r->>'key'=NEW.request_key AND r->>'neighbour'=NEW.result->'request'->>'neighbour'
   AND r->>'direction'=NEW.result->'request'->>'direction' AND NEW.result->'request'->>'dataset'=NEW.dataset) THEN
  RAISE EXCEPTION 'Regional observation does not match border intent';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER validate_market_border_identity BEFORE INSERT ON public.energy_market_forecast_observations
 FOR EACH ROW EXECUTE FUNCTION private.validate_market_border_identity();
REVOKE ALL ON FUNCTION private.validate_market_border_identity() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.evaluate_test_market_health()
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
 FOR batch IN SELECT k.kind,k.hours,b.* FROM (VALUES('day_ahead',1),('generation',6),('market_context',6),('weather_truth',6),('regional_context',6)) k(kind,hours)
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
  SELECT DISTINCT ON(o.dataset,o.zone,coalesce(a.facts->>'scope_key',a.facts->>'station_id','')) o.dataset,o.zone,o.id,o.sequence,o.requested_at,o.requested_from,o.requested_to,
   a.status,a.error_code,a.facts,coalesce(a.facts->>'scope_key',a.facts->>'station_id','') scope_key
  FROM public.energy_market_forecast_observations o JOIN public.energy_market_observation_assessments a ON a.observation_id=o.id AND a.assessor_version='market-quality-v1'
  ORDER BY o.dataset,o.zone,coalesce(a.facts->>'scope_key',a.facts->>'station_id',''),o.sequence DESC) s;
 FOR source IN SELECT * FROM jsonb_to_recordset(heads) AS s(dataset text,zone text,id uuid,sequence bigint,requested_at timestamptz,requested_from timestamptz,requested_to timestamptz,status text,error_code text,facts jsonb,scope_key text) LOOP
  checks:=checks+1;
  code:=NULL;
  cadence:=CASE WHEN source.dataset IN ('wind_day_ahead','load_day_ahead','jao_max_net_positions','jao_max_exchanges') THEN interval '1 hour' ELSE interval '6 hours' END;
  SELECT max(o.requested_at) INTO last_good FROM public.energy_market_forecast_observations o JOIN public.energy_market_observation_assessments a ON a.observation_id=o.id AND a.assessor_version='market-quality-v1'
   WHERE o.dataset=source.dataset AND o.zone=source.zone AND (a.status='data' OR (o.dataset='nucs_transmission_outages' AND a.status='no_data')) AND coalesce(a.facts->>'scope_key',a.facts->>'station_id','')=source.scope_key;
  IF source.status='parse_error' THEN code:='parse_error';
  ELSIF last_good IS NULL OR at_time-last_good>2*cadence+interval '15 minutes' THEN code:='stale_success';
  ELSIF coalesce(jsonb_array_length(source.facts->'issues'),0)>0 OR coalesce(jsonb_array_length(source.facts->'missing_se3_labels'),0)>0 THEN code:='semantic_issues';
  END IF;
  IF code IS NOT NULL THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('key','source/'||source.dataset||'/'||source.zone||'/'||source.scope_key,
    'severity','problem','fingerprint',jsonb_build_object('rule',code,'error',source.error_code,'issues',source.facts->'issues','missing_labels',source.facts->'missing_se3_labels'),
    'detail',jsonb_build_object('dataset',source.dataset,'zone',source.zone,'scope',source.scope_key,'last_success',last_good,'latest_attempt',source.requested_at,'status',source.status)));
  END IF;
  IF source.facts->>'kind'='station_hourly_truth' AND (source.facts->'previous_day'->>'approved')::integer<(source.facts->'previous_day'->>'expected')::integer THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('key','truth/'||source.scope_key||'/'||source.dataset||'/coverage','severity','problem',
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

CREATE FUNCTION private.request_test_regional_context()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
 SELECT * INTO config FROM private.test_market_archive_config WHERE singleton; IF NOT FOUND THEN RETURN; END IF;
 PERFORM net.http_post(url:=config.function_url,headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
  body:='{"regional":true}'::jsonb,timeout_milliseconds:=180000);
END; $$;
CREATE FUNCTION private.enable_test_regional_context()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RAISE EXCEPTION 'Enable TEST archive first'; END IF;
 PERFORM cron.schedule('test-energy-regional-context','47 */6 * * *','SELECT private.request_test_regional_context()');
END; $$;
REVOKE ALL ON FUNCTION private.request_test_regional_context(),private.enable_test_regional_context() FROM PUBLIC,anon,authenticated,service_role;
