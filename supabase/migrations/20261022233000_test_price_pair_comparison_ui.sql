-- Staff-only projection for the TEST application. No forecasts or truth are changed.
CREATE FUNCTION public.get_test_price_pair_comparison(p_pair_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; report jsonb; selected public.energy_test_price_pairs%ROWTYPE;
  selected_json jsonb; targets jsonb;
BEGIN
  IF NOT coalesce(public.is_staff(auth.uid()),false) THEN
    RAISE EXCEPTION 'Price forecast comparisons are staff-only' USING ERRCODE='42501';
  END IF;
  -- Reuse the research lock so summary, selected forecast and truth share one
  -- committed state even if prices arrive between the following reads.
  report := public.read_test_price_pair_report();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config
    WHERE singleton AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  IF scoped_home IS NULL THEN
    RETURN jsonb_build_object('enabled',false,'updated_at',clock_timestamp(),'report',report,'selected',NULL,'targets','[]'::jsonb);
  END IF;
  IF p_pair_id IS NULL THEN
    SELECT * INTO selected FROM public.energy_test_price_pairs WHERE home_id=scoped_home ORDER BY reserved_at DESC,id LIMIT 1;
  ELSE
    SELECT * INTO selected FROM public.energy_test_price_pairs WHERE home_id=scoped_home AND id=p_pair_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown TEST forecast pair' USING ERRCODE='22023'; END IF;
  END IF;
  IF selected.id IS NOT NULL THEN
    selected_json := jsonb_build_object('id',selected.id,'status',selected.status,
      'reserved_at',selected.reserved_at,'saved_at',selected.saved_at,'reason',selected.forecast->>'reason',
      'training_quarters',selected.forecast->'fit'->'training'->'quarters',
      'target_count',(SELECT count(*) FROM public.energy_test_price_targets WHERE pair_id=selected.id),
      'eligible_count',(SELECT count(*) FROM public.energy_test_price_targets WHERE pair_id=selected.id AND eligible));
    SELECT coalesce(jsonb_agg(jsonb_build_object('start',t.start_ts,'target_day',t.target_day,'lead_day',t.lead_day,
        'reduced',t.reduced,'full',t."full",'actual',o.actual,'truth_sequence',o.truth_sequence) ORDER BY t.start_ts),'[]'::jsonb)
      INTO targets FROM public.energy_test_price_targets t
      LEFT JOIN public.energy_test_price_pair_outcomes o ON o.target_id=t.id
      WHERE t.pair_id=selected.id AND t.eligible;
  END IF;
  RETURN jsonb_build_object('enabled',true,'updated_at',clock_timestamp(),
    'home_name',(SELECT name FROM public.homes WHERE id=scoped_home),
    'report',report,'selected',selected_json,'targets',coalesce(targets,'[]'::jsonb));
END; $$;
REVOKE ALL ON FUNCTION public.get_test_price_pair_comparison(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_test_price_pair_comparison(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_test_price_pair_comparison(uuid) IS
  'Read-only staff TEST comparison: bounded recent pair navigation, all-time paired scores and at most 288 eligible target quarters; no training inputs or credentials.';
