-- Room topology and temperature-only evidence are independent of planner inputs.
CREATE TABLE public.energy_room_profiles (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  rooms jsonb NOT NULL DEFAULT '{}',
  connections jsonb NOT NULL DEFAULT '[]',
  revision integer NOT NULL DEFAULT 0
);

CREATE TABLE public.energy_room_probe_slots (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  room_key text NOT NULL,
  source_key text NOT NULL,
  start_ts timestamptz NOT NULL,
  temperature_c double precision NOT NULL,
  PRIMARY KEY (home_id, room_key, source_key, start_ts)
);
CREATE INDEX energy_room_probe_slots_retention ON public.energy_room_probe_slots (start_ts);
ALTER TABLE public.energy_room_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_room_probe_slots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_room_profiles, public.energy_room_probe_slots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.energy_room_profiles, public.energy_room_probe_slots TO service_role;

-- A paired app can publish its room catalogue and measurements. The portal
-- alone edits connections. The column-specific update preserves concurrent saves.
CREATE FUNCTION public.record_energy_room_observations(p_home_id uuid, p_rooms jsonb, p_slots jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  saved_connections jsonb;
  accepted integer;
BEGIN
  INSERT INTO public.energy_room_profiles AS profile (home_id, rooms)
    VALUES (p_home_id, p_rooms)
    ON CONFLICT (home_id) DO UPDATE SET rooms = EXCLUDED.rooms
    RETURNING profile.connections INTO saved_connections;

  INSERT INTO public.energy_room_probe_slots AS stored (home_id, room_key, source_key, start_ts, temperature_c)
    SELECT p_home_id, slot.room_key, p_rooms -> slot.room_key ->> 'source_key', slot.start_ts, slot.temperature_c
    FROM jsonb_to_recordset(p_slots) AS slot(room_key text, start_ts timestamptz, temperature_c double precision)
    ON CONFLICT (home_id, room_key, source_key, start_ts)
    DO UPDATE SET temperature_c = EXCLUDED.temperature_c
    WHERE stored.temperature_c IS DISTINCT FROM EXCLUDED.temperature_c;
  GET DIAGNOSTICS accepted = ROW_COUNT;

  RETURN jsonb_build_object('connections', saved_connections, 'readings_written', accepted);
END;
$$;
REVOKE ALL ON FUNCTION public.record_energy_room_observations(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_energy_room_observations(uuid, jsonb, jsonb) TO service_role;

CREATE FUNCTION public.get_energy_room_profile(p_home_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT FROM public.homes
    WHERE id = p_home_id AND public.can_access_energy_billing_customer(customer_id)) THEN
    RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'revision', profile.revision,
    'connections', profile.connections,
    'rooms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('key', room.key, 'name', room.value ->> 'name',
        'has_probe', room.value ->> 'source_key' IS NOT NULL,
        'latest', CASE WHEN slot.start_ts IS NOT NULL
          THEN jsonb_build_object('start', slot.start_ts, 'temperature_c', slot.temperature_c) END
      ) ORDER BY room.value ->> 'name', room.key)
      FROM jsonb_each(profile.rooms) AS room
      LEFT JOIN LATERAL (
        SELECT start_ts, temperature_c FROM public.energy_room_probe_slots
        WHERE home_id = p_home_id AND room_key = room.key AND source_key = room.value ->> 'source_key'
        ORDER BY start_ts DESC LIMIT 1
      ) AS slot ON true
    ), '[]'::jsonb)
  ) INTO result
  FROM public.energy_room_profiles AS profile WHERE home_id = p_home_id;
  RETURN COALESCE(result, '{"revision":0,"connections":[],"rooms":[]}'::jsonb);
END;
$$;

CREATE FUNCTION public.set_energy_room_connections(p_home_id uuid, p_expected_revision integer, p_connections jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  profile public.energy_room_profiles%ROWTYPE;
  edge jsonb;
  room_a text;
  room_b text;
  room_pair text[];
  sorted_connections jsonb := '[]';
  canonical jsonb;
BEGIN
  IF NOT EXISTS (SELECT FROM public.homes
    WHERE id = p_home_id AND public.can_access_energy_billing_customer(customer_id)) THEN
    RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO profile FROM public.energy_room_profiles WHERE home_id = p_home_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room inventory has not arrived from Home Assistant' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_connections) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid room connections' USING ERRCODE = '22023';
  END IF;
  FOR edge IN SELECT value FROM jsonb_array_elements(p_connections) LOOP
    room_a := edge -> 'rooms' ->> 0;
    room_b := edge -> 'rooms' ->> 1;
    IF jsonb_typeof(edge -> 'rooms') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Choose two different rooms and a doorway type' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(edge -> 'rooms') <> 2
        OR jsonb_typeof(edge -> 'rooms' -> 0) IS DISTINCT FROM 'string'
        OR jsonb_typeof(edge -> 'rooms' -> 1) IS DISTINCT FROM 'string'
        OR room_a = room_b OR edge ->> 'mode' IS NULL
        OR edge ->> 'mode' NOT IN ('usually_open', 'varies') THEN
      RAISE EXCEPTION 'Choose two different rooms and a doorway type' USING ERRCODE = '22023';
    END IF;
    room_pair := ARRAY[least(room_a COLLATE "C", room_b COLLATE "C"), greatest(room_a COLLATE "C", room_b COLLATE "C")];
    IF sorted_connections @> jsonb_build_array(jsonb_build_object('rooms', to_jsonb(room_pair))) THEN
      RAISE EXCEPTION 'That doorway is already listed' USING ERRCODE = '22023';
    END IF;
    canonical := jsonb_build_object('rooms', to_jsonb(room_pair), 'mode', edge ->> 'mode');
    IF (NOT profile.rooms ? room_a OR NOT profile.rooms ? room_b)
       AND NOT profile.connections @> jsonb_build_array(canonical) THEN
      RAISE EXCEPTION 'A room is no longer available in Home Assistant' USING ERRCODE = '22023';
    END IF;
    sorted_connections := sorted_connections || jsonb_build_array(canonical);
  END LOOP;
  SELECT COALESCE(jsonb_agg(value ORDER BY value -> 'rooms'), '[]') INTO sorted_connections
    FROM jsonb_array_elements(sorted_connections);

  -- A retry of the same saved document succeeds without another revision.
  IF sorted_connections = profile.connections THEN RETURN profile.revision; END IF;
  IF p_expected_revision IS DISTINCT FROM profile.revision THEN
    RAISE EXCEPTION 'Room connections changed. Reload the saved connections and try again.' USING ERRCODE = '40001';
  END IF;
  UPDATE public.energy_room_profiles SET connections = sorted_connections, revision = profile.revision + 1
    WHERE home_id = p_home_id;
  RETURN profile.revision + 1;
END;
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_profile(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_energy_room_connections(uuid, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_room_profile(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_energy_room_connections(uuid, integer, jsonb) TO authenticated;

SELECT cron.schedule('prune-energy-room-probe-history', '37 3 * * *',
  $$DELETE FROM public.energy_room_probe_slots WHERE start_ts < now() - interval '120 days'$$);
