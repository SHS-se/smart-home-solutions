-- Recommendations are shared state, never an implicit request to solve.
ALTER TABLE public.energy_optimisation_current
  ADD COLUMN replan_recommendations jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE FUNCTION public.recommend_energy_replan(p_home_id uuid, p_key text, p_reason text, p_occurred_at timestamptz)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.energy_optimisation_current
  SET replan_recommendations = coalesce((SELECT jsonb_agg(r) FROM jsonb_array_elements(replan_recommendations) r WHERE r->>'key' <> p_key), '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'key', p_key, 'reason', p_reason, 'occurred_at', p_occurred_at)), updated_at = now()
  WHERE home_id = p_home_id;
$$;
REVOKE ALL ON FUNCTION public.recommend_energy_replan(uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recommend_energy_replan(uuid,text,text,timestamptz) TO service_role;

CREATE FUNCTION public.clear_solved_energy_recommendations() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Events raised while the solver was running still need attention.
  SELECT coalesce(jsonb_agg(r), '[]'::jsonb) INTO NEW.replan_recommendations
    FROM jsonb_array_elements(OLD.replan_recommendations) r
    WHERE (r->>'occurred_at')::timestamptz > NEW.issued_at;
  RETURN NEW;
END; $$;
CREATE TRIGGER energy_recommendations_solved BEFORE UPDATE OF plan_id ON public.energy_optimisation_current
  FOR EACH ROW WHEN (NEW.plan_id IS DISTINCT FROM OLD.plan_id AND NEW.status = 'ready')
  EXECUTE FUNCTION public.clear_solved_energy_recommendations();

CREATE FUNCTION public.energy_value_change_recommendation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE h uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN h := OLD.home_id; ELSE h := NEW.home_id; END IF;
  PERFORM public.recommend_energy_replan(h, 'value_curves',
    'A value curve or value setting changed. Replan to apply it to the schedule.', now());
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.energy_value_change_recommendation() FROM PUBLIC;
CREATE TRIGGER energy_curve_changed AFTER INSERT OR UPDATE OR DELETE ON public.energy_optimisation_value_curves
  FOR EACH ROW EXECUTE FUNCTION public.energy_value_change_recommendation();
CREATE TRIGGER energy_value_setting_changed AFTER INSERT OR UPDATE OR DELETE ON public.energy_optimisation_value_settings
  FOR EACH ROW EXECUTE FUNCTION public.energy_value_change_recommendation();

CREATE OR REPLACE FUNCTION public.get_energy_portal_delta(
  p_customer_id uuid, p_home_id uuid, p_known jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_to timestamptz := date_bin(interval '15 minutes', statement_timestamp(), '2000-01-01'::timestamptz);
  v_from timestamptz := v_to - interval '72 hours';
  v_rows jsonb;
  v_current jsonb;
  v_plan jsonb;
  v_payload jsonb;
  v_hash text;
  v_result jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL
    OR NOT public.can_access_energy_billing_customer(p_customer_id)
    OR NOT public.energy_home_matches_customer(p_home_id, p_customer_id)
  THEN RAISE EXCEPTION 'Home not found or access denied'; END IF;
  IF jsonb_typeof(p_known) IS DISTINCT FROM 'object' OR octet_length(p_known::text) > 200000
  THEN RAISE EXCEPTION 'Invalid portal cache'; END IF;

  -- Plan identity is immutable; heartbeat and acknowledgement fields are small
  -- and are always returned. Never SELECT the stored planning snapshot here.
  SELECT jsonb_build_object(
    'home_id', home_id, 'captured_at', captured_at, 'updated_at', updated_at,
    'plan_id', plan_id, 'generation_request_id', generation_request_id,
    'plan_schema_version', plan_schema_version, 'ha_runtime', ha_runtime,
    'ha_runtime_received_at', ha_runtime_received_at, 'ha_ack_status', ha_ack_status,
    'ha_acknowledged_at', ha_acknowledged_at, 'ha_integration_version', ha_integration_version,
    'ha_ack_request_id', ha_ack_request_id, 'ha_ack_error', ha_ack_error,
    'replan_recommendations', replan_recommendations,
    'replan_request_id', replan_request_id, 'replan_requested_at', replan_requested_at,
    'replan_completed_request_id', replan_completed_request_id, 'replan_error', replan_error
  ), CASE WHEN p_known->>'plan_id' IS DISTINCT FROM plan_id::text THEN plan ELSE NULL END
  INTO v_current, v_plan FROM public.energy_optimisation_current
  WHERE customer_id = p_customer_id AND home_id = p_home_id;
  v_result := jsonb_build_object('current', v_current, 'plan', v_plan);

  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY start_ts), '[]'::jsonb) INTO v_rows FROM (
    SELECT start_ts, total_load_kwh, solar_production_kwh, grid_import_kwh, grid_export_kwh,
      battery_charge_kwh, battery_discharge_kwh, battery_soc, ev_soc
    FROM public.energy_optimisation_actual_slots
    WHERE customer_id = p_customer_id AND home_id = p_home_id AND start_ts >= v_from AND start_ts < v_to
  ) r;
  v_result := v_result || jsonb_build_object('actuals', public.energy_portal_history_delta(v_rows, COALESCE(p_known->'actuals', '{}'::jsonb)));
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY start_ts), '[]'::jsonb) INTO v_rows FROM (
    SELECT start_ts, import_price_sek_per_kwh, export_price_sek_per_kwh
    FROM public.energy_optimisation_price_slots
    WHERE customer_id = p_customer_id AND home_id = p_home_id AND start_ts >= v_from AND start_ts < v_to
  ) r;
  v_result := v_result || jsonb_build_object('prices', public.energy_portal_history_delta(v_rows, COALESCE(p_known->'prices', '{}'::jsonb)));
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY start_ts), '[]'::jsonb) INTO v_rows
  FROM public.get_energy_optimisation_device_slots(p_customer_id, p_home_id, v_from, v_to) r;
  v_result := v_result || jsonb_build_object('device_actuals', public.energy_portal_history_delta(v_rows, COALESCE(p_known->'device_actuals', '{}'::jsonb)));

  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id), '[]'::jsonb) INTO v_payload FROM (
    SELECT id, device_key, statistic_id, name, category, load_type_override, planning_role_override,
      planning_choice_at, control_type_override, mapping_status, mapped_control_type, mapping_error,
      mapping_summary, mapping_reported_at, active_power_w, profile_sample_count, last_seen_at
    FROM public.energy_optimisation_devices
    WHERE customer_id = p_customer_id AND home_id = p_home_id AND retired_at IS NULL
  ) r;
  v_hash := md5(v_payload::text);
  v_result := v_result || jsonb_build_object('devices', jsonb_build_object('hash', v_hash,
    'value', CASE WHEN p_known->>'devices' IS DISTINCT FROM v_hash THEN v_payload ELSE NULL END));

  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY room_key), '[]'::jsonb) INTO v_payload FROM (
    SELECT room_key, trained, rejection_reason, sample_count
    FROM public.energy_optimisation_zone_models WHERE customer_id = p_customer_id AND home_id = p_home_id
  ) r;
  v_hash := md5(v_payload::text);
  v_result := v_result || jsonb_build_object('zone_models', jsonb_build_object('hash', v_hash,
    'value', CASE WHEN p_known->>'zone_models' IS DISTINCT FROM v_hash THEN v_payload ELSE NULL END));

  -- The portal displays counts and room names, not raw month-long observations.
  -- Aggregate those directly, avoiding the old per-quarter JSON room payloads.
  WITH thermal AS MATERIALIZED (
    SELECT start_ts, room_key FROM public.energy_optimisation_thermal_slots
    WHERE customer_id = p_customer_id AND home_id = p_home_id
      AND start_ts >= v_to - interval '30 days' AND start_ts < v_to
  ), quarters AS (SELECT DISTINCT start_ts FROM thermal)
  SELECT jsonb_build_object(
    'slotCount', (SELECT count(*) FROM quarters),
    'outdoorSlotCount', (SELECT count(*) FROM quarters q JOIN public.energy_optimisation_outdoor_slots o
      ON o.home_id = p_home_id AND o.start_ts = q.start_ts WHERE o.temperature_c IS NOT NULL),
    'observedRoomKeys', COALESCE((SELECT jsonb_agg(room_key ORDER BY room_key) FROM (SELECT DISTINCT room_key FROM thermal) rooms), '[]'::jsonb),
    'firstObservedAt', (SELECT min(start_ts) FROM quarters),
    'lastObservedAt', (SELECT max(start_ts) FROM quarters)
  ) INTO v_payload;
  v_hash := md5(v_payload::text);
  v_result := v_result || jsonb_build_object('thermal', jsonb_build_object('hash', v_hash,
    'value', CASE WHEN p_known->>'thermal' IS DISTINCT FROM v_hash THEN v_payload ELSE NULL END));
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.get_energy_portal_delta(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_portal_delta(uuid, uuid, jsonb) TO authenticated;

CREATE FUNCTION public.energy_configuration_change_recommendation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.recommend_energy_replan(NEW.home_id, 'planning_configuration',
    'Device planning configuration changed. Review the retained schedule and consider a manual replan.', now());
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.energy_configuration_change_recommendation() FROM PUBLIC;
CREATE TRIGGER energy_device_choice_changed AFTER UPDATE ON public.energy_optimisation_devices
  FOR EACH ROW WHEN (ROW(NEW.planning_role_override, NEW.control_type_override, NEW.load_type_override)
    IS DISTINCT FROM ROW(OLD.planning_role_override, OLD.control_type_override, OLD.load_type_override))
  EXECUTE FUNCTION public.energy_configuration_change_recommendation();
CREATE TRIGGER energy_home_choice_changed AFTER UPDATE ON public.energy_optimisation_home_planning
  FOR EACH ROW WHEN (NEW.battery_included IS DISTINCT FROM OLD.battery_included)
  EXECUTE FUNCTION public.energy_configuration_change_recommendation();

-- Quarter monitoring needs prices and state/energy trajectories, not full
-- snapshots, explanations, device predictions or comparison plans.
CREATE FUNCTION public.get_energy_replan_monitor(p_home_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'replan_request_id', replan_request_id, 'replan_completed_request_id', replan_completed_request_id,
    'replan_requested_at', replan_requested_at, 'replan_error', replan_error,
    'snapshot', jsonb_build_object('slots', coalesce((SELECT jsonb_agg(public.energy_replan_pick(s,
      ARRAY['start','import_price_sek_per_kwh','export_price_sek_per_kwh'])) FROM jsonb_array_elements(snapshot->'slots') s), '[]'::jsonb)),
    'plan', CASE WHEN plan IS NOT NULL THEN public.energy_replan_pick(plan,
      ARRAY['status','issued_at','valid_until','battery','ev_battery']) || jsonb_build_object('plans', jsonb_build_object('priority', jsonb_build_object('slots',
        coalesce((SELECT jsonb_agg(public.energy_replan_pick(s, ARRAY['start','load_w','battery_soc','ev_soc']) ORDER BY ordinal)
          FROM jsonb_array_elements(plan#>'{plans,priority,slots}') WITH ORDINALITY AS slots(s, ordinal)), '[]'::jsonb)))) ELSE NULL END
  ) FROM public.energy_optimisation_current WHERE home_id = p_home_id;
$$;
REVOKE ALL ON FUNCTION public.get_energy_replan_monitor(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_replan_monitor(uuid) TO service_role;
