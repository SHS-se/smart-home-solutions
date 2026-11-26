-- The SHS app owns the map. This table is its learning/forecasting replica.
ALTER TABLE public.energy_room_profiles
  ADD COLUMN app_map_owner text,
  ADD COLUMN app_map_revision bigint;

REVOKE ALL ON FUNCTION public.set_energy_room_connections(uuid,integer,jsonb) FROM authenticated;

CREATE FUNCTION public.read_energy_room_connections(p_home_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT jsonb_build_object('connections', COALESCE(
    (SELECT connections FROM energy_room_profiles WHERE home_id=p_home_id), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.read_energy_room_connections(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_energy_room_connections(uuid) TO service_role;

CREATE FUNCTION public.publish_energy_room_connections(
  p_home_id uuid, p_owner text, p_revision bigint, p_connections jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
  profile energy_room_profiles%ROWTYPE;
  edge jsonb;
  a text;
  b text;
  canonical jsonb := '[]';
  pair jsonb;
BEGIN
  IF p_owner IS NULL OR btrim(p_owner)='' OR p_revision IS NULL OR p_revision < 1
      OR jsonb_typeof(p_connections) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'An app owner, revision and room connections are required' USING ERRCODE='22023';
  END IF;
  FOR edge IN SELECT value FROM jsonb_array_elements(p_connections) LOOP
    IF jsonb_typeof(edge->'rooms') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Choose two different rooms' USING ERRCODE='22023';
    END IF;
    a:=edge->'rooms'->>0; b:=edge->'rooms'->>1;
    IF jsonb_array_length(edge->'rooms')<>2 OR jsonb_typeof(edge->'rooms'->0) IS DISTINCT FROM 'string'
        OR jsonb_typeof(edge->'rooms'->1) IS DISTINCT FROM 'string' OR btrim(a)='' OR btrim(b)='' OR a=b THEN
      RAISE EXCEPTION 'Choose two different rooms' USING ERRCODE='22023';
    END IF;
    pair:=jsonb_build_object('rooms',jsonb_build_array(least(a COLLATE "C",b COLLATE "C"),greatest(a COLLATE "C",b COLLATE "C")));
    IF canonical @> jsonb_build_array(pair) THEN
      RAISE EXCEPTION 'That doorway is already listed' USING ERRCODE='22023';
    END IF;
    canonical:=canonical||jsonb_build_array(pair);
  END LOOP;
  SELECT COALESCE(jsonb_agg(value ORDER BY value->'rooms'),'[]') INTO canonical FROM jsonb_array_elements(canonical);

  INSERT INTO energy_room_profiles(home_id) VALUES(p_home_id) ON CONFLICT(home_id) DO NOTHING;
  SELECT * INTO profile FROM energy_room_profiles WHERE home_id=p_home_id FOR UPDATE;
  IF profile.app_map_owner IS NOT NULL AND profile.app_map_owner<>p_owner THEN
    RAISE EXCEPTION 'Room connections belong to another app installation' USING ERRCODE='40001';
  END IF;
  IF profile.app_map_revision > p_revision THEN
    RAISE EXCEPTION 'Newer app room connections are already stored' USING ERRCODE='40001';
  END IF;
  IF profile.app_map_revision = p_revision AND profile.connections<>canonical THEN
    RAISE EXCEPTION 'Room connections differ at the same app revision' USING ERRCODE='40001';
  END IF;
  IF profile.app_map_revision IS DISTINCT FROM p_revision THEN
    UPDATE energy_room_profiles SET connections=canonical, app_map_owner=p_owner, app_map_revision=p_revision,
      revision=profile.revision + CASE WHEN profile.connections<>canonical THEN 1 ELSE 0 END
      WHERE home_id=p_home_id;
  END IF;
  RETURN jsonb_build_object('owner',p_owner,'revision',p_revision,'connections',canonical);
END;
$$;
REVOKE ALL ON FUNCTION public.publish_energy_room_connections(uuid,text,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_energy_room_connections(uuid,text,bigint,jsonb) TO service_role;
