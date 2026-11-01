-- Versioned TEST research only. Preserve all v1 evidence and leave activation unchanged.
-- Only the explicitly deployed TEST worker requests v2 runs; this migration adds no cron.
ALTER TABLE public.energy_test_price_corrections
  DROP CONSTRAINT energy_test_price_corrections_algorithm_check,
  ADD CONSTRAINT energy_test_price_corrections_algorithm_check
    CHECK(algorithm IN ('se3-price-residual-v1','se3-price-residual-v2'));
CREATE INDEX test_price_correction_pending_algorithm
  ON public.energy_test_price_corrections(home_id,algorithm,reserved_at,id) WHERE status='pending';
DROP INDEX public.test_price_correction_pending;

-- Replace old callable signatures, rather than leaving ambiguous default overloads.
DROP FUNCTION public.get_test_price_correction_comparison(uuid);
DROP FUNCTION public.read_test_price_correction_report();
DROP FUNCTION public.begin_test_price_correction();

CREATE FUNCTION public.begin_test_price_correction(p_algorithm text DEFAULT 'se3-price-residual-v1')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; run public.energy_test_price_corrections%ROWTYPE;
  base public.energy_price_forecast_generations%ROWTYPE; mix public.energy_generation_forecast_runs%ROWTYPE;
  load public.energy_market_forecast_observations%ROWTYPE;
  known_at timestamptz; cutoff bigint; slots jsonb; samples jsonb; frozen jsonb; snapshot record;
BEGIN
  IF p_algorithm IS NULL OR p_algorithm NOT IN ('se3-price-residual-v1','se3-price-residual-v2') THEN
    RAISE EXCEPTION 'Unknown TEST correction algorithm' USING ERRCODE='22023';
  END IF;
  PERFORM private.lock_test_price_experiment();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config WHERE singleton AND price_correction_enabled
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  IF scoped_home IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO run FROM public.energy_test_price_corrections WHERE home_id=scoped_home AND algorithm=p_algorithm AND status='pending' ORDER BY reserved_at,id LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('id',run.id,'algorithm',run.algorithm,'status',run.status,'context',run.context); END IF;
  -- One statement freezes committed baseline and market versions. Remote issue dates do not select availability.
  SELECT b.b baseline,m.m generation,l.l demand INTO snapshot FROM
    (SELECT b FROM public.energy_price_forecast_generations b WHERE home_id=scoped_home ORDER BY generated_at DESC,id DESC LIMIT 1) b
    LEFT JOIN LATERAL(SELECT m FROM public.energy_generation_forecast_runs m WHERE zone='SE3' AND algorithm='se3-generation-analog-v2' ORDER BY recorded_at DESC,id DESC LIMIT 1) m ON true
    LEFT JOIN LATERAL(SELECT l FROM public.energy_market_forecast_observations l WHERE dataset='load_week_ahead' AND result->>'status'='data' ORDER BY sequence DESC LIMIT 1) l ON true;
  base:=snapshot.baseline; mix:=snapshot.generation; load:=snapshot.demand;
  IF base.id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO run FROM public.energy_test_price_corrections WHERE home_id=scoped_home AND baseline_id=base.id AND algorithm=p_algorithm;
  IF FOUND THEN RETURN jsonb_build_object('id',run.id,'algorithm',run.algorithm,'status',run.status,'context',run.context); END IF;
  known_at:=clock_timestamp();
  SELECT coalesce(max(sequence),0) INTO cutoff FROM public.energy_test_price_observations WHERE home_id=scoped_home;
  SELECT jsonb_agg(jsonb_build_object('start',s.value,'price',base.outlook->'shadowImportSekPerKwh'->(s.ordinality-1)::integer,
    'published',base.inputs->'published_import_sek_per_kwh'->(s.ordinality-1)::integer<>'null'::jsonb) ORDER BY s.ordinality)
    INTO slots FROM jsonb_array_elements(base.inputs->'slot_starts') WITH ORDINALITY s;
  -- V1 retains its own cohort. V2 can reuse prospective baseline/feature examples
  -- from both versions; the label always comes from the price ledger, never a correction.
  -- A forecast can train once its truth is published, even before physical delivery.
  -- Unavailable first corrections still supply prospectively frozen feature/label pairs.
  SELECT coalesce(jsonb_agg(jsonb_build_object('runId',s.run_id,'origin',s.reserved_at,'start',s.start_ts,'leadDay',s.lead_day,
      'baseline',s.baseline,'features',s.features,'actual',s.actual,'truthSequence',s.sequence) ORDER BY s.start_ts,s.lead_day),'[]'::jsonb) INTO samples
    FROM (SELECT DISTINCT ON(t.start_ts,t.lead_day) t.*,r.reserved_at,o.import_price_sek_per_kwh actual,o.sequence
      FROM public.energy_test_price_correction_targets t JOIN public.energy_test_price_corrections r ON r.id=t.run_id
      JOIN LATERAL(SELECT sequence,import_price_sek_per_kwh FROM public.energy_test_price_observations
        WHERE home_id=scoped_home AND start_ts=t.start_ts AND sequence<=cutoff ORDER BY sequence DESC LIMIT 1) o ON o.sequence>r.eligibility_cutoff
      WHERE r.algorithm IN ('se3-price-residual-v1',p_algorithm) AND t.home_id=scoped_home AND t.training_eligible AND r.saved_at<known_at AND t.start_ts>=known_at-interval '30 days'
      ORDER BY t.start_ts,t.lead_day,r.reserved_at DESC,r.id DESC) s;
  frozen:=jsonb_build_object('knownAt',known_at,'truthCutoff',cutoff,
    'baseline',jsonb_build_object('id',base.id,'generatedAt',base.generated_at,'slots',slots),
    'generationRunId',mix.id,'generation',mix.forecast,'load',CASE WHEN load.id IS NULL THEN NULL ELSE jsonb_build_object('id',load.id,'intervals',load.result->'document'->'intervals') END,
    'training',samples);
  INSERT INTO public.energy_test_price_corrections(home_id,baseline_id,algorithm,context,reserved_at)
    VALUES(scoped_home,base.id,p_algorithm,frozen,known_at) RETURNING * INTO run;
  RETURN jsonb_build_object('id',run.id,'algorithm',run.algorithm,'status',run.status,'context',run.context);
END; $$;


CREATE FUNCTION public.read_test_price_correction_report(p_algorithm text DEFAULT 'se3-price-residual-v1')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; report jsonb;
BEGIN
  IF p_algorithm IS NULL OR p_algorithm NOT IN ('se3-price-residual-v1','se3-price-residual-v2') THEN
    RAISE EXCEPTION 'Unknown TEST correction algorithm' USING ERRCODE='22023';
  END IF;
  PERFORM private.lock_test_price_experiment();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config WHERE singleton AND price_correction_enabled
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  SELECT jsonb_build_object(
    'algorithm',p_algorithm,
    'truth_cutoff',coalesce((SELECT max(sequence) FROM public.energy_test_price_observations WHERE home_id=scoped_home),0),
    'pair_count',(SELECT count(*) FROM public.energy_test_price_corrections WHERE home_id=scoped_home AND algorithm=p_algorithm),
    'scores',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY lead_day) FROM private.test_price_comparison_scores s WHERE home_id=scoped_home AND algorithm=p_algorithm),'[]'::jsonb),
    'pairs',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY reserved_at DESC,id) FROM (
      SELECT r.id,r.algorithm,r.status,r.reserved_at,r.saved_at,r.baseline_id,r.context->'baseline'->>'generatedAt' baseline_generated_at,
        (SELECT count(*) FROM public.energy_test_price_correction_targets WHERE run_id=r.id) target_count,
        (SELECT count(*) FROM public.energy_test_price_correction_targets WHERE run_id=r.id AND eligible) eligible_count,
        (SELECT count(*) FROM public.energy_test_price_correction_outcomes WHERE pair_id=r.id) scored_count
      FROM public.energy_test_price_corrections r WHERE home_id=scoped_home AND algorithm=p_algorithm ORDER BY reserved_at DESC,id LIMIT 100
    ) s),'[]'::jsonb)) INTO report;
  RETURN report;
END; $$;

CREATE FUNCTION public.get_test_price_correction_comparison(p_pair_id uuid DEFAULT NULL,p_algorithm text DEFAULT 'se3-price-residual-v1')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; report jsonb; selected public.energy_test_price_corrections%ROWTYPE; selected_json jsonb; targets jsonb;
BEGIN
  IF NOT coalesce(public.is_staff(auth.uid()),false) THEN RAISE EXCEPTION 'Price forecast comparisons are staff-only' USING ERRCODE='42501'; END IF;
  report:=public.read_test_price_correction_report(p_algorithm);
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config WHERE singleton AND price_correction_enabled
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  IF scoped_home IS NULL THEN RETURN jsonb_build_object('algorithm',p_algorithm,'enabled',false,'updated_at',clock_timestamp(),'report',report,'selected',NULL,'targets','[]'::jsonb); END IF;
  IF p_pair_id IS NULL THEN
    SELECT * INTO selected FROM public.energy_test_price_corrections WHERE home_id=scoped_home AND algorithm=p_algorithm ORDER BY reserved_at DESC,id LIMIT 1;
  ELSE
    SELECT * INTO selected FROM public.energy_test_price_corrections WHERE home_id=scoped_home AND id=p_pair_id AND algorithm=p_algorithm;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown TEST correction' USING ERRCODE='22023'; END IF;
  END IF;
  IF selected.id IS NOT NULL THEN
    selected_json:=jsonb_build_object('id',selected.id,'algorithm',selected.algorithm,'status',selected.status,'reserved_at',selected.reserved_at,'saved_at',selected.saved_at,
      'reason',selected.forecast->>'reason','training_quarters',selected.forecast->'fit'->'training'->'quarters',
      'baseline_generated_at',selected.context->'baseline'->>'generatedAt',
      'target_count',(SELECT count(*) FROM public.energy_test_price_correction_targets WHERE run_id=selected.id),
      'eligible_count',(SELECT count(*) FROM public.energy_test_price_correction_targets WHERE run_id=selected.id AND eligible));
    SELECT coalesce(jsonb_agg(jsonb_build_object('start',t.start_ts,'target_day',t.target_day,'lead_day',t.lead_day,
      'reduced',t.baseline,'full',t.corrected,'actual',o.actual,'truth_sequence',o.truth_sequence) ORDER BY t.start_ts),'[]'::jsonb) INTO targets
      FROM public.energy_test_price_correction_targets t LEFT JOIN public.energy_test_price_correction_outcomes o ON o.target_id=t.id
      WHERE t.run_id=selected.id AND t.eligible;
  END IF;
  RETURN jsonb_build_object('algorithm',p_algorithm,'enabled',true,'updated_at',clock_timestamp(),'home_name',(SELECT name FROM public.homes WHERE id=scoped_home),
    'report',report,'selected',selected_json,'targets',coalesce(targets,'[]'::jsonb));
END; $$;

-- The original public score view remains v1-only. Both versions use the same math.
CREATE VIEW public.energy_test_price_correction_v2_scores AS
  SELECT * FROM private.test_price_comparison_scores WHERE algorithm='se3-price-residual-v2';
REVOKE ALL ON public.energy_test_price_correction_v2_scores FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.energy_test_price_correction_v2_scores TO service_role;
REVOKE ALL ON FUNCTION public.begin_test_price_correction(text),public.read_test_price_correction_report(text),
  public.get_test_price_correction_comparison(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_test_price_correction(text),public.read_test_price_correction_report(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_test_price_correction_comparison(uuid,text) TO authenticated;
COMMENT ON FUNCTION public.begin_test_price_correction(text) IS
  'Versioned TEST residual reservation: v1 labels remain isolated; v2 reuses only prospective frozen baseline/feature residual evidence from v1/v2.';
