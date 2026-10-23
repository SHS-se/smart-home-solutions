-- A device's colour is identity data, assigned once at discovery.
BEGIN;
LOCK TABLE public.energy_optimisation_devices IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE public.energy_optimisation_devices ADD COLUMN colour text;

CREATE FUNCTION public.next_energy_device_colour(p_home_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  seeds constant text[] := ARRAY[
    '#c43c54','#007f86','#7851a9','#c07800','#467821','#b54f91',
    '#3865ad','#a35127','#638a00','#b03636','#008663','#806cba',
    '#c06582','#34666b','#95641a','#6c854c','#a24472','#527aa4',
    '#9a5443','#676a24','#866593','#3d8174','#a1664c','#687db1'
  ];
  reserved constant text[] := ARRAY[
    '#eb6834','#2a78d6','#1baf7a','#4a3aa7','#8a8f98','#38bdf8','#0284c7',
    '#475569','#f97316','#64748b','#a855f7','#e87ba4','#6b7280'
  ];
  used text[];
  candidate text;
  rgb integer;
  red integer;
  green integer;
  blue integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('energy_device_colour:' || p_home_id::text, 0));
  SELECT coalesce(array_agg(colour) FILTER (WHERE colour IS NOT NULL), ARRAY[]::text[])
    INTO used FROM public.energy_optimisation_devices WHERE home_id = p_home_id;
  FOREACH candidate IN ARRAY seeds LOOP
    IF NOT (candidate = ANY(used)) THEN RETURN candidate; END IF;
  END LOOP;
  -- An odd multiplier permutes all 24-bit RGB values without wrapping to a
  -- duplicate. Keep medium-intensity, chromatic candidates; reserve semantic
  -- colours and the authored seeds. Only new assignments use this policy.
  FOR i IN 0..16777215 LOOP
    rgb := ((i::bigint * 104729 + 1640531) % 16777216)::integer;
    red := (rgb >> 16) & 255; green := (rgb >> 8) & 255; blue := rgb & 255;
    IF greatest(red, green, blue) - least(red, green, blue) < 65
      OR red + green + blue NOT BETWEEN 240 AND 550
      OR greatest(red, green, blue) > 225 THEN CONTINUE; END IF;
    candidate := '#' || lpad(to_hex(rgb), 6, '0');
    IF NOT (candidate = ANY(used || seeds || reserved)) THEN RETURN candidate; END IF;
  END LOOP;
  RAISE EXCEPTION 'Device colour space exhausted for home %', p_home_id;
END;
$$;
REVOKE ALL ON FUNCTION public.next_energy_device_colour(uuid) FROM PUBLIC, anon, authenticated;

-- Include retired devices so neither history nor a returning device changes.
DO $$ DECLARE device record; BEGIN
  FOR device IN SELECT id, home_id FROM public.energy_optimisation_devices
    ORDER BY home_id, first_seen_at, device_key, id LOOP
    UPDATE public.energy_optimisation_devices
      SET colour = public.next_energy_device_colour(device.home_id) WHERE id = device.id;
  END LOOP;
END $$;
ALTER TABLE public.energy_optimisation_devices
  ALTER COLUMN colour SET NOT NULL,
  ADD CONSTRAINT energy_device_colour_format CHECK (colour ~ '^#[0-9a-f]{6}$'),
  ADD CONSTRAINT energy_device_colour_unique UNIQUE (home_id, colour);
COMMENT ON COLUMN public.energy_optimisation_devices.colour IS
  'Immutable home-unique RGB colour, assigned at first discovery and retained through retirement.';

CREATE FUNCTION public.assign_energy_device_colour() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE existing_colour text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.colour IS DISTINCT FROM OLD.colour OR NEW.home_id IS DISTINCT FROM OLD.home_id THEN
      RAISE EXCEPTION 'Device colour and home are immutable';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('energy_device_colour:' || NEW.home_id::text, 0));
  -- BEFORE INSERT also runs on ON CONFLICT updates. Reuse the stored value
  -- before PostgreSQL chooses that path, including concurrent inventory.
  SELECT colour INTO existing_colour FROM public.energy_optimisation_devices
    WHERE home_id = NEW.home_id AND device_key = NEW.device_key;
  IF FOUND THEN NEW.colour := existing_colour;
  ELSE
    IF NEW.colour IS NOT NULL THEN RAISE EXCEPTION 'Device colours are assigned by the catalogue'; END IF;
    NEW.colour := public.next_energy_device_colour(NEW.home_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.assign_energy_device_colour() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER energy_device_colour BEFORE INSERT OR UPDATE ON public.energy_optimisation_devices
  FOR EACH ROW EXECUTE FUNCTION public.assign_energy_device_colour();
COMMIT;

-- Portal device transport: retired metadata remains available to history.
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
    SELECT id, device_key, statistic_id, name, colour, retired_at, category, load_type_override, planning_role_override,
      planning_choice_at, control_type_override, mapping_status, mapped_control_type, mapping_error,
      mapping_summary, mapping_reported_at, active_power_w, profile_sample_count, last_seen_at
    FROM public.energy_optimisation_devices
    WHERE customer_id = p_customer_id AND home_id = p_home_id
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
