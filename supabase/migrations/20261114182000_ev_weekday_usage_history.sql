CREATE FUNCTION public.get_energy_ev_usage_history(p_home_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_array(extract(epoch FROM start_ts) * 1000, ev_soc, ev_charging_kwh)
    ORDER BY start_ts), '[]'::jsonb)
  FROM public.energy_optimisation_actual_slots
  WHERE home_id = p_home_id AND start_ts >= p_from AND start_ts < p_to
    AND (ev_soc IS NOT NULL OR ev_charging_kwh IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION public.get_energy_ev_usage_history(uuid,timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_ev_usage_history(uuid,timestamptz,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.get_energy_replan_monitor(p_home_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'replan_request_id', replan_request_id, 'replan_completed_request_id', replan_completed_request_id,
    'replan_requested_at', replan_requested_at, 'replan_error', replan_error,
    'snapshot', jsonb_build_object('slots', coalesce((SELECT jsonb_agg(public.energy_replan_pick(s,
      ARRAY['start','import_price_sek_per_kwh','export_price_sek_per_kwh'])) FROM jsonb_array_elements(snapshot->'slots') s), '[]'::jsonb)),
    'plan', CASE WHEN plan IS NOT NULL THEN public.energy_replan_pick(plan,
      ARRAY['status','issued_at','valid_until','battery','ev_battery']) || jsonb_build_object('plans', jsonb_build_object('priority', jsonb_build_object('slots',
        coalesce((SELECT jsonb_agg(public.energy_replan_pick(s,
            ARRAY['start','load_w','battery_soc','ev_soc','ev_soc_from_charging']) ORDER BY ordinal)
          FROM jsonb_array_elements(plan#>'{plans,priority,slots}') WITH ORDINALITY AS slots(s, ordinal)), '[]'::jsonb)))) ELSE NULL END
  ) FROM public.energy_optimisation_current WHERE home_id = p_home_id;
$$;
