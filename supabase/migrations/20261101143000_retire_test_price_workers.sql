-- Retire unsuccessful price studies; retain every input, forecast, outcome and price-ledger row.
SELECT cron.unschedule(jobid) FROM cron.job
 WHERE jobname IN ('test-energy-price-experiment','test-energy-price-correction');

CREATE FUNCTION private.enable_test_price_ledger(p_home_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
  -- Exclude writers before acquiring the advisory lock: existing price writers
  -- finish their row-trigger transaction first, avoiding an inverse lock order.
  LOCK TABLE public.energy_optimisation_price_slots IN SHARE ROW EXCLUSIVE MODE;
  PERFORM private.lock_test_price_experiment();
  SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
  IF NOT FOUND OR config.function_url<>'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive' THEN
    RAISE EXCEPTION 'Enable the exact TEST market archive first';
  END IF;
  IF p_home_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.homes WHERE id=p_home_id) THEN RAISE EXCEPTION 'Unknown TEST research home'; END IF;
  IF config.price_experiment_home_id IS NOT NULL AND config.price_experiment_home_id<>p_home_id THEN RAISE EXCEPTION 'TEST price experiment already has a different home'; END IF;
  UPDATE private.test_market_archive_config SET price_experiment_home_id=p_home_id WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.energy_optimisation_price_slots'::regclass AND tgname='capture_test_price_knowledge' AND NOT tgisinternal) THEN
    CREATE TRIGGER capture_test_price_knowledge AFTER INSERT OR UPDATE ON public.energy_optimisation_price_slots
      FOR EACH ROW EXECUTE FUNCTION private.capture_test_price_knowledge();
  END IF;
  INSERT INTO public.energy_test_price_observations(home_id,start_ts,import_price_sek_per_kwh,event,source,source_received_at)
    SELECT p.home_id,p.start_ts,p.import_price_sek_per_kwh,
      CASE WHEN prior.sequence IS NULL THEN 'initial_seed' ELSE 'reconcile' END,p.source,p.received_at
    FROM public.energy_optimisation_price_slots p
    LEFT JOIN LATERAL(SELECT o.sequence,o.import_price_sek_per_kwh FROM public.energy_test_price_observations o
      WHERE o.home_id=p.home_id AND o.start_ts=p.start_ts ORDER BY sequence DESC LIMIT 1) prior ON true
    WHERE p.home_id=p_home_id AND (prior.sequence IS NULL OR prior.import_price_sek_per_kwh IS DISTINCT FROM p.import_price_sek_per_kwh);
END; $$;

CREATE OR REPLACE FUNCTION public.read_test_price_correction_report(p_algorithm text DEFAULT 'se3-price-residual-v1')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; report jsonb;
BEGIN
  IF p_algorithm IS NULL OR p_algorithm NOT IN ('se3-price-residual-v1','se3-price-residual-v2') THEN
    RAISE EXCEPTION 'Unknown TEST correction algorithm' USING ERRCODE='22023';
  END IF;
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config WHERE singleton
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

CREATE OR REPLACE FUNCTION public.get_test_price_correction_comparison(p_pair_id uuid DEFAULT NULL,p_algorithm text DEFAULT 'se3-price-residual-v1')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; report jsonb; selected public.energy_test_price_corrections%ROWTYPE; selected_json jsonb; targets jsonb;
BEGIN
  IF NOT coalesce(public.is_staff(auth.uid()),false) THEN RAISE EXCEPTION 'Price forecast comparisons are staff-only' USING ERRCODE='42501'; END IF;
  report:=public.read_test_price_correction_report(p_algorithm);
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config WHERE singleton
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

DROP FUNCTION public.begin_test_price_pair();
DROP FUNCTION public.complete_test_price_pair(uuid,jsonb);
DROP FUNCTION public.begin_test_price_correction(text);
DROP FUNCTION public.complete_test_price_correction(uuid,jsonb);
DROP FUNCTION private.request_test_price_experiment();
DROP FUNCTION private.enable_test_price_experiment(uuid);
DROP FUNCTION private.request_test_price_correction();
DROP FUNCTION private.enable_test_price_correction();
ALTER TABLE private.test_market_archive_config DROP COLUMN price_correction_enabled;
REVOKE ALL ON FUNCTION private.enable_test_price_ledger(uuid) FROM PUBLIC,anon,authenticated,service_role;
