-- Stop acquiring Open-Meteo data. Frozen comparison outputs keep their evidence IDs.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('test-energy-weather-price','test-energy-price-weather','test-energy-weather-accuracy');
DROP FUNCTION private.enable_test_weather_price();
DROP FUNCTION private.replay_test_weather_price(timestamptz,timestamptz);
DROP FUNCTION private.request_test_weather_price(timestamptz);
REVOKE EXECUTE ON FUNCTION public.read_test_weather_price_context(timestamptz),public.record_test_weather_price(uuid,jsonb) FROM service_role;

CREATE OR REPLACE FUNCTION private.enable_test_market_quality()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RAISE EXCEPTION 'Enable TEST archive first'; END IF;
 PERFORM cron.schedule('test-energy-weather-truth','37 */6 * * *','SELECT private.request_test_weather_truth()');
 PERFORM cron.schedule('test-energy-market-health','55 * * * *','SELECT private.evaluate_test_market_health()');
 PERFORM cron.schedule('test-energy-demand-accuracy','50 9 * * *',$job$SELECT private.request_test_market_accuracy('demand_accuracy')$job$);
END; $$;

-- Preserve the legacy observation identities and their archived outcome status for
-- saved forecast references. Remove the payloads, coordinate samples and hashes.
ALTER TABLE public.energy_market_forecast_observations
 DROP CONSTRAINT energy_market_forecast_observations_weather_evidence_check,
 DROP CONSTRAINT energy_market_observation_batch_required,
 ADD CONSTRAINT energy_market_observation_batch_required CHECK(
   (batch_id IS NOT NULL AND request_key IS NOT NULL) OR
   (dataset='weather_medium_range' AND result->>'retired_provider'='open_meteo')) NOT VALID;
DELETE FROM public.energy_market_observation_assessments a USING public.energy_market_forecast_observations o
 WHERE a.observation_id=o.id AND o.dataset='weather_medium_range';
UPDATE public.energy_market_forecast_observations
 SET result=jsonb_build_object('status',result->'status','retired_provider','open_meteo')
 WHERE dataset='weather_medium_range';
ALTER TABLE public.energy_market_forecast_observations ADD CONSTRAINT retired_weather_payload_removed
 CHECK(dataset<>'weather_medium_range' OR result=jsonb_build_object('status',result->'status','retired_provider','open_meteo'));

-- The provider-specific point cache and its sole former household projections.
DELETE FROM public.energy_outdoor_forecast_cache WHERE provider='open_meteo_shortwave_radiation';
UPDATE public.energy_optimisation_outdoor_slots SET solar_w_per_m2=NULL WHERE solar_w_per_m2 IS NOT NULL;
UPDATE public.energy_prepared_forecasts SET forecast=jsonb_set(forecast,'{solar_irradiance_w_per_m2}','null'::jsonb)
 WHERE jsonb_typeof(forecast->'solar_irradiance_w_per_m2')='array';

-- Historical ROI reconstruction is an independent product. Invalidate the
-- affected simulations under the same per-home lock used by publication.
DO $$
DECLARE profile record;
BEGIN
 FOR profile IN SELECT home_id FROM public.energy_roi_solar_profiles WHERE provenance->>'provider'='open_meteo_historical_forecast' LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('energy-roi:' || profile.home_id::text,0));
  DELETE FROM public.energy_roi_solar_profiles WHERE home_id=profile.home_id AND provenance->>'provider'='open_meteo_historical_forecast';
  IF FOUND THEN
   DELETE FROM public.energy_roi_checkpoints WHERE home_id=profile.home_id;
   UPDATE public.energy_roi_reports SET model=jsonb_set(model,'{roi_solar_profile}','null'::jsonb),
     months='{}'::jsonb,generation=generation+1,updated_at=now() WHERE home_id=profile.home_id;
  END IF;
 END LOOP;
END; $$;

CREATE OR REPLACE VIEW public.energy_market_operational_observations WITH(security_invoker=true) AS
 SELECT o.* FROM public.energy_market_forecast_observations o LEFT JOIN public.energy_market_collection_batches b ON b.id=o.batch_id
 WHERE o.dataset<>'weather_medium_range' AND (b.id IS NULL OR public.market_collection_is_current(b.kind,b.plan,b.requested_at));

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
 SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]') INTO batches FROM (SELECT DISTINCT ON(kind) id,kind,requested_at,plan FROM public.energy_market_collection_batches WHERE public.market_collection_is_current(kind,plan,requested_at) ORDER BY kind,requested_at DESC,id DESC) b;
 FOR batch IN SELECT k.kind,k.hours,b.* FROM (VALUES('day_ahead',1),('generation',6),('market_context',6),('weather_truth',6),('regional_context',6)) k(kind,hours)
  LEFT JOIN LATERAL(SELECT id,requested_at,plan FROM public.energy_market_collection_batches WHERE kind=k.kind AND public.market_collection_is_current(kind,plan,requested_at) ORDER BY requested_at DESC,id DESC LIMIT 1) b ON true LOOP
  checks:=checks+1;
  IF batch.id IS NULL OR at_time-batch.requested_at > make_interval(hours=>2*batch.hours,mins=>15) THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('key','collection/'||batch.kind||'/stale','severity','problem','fingerprint',jsonb_build_object('rule','stale'),
    'detail',jsonb_build_object('kind',batch.kind,'last_batch',batch.requested_at,'cadence_hours',batch.hours)));
  END IF;
  IF batch.id IS NOT NULL AND at_time-batch.requested_at>interval '15 minutes' AND
   (SELECT count(*) FROM public.energy_market_operational_observations WHERE batch_id=batch.id)<jsonb_array_length(batch.plan) THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('key','collection/'||batch.kind||'/interrupted','severity','problem','fingerprint',jsonb_build_object('rule','interrupted'),
    'detail',jsonb_build_object('batch_id',batch.id,'expected',jsonb_array_length(batch.plan),'saved',(SELECT count(*) FROM public.energy_market_operational_observations WHERE batch_id=batch.id))));
  END IF;
 END LOOP;
 -- Assessment projections carry outcomes without reading large raw result JSON.
 SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO heads FROM (
  SELECT DISTINCT ON(o.dataset,o.zone,coalesce(a.facts->>'scope_key',a.facts->>'station_id','')) o.dataset,o.zone,o.id,o.sequence,o.requested_at,o.requested_from,o.requested_to,
   a.status,a.error_code,a.facts,coalesce(a.facts->>'scope_key',a.facts->>'station_id','') scope_key
  FROM public.energy_market_operational_observations o JOIN public.energy_market_observation_assessments a ON a.observation_id=o.id AND a.assessor_version='market-quality-v1'
  ORDER BY o.dataset,o.zone,coalesce(a.facts->>'scope_key',a.facts->>'station_id',''),o.sequence DESC) s;
 FOR source IN SELECT * FROM jsonb_to_recordset(heads) AS s(dataset text,zone text,id uuid,sequence bigint,requested_at timestamptz,requested_from timestamptz,requested_to timestamptz,status text,error_code text,facts jsonb,scope_key text) LOOP
  checks:=checks+1;
  code:=NULL;
  cadence:=CASE WHEN source.dataset IN ('wind_day_ahead','load_day_ahead','jao_max_net_positions','jao_max_exchanges') THEN interval '1 hour' ELSE interval '6 hours' END;
  SELECT max(o.requested_at) INTO last_good FROM public.energy_market_operational_observations o JOIN public.energy_market_observation_assessments a ON a.observation_id=o.id AND a.assessor_version='market-quality-v1'
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
 FOR code IN SELECT unnest(ARRAY['demand_accuracy']) LOOP
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
