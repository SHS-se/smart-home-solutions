-- The browser supplies hashes of its cached quarters. Compare content rather
-- than timestamps so backfills, corrections, deletions and concurrent commits
-- cannot be missed. Only changed quarters cross the network.
CREATE FUNCTION public.energy_portal_history_delta(p_rows jsonb, p_known jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  WITH rows AS (
    SELECT value AS row, value->>'start_ts' AS key, md5(value::text) AS hash
    FROM jsonb_array_elements(p_rows)
  )
  SELECT jsonb_build_object(
    'upserts', COALESCE((SELECT jsonb_agg(jsonb_build_object('row', row, 'hash', hash) ORDER BY key)
      FROM rows WHERE p_known->>key IS DISTINCT FROM hash), '[]'::jsonb),
    'removed', COALESCE((SELECT jsonb_agg(key) FROM jsonb_object_keys(p_known) AS known(key)
      WHERE NOT EXISTS (SELECT 1 FROM rows WHERE rows.key = known.key)), '[]'::jsonb)
  );
$$;
REVOKE ALL ON FUNCTION public.energy_portal_history_delta(jsonb, jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.get_energy_portal_delta(
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
